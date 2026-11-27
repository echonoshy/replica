import { z } from "zod";
import { findAnchors, hotMemorySummarySchema, isWikiPagePath } from "@wiki-memory/shared";
import type { Citation, ProceduralRule, RetrieveInput, RetrieveResult, SourceResult, SpaceRef, WikiContext } from "@wiki-memory/shared";
import type { DocumentRecord, MetadataRepository, WikiStorage } from "../db/interfaces.js";
import { spaceKey, zeroUsage } from "../db/interfaces.js";
import { indexText, queryTerms } from "../db/tokenize.js";
import { ServiceError } from "../errors.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";
import { factStorageKey, inferFactTier } from "../memory/memory-state.js";
import type { FactTelemetryRecord, SQLiteMemoryStateStore } from "../memory/memory-state.js";
import { anchorKey, claimAnchors, isFact, isRule } from "../pipeline/analyzer.js";
import type { Claim, Fact, PrivacyScope, ProceduralRuleClaim } from "../pipeline/analyzer.js";
import { anchoredSections } from "../pipeline/normalizer.js";
import { clipBytes, inline, markdownAst, plainText, readPage, walk } from "../pipeline/wiki-markdown.js";
import type { ConversationSearchHit, SQLiteChatStore } from "../chat/chat-store.js";
import { compileWiki, factTelemetry, reconcile } from "../pipeline/wiki-compiler.js";
import { extractWikiLinks, type Navigator } from "./navigator.js";
import { countTokens, relevantMarkdown, trimIndex, truncateTokens } from "./token-budget.js";

const noEvidence = (query: string) => /\p{Script=Han}/u.test(query)
  ? "当前快照没有足够的相关证据。" : "The snapshot does not contain enough relevant evidence.";

const framingLeadIn = /^(?:(?:具体|分项|分别)?(?:说明|回答|答复|情况|要点|总结)(?:如下)?|以下(?:是|为)?(?:具体)?(?:回答|说明|要点)|(?:here (?:is|are) (?:the |a )?)?(?:summary|answers?|details|key points))\s*[:：]$/i;
const evidenceGap = /未提及|未找到|未说明|未明确|未记载|未记录|未给出|未包含|未列出|未披露|未确认|没有(?:提及|找到|说明|明确|记载|记录|给出|包含)|没有.*(?:信息|记录|资料|数据|证据)|暂无.*(?:信息|记录|资料|数据|证据)|无相关|无法确认|无法确定|not mentioned|no (?:relevant )?(?:evidence|information|record)|not found in|cannot (?:confirm|determine)|(?:passages|sources|records) do not (?:mention|cover|specify|state|clarify)/i;

const factualCuePattern = /[。！？.!?]|(?:^|[^\p{L}])(?:is|are|was|were)(?:$|[^\p{L}])|是|为|约|共|\d|[一二三四五六七八九十百千万亿两]+(?:元|万|千|百|天|日|月|年|岁|次|个|点|小时|分钟|%|％)/iu;

function isSectionLabel(text: string, requireColon: boolean) {
  const stripped = text.replace(/^(?:\d+[.、)）]\s*|[一二三四五六七八九十]+[、.）)]\s*)/, "");
  if ([...stripped].length > 24) return false;
  if (requireColon && !/[:：]$/.test(stripped)) return false;
  return !factualCuePattern.test(stripped);
}

function needsCitation(text: string, isBoldOnly = false) {
  if (!text) return false;
  const body = text.replace(/^(?:关于|针对|就)[^，,。！？:：\n]{1,24}[，,]\s*/u, "");
  if ([...text].length <= 40 && framingLeadIn.test(body)) return false;
  // Short pure section label (colon-terminated or standalone bold heading like "**年底全家旅行**"),
  // excluding factual assertions with verbs/quantities like "违约金是五万元：".
  if (isSectionLabel(text, !isBoldOnly)) return false;
  // A disclaimer cannot exempt a separate assertion in the same paragraph.
  const statement = body.replace(/^(?:根据(?:现有|当前|所提供的?)?(?:资料|材料|记录)|(?:in|according to) the (?:supplied|available|provided) passages)[，,]\s*/i, "");
  const clauses = statement.split(/[。！？.!?；;，,\n]+|但(?:是)?|不过|\b(?:but|however)\b/i)
    .map((part) => part.trim()).filter(Boolean);
  return !clauses.length || clauses.some((part) => !evidenceGap.test(part));
}

export async function requireSpace(repo: MetadataRepository, ref: SpaceRef) {
  const space = await repo.findSpace(ref);
  if (!space) throw new ServiceError(404, "SPACE_NOT_FOUND", "Memory space not found");
  return space;
}

export async function snapshotFor(repo: MetadataRepository, ref: SpaceRef, requested?: number | null) {
  const space = await requireSpace(repo, ref);
  const version = requested ?? space.current_version;
  const snapshot = version ? await repo.getSnapshot(spaceKey(ref), version) : null;
  if (version && !snapshot) throw new ServiceError(404, "SNAPSHOT_NOT_FOUND", "Snapshot version not found");
  return { space, snapshot };
}

export class SourceReader {
  private readonly docs = new Map<string, Promise<DocumentRecord | undefined>>();
  private readonly sections = new Map<string, Promise<ReturnType<typeof anchoredSections>>>();

  constructor(private readonly repo: MetadataRepository, private readonly storage: WikiStorage, private readonly ref: SpaceRef) {}

  private document(id: string) {
    const cached = this.docs.get(id) ?? this.repo.findDocument(spaceKey(this.ref), id);
    this.docs.set(id, cached);
    return cached;
  }

  private blocks(doc: DocumentRecord) {
    const cached = this.sections.get(doc.docId) ?? this.storage.readNormalized(this.ref, doc).then((result) =>
      result ? anchoredSections(result.markdown) : []);
    this.sections.set(doc.docId, cached);
    return cached;
  }

  async lookup(docId: string, locator: string, checkPassage?: (text: string) => Promise<void>): Promise<SourceResult> {
    const doc = await this.document(docId);
    if (!doc) throw new ServiceError(404, "SOURCE_NOT_FOUND", "Source document not found in this space");
    const sections = await this.blocks(doc);
    const index = sections.findIndex((section) => section.locator === locator);
    if (index < 0) throw new ServiceError(404, "SOURCE_NOT_FOUND", "Source locator not found");
    const passage = sections[index].text;
    if (checkPassage) await checkPassage(passage);
    return {
      anchor: `${docId}#${locator}`, doc_id: docId, filename: doc.filename, doc_date: doc.docDate, locator,
      raw_excerpt: clipBytes(passage, 24_000),
      previous: !checkPassage && index > 0 ? clipBytes(sections[index - 1].text, 800) : null,
      next: !checkPassage && sections[index + 1] ? clipBytes(sections[index + 1].text, 800) : null,
    };
  }

  async citations(text: string, rawBudget: { remaining: number } | null, renderFilename?: (name: string) => string) {
    const anchors = new Map(findAnchors(text).map((anchor) => [anchor.anchor, anchor]));
    const citations: Citation[] = [];
    for (const { anchor, docId, locator } of anchors.values()) {
      const doc = await this.document(docId);
      if (!doc) throw new ServiceError(500, "SOURCE_MISSING", "A published citation has no source document");
      let raw: string | null = null;
      if (rawBudget && rawBudget.remaining > 0) {
        const excerpt = (await this.lookup(docId, locator)).raw_excerpt;
        if (excerpt) {
          const fairBudget = Math.ceil(rawBudget.remaining / (anchors.size - citations.length));
          raw = truncateTokens(excerpt, Math.min(1500, fairBudget)) || null;
          rawBudget.remaining -= countTokens(raw);
        }
      }
      citations.push({ anchor, doc_id: docId, filename: renderFilename ? renderFilename(doc.filename) || docId : doc.filename, doc_date: doc.docDate, raw_excerpt: raw });
    }
    return citations;
  }
}

export async function readSnapshotClaims(
  storage: WikiStorage & { readClaims?(ref: SpaceRef, version: number): Promise<Claim[]> },
  ref: SpaceRef, version: number,
): Promise<Claim[]> {
  if (!version) return [];
  const claims = storage.readClaims ? await storage.readClaims(ref, version)
    : JSON.parse(await storage.readSnapshotFile(ref, version, "_claims.json"));
  if (!Array.isArray(claims)) throw new Error("Invalid snapshot claims");
  return claims;
}

export function recordCitedFacts(store: SQLiteMemoryStateStore | undefined, key: string, claims: Claim[], citations: Citation[]) {
  if (!store || !citations.length) return;
  const anchors = new Set(citations.map((c) => c.anchor));
  try {
    const controls = store.listTelemetry(key);
    const keys = claims.filter(isFact).filter((fact) =>
      claimAnchors(fact).some((a) => anchors.has(anchorKey(a)))).map((fact) =>
      factTelemetry(fact, controls)?.fact_key ?? factStorageKey(fact));
    if (keys.length) store.recordRecallByFacts(key, keys);
  } catch {
    // Recall statistics are best effort; a citation remains valid independently.
  }
}

export async function searchChatTurns(chats: SQLiteChatStore, state: SQLiteMemoryStateStore | undefined, gateway: OpenAiGateway,
  key: string, query: string, options: NonNullable<Parameters<SQLiteChatStore["searchConversations"]>[2]>,
  pendingOnly = false) {
  const limit = options.limit ?? 4;
  const hits = chats.searchConversations(key, query, { ...options, limit: pendingOnly ? limit * 2 : limit })
    .filter((h) => !pendingOnly || h.session_status !== "dreamed");
  if (!state || !gateway.hasEmbeddings?.()) return hits.slice(0, limit);
  const vectors = await gateway.embed([query]).catch(() => null);
  if (!vectors?.[0]?.length) return hits.slice(0, limit);
  const semantic = state.semanticSearchTurns(key, query, { excludeSessionId: options.excludeSessionId, limit: limit * 2,
    minSimilarity: 0.22, queryVector: vectors[0] });
  const byTurn = new Map(hits.map((hit, i) => [hit.session_id + "#" + hit.turn_locator, { hit, rank: 1 / (61 + i) }]));
  for (const [i, { session_id, turn_locator }] of semantic.entries()) {
    const id = session_id + "#" + turn_locator;
    const existing = byTurn.get(id);
    const rank = 1 / (61 + i);
    if (existing) { existing.rank += rank; continue; }
    const turn = chats.getSessionTurn(session_id, turn_locator);
    if (!turn || (pendingOnly && turn.session_status === "dreamed")) continue;
    byTurn.set(id, { rank, hit: { session_id, turn_locator, session_title: turn.session_title,
      session_date: turn.session_date, session_status: turn.session_status, dreamed_doc_id: turn.dreamed_doc_id,
      excerpt: truncateTokens(turn.raw_excerpt, 750), matched_terms: [], score: -rank } });
  }
  const result: ConversationSearchHit[] = [];
  const counts = new Map<string, number>();
  for (const { hit, rank } of [...byTurn.values()].sort((a, b) => b.rank - a.rank)) {
    const count = counts.get(hit.session_id) ?? 0;
    const cap = hit.session_status === "pending" ? options.maxPendingPerSession ?? 4 : options.maxPerSession ?? 2;
    if (count >= cap) continue;
    result.push({ ...hit, score: -rank });
    counts.set(hit.session_id, count + 1);
    if (result.length >= limit) break;
  }
  return result;
}

export const externalScopes: PrivacyScope[] = ["private_health", "family", "work_internal"];

export function ruleSummary(rule: ProceduralRuleClaim): ProceduralRule {
  return {
    rule_id: rule.rule_id, trigger_context: rule.trigger_context, instruction: rule.instruction,
    rationale: rule.rationale, scope: rule.scope ?? "general", priority: rule.priority ?? "normal",
    doc_id: rule.docId, locator: rule.locator,
    doc_date: rule.docDate, archived: Boolean(rule.archived), archived_reason: rule.archived?.reason,
  };
}

function scopedPageRenderer(claims: Claim[], controls: Map<string, FactTelemetryRecord>, excluded: PrivacyScope[]) {
  const byAnchor = new Map<string, Array<Claim & Fact>>();
  for (const fact of claims.filter(isFact)) {
    for (const anchor of claimAnchors(fact).map(anchorKey)) {
      const list = byAnchor.get(anchor) ?? [];
      list.push(fact);
      byAnchor.set(anchor, list);
    }
  }
  const hidden = new Set<string>();
  const publicSubjects = new Set<string>();
  const hiddenSubjects = new Set<string>();
  for (const fact of claims.filter(isFact)) {
    const control = factTelemetry(fact, controls);
    if (control?.archived_reason || excluded.includes(control?.scope_override ?? fact.scope ?? "general")) {
      hidden.add(fact.value);
      hidden.add(control?.edited_value ?? "");
      hiddenSubjects.add(fact.subject);
    } else {
      publicSubjects.add(fact.subject);
    }
  }
  for (const subject of hiddenSubjects) if (!publicSubjects.has(subject)) hidden.add(subject);
  const hiddenRuleAnchors = new Set<string>();
  const visibleRules = claims.filter(isRule).filter((rule) => !excluded.includes(ruleSummary(rule).scope));
  for (const rule of claims.filter(isRule)) {
    if (excluded.includes(ruleSummary(rule).scope)) {
      if (!visibleRules.some((r) => r.trigger_context === rule.trigger_context)) hidden.add(rule.trigger_context);
      hidden.add(rule.instruction);
      hidden.add(rule.rationale ?? "");
      claimAnchors(rule).forEach((a) => hiddenRuleAnchors.add(anchorKey(a)));
    }
  }
  hidden.delete("");
  const hiddenText = [...hidden].flatMap((value) => [value, inline(value)]);
  return (body: string) => body.split("\n").flatMap((line) => {
    const prose = line.replace(/\[src:[^\]]+\]/g, "");
    if (hiddenText.some((value) => prose.includes(value))) return [];
    const anchors = findAnchors(line);
    const candidates = [...new Set(anchors.flatMap((a) => byAnchor.get(a.anchor) ?? []))];
    // One source paragraph may support several independent bullets with different scopes.
    const direct = candidates.filter((fact) =>
      line.includes(`**${inline(fact.subject)} · ${inline(fact.predicate)}** · ${inline(fact.value)} [src:`));
    const mentioned = candidates.filter((fact) => line.includes(inline(fact.value)));
    // Rules and facts can cite the very same paragraph. An exact rendered rule has its own scope.
    if (!direct.length && visibleRules.some((rule) => line.includes(inline(rule.instruction))
      && line.includes(inline(rule.trigger_context)) && anchors.some((a) => a.anchor === anchorKey(rule)))) return [line];
    if (!direct.length && anchors.some((a) => hiddenRuleAnchors.has(a.anchor))) return [];
    const facts = direct.length ? direct : mentioned.length ? mentioned : candidates;
    let rendered = line;
    for (const fact of facts) {
      const control = factTelemetry(fact, controls);
      const value = control?.edited_value ?? fact.value;
      const scope = control?.scope_override ?? fact.scope ?? "general";
      if (control?.archived_reason || excluded.includes(scope)) return [];
      if (control?.edited_value != null) {
        // Escape edited Markdown and preserve only the provenance tags from the snapshot.
        const label = `**${inline(fact.subject)} · ${inline(fact.predicate)}** · `;
        const original = (direct.length ? label : "") + inline(fact.value);
        if (!rendered.includes(original)) return [];
        rendered = rendered.replace(original, () => (direct.length ? label : "") + inline(value));
      }
    }
    return [rendered];
  }).join("\n");
}

// A projected view is shared by retrieval and the individual tools. Search indexes
// only nominate paths. Page text, links and index entries all come from this view.
export async function wikiView(repo: MetadataRepository, storage: WikiStorage, state: SQLiteMemoryStateStore | undefined,
  ref: SpaceRef, requested: number | null | undefined, excluded: PrivacyScope[], asOfDate?: string, needClaims = false) {
  const { space, snapshot } = await snapshotFor(repo, ref, requested);
  const version = snapshot?.version ?? 0;
  const key = spaceKey(ref);
  const today = asOfDate ?? new Date().toISOString().slice(0, 10);
  const controls = state?.listTelemetry(key) ?? new Map<string, FactTelemetryRecord>();
  const restricted = excluded.length > 0 || [...controls.values()].some((c) => c.archived_reason || c.edited_value != null);
  const [ledger, files] = await Promise.all([
    state || restricted || needClaims || asOfDate ? readSnapshotClaims(storage, ref, version).catch((error: unknown) => {
      // Older snapshots without a ledger can still serve their published Markdown in full mode.
      if (restricted || asOfDate) throw error;
      return [];
    }) : [],
    version ? storage.listSnapshotFiles(ref, version) : [],
  ]);
  const claims = asOfDate ? ledger.filter((c) => c.docDate <= asOfDate) : ledger;
  let reconciled: ReturnType<typeof reconcile> | undefined;
  const active = () => reconciled ??= reconcile(claims, today, { asOfDate });
  const render = restricted ? scopedPageRenderer(claims, controls, excluded) : (s: string) => s;
  const visibleText = (text: string) => !excluded.length || render(text) === text;
  let summaries: ProceduralRule[] | undefined;
  const activeRules = () => summaries ??= (active().rules ?? []).map(ruleSummary).filter((r) =>
    !r.archived && !excluded.includes(r.scope) && visibleText([r.trigger_context, r.instruction, r.rationale].join(" ")));
  let paths = files.filter((path) => path !== "_index.md");
  const read = (path: string) => storage.readSnapshotFile(ref, version, path);
  let load = read;
  if (snapshot && asOfDate) {
    const draft = new Map(await Promise.all(files.map(async (p) => [p, await read(p)] as const)));
    compileWiki(draft, space, version, snapshot.documents, [], claims, today + "T00:00:00.000Z", ledger, { asOfDate });
    paths = [...draft.keys()].filter((p) => p !== "_index.md" && isWikiPagePath(p));
    load = async (p) => draft.get(p)!;
  }
  let index = version ? await load("_index.md") : "";
  const readContent = async (p: string) => {
    const { frontmatter, body } = readPage(await load(p));
    const title = render(frontmatter?.title ?? p);
    const markdown = render(body);
    const metadata = restricted && frontmatter ? { ...frontmatter, title: title || p,
      sources: [...new Set(findAnchors(markdown).map((a) => a.docId))] } : frontmatter;
    return { frontmatter: metadata, title: title || p, body: markdown };
  };
  let page = readContent;
  if (restricted) {
    const visible = new Map<string, Awaited<ReturnType<typeof readContent>>>();
    const entries = await Promise.all(paths.map(async (p) => [p, await readContent(p)] as const));
    for (const [path, entry] of entries) {
      if (render(path) && findAnchors(entry.body).length) visible.set(path, entry);
    }
    // Keep navigational hubs if they lead to visible evidence.
    for (const [path, entry] of entries) {
      if (render(path) && extractWikiLinks(path, entry.body).some((p) => visible.has(p))) visible.set(path, entry);
    }
    paths = [...visible.keys()];
    page = async (p) => {
      const entry = visible.get(p)!;
      const body = entry.body.split("\n").filter((line) => {
        if (!line.includes("](")) return true;
        return extractWikiLinks(p, line).every((target) => visible.has(target));
      }).join("\n");
      return { ...entry, body };
    };
    index = index.split("\n").filter((line) => line.startsWith("- ["))
      .map((line) => line.replace(/(\.md\)).*$/, "$1"))
      .filter((line) => render(line) && extractWikiLinks("_index.md", line).some((p) => visible.has(p))).join("\n");
  }
  const coreCard = () => {
    const card = state?.buildCoreProfileCard(key, active().current, today, {
      excludeScopes: excluded, rules: activeRules().map((r) => ({ ...r, docId: r.doc_id })),
    }) ?? "";
    return card.split("\n").filter((line) => !excluded.length ||
      (!line.startsWith("- **称谓与实体映射**") && visibleText(line.replace(/\[src:[^\]]+\]/g, "")))).join("\n") || null;
  };
  const hotMemories = () => (state?.listHotMemories(key, "active") ?? [])
    .filter((h) => !excluded.includes(h.scope) && visibleText(h.content) && visibleText(h.target_hint ?? ""))
    .map((h) => hotMemorySummarySchema.parse(h));
  return { snapshot, version, claims, index, paths, page, restricted, render, get rules() { return activeRules(); }, coreCard, hotMemories };
}

export class Synthesizer {
  constructor(
    private readonly repo: MetadataRepository, private readonly storage: WikiStorage,
    private readonly gateway: OpenAiGateway, private readonly navigator: Navigator,
    private readonly memoryState?: SQLiteMemoryStateStore, private readonly chatStore?: SQLiteChatStore,
  ) {}

  async retrieve(
    input: RetrieveInput,
    plan?: { queries?: string[]; needsInventory?: boolean; needsAuditHistory?: boolean; boostSafety?: boolean; excludeScopes?: PrivacyScope[] },
  ): Promise<RetrieveResult> {
    const started = Date.now();
    const excluded = [...new Set([...(plan?.excludeScopes ?? []), ...(input.privacy_mode === "external_safe" ? externalScopes : [])])];
    const boostSafety = Boolean(input.boost_safety || plan?.boostSafety || input.needs_inventory || plan?.needsInventory);
    const view = await wikiView(this.repo, this.storage, this.memoryState, input, input.snapshot_version, excluded,
      input.as_of_date, Boolean(input.include_rules || boostSafety));
    const { snapshot, version, claims, restricted: restrict, index, paths } = view;
    const key = spaceKey(input);
    const extras: Partial<RetrieveResult> = {};
    if (input.include_rules) extras.rules = view.rules;
    if (input.include_core_card) extras.core_card = view.coreCard();
    if (input.include_hot_memories) extras.hot_memories = view.hotMemories();
    if (input.include_pending_chats && this.chatStore && !excluded.length) {
      extras.pending_chat_hits = (await searchChatTurns(this.chatStore, this.memoryState, this.gateway,
        key, input.query, { limit: 16, prioritizePending: true }, true))
        .filter((h) => !input.as_of_date || h.session_date <= input.as_of_date);
    }
    const answerRequested = input.return_mode !== "context";
    const contextsRequested = input.return_mode !== "answer";
    if (!snapshot) {
      const answer = answerRequested ? noEvidence(input.query) : null;
      return {
        ...extras, snapshot_version: 0, strategy_used: input.retrieval_strategy ?? "fast", hops: 0,
        index_excerpt: null, contexts: [], answer, citations: [],
        usage: { selected_pages: 0, returned_tokens: countTokens(answer), latency_ms: Date.now() - started },
      };
    }
    const searchQueries = plan?.queries?.length ? plan.queries : [input.query];
    const needsInventory = input.needs_inventory || plan?.needsInventory;
    // A superseded value can be absent from both persisted indexes. Search the projected pages too.
    let historicalMatches: string[] | undefined;
    if (input.as_of_date) {
      const terms = new Set(searchQueries.flatMap(queryTerms));
      const scored = await Promise.all(paths.map(async (path) => {
        const { body } = await view.page(path);
        const words = new Set(indexText(body).match(/[\p{L}\p{N}]+/gu) ?? []);
        return { path, score: [...terms].filter((term) => words.has(term)).length };
      }));
      historicalMatches = scored.filter((p) => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map((p) => p.path);
    }
    const selection = await this.navigator.select(input, version, index, paths, {
      queries: searchQueries, needsInventory, needsAuditHistory: plan?.needsAuditHistory, historicalMatches,
    });
    const load = async ({ path, reason }: { path: string; reason: string }) => ({
      path, reason: view.render(reason), ...await view.page(path),
    });
    const sources = new SourceReader(this.repo, this.storage, input);
    const verify = !restrict && !input.as_of_date ? async (anchor: string) => {
      const [id, locator] = anchor.split("#");
      if (!snapshot.documents.includes(id)) return null;
      const source = await sources.lookup(id, locator);
      return truncateTokens(source.raw_excerpt ?? "", 256);
    } : undefined;
    const first = await Promise.all(selection.map(load));
    const { pages, hops, strategy } = input.retrieval_strategy && input.retrieval_strategy !== "fast"
      ? await this.navigator.expand(input, index, paths, first, load, verify, searchQueries, plan?.needsAuditHistory)
      : { pages: first, hops: 1, strategy: "fast" as const };
    const redlineAnchors = new Set<string>();
    if (boostSafety && claims.length) {
      const controls = this.memoryState?.listTelemetry(key);
      for (const claim of claims) {
        if (isFact(claim)) {
          const tel = factTelemetry(claim, controls);
          const downgraded = !tel?.pinned && tel?.tier_override != null && tel.tier_override !== "pinned_redline";
          const pinned = tel?.pinned ? true : downgraded ? false : Boolean(claim.pinned);
          const tier = pinned ? "pinned_redline" : (tel?.tier_override ?? claim.tier ?? inferFactTier({ ...claim, pinned }));
          if (tier === "pinned_redline" && !claim.archived && !tel?.archived_reason) {
            for (const a of claimAnchors(claim)) redlineAnchors.add(anchorKey(a));
          }
        } else if (isRule(claim) && !claim.archived && claim.priority === "redline") {
          for (const a of claimAnchors(claim)) redlineAnchors.add(anchorKey(a));
        }
      }
    }
    const tightBudget = answerRequested && input.max_tokens < 1000;
    const indexCap = input.return_mode === "answer" && tightBudget
      ? Math.floor(input.max_tokens / 12)
      : tightBudget ? Math.floor(input.max_tokens / 10) : Math.floor(input.max_tokens / 5);
    const indexExcerpt = input.include_index && (!restrict || input.privacy_mode === "external_safe") ? trimIndex(index, indexCap) : null;
    const afterIndex = input.max_tokens - countTokens(indexExcerpt);
    const rawReserve = input.verify_raw_sources && !restrict && !input.as_of_date
      ? Math.floor(afterIndex / (tightBudget ? 6 : 4))
      : 0;
    const afterRaw = afterIndex - rawReserve;
    const minAnswerFloor = answerRequested ? Math.min(Math.floor(afterRaw * 0.65), 240) : 0;
    const contextLimit = input.return_mode === "both"
      ? Math.max(64, Math.min(Math.floor(afterRaw * 0.62), afterRaw - minAnswerFloor))
      : contextsRequested || strategy !== "fast" ? afterRaw : Math.max(6000, afterRaw);
    let contextBudget = contextLimit;
    const slices: Omit<WikiContext, "citations">[] = [];
    for (const [i, page] of pages.entries()) {
      const share = Math.min(contextBudget, Math.max(64, Math.floor(contextBudget / (pages.length - i))));
      const excerpt = relevantMarkdown(page.body, searchQueries, share, boostSafety, redlineAnchors);
      if (!excerpt || !findAnchors(excerpt).length) continue;
      slices.push({ page_id: page.path, title: page.title, relevance_reason: page.reason, content: excerpt });
      contextBudget -= countTokens(excerpt);
    }

    let answer: string | null = null;
    if (answerRequested) {
      const answerBudget = contextsRequested ? Math.max(minAnswerFloor, afterRaw - contextLimit + contextBudget) : afterRaw;
      answer = await this.answer(input.query, slices, answerBudget);
    }
    const rawBudget = rawReserve ? { remaining: rawReserve } : null;
    const renderFilename = excluded.length ? view.render : undefined;
    const contexts: WikiContext[] = [];
    if (contextsRequested) {
      for (const page of slices) {
        contexts.push({ ...page, citations: await sources.citations(page.content, rawBudget, renderFilename) });
      }
    }
    const answerCitations = answer && (!contextsRequested || input.return_mode === "both")
      ? await sources.citations(answer, contextsRequested ? null : rawBudget, renderFilename) : [];
    const returnedTokens = countTokens(indexExcerpt) + countTokens(answer)
      + (contextsRequested ? contextLimit - contextBudget : 0) + rawReserve - (rawBudget?.remaining ?? 0);
    recordCitedFacts(this.memoryState, key, claims, [...answerCitations, ...contexts.flatMap((p) => p.citations)]);
    return {
      ...extras, strategy_used: strategy, hops, snapshot_version: version, index_excerpt: indexExcerpt, contexts, answer, citations: answerCitations,
      usage: { selected_pages: slices.length, returned_tokens: returnedTokens, latency_ms: Date.now() - started },
    };
  }

  private fitCitedAnswer(answer: string, budget: number) {
    if (countTokens(answer) <= budget) return answer;
    const blocks = answer.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const kept: string[] = [];
    let used = 0;
    for (const block of blocks) {
      const cost = countTokens(block) + (kept.length ? 2 : 0);
      if (used + cost <= budget) {
        kept.push(block);
        used += cost;
        continue;
      }
      if (!kept.length) {
        // Split a single long paragraph into cited sentences and keep as many whole sentences as fit.
        const sentences = block.match(/[^。！？.!?\n]+[。！？.!?]*(?:\s*\[src:[^\]]+\])*/g) ?? [block];
        const parts: string[] = [];
        for (const sentence of sentences) {
          const piece = sentence.trim();
          if (!piece) continue;
          const next = [...parts, piece].join(" ");
          if (countTokens(next) <= budget) parts.push(piece);
          else break;
        }
        if (parts.length && findAnchors(parts.join(" ")).length) {
          kept.push(parts.join(" "));
        }
      }
      break;
    }
    const fitted = kept.join("\n\n").trim();
    return fitted && findAnchors(fitted).length && countTokens(fitted) <= budget ? fitted : null;
  }

  private async answer(query: string, contexts: Omit<WikiContext, "citations">[], budget: number) {
    if (!contexts.length) return noEvidence(query);
    const available = new Set(contexts.flatMap(({ content }) => findAnchors(content).map((a) => a.anchor)));
    let lastValidOversize: string | null = null;
    const validateCitations = (answer: string, ctx: z.RefinementCtx) => {
      const anchors = findAnchors(answer);
      if (!anchors.length || anchors.length !== (answer.match(/\[src:/g) ?? []).length
        || anchors.some((tag) => !available.has(tag.anchor))) {
        ctx.addIssue({ code: "custom", message: "Every answer citation must occur verbatim in a supplied passage" });
        return false;
      }
      let missing = false;
      const ast = markdownAst(answer);
      const checkedTables = new Set<object>();
      walk(ast, (node) => {
        if (node.type === "table" && "children" in node && Array.isArray(node.children)) {
          checkedTables.add(node);
          // Skip row 0 (table column headers like "项目 | 负责人") and validate citations per body row.
          for (const row of node.children.slice(1)) {
            const raw = answer.slice(row.position?.start.offset, row.position?.end.offset);
            if (!findAnchors(raw).length && needsCitation(plainText(row).trim())) {
              missing = true;
              ctx.addIssue({ code: "custom", message: "Each factual table row must include a citation" });
            }
          }
          return;
        }
        if (node.type !== "paragraph") return;
        const raw = answer.slice(node.position?.start.offset, node.position?.end.offset);
        const isBoldOnly = "children" in node && Array.isArray(node.children)
          && node.children.length === 1 && node.children[0]?.type === "strong";
        const text = plainText(node).trim();
        if (!findAnchors(raw).length && needsCitation(text, isBoldOnly)) {
          missing = true;
          ctx.addIssue({ code: "custom", message: `Each factual paragraph or bullet must include a citation (missing in: "${text.slice(0, 48)}")` });
        }
      });
      void checkedTables;
      return !missing;
    };
    const schema = z.object({ answer: z.string().trim() }).superRefine(({ answer }, ctx) => {
      if (!answer) return;
      const citationsOk = validateCitations(answer, ctx);
      if (countTokens(answer) > budget) {
        if (citationsOk) lastValidOversize = answer;
        ctx.addIssue({
          code: "custom",
          message: `Answer is ${countTokens(answer)} tokens, exceeding max_answer_tokens (${budget}). Condense aggressively into concise cited bullet points.`,
        });
      }
    });
    const completionLimit = Math.min(32_768, Math.max(8192, budget * 2));
    try {
      const result = await this.gateway.structured("strong", prompts.synthesizer, {
        query, max_answer_tokens: budget,
        ...(budget < 450 ? { brevity_note: `Keep the entire answer strictly under ${budget} tokens using short, direct cited statements (no preamble).` } : {}),
        passages: contexts.map(({ title, content }) => ({ title, content })),
      }, schema, zeroUsage(), completionLimit);
      return result.answer || noEvidence(query);
    } catch (error) {
      if (lastValidOversize) {
        const fitted = this.fitCitedAnswer(lastValidOversize, budget);
        if (fitted) return fitted;
      }
      throw error;
    }
  }
}
