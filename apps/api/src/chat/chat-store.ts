import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Citation, RetrieveResult } from "@wiki-memory/shared";
import type { Job } from "../db/interfaces.js";
import { indexText, queryTerms } from "../db/tokenize.js";
import { ServiceError } from "../errors.js";
import { cosineSimilarity, vectorizeSemanticText } from "../memory/memory-state.js";
import type { SQLiteMemoryStateStore } from "../memory/memory-state.js";
import { groupMessagesIntoTurns, splitTurnBySpeaker, stripCitationTags } from "./turns.js";

export type ChatSessionStatus = "pending" | "dreaming" | "dreamed";

interface SessionTurnSource {
  session_id: string;
  session_title: string;
  session_date: string;
  session_status: ChatSessionStatus;
  dreamed_doc_id: string | null;
}

export interface ConversationSearchHit extends SessionTurnSource {
  turn_locator: string;
  excerpt: string;
  matched_terms: string[];
  score: number;
}

export interface RecentSessionSummary {
  session_id: string;
  title: string;
  session_date: string;
  status: ChatSessionStatus;
  message_count: number;
  preview: string;
}

export interface SessionTurnResult extends SessionTurnSource {
  locator: string;
  raw_excerpt: string;
  previous: string | null;
  next: string | null;
}

export interface ChatSessionRecord {
  session_id: string;
  space_key: string;
  title: string;
  session_date: string;
  status: ChatSessionStatus;
  dreamed_doc_id: string | null;
  dreamed_version: number | null;
  dreamed_job_id: string | null;
  dreamed_message_count: number;
  message_count: number;
  source_nudge_id: string | null;
  source_nudge_kind: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRecord {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  baseline_reply: string | null;
  retrieval: RetrieveResult | null;
  citations: Citation[];
  conversation_hits: ConversationSearchHit[];
  tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

type RawSessionRow = Omit<ChatSessionRecord, "message_count"> & {
  message_count?: number;
  prior_dreamed_doc_id: string | null;
  dreaming_message_count: number | null;
};

interface RawMessageRow {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  baseline_reply: string | null;
  retrieval_json: string | null;
  citations_json: string | null;
  conversation_hits_json: string | null;
  tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

function clip(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function clipAroundMatch(text: string, matchedTerms: string[], limit: number) {
  if (text.length <= limit) return text;
  const lower = text.normalize("NFKC").toLowerCase();
  let bestIndex = -1;
  for (const term of matchedTerms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (bestIndex < 0 || idx < bestIndex)) bestIndex = idx;
  }
  if (bestIndex < 0 || bestIndex < Math.floor(limit * 0.65)) return clip(text, limit);
  const start = Math.max(0, bestIndex - Math.floor(limit * 0.35));
  const end = Math.min(text.length, start + limit - 2);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function turnSource(session: Pick<ChatSessionRecord, "session_id" | "title" | "session_date" | "status" | "dreamed_doc_id">): SessionTurnSource {
  return {
    session_id: session.session_id,
    session_title: session.title,
    session_date: session.session_date,
    session_status: session.status,
    // A pending or in-flight copy may have turns outside the published document.
    dreamed_doc_id: session.status === "dreamed" ? session.dreamed_doc_id : null,
  };
}

// Nonnegative hashed vectors share a background dot product even for unrelated text.
// For compound queries, verify semantic-only hits against the meaningful query terms,
// discounting that background so a generic phrase cannot undo the FTS precision gate.
function centeredSimilarity(query: number[], turn: number[]) {
  const sum = (v: number[]) => v.reduce((total, weight) => total + weight, 0);
  const q = sum(query);
  const t = sum(turn);
  const dimensions = query.length;
  const norm = Math.sqrt((1 - q * q / dimensions) * (1 - t * t / dimensions));
  return norm > 0 ? (cosineSimilarity(query, turn) - q * t / dimensions) / norm : 0;
}

export class SQLiteChatStore {
  private readonly dreamingLocks = new Map<string, Promise<void>>();
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(private readonly client: Database.Database, private readonly memoryState?: SQLiteMemoryStateStore) {
    this.client.transaction(() => {
      this.client.exec(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          session_id TEXT PRIMARY KEY,
          space_key TEXT NOT NULL,
          title TEXT NOT NULL,
          session_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          dreamed_doc_id TEXT,
          dreamed_version INTEGER,
          dreamed_job_id TEXT,
          dreamed_message_count INTEGER NOT NULL DEFAULT 0,
          prior_dreamed_doc_id TEXT,
          dreaming_message_count INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_space ON chat_sessions(space_key, updated_at DESC);

        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          baseline_reply TEXT,
          retrieval_json TEXT,
          citations_json TEXT,
          conversation_hits_json TEXT,
          tokens INTEGER,
          latency_ms INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id ASC);
        CREATE VIRTUAL TABLE IF NOT EXISTS chat_turns_fts USING fts5(
          space_key UNINDEXED,
          session_id UNINDEXED,
          turn_locator UNINDEXED,
          session_title,
          content
        );
      `);
      const columns = this.client.pragma("table_info(chat_messages)") as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "conversation_hits_json")) {
        this.client.exec("ALTER TABLE chat_messages ADD COLUMN conversation_hits_json TEXT");
      }
      const sessionColumns = this.client.pragma("table_info(chat_sessions)") as Array<{ name: string }>;
      if (!sessionColumns.some(({ name }) => name === "prior_dreamed_doc_id")) {
        this.client.exec("ALTER TABLE chat_sessions ADD COLUMN prior_dreamed_doc_id TEXT");
      }
      if (!sessionColumns.some(({ name }) => name === "dreaming_message_count")) {
        this.client.exec("ALTER TABLE chat_sessions ADD COLUMN dreaming_message_count INTEGER");
      }
      if (!sessionColumns.some(({ name }) => name === "source_nudge_id")) {
        this.client.exec("ALTER TABLE chat_sessions ADD COLUMN source_nudge_id TEXT");
      }
      if (!sessionColumns.some(({ name }) => name === "source_nudge_kind")) {
        this.client.exec("ALTER TABLE chat_sessions ADD COLUMN source_nudge_kind TEXT");
      }
      const missing = this.client.prepare(`
        SELECT s.session_id
        FROM chat_sessions s
        WHERE EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.session_id)
          AND s.session_id NOT IN (SELECT session_id FROM chat_turns_fts)
      `).all() as Array<{ session_id: string }>;
      for (const { session_id } of missing) this.reindexSession(session_id);
      if (this.memoryState) {
        const incomplete = this.client.prepare(`
          SELECT DISTINCT f.session_id FROM chat_turns_fts f
          WHERE NOT EXISTS (SELECT 1 FROM chat_turn_vectors v
            WHERE v.space_key = f.space_key AND v.session_id = f.session_id AND v.turn_locator = f.turn_locator)
        `).pluck().all() as string[];
        for (const id of incomplete) this.reindexSession(id);
      }
    }).immediate();
  }

  private mapSession(row: RawSessionRow): ChatSessionRecord {
    return {
      session_id: row.session_id,
      space_key: row.space_key,
      title: row.title,
      session_date: row.session_date,
      status: row.status,
      dreamed_doc_id: row.dreamed_doc_id,
      dreamed_version: row.dreamed_version,
      dreamed_job_id: row.dreamed_job_id,
      dreamed_message_count: row.dreamed_message_count,
      message_count: Number(row.message_count ?? 0),
      source_nudge_id: row.source_nudge_id,
      source_nudge_kind: row.source_nudge_kind,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapMessage(row: RawMessageRow): ChatMessageRecord {
    return {
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      baseline_reply: row.baseline_reply,
      retrieval: row.retrieval_json ? (JSON.parse(row.retrieval_json) as RetrieveResult) : null,
      citations: row.citations_json ? (JSON.parse(row.citations_json) as Citation[]) : [],
      conversation_hits: row.conversation_hits_json ? (JSON.parse(row.conversation_hits_json) as ConversationSearchHit[]) : [],
      tokens: row.tokens,
      latency_ms: row.latency_ms,
      created_at: row.created_at,
    };
  }

  listSessions(spaceKey: string): ChatSessionRecord[] {
    const rows = this.client.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.session_id) AS message_count
      FROM chat_sessions s
      WHERE s.space_key = ?
      ORDER BY s.updated_at DESC, s.created_at DESC
    `).all(spaceKey) as RawSessionRow[];
    return rows.map((r) => this.mapSession(r));
  }

  getSession(sessionId: string): ChatSessionRecord | undefined {
    const row = this.client.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.session_id) AS message_count
      FROM chat_sessions s
      WHERE s.session_id = ?
    `).get(sessionId) as RawSessionRow | undefined;
    return row ? this.mapSession(row) : undefined;
  }

  getMessages(sessionId: string): ChatMessageRecord[] {
    const rows = this.client.prepare(`
      SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC
    `).all(sessionId) as RawMessageRow[];
    return rows.map((r) => this.mapMessage(r));
  }

  private getTurns(sessionId: string) {
    const messages = this.client.prepare(`
      SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id ASC
    `).all(sessionId) as Array<Pick<RawMessageRow, "role" | "content">>;
    return groupMessagesIntoTurns(messages);
  }

  private reindexSession(sessionId: string, lastTurnOnly = false) {
    const session = this.getSession(sessionId);
    if (!session) return;
    const turns = this.getTurns(sessionId);
    if (lastTurnOnly) {
      const last = turns.at(-1);
      if (!last) return;
      this.client.prepare("DELETE FROM chat_turns_fts WHERE session_id = ? AND turn_locator = ?").run(sessionId, last.locator);
    } else {
      this.client.prepare("DELETE FROM chat_turns_fts WHERE session_id = ?").run(sessionId);
    }
    const title = indexText(session.title);
    const insert = this.client.prepare(`
      INSERT INTO chat_turns_fts (space_key, session_id, turn_locator, session_title, content)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const { locator, text } of lastTurnOnly ? turns.slice(-1) : turns) {
      // Strip citation tags from assistant replies before indexing so old citation IDs
      // and boilerplate never pollute raw conversation search.
      const { userText, assistantText } = splitTurnBySpeaker(text);
      const cleanAssistant = assistantText ? stripCitationTags(assistantText) : "";
      const searchable = [userText, cleanAssistant].filter(Boolean).join("\n\n");
      insert.run(session.space_key, sessionId, locator, title, indexText(searchable));
      this.memoryState?.upsertTurnVector(session.space_key, sessionId, locator, `${session.title}\n${searchable}`);
    }
  }

  private rankConversationTurns(spaceKey: string, terms: string[], excludeSessionId?: string, weakMatches?: Map<string, string[]>) {
    const meaningful = terms.filter((term) => [...term].length > 1 || /[a-z0-9]/i.test(term));
    if (!meaningful.length) return [];

    const match = meaningful.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
    const candidates = this.client.prepare(`
      SELECT s.*, f.turn_locator, f.session_title AS indexed_title, f.content AS indexed_content,
        bm25(chat_turns_fts, 0, 0, 0, 2, 1) AS score
      FROM chat_turns_fts f
      JOIN chat_sessions s ON s.session_id = f.session_id
      WHERE chat_turns_fts MATCH ? AND f.space_key = ?
        AND (? IS NULL OR f.session_id <> ?)
      ORDER BY score, s.session_date DESC
      LIMIT 50
    `).all(match, spaceKey, excludeSessionId ?? null, excludeSessionId ?? null) as Array<RawSessionRow & {
      turn_locator: string; indexed_title: string; indexed_content: string; score: number;
    }>;

    const turnsCache = new Map<string, ReturnType<typeof groupMessagesIntoTurns>>();
    return candidates.flatMap((row) => {
      const titleTokens = new Set(row.indexed_title.match(/[\p{L}\p{N}]+/gu));
      const turnTokens = new Set(row.indexed_content.match(/[\p{L}\p{N}]+/gu));
      const matchedTerms = meaningful.filter((term) => titleTokens.has(term) || turnTokens.has(term));
      const titleHits = matchedTerms.filter((term) => titleTokens.has(term));
      const hasStrongTitleHit = titleHits.some((term) => /[a-z0-9]/i.test(term)) || titleHits.length >= 2;
      const required = terms.length >= 4 && !hasStrongTitleHit ? 2 : 1;
      if (matchedTerms.length < required) {
        weakMatches?.set(`${row.session_id}#${row.turn_locator}`, matchedTerms);
        return [];
      }

      // Prefer turns where the user actually uttered the matched terms over assistant-only echoes.
      const turns = turnsCache.get(row.session_id) ?? this.getTurns(row.session_id);
      turnsCache.set(row.session_id, turns);
      const turn = turns.find(({ locator }) => locator === row.turn_locator);
      const userTokens = turn
        ? new Set(indexText(splitTurnBySpeaker(turn.text).userText).match(/[\p{L}\p{N}]+/gu) ?? [])
        : new Set<string>();
      const userMatched = matchedTerms.filter((term) => userTokens.has(term)).length;
      return [{
        ...turnSource(row), turn_locator: row.turn_locator,
        matched_terms: matchedTerms, score: row.score, user_matched: userMatched,
      }];
    }).sort((a, b) => {
      // A small relative BM25 boost keeps pending evidence ahead of near ties;
      // user-spoken matches outrank assistant-only echoes at the same term count.
      const score = (hit: typeof a) => hit.score * (hit.session_status === "pending" ? 1.05 : 1);
      return b.matched_terms.length - a.matched_terms.length
        || Number(b.user_matched > 0) - Number(a.user_matched > 0)
        || score(a) - score(b)
        || Number(b.session_status === "pending") - Number(a.session_status === "pending")
        || b.session_date.localeCompare(a.session_date);
    });
  }

  searchConversations(spaceKey: string, query: string, opts?: {
    excludeSessionId?: string; limit?: number; maxPerSession?: number;
    maxPendingPerSession?: number; prioritizePending?: boolean;
  }): ConversationSearchHit[] {
    const {
      excludeSessionId,
      limit = 4,
      maxPerSession = 2,
      prioritizePending = false,
      maxPendingPerSession = prioritizePending ? Math.max(maxPerSession, 4) : maxPerSession,
    } = opts ?? {};
    if (limit <= 0 || maxPerSession <= 0) return [];
    const expandedQuery = this.memoryState ? this.memoryState.expandQueryWithAliases(spaceKey, query) : query;
    const terms = queryTerms(expandedQuery);
    if (!terms.length) return [];
    const weakMatches = this.memoryState ? new Map<string, string[]>() : undefined;
    const ranked = this.rankConversationTurns(spaceKey, terms, excludeSessionId, weakMatches);
    const semantic = this.memoryState?.semanticSearchTurns(spaceKey, expandedQuery, {
      excludeSessionId, limit: Math.max(limit * 3, 12), minSimilarity: 0.22,
    });
    if (semantic?.length) {
      const key = (hit: { session_id: string; turn_locator: string }) => `${hit.session_id}#${hit.turn_locator}`;
      const rrf = new Map(ranked.map((hit, i) => [key(hit), 1 / (60 + i + 1)]));
      const meaningfulVector = terms.length >= 4 ? vectorizeSemanticText(terms.join(" ")) : undefined;
      const source = this.client.prepare(`
        SELECT s.*, v.vector_json FROM chat_turn_vectors v JOIN chat_sessions s ON s.session_id = v.session_id
        WHERE v.space_key = ? AND v.session_id = ? AND v.turn_locator = ?
      `);
      for (const [i, hit] of semantic.entries()) {
        const id = key(hit);
        if (!rrf.has(id)) {
          const session = source.get(spaceKey, hit.session_id, hit.turn_locator) as (RawSessionRow & { vector_json: string }) | undefined;
          if (!session) continue;
          if (meaningfulVector) {
            const partial = weakMatches?.get(id);
            const probe = partial?.length ? vectorizeSemanticText(terms.filter((t) => !partial.includes(t)).join(" ")) : meaningfulVector;
            if (centeredSimilarity(probe, JSON.parse(session.vector_json)) < 0.22) continue;
          }
          ranked.push({ ...turnSource(session), turn_locator: hit.turn_locator, matched_terms: [], user_matched: 0, score: 0 });
        }
        rrf.set(id, (rrf.get(id) ?? 0) + 1 / (60 + i + 1));
      }
      // Use the existing lower-is-better score convention for fused hits.
      for (const hit of ranked) hit.score = -rrf.get(key(hit))!;
      ranked.sort((a, b) => a.score - b.score);
    }
    const hits: ConversationSearchHit[] = [];
    const turnsBySession = new Map<string, ReturnType<typeof groupMessagesIntoTurns>>();
    const selected = new Map<string, Set<string>>();
    const include = (hit: typeof ranked[number]) => {
      if (hits.length >= limit) return false;
      const locators = selected.get(hit.session_id) ?? new Set<string>();
      if (locators.has(hit.turn_locator)) return false;
      const cap = hit.session_status === "pending" ? maxPendingPerSession : maxPerSession;
      if (locators.size >= cap) return false;
      const turns = turnsBySession.get(hit.session_id) ?? this.getTurns(hit.session_id);
      turnsBySession.set(hit.session_id, turns);
      const turn = turns.find(({ locator }) => locator === hit.turn_locator);
      if (!turn) return false;
      const { user_matched: _userMatched, ...cleanHit } = hit;
      hits.push({ ...cleanHit, excerpt: clipAroundMatch(turn.text, hit.matched_terms, 3000) });
      locators.add(hit.turn_locator);
      selected.set(hit.session_id, locators);
      return true;
    };

    const clausePools: Array<typeof ranked> = [];
    if (limit >= 4) {
      const clauses = new Map<string, string[]>();
      for (const part of query.split(/[？?。；;\n]+/)) {
        const terms = queryTerms(part).filter((term) => [...term].length > 1 || /[a-z0-9]/i.test(term));
        if (terms.length) clauses.set(terms.join(" "), terms);
        if (clauses.size >= limit) break;
      }
      if (clauses.size >= 2) {
        // Each question gets its own FTS pool, even if one client dominates all 50 overall candidates.
        for (const terms of clauses.values()) {
          clausePools.push(this.rankConversationTurns(spaceKey, terms, excludeSessionId));
        }
      }
    }

    if (prioritizePending) {
      // Reserve up to half the slots for relevant pending turns first so un-dreamed updates
      // are surfaced without letting weak pending noise starve strongly-matched dreamed turns.
      const pendingReserve = Math.max(2, Math.ceil(limit / 2));
      const topMatchCount = ranked[0]?.matched_terms.length ?? 0;
      const isCompetitivePending = (hit: typeof ranked[number], poolTop: number) =>
        hit.matched_terms.length >= 2 || poolTop <= 2;

      for (const pool of clausePools) {
        const poolTop = pool[0]?.matched_terms.length ?? 0;
        let added = 0;
        for (const match of pool) {
          if (hits.length >= pendingReserve) break;
          if (match.session_status !== "pending") continue;
          if (!isCompetitivePending(match, poolTop)) continue;
          const overall = ranked.find((hit) => hit.session_id === match.session_id && hit.turn_locator === match.turn_locator);
          if (include(overall ?? match) && ++added >= 2) break;
        }
      }
      for (const hit of ranked) {
        if (hits.length >= pendingReserve) break;
        if (hit.session_status === "pending" && isCompetitivePending(hit, topMatchCount)) include(hit);
      }
      for (const pool of clausePools) {
        if (hits.length >= limit) break;
        for (const match of pool) {
          const overall = ranked.find((hit) => hit.session_id === match.session_id && hit.turn_locator === match.turn_locator);
          if (include(overall ?? match)) break;
        }
      }
    } else {
      for (const pool of clausePools) {
        for (const match of pool) {
          const overall = ranked.find((hit) => hit.session_id === match.session_id && hit.turn_locator === match.turn_locator);
          if (include(overall ?? match)) break;
        }
      }
    }
    for (const hit of ranked) {
      if (hits.length >= limit) break;
      include(hit);
    }
    return hits;
  }

  listRecentSessions(spaceKey: string, opts?: { excludeSessionId?: string; limit?: number }): RecentSessionSummary[] {
    const { excludeSessionId = null, limit = 8 } = opts ?? {};
    if (limit <= 0) return [];
    const rows = this.client.prepare(`
      SELECT s.session_id, s.title, s.session_date, s.status,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.session_id) AS message_count,
        (SELECT m.content FROM chat_messages m
          WHERE m.session_id = s.session_id AND m.role = 'user'
            AND trim(m.content, char(9, 10, 11, 12, 13, 32, 160, 12288)) <> ''
          ORDER BY m.id LIMIT 1) AS preview
      FROM chat_sessions s
      WHERE s.space_key = ? AND (? IS NULL OR s.session_id <> ?)
        AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.session_id
          AND trim(m.content, char(9, 10, 11, 12, 13, 32, 160, 12288)) <> '')
      ORDER BY s.session_date DESC, s.updated_at DESC
      LIMIT ?
    `).all(spaceKey, excludeSessionId, excludeSessionId, limit) as Array<Omit<RecentSessionSummary, "preview"> & {
      preview: string | null;
    }>;
    return rows.map((row) => ({ ...row, preview: clip((row.preview ?? "").replace(/\s+/g, " ").trim(), 120) }));
  }

  getSessionTurn(sessionId: string, locator: string): SessionTurnResult | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const turns = this.getTurns(sessionId);
    const index = turns.findIndex((turn) => turn.locator === locator);
    if (index < 0) return undefined;
    return {
      ...turnSource(session),
      locator,
      raw_excerpt: turns[index].text,
      previous: turns[index - 1]?.text ?? null,
      next: turns[index + 1]?.text ?? null,
    };
  }

  createSession(input: {
    sessionId?: string;
    spaceKey: string;
    title?: string;
    sessionDate?: string;
    status?: ChatSessionStatus;
    dreamedDocId?: string | null;
    dreamedVersion?: number | null;
    dreamedJobId?: string | null;
    dreamedMessageCount?: number;
    sourceNudgeId?: string;
    sourceNudgeKind?: string;
    createdAt?: string;
    updatedAt?: string;
  }): ChatSessionRecord {
    const now = input.createdAt ?? new Date().toISOString();
    const sessionId = input.sessionId ?? `chat_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const title = (input.title ?? "").trim() || "新对话";
    const sessionDate = input.sessionDate ?? now.slice(0, 10);
    const status = input.status ?? "pending";
    this.client.prepare(`
      INSERT INTO chat_sessions (
        session_id, space_key, title, session_date, status,
        dreamed_doc_id, dreamed_version, dreamed_job_id, dreamed_message_count,
        source_nudge_id, source_nudge_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      input.spaceKey,
      title,
      sessionDate,
      status,
      input.dreamedDocId ?? null,
      input.dreamedVersion ?? null,
      input.dreamedJobId ?? null,
      input.dreamedMessageCount ?? 0,
      input.sourceNudgeId ?? null,
      input.sourceNudgeKind ?? null,
      now,
      input.updatedAt ?? now,
    );
    return this.getSession(sessionId)!;
  }

  createSessionFromNudge(input: {
    spaceKey: string;
    title: string;
    sessionDate: string;
    nudgeId: string;
    nudgeKind: string;
    assistantContent: string;
    citations: Citation[];
    snapshotVersion: number;
    createdAt?: string;
  }) {
    return this.client.transaction(() => {
      const createdAt = input.createdAt ?? new Date().toISOString();
      const { session_id: sessionId } = this.createSession({
        spaceKey: input.spaceKey,
        title: input.title,
        sessionDate: input.sessionDate,
        status: "pending",
        // The opening message already comes from Wiki Memory. Wait for a reply before dreaming.
        dreamedMessageCount: 1,
        sourceNudgeId: input.nudgeId,
        sourceNudgeKind: input.nudgeKind,
        createdAt,
      });
      const opening = this.appendMessage({
        sessionId,
        role: "assistant",
        content: input.assistantContent,
        citations: input.citations,
        retrieval: {
          snapshot_version: input.snapshotVersion, index_excerpt: null, contexts: [], answer: null,
          citations: input.citations, usage: { selected_pages: 0, returned_tokens: 0, latency_ms: 0 },
        },
        createdAt,
        preserveStatus: true,
      });
      return { session: this.getSession(sessionId)!, messages: [opening] };
    })();
  }

  appendMessage(input: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    baselineReply?: string | null;
    retrieval?: RetrieveResult | null;
    citations?: Citation[];
    conversationHits?: ConversationSearchHit[];
    tokens?: number | null;
    latencyMs?: number | null;
    createdAt?: string;
    preserveStatus?: boolean;
  }): ChatMessageRecord {
    return this.client.transaction(() => {
      const now = input.createdAt ?? new Date().toISOString();
      const info = this.client.prepare(`
        INSERT INTO chat_messages (
          session_id, role, content, baseline_reply, retrieval_json, citations_json, conversation_hits_json,
          tokens, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.role,
        input.content,
        input.baselineReply ?? null,
        input.retrieval ? JSON.stringify(input.retrieval) : null,
        input.citations === undefined ? null : JSON.stringify(input.citations),
        input.conversationHits?.length ? JSON.stringify(input.conversationHits) : null,
        input.tokens ?? null,
        input.latencyMs ?? null,
        now,
      );

      const session = this.getSession(input.sessionId);
      let titleChanged = false;
      if (session && !input.preserveStatus) {
        let nextTitle = session.title;
        if (input.role === "user" && (session.title === "新对话" || !session.title.trim())) {
          const clean = input.content.replace(/\s+/g, " ").trim();
          nextTitle = clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
        }
        const nextStatus: ChatSessionStatus = session.status !== "dreaming" && session.message_count > session.dreamed_message_count
          ? "pending" : session.status;
        titleChanged = nextTitle !== session.title;
        this.client.prepare(`
          UPDATE chat_sessions SET title = ?, status = ?, updated_at = ? WHERE session_id = ?
        `).run(nextTitle, nextStatus, now, input.sessionId);
      }

      this.reindexSession(input.sessionId, !titleChanged);
      const row = this.client.prepare("SELECT * FROM chat_messages WHERE id = ?").get(info.lastInsertRowid) as RawMessageRow;
      return this.mapMessage(row);
    })();
  }

  deleteSession(sessionId: string, expectedDream?: Pick<ChatSessionRecord, "dreamed_doc_id" | "dreamed_job_id">): boolean {
    return this.client.transaction(() => {
      if (expectedDream) {
        const current = this.getSession(sessionId);
        if (!current) return false;
        if (current.dreamed_doc_id !== expectedDream.dreamed_doc_id || current.dreamed_job_id !== expectedDream.dreamed_job_id) {
          throw new ServiceError(409, "CHAT_DREAM_CHANGED", "A chat digest changed while deleting the session");
        }
      }
      this.client.prepare("DELETE FROM chat_turns_fts WHERE session_id = ?").run(sessionId);
      this.memoryState?.deleteSessionVectors(sessionId);
      const res = this.client.prepare("DELETE FROM chat_sessions WHERE session_id = ?").run(sessionId);
      if (!res.changes) return false;
      const outboxColumns = this.client.pragma("table_info(proactive_outbox)") as Array<{ name: string }>;
      if (outboxColumns.some(({ name }) => name === "session_id")) {
        this.client.prepare("UPDATE proactive_outbox SET session_id = NULL WHERE session_id = ?").run(sessionId);
      }
      return true;
    })();
  }

  deleteSpaceSessions(spaceKey: string) {
    this.client.transaction(() => {
      if (this.memoryState) this.client.prepare("DELETE FROM chat_turn_vectors WHERE space_key = ?").run(spaceKey);
      this.client.prepare("DELETE FROM chat_turns_fts WHERE space_key = ?").run(spaceKey);
      this.client.prepare("DELETE FROM chat_sessions WHERE space_key = ?").run(spaceKey);
    })();
  }

  async withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(sessionId);
    const { promise, resolve } = Promise.withResolvers<void>();
    this.sessionLocks.set(sessionId, promise);
    try {
      await prior;
      return await action();
    } finally {
      resolve();
      if (this.sessionLocks.get(sessionId) === promise) this.sessionLocks.delete(sessionId);
    }
  }

  async withDreamingLock<T>(spaceKey: string, action: () => Promise<T>): Promise<T> {
    const prior = this.dreamingLocks.get(spaceKey);
    const { promise, resolve } = Promise.withResolvers<void>();
    this.dreamingLocks.set(spaceKey, promise);
    try {
      await prior;
      return await action();
    } finally {
      resolve();
      if (this.dreamingLocks.get(spaceKey) === promise) this.dreamingLocks.delete(spaceKey);
    }
  }

  dreamDocumentIds(sessionId: string): string[] {
    const row = this.client.prepare("SELECT * FROM chat_sessions WHERE session_id = ?").get(sessionId) as RawSessionRow | undefined;
    const ids = new Set<string>();
    if (row?.dreamed_doc_id) ids.add(row.dreamed_doc_id);
    if (row?.prior_dreamed_doc_id) ids.add(row.prior_dreamed_doc_id);
    if (row) {
      const exported = this.client.prepare(
        "SELECT doc_id FROM documents WHERE space_key = ? AND filename LIKE ?",
      ).all(row.space_key, `session_${sessionId}_m%.json`) as Array<{ doc_id: string }>;
      for (const { doc_id } of exported) ids.add(doc_id);
    }
    return [...ids];
  }

  reconcileRollback(spaceKey: string, targetVersion: number, activeDocIds: Iterable<string>) {
    const active = new Set(activeDocIds);
    const sessions = this.listSessions(spaceKey);
    const docsBySession = new Map<string, Array<{ doc_id: string; count: number }>>();
    const docRows = this.client.prepare(
      "SELECT doc_id, filename FROM documents WHERE space_key = ? AND filename LIKE 'session_%_m%.json'",
    ).all(spaceKey) as Array<{ doc_id: string; filename: string }>;
    for (const row of docRows) {
      if (!active.has(row.doc_id)) continue;
      const match = row.filename.match(/^session_(.+)_m(\d+)\.json$/);
      if (!match) continue;
      const list = docsBySession.get(match[1]) ?? [];
      list.push({ doc_id: row.doc_id, count: Number(match[2]) });
      docsBySession.set(match[1], list);
    }

    const now = new Date().toISOString();
    const update = this.client.prepare(`
      UPDATE chat_sessions
      SET status = ?, dreamed_doc_id = ?, dreamed_version = ?, dreamed_job_id = ?,
          dreamed_message_count = ?, prior_dreamed_doc_id = NULL, dreaming_message_count = NULL, updated_at = ?
      WHERE session_id = ?
    `);
    this.client.transaction(() => {
      for (const session of sessions) {
        const docActive = session.dreamed_doc_id ? active.has(session.dreamed_doc_id) : false;
        const versionValid = session.dreamed_version !== null && session.dreamed_version <= targetVersion;
        if (docActive && versionValid) continue;

        const candidates = (docsBySession.get(session.session_id) ?? []).sort((a, b) => b.count - a.count);
        const restored = candidates[0];
        if (restored) {
          const nextStatus: ChatSessionStatus = session.message_count > restored.count ? "pending" : "dreamed";
          update.run(nextStatus, restored.doc_id, targetVersion, null, restored.count, now, session.session_id);
        } else if (session.dreamed_doc_id || session.dreamed_version !== null || session.status !== "pending") {
          update.run("pending", null, null, null, 0, now, session.session_id);
        }
      }
    })();
  }

  markSessionsDreaming(entries: Array<{
    sessionId: string; docId: string; messageCount: number; expectedDocId?: string | null;
  }>, jobId: string) {
    const now = new Date().toISOString();
    const stmt = this.client.prepare(`
      UPDATE chat_sessions
      SET prior_dreamed_doc_id = CASE WHEN dreamed_version IS NOT NULL THEN dreamed_doc_id ELSE NULL END,
        status = 'dreaming', dreamed_job_id = ?, dreamed_doc_id = ?, dreaming_message_count = ?, updated_at = ?
      WHERE session_id = ? AND status = 'pending' AND (? OR dreamed_doc_id IS ?)
    `);
    this.client.transaction(() => {
      for (const entry of entries) {
        const updated = stmt.run(jobId, entry.docId, entry.messageCount, now, entry.sessionId,
          Number(entry.expectedDocId === undefined), entry.expectedDocId ?? null);
        if (!updated.changes && entry.expectedDocId !== undefined) {
          throw new ServiceError(409, "CHAT_DREAM_CHANGED", "A pending session changed while enqueuing its digest");
        }
      }
    })();
  }

  async syncDreamingSessions(spaceKey: string, getJob: (id: string) => Promise<Job | undefined>) {
    const dreaming = this.client.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.session_id) AS message_count
      FROM chat_sessions s
      WHERE s.space_key = ? AND s.status = 'dreaming' AND s.dreamed_job_id IS NOT NULL
    `).all(spaceKey) as RawSessionRow[];

    if (!dreaming.length) return;

    const jobCache = new Map<string, Job | undefined>();
    for (const row of dreaming) {
      const jobId = row.dreamed_job_id!;
      if (!jobCache.has(jobId)) {
        jobCache.set(jobId, await getJob(jobId));
      }
      const job = jobCache.get(jobId);
      if (!job) continue;
      if (job.status === "published") {
        const version = job.targetVersion ?? row.dreamed_version;
        const exportedCount = row.dreaming_message_count ?? Number(row.message_count ?? 0);
        this.client.prepare(`
          UPDATE chat_sessions
          SET status = CASE WHEN (SELECT COUNT(*) FROM chat_messages WHERE session_id = chat_sessions.session_id) > ?
              THEN 'pending' ELSE 'dreamed' END,
            dreamed_version = ?, dreamed_message_count = ?, prior_dreamed_doc_id = NULL, dreaming_message_count = NULL
          WHERE session_id = ? AND status = 'dreaming' AND dreamed_job_id = ?
        `).run(exportedCount, version, exportedCount, row.session_id, jobId);
      } else if (job.status === "failed") {
        this.client.prepare(`
          UPDATE chat_sessions
          SET status = 'pending', dreamed_doc_id = prior_dreamed_doc_id, prior_dreamed_doc_id = NULL,
            dreaming_message_count = NULL, updated_at = ?
          WHERE session_id = ? AND status = 'dreaming' AND dreamed_job_id = ?
        `).run(new Date().toISOString(), row.session_id, jobId);
      }
    }
  }
}
