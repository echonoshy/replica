import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Citation, RetrieveResult } from "@replica/shared";
import type { Job } from "../db/interfaces.js";
import { indexText, queryTerms } from "../db/tokenize.js";
import { ServiceError } from "../errors.js";
import { groupMessagesIntoTurns } from "./turns.js";

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

export class SQLiteChatStore {
  private readonly dreamingLocks = new Map<string, Promise<void>>();

  constructor(private readonly client: Database.Database) {
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
      const missing = this.client.prepare(`
        SELECT s.session_id
        FROM chat_sessions s
        WHERE EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.session_id)
          AND s.session_id NOT IN (SELECT session_id FROM chat_turns_fts)
      `).all() as Array<{ session_id: string }>;
      for (const { session_id } of missing) this.reindexSession(session_id);
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

  private reindexSession(sessionId: string) {
    this.client.prepare("DELETE FROM chat_turns_fts WHERE session_id = ?").run(sessionId);
    const session = this.getSession(sessionId);
    if (!session) return;
    const title = indexText(session.title);
    const insert = this.client.prepare(`
      INSERT INTO chat_turns_fts (space_key, session_id, turn_locator, session_title, content)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const { locator, text } of this.getTurns(sessionId)) {
      insert.run(session.space_key, sessionId, locator, title, indexText(text));
    }
  }

  searchConversations(spaceKey: string, query: string, opts?: {
    excludeSessionId?: string; limit?: number; maxPerSession?: number;
  }): ConversationSearchHit[] {
    const { excludeSessionId = null, limit = 4, maxPerSession = 2 } = opts ?? {};
    const terms = queryTerms(query);
    const meaningful = terms.filter((term) => [...term].length > 1);
    if (!meaningful.length || limit <= 0 || maxPerSession <= 0) return [];

    const match = meaningful.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
    const candidates = this.client.prepare(`
      SELECT s.*, f.turn_locator, f.session_title AS indexed_title, f.content AS indexed_content,
        bm25(chat_turns_fts, 0, 0, 0, 2, 1) AS score
      FROM chat_turns_fts f
      JOIN chat_sessions s ON s.session_id = f.session_id
      WHERE chat_turns_fts MATCH ? AND f.space_key = ?
        AND (? IS NULL OR f.session_id <> ?)
      ORDER BY score, s.session_date DESC
      LIMIT 30
    `).all(match, spaceKey, excludeSessionId, excludeSessionId) as Array<RawSessionRow & {
      turn_locator: string; indexed_title: string; indexed_content: string; score: number;
    }>;

    const ranked = candidates.flatMap((row) => {
      const titleTokens = new Set(row.indexed_title.match(/[\p{L}\p{N}]+/gu));
      const turnTokens = new Set(row.indexed_content.match(/[\p{L}\p{N}]+/gu));
      const matchedTerms = meaningful.filter((term) => titleTokens.has(term) || turnTokens.has(term));
      const required = terms.length >= 4 && !matchedTerms.some((term) => titleTokens.has(term)) ? 2 : 1;
      if (matchedTerms.length < required) return [];
      return [{
        ...turnSource(row), turn_locator: row.turn_locator,
        matched_terms: matchedTerms, score: row.score,
      }];
    }).sort((a, b) => {
      // A small relative BM25 boost keeps pending evidence ahead of near ties.
      const score = (hit: typeof a) => hit.score * (hit.session_status === "pending" ? 1.05 : 1);
      return b.matched_terms.length - a.matched_terms.length || score(a) - score(b)
        || Number(b.session_status === "pending") - Number(a.session_status === "pending")
        || b.session_date.localeCompare(a.session_date);
    });

    const hits: ConversationSearchHit[] = [];
    const turnsBySession = new Map<string, ReturnType<typeof groupMessagesIntoTurns>>();
    const hitCount = new Map<string, number>();
    for (const hit of ranked) {
      const count = hitCount.get(hit.session_id) ?? 0;
      if (count >= maxPerSession) continue;
      const turns = turnsBySession.get(hit.session_id) ?? this.getTurns(hit.session_id);
      turnsBySession.set(hit.session_id, turns);
      const turn = turns.find(({ locator }) => locator === hit.turn_locator);
      if (!turn) continue;
      hits.push({ ...hit, excerpt: clip(turn.text, 900) });
      hitCount.set(hit.session_id, count + 1);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  listRecentSessions(spaceKey: string, opts?: { excludeSessionId?: string; limit?: number }): RecentSessionSummary[] {
    const { excludeSessionId = null, limit = 5 } = opts ?? {};
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
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      now,
      input.updatedAt ?? now,
    );
    return this.getSession(sessionId)!;
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
        input.citations?.length ? JSON.stringify(input.citations) : null,
        input.conversationHits?.length ? JSON.stringify(input.conversationHits) : null,
        input.tokens ?? null,
        input.latencyMs ?? null,
        now,
      );

      const session = this.getSession(input.sessionId);
      if (session && !input.preserveStatus) {
        let nextTitle = session.title;
        if (input.role === "user" && (session.title === "新对话" || !session.title.trim())) {
          const clean = input.content.replace(/\s+/g, " ").trim();
          nextTitle = clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
        }
        const nextStatus: ChatSessionStatus = session.status !== "dreaming" && session.message_count > session.dreamed_message_count
          ? "pending" : session.status;
        this.client.prepare(`
          UPDATE chat_sessions SET title = ?, status = ?, updated_at = ? WHERE session_id = ?
        `).run(nextTitle, nextStatus, now, input.sessionId);
      }

      this.reindexSession(input.sessionId);
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
      const res = this.client.prepare("DELETE FROM chat_sessions WHERE session_id = ?").run(sessionId);
      return res.changes > 0;
    })();
  }

  deleteSpaceSessions(spaceKey: string) {
    this.client.transaction(() => {
      this.client.prepare("DELETE FROM chat_turns_fts WHERE space_key = ?").run(spaceKey);
      this.client.prepare("DELETE FROM chat_sessions WHERE space_key = ?").run(spaceKey);
    })();
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
    return [row?.dreamed_doc_id, row?.prior_dreamed_doc_id].filter((id): id is string => !!id);
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
