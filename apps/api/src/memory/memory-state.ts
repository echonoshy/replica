import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { indexText } from "../db/tokenize.js";
import { claimAnchors, claimKey, isFact } from "../pipeline/analyzer.js";
import type { Claim, Fact, MemoryTier, PrivacyScope, Relation } from "../pipeline/analyzer.js";

export interface EntityAliasRecord {
  space_key: string;
  kind: Relation["kind"];
  canonical_subject: string;
  alias: string;
  created_at: string;
}

export interface FactTelemetryRecord {
  space_key: string;
  fact_key: string;
  tier_override: MemoryTier | null;
  scope_override: PrivacyScope | null;
  pinned: boolean;
  archived_reason: string | null;
  edited_value: string | null;
  recall_count: number;
  last_recalled_at: string | null;
  updated_at: string;
}

export interface HotMemoryRecord {
  id: string;
  space_key: string;
  session_id: string | null;
  kind: "remember" | "forget";
  content: string;
  target_hint: string | null;
  tier: MemoryTier;
  scope: PrivacyScope;
  status: "active" | "consumed" | "dismissed";
  created_at: string;
}

export interface EnrichedFactView {
  fact_key: string;
  kind: Relation["kind"];
  subject: string;
  predicate: string;
  value: string;
  original_value: string;
  doc_id: string;
  locator: string;
  doc_date: string;
  sources: string[];
  tier: MemoryTier;
  scope: PrivacyScope;
  pinned: boolean;
  archived: boolean;
  archived_reason: string | null;
  recall_count: number;
  last_recalled_at: string | null;
  activation_score: number;
  decay_state: "pinned" | "fresh" | "fading" | "cold";
  aliases: string[];
}

export interface SemanticTurnHit {
  session_id: string;
  turn_locator: string;
  similarity: number;
}

const PINNED_REDLINE_PATTERN = /过敏|急诊|医嘱|禁忌|红线|严禁|禁止|不得|不许|绝对不能|不能碰|不耐受|肾上腺素|应急金|底线|杠杆|小盘股|处方粮|高磷|痛风|高血压|等保|出境|公有云|家庭成员|身份|配偶|爱人|父母|父亲|母亲|儿子|女儿|孩子|宠物|allergy|medical|emergency|redline|prohibit|forbidden/i;
const WORKING_PATTERN = /待办|排期|筹备|本次|暂定|验收|更换|缴费|预约|复查|陪诊|评审|kickoff|测试|内测|灰度|出差|行程|预算|住宿|民宿|洗碗机|刹车片|物业费|账单|支出|报销|草稿|提纲|清单|todo|task|review|draft|trip/i;
const PRIVATE_HEALTH_PATTERN = /过敏|急诊|医嘱|药|医院|复查|体检|痛风|尿酸|血压|氨氯地平|颈椎|乳糖|青霉素|肾上腺素|白内障|肌酐|处方粮|高磷|发烧|布洛芬|健康|门诊|病/i;
const FAMILY_PATTERN = /爱人|老婆|妻子|丈夫|配偶|伴侣|父亲|母亲|爸|妈|祖父母|爷爷|奶奶|外公|外婆|父母|儿子|女儿|孩子|幼儿园|生日|家庭|家里|应急金|房贷|猫|狗|宠物/i;
const WORK_INTERNAL_PATTERN = /绩效|1on1|一对一|汇报|工资|薪资|报价底线|谈判底线|外包底线|预付款|尾款|定金|审计|合规|内部|保密|会议纪要|风险清单|SLA|P0|灰度|测试号/i;

// Generic synonym groups supplement lexical matching when embeddings are unavailable.
const SEMANTIC_CONCEPTS: Array<[string, RegExp]> = [
  ["pet_litter", /猫砂|豆腐砂|垫料|猫厕所|宠物厕所|猫砂盆|cat litter/],
  ["pet_cat", /宠物|猫|狗|兽医|宠粮|处方粮|喂食|pet care/],
  ["allergy_peanut", /食物过敏|过敏原|花生|坚果|配料表|误食|食物致敏|food allerg/],
  ["allergy_drug", /药物过敏|药物禁忌|过敏史|青霉素|阿莫西林|用药过敏|drug allerg/],
  ["diet_lactose", /乳糖|牛奶|乳制品|奶酪|无乳糖|燕麦奶|lactose/],
  ["coffee", /拿铁|美式|咖啡|浓缩咖啡|燕麦奶|coffee|latte/],
  ["diet_gout", /痛风|尿酸|嘌呤|动物内脏|海鲜|啤酒|gout|purine/],
  ["diet_dislikes", /忌口|不吃|不爱吃|饮食偏好|饮食禁忌/],
  ["finance_emergency", /应急金|应急储蓄|紧急备用金|备用金|周转金|应急资金|emergency fund/],
  ["finance_invest", /投资|杠杆|股票|加仓|定投|基金|期权|融资融券|investing|leverage/],
  ["work_report", /汇报|工作报告|进度报告|周报|月报|风险清单|工作总结|status report/],
  ["work_launch", /灰度|上线|发布|延期|交付|项目排期|里程碑/],
  ["travel_trip", /旅行|旅游|出游|差旅|行程|住宿|民宿|酒店|旅馆|travel|hotel/],
  ["family_mother", /父母|妈妈|母亲|我妈|外婆|外祖母|奶奶|祖母|mother/],
  ["family_father", /父母|爸爸|父亲|我爸|外公|外祖父|爷爷|祖父|father/],
  ["family_spouse", /爱人|老婆|妻子|老公|丈夫|配偶|伴侣|spouse/],
  ["family_child", /儿子|女儿|孩子|小孩|子女|幼儿|儿童|child/],
  ["schedule_car", /刹车片|修车|车辆保养|汽车维修|车检/],
  ["schedule_home", /家电|物业|水电|家居维护|家庭维修|报修|洗碗机|净水器|更换滤芯/],
];

const VECTOR_DIMS = 128;

export function factStorageKey(fact: Pick<Fact, "kind" | "subject" | "predicate" | "value">): string {
  const raw = `${fact.kind}:${claimKey(fact.subject)}:${claimKey(fact.predicate)}:${claimKey(fact.value)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 20);
}

export function factTelemetry(fact: Fact, telemetry?: Map<string, FactTelemetryRecord>) {
  if (!telemetry?.size) return undefined;
  return telemetry.get(factStorageKey(fact)) ?? fact.previous_fact_keys?.map((key) => telemetry.get(key)).find(Boolean);
}

export function inferFactTier(fact: Pick<Fact, "subject" | "predicate" | "value" | "cardinality" | "expires_on" | "pinned">): MemoryTier {
  if (fact.pinned) return "pinned_redline";
  const text = `${fact.subject} ${fact.predicate} ${fact.value}`;
  if (PINNED_REDLINE_PATTERN.test(text)) return "pinned_redline";
  if (fact.expires_on || WORKING_PATTERN.test(text)) return "working";
  return "durable";
}

export function inferFactScope(fact: Pick<Fact, "subject" | "predicate" | "value">): PrivacyScope {
  const text = `${fact.subject} ${fact.predicate} ${fact.value}`;
  if (PRIVATE_HEALTH_PATTERN.test(text)) return "private_health";
  if (WORK_INTERNAL_PATTERN.test(text)) return "work_internal";
  if (FAMILY_PATTERN.test(text)) return "family";
  if (/项目|产品|发布|架构|客户|外包|报销|出差|会议|合作|文档/.test(text)) return "work_shareable";
  return "general";
}

export function computeFactActivation(
  fact: Pick<Fact, "expires_on" | "tier" | "pinned" | "subject" | "predicate" | "value" | "cardinality"> & { docDate?: string },
  telemetry: FactTelemetryRecord | undefined,
  today: string,
): { tier: MemoryTier; score: number; state: "pinned" | "fresh" | "fading" | "cold" } {
  const tier: MemoryTier = telemetry?.pinned
    ? "pinned_redline"
    : telemetry?.tier_override ?? fact.tier ?? inferFactTier(fact);
  if (tier === "pinned_redline") {
    return { tier, score: 1, state: "pinned" };
  }
  const refDate = telemetry?.last_recalled_at?.slice(0, 10) ?? fact.docDate ?? today;
  const msToday = Date.parse(`${today}T12:00:00Z`);
  const msRef = Date.parse(`${refDate}T12:00:00Z`);
  const deltaDays = Number.isNaN(msToday) || Number.isNaN(msRef) ? 0 : Math.max(0, (msToday - msRef) / 86_400_000);
  // Ebbinghaus-style exponential decay with importance-stratified lambda:
  // durable: half-life ~180 days (lambda = 0.00385), working: half-life ~20 days (lambda = 0.0347).
  const lambda = tier === "working" ? 0.0347 : 0.00385;
  const baseDecay = Math.exp(-lambda * deltaDays);
  const recallCount = telemetry?.recall_count ?? 0;
  const recallBoost = Math.min(0.35, Math.log1p(recallCount) * 0.14);
  const score = Math.min(1, Math.round((baseDecay + recallBoost) * 1000) / 1000);
  const state = score >= 0.65 ? "fresh" : score >= 0.35 ? "fading" : "cold";
  return { tier, score, state };
}

function hashBucket(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % VECTOR_DIMS;
}

export function vectorizeSemanticText(text: string, aliasMap?: Map<string, string[]>): number[] {
  const lexVec = new Float64Array(VECTOR_DIMS);
  const semVec = new Float64Array(VECTOR_DIMS);
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = indexText(normalized).match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    if ([...token].length <= 1 && !/[a-z0-9]/i.test(token)) continue;
    lexVec[hashBucket(`t:${token}`)] += 1;
  }
  // Character trigrams capture fuzzy Chinese/English subword similarity.
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  for (let i = 0; i + 2 < compact.length && i < 1600; i++) {
    lexVec[hashBucket(`g:${compact.slice(i, i + 3)}`)] += 0.5;
  }
  // Concept clusters bridge cross-word paraphrases (e.g. 豆腐砂 <-> 猫厕所垫料).
  for (const [concept, pattern] of SEMANTIC_CONCEPTS) {
    if (pattern.test(normalized)) {
      semVec[hashBucket(`c:${concept}`)] += 1.0;
      semVec[hashBucket(`c2:${concept}`)] += 0.8;
    }
  }
  // Entity alias expansion puts canonical name and every registered alias in the same vector subspace.
  if (aliasMap) {
    for (const [canonical, aliases] of aliasMap) {
      const group = [canonical, ...aliases];
      if (group.some((term) => term.length >= 2 && normalized.includes(term.toLowerCase()))) {
        semVec[hashBucket(`a:${claimKey(canonical)}`)] += 1.2;
      }
    }
  }
  // Separately L2-normalize lexical and concept/alias subspaces so long 600-char replies
  // never dilute concept matches against short 6-char user queries.
  let lexNorm = 0;
  let semNorm = 0;
  for (let i = 0; i < VECTOR_DIMS; i++) {
    lexNorm += lexVec[i] * lexVec[i];
    semNorm += semVec[i] * semVec[i];
  }
  const lexDenom = Math.sqrt(lexNorm) || 1;
  const semDenom = Math.sqrt(semNorm) || 1;
  const vec = new Float64Array(VECTOR_DIMS);
  for (let i = 0; i < VECTOR_DIMS; i++) {
    vec[i] = (lexNorm > 0 ? (lexVec[i] / lexDenom) * 0.65 : 0)
      + (semNorm > 0 ? (semVec[i] / semDenom) * 0.76 : 0);
  }
  let norm = 0;
  for (let i = 0; i < VECTOR_DIMS; i++) norm += vec[i] * vec[i];
  const denom = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => Math.round((v / denom) * 10_000) / 10_000);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return NaN;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function rankVectors<T extends { vector_json: string }>(rows: T[], query: number[], limit: number, minSimilarity: number) {
  const hits: Array<Omit<T, "vector_json"> & { similarity: number }> = [];
  let compatible = false;
  for (const { vector_json, ...id } of rows) {
    try {
      const vector: unknown = JSON.parse(vector_json);
      if (!Array.isArray(vector) || vector.length !== query.length || !vector.every(Number.isFinite)) continue;
      compatible = true;
      const similarity = cosineSimilarity(query, vector);
      if (similarity >= minSimilarity) hits.push({ ...id, similarity });
    } catch { /* Skip unreadable vectors. */ }
  }
  return { compatible, hits: hits.sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(0, limit)) };
}

export class SQLiteMemoryStateStore {
  constructor(private readonly client: Database.Database) {
    this.client.transaction(() => {
      this.client.exec(`
        CREATE TABLE IF NOT EXISTS entity_aliases (
          space_key TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'entity',
          canonical_subject TEXT NOT NULL,
          alias TEXT NOT NULL,
          alias_norm TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (space_key, kind, alias_norm)
        );
        CREATE INDEX IF NOT EXISTS idx_entity_aliases_space ON entity_aliases(space_key, canonical_subject);

        CREATE TABLE IF NOT EXISTS fact_telemetry (
          space_key TEXT NOT NULL,
          fact_key TEXT NOT NULL,
          tier_override TEXT,
          scope_override TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          archived_reason TEXT,
          edited_value TEXT,
          recall_count INTEGER NOT NULL DEFAULT 0,
          last_recalled_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_key, fact_key)
        );
        CREATE INDEX IF NOT EXISTS idx_fact_telemetry_space ON fact_telemetry(space_key);

        CREATE TABLE IF NOT EXISTS hot_memories (
          id TEXT PRIMARY KEY,
          space_key TEXT NOT NULL,
          session_id TEXT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          target_hint TEXT,
          tier TEXT NOT NULL DEFAULT 'durable',
          scope TEXT NOT NULL DEFAULT 'general',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hot_memories_space ON hot_memories(space_key, status, created_at DESC);

        CREATE TABLE IF NOT EXISTS chat_turn_vectors (
          space_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_locator TEXT NOT NULL,
          vector_json TEXT NOT NULL,
          is_dense INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_key, session_id, turn_locator)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_turn_vectors_space ON chat_turn_vectors(space_key);

        CREATE TABLE IF NOT EXISTS wiki_page_vectors (
          space_key TEXT NOT NULL,
          version INTEGER NOT NULL,
          page_id TEXT NOT NULL,
          vector_json TEXT NOT NULL,
          is_dense INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (space_key, version, page_id)
        );
        CREATE INDEX IF NOT EXISTS idx_wiki_page_vectors_space_version ON wiki_page_vectors(space_key, version);
      `);
      const columns = this.client.pragma("table_info(chat_turn_vectors)") as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === "is_dense")) {
        this.client.exec("ALTER TABLE chat_turn_vectors ADD COLUMN is_dense INTEGER NOT NULL DEFAULT 0");
      }
    }).immediate();
  }

  // --- Entity Aliases ---
  registerAlias(spaceKey: string, kind: Relation["kind"], canonicalSubject: string, alias: string): EntityAliasRecord | null {
    const cleanCanonical = canonicalSubject.trim();
    const cleanAlias = alias.trim();
    if (!cleanCanonical || !cleanAlias) return null;
    if (claimKey(cleanCanonical) === claimKey(cleanAlias)) return null;
    const now = new Date().toISOString();
    const aliasNorm = claimKey(cleanAlias);
    this.client.prepare(`
      INSERT INTO entity_aliases (space_key, kind, canonical_subject, alias, alias_norm, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_key, kind, alias_norm) DO UPDATE SET
        canonical_subject = excluded.canonical_subject,
        alias = excluded.alias,
        created_at = excluded.created_at
    `).run(spaceKey, kind, cleanCanonical, cleanAlias, aliasNorm, now);
    // Point any transitive aliases that previously targeted the old alias to the new canonical subject.
    this.client.prepare(`
      UPDATE entity_aliases
      SET canonical_subject = ?
      WHERE space_key = ? AND kind = ? AND lower(trim(canonical_subject)) = ?
    `).run(cleanCanonical, spaceKey, kind, aliasNorm);
    return { space_key: spaceKey, kind, canonical_subject: cleanCanonical, alias: cleanAlias, created_at: now };
  }

  removeAlias(spaceKey: string, kind: Relation["kind"], alias: string): boolean {
    const res = this.client.prepare(`
      DELETE FROM entity_aliases WHERE space_key = ? AND kind = ? AND alias_norm = ?
    `).run(spaceKey, kind, claimKey(alias));
    return res.changes > 0;
  }

  listAliases(spaceKey: string): EntityAliasRecord[] {
    return this.client.prepare(`
      SELECT space_key, kind, canonical_subject, alias, created_at
      FROM entity_aliases
      WHERE space_key = ?
      ORDER BY canonical_subject ASC, alias ASC
    `).all(spaceKey) as EntityAliasRecord[];
  }

  aliasLookupMap(spaceKey: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of this.listAliases(spaceKey)) {
      map.set(`${row.kind}:${claimKey(row.alias)}`, row.canonical_subject);
    }
    return map;
  }

  canonicalAliasGroups(spaceKey: string): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const row of this.listAliases(spaceKey)) {
      const list = groups.get(row.canonical_subject) ?? [];
      if (!list.includes(row.alias)) list.push(row.alias);
      groups.set(row.canonical_subject, list);
    }
    return groups;
  }

  resolveCanonical(spaceKey: string, kind: Relation["kind"], subject: string): string {
    const lookup = this.aliasLookupMap(spaceKey);
    return lookup.get(`${kind}:${claimKey(subject)}`) ?? subject;
  }

  expandQueryWithAliases(spaceKey: string, query: string): string {
    const groups = this.canonicalAliasGroups(spaceKey);
    if (!groups.size) return query;
    const normQuery = query.normalize("NFKC").toLowerCase();
    const extras: string[] = [];
    for (const [canonical, aliases] of groups) {
      const allTerms = [canonical, ...aliases];
      const matched = allTerms.some((t) => t.length >= 2 && normQuery.includes(t.normalize("NFKC").toLowerCase()));
      if (matched) {
        for (const term of allTerms) {
          if (!normQuery.includes(term.normalize("NFKC").toLowerCase())) extras.push(term);
        }
      }
    }
    return extras.length ? `${query} ${[...new Set(extras)].slice(0, 8).join(" ")}` : query;
  }

  // --- Fact Telemetry, Decay & User Controls ---
  listTelemetry(spaceKey: string): Map<string, FactTelemetryRecord> {
    const rows = this.client.prepare(`
      SELECT * FROM fact_telemetry WHERE space_key = ?
    `).all(spaceKey) as Array<{
      space_key: string; fact_key: string; tier_override: MemoryTier | null; scope_override: PrivacyScope | null;
      pinned: number; archived_reason: string | null; edited_value: string | null;
      recall_count: number; last_recalled_at: string | null; updated_at: string;
    }>;
    const map = new Map<string, FactTelemetryRecord>();
    for (const r of rows) {
      map.set(r.fact_key, { ...r, pinned: Boolean(r.pinned) });
    }
    return map;
  }

  upsertFactControl(
    spaceKey: string,
    factKey: string,
    patch: {
      tier_override?: MemoryTier | null;
      scope_override?: PrivacyScope | null;
      pinned?: boolean;
      archived_reason?: string | null;
      edited_value?: string | null;
    },
  ): FactTelemetryRecord {
    const existing = this.listTelemetry(spaceKey).get(factKey);
    const now = new Date().toISOString();
    const next: FactTelemetryRecord = {
      space_key: spaceKey,
      fact_key: factKey,
      tier_override: patch.tier_override !== undefined ? patch.tier_override : (existing?.tier_override ?? null),
      scope_override: patch.scope_override !== undefined ? patch.scope_override : (existing?.scope_override ?? null),
      pinned: patch.pinned !== undefined ? patch.pinned : (existing?.pinned ?? false),
      archived_reason: patch.archived_reason !== undefined ? patch.archived_reason : (existing?.archived_reason ?? null),
      edited_value: patch.edited_value !== undefined ? patch.edited_value : (existing?.edited_value ?? null),
      recall_count: existing?.recall_count ?? 0,
      last_recalled_at: existing?.last_recalled_at ?? null,
      updated_at: now,
    };
    this.client.prepare(`
      INSERT INTO fact_telemetry (
        space_key, fact_key, tier_override, scope_override, pinned,
        archived_reason, edited_value, recall_count, last_recalled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_key, fact_key) DO UPDATE SET
        tier_override = excluded.tier_override,
        scope_override = excluded.scope_override,
        pinned = excluded.pinned,
        archived_reason = excluded.archived_reason,
        edited_value = excluded.edited_value,
        updated_at = excluded.updated_at
    `).run(
      next.space_key, next.fact_key, next.tier_override, next.scope_override,
      next.pinned ? 1 : 0, next.archived_reason, next.edited_value,
      next.recall_count, next.last_recalled_at, next.updated_at,
    );
    return next;
  }

  recordRecallByFacts(spaceKey: string, factKeys: string[], now = new Date().toISOString()): void {
    const unique = [...new Set(factKeys)].filter(Boolean);
    if (!unique.length) return;
    const stmt = this.client.prepare(`
      INSERT INTO fact_telemetry (
        space_key, fact_key, pinned, recall_count, last_recalled_at, updated_at
      ) VALUES (?, ?, 0, 1, ?, ?)
      ON CONFLICT(space_key, fact_key) DO UPDATE SET
        recall_count = fact_telemetry.recall_count + 1,
        last_recalled_at = excluded.last_recalled_at,
        updated_at = excluded.updated_at
    `);
    this.client.transaction(() => {
      for (const key of unique) stmt.run(spaceKey, key, now, now);
    }).immediate();
  }

  // --- Hot Memories (Instant online remember / forget) ---
  addHotMemory(input: {
    spaceKey: string;
    sessionId?: string | null;
    kind: "remember" | "forget";
    content: string;
    targetHint?: string | null;
    tier?: MemoryTier;
    scope?: PrivacyScope;
  }): HotMemoryRecord {
    const id = `hot_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const record: HotMemoryRecord = {
      id,
      space_key: input.spaceKey,
      session_id: input.sessionId ?? null,
      kind: input.kind,
      content: input.content.trim(),
      target_hint: input.targetHint?.trim() || null,
      tier: input.tier ?? (PINNED_REDLINE_PATTERN.test(input.content) ? "pinned_redline" : "durable"),
      scope: input.scope ?? inferFactScope({ subject: "", predicate: "", value: input.content }),
      status: "active",
      created_at: now,
    };
    this.client.prepare(`
      INSERT INTO hot_memories (id, space_key, session_id, kind, content, target_hint, tier, scope, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.space_key, record.session_id, record.kind, record.content,
      record.target_hint, record.tier, record.scope, record.status, record.created_at,
    );
    return record;
  }

  listHotMemories(spaceKey: string, status: HotMemoryRecord["status"] | "all" = "active"): HotMemoryRecord[] {
    if (status === "all") {
      return this.client.prepare(`
        SELECT * FROM hot_memories WHERE space_key = ? ORDER BY created_at DESC LIMIT 100
      `).all(spaceKey) as HotMemoryRecord[];
    }
    return this.client.prepare(`
      SELECT * FROM hot_memories WHERE space_key = ? AND status = ? ORDER BY created_at DESC LIMIT 50
    `).all(spaceKey, status) as HotMemoryRecord[];
  }

  updateHotMemoryStatus(spaceKey: string, id: string, status: HotMemoryRecord["status"]): boolean {
    const res = this.client.prepare(`
      UPDATE hot_memories SET status = ? WHERE space_key = ? AND id = ?
    `).run(status, spaceKey, id);
    return res.changes > 0;
  }

  markSessionHotMemoriesConsumed(spaceKey: string, sessionIds: string[]): void {
    if (!sessionIds.length) return;
    const placeholders = sessionIds.map(() => "?").join(",");
    this.client.prepare(`
      UPDATE hot_memories SET status = 'consumed'
      WHERE space_key = ? AND status = 'active' AND session_id IN (${placeholders})
    `).run(spaceKey, ...sessionIds);
  }

  markHotMemoriesConsumedByIds(spaceKey: string, ids: string[]): number {
    if (!ids.length) return 0;
    return this.client.prepare(`
      UPDATE hot_memories SET status = 'consumed'
      WHERE space_key = ? AND status = 'active' AND id IN (SELECT value FROM json_each(?))
    `).run(spaceKey, JSON.stringify(ids)).changes;
  }

  upsertTurnVector(spaceKey: string, sessionId: string, turnLocator: string, text: string): void {
    this.writeTurnVector(spaceKey, sessionId, turnLocator, vectorizeSemanticText(text, this.canonicalAliasGroups(spaceKey)), false);
  }

  upsertTurnDenseVector(spaceKey: string, sessionId: string, turnLocator: string, vector: number[]): void {
    this.writeTurnVector(spaceKey, sessionId, turnLocator, vector, true);
  }

  private writeTurnVector(spaceKey: string, sessionId: string, turnLocator: string, vector: number[], isDense: boolean): void {
    this.client.prepare(`
      INSERT INTO chat_turn_vectors (space_key, session_id, turn_locator, vector_json, is_dense, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_key, session_id, turn_locator) DO UPDATE SET
        vector_json = excluded.vector_json,
        is_dense = excluded.is_dense,
        updated_at = excluded.updated_at
    `).run(spaceKey, sessionId, turnLocator, JSON.stringify(vector), Number(isDense), new Date().toISOString());
  }

  deleteSessionVectors(sessionId: string): void {
    this.client.prepare("DELETE FROM chat_turn_vectors WHERE session_id = ?").run(sessionId);
  }

  semanticSearchTurns(spaceKey: string, query: string, opts?: {
    excludeSessionId?: string; limit?: number; minSimilarity?: number; queryVector?: number[];
  }): SemanticTurnHit[] {
    const { excludeSessionId = null, limit = 16, minSimilarity = 0.16, queryVector } = opts ?? {};
    const select = this.client.prepare(`
      SELECT session_id, turn_locator, vector_json
      FROM chat_turn_vectors
      WHERE space_key = ? AND is_dense = ? AND (? IS NULL OR session_id <> ?)
    `);
    const rowsFor = (dense: boolean) => select.all(spaceKey, Number(dense), excludeSessionId, excludeSessionId) as Array<{
      session_id: string; turn_locator: string; vector_json: string;
    }>;
    if (queryVector?.length) {
      const dense = rankVectors(rowsFor(true), queryVector, limit, minSimilarity);
      if (dense.compatible) return dense.hits;
    }
    const local = vectorizeSemanticText(query, this.canonicalAliasGroups(spaceKey));
    return rankVectors(rowsFor(false), local, limit, minSimilarity).hits;
  }

  upsertWikiPageVector(spaceKey: string, version: number, pageId: string, textOrVector: string | number[], isDense = true): void {
    const localText = typeof textOrVector === "string";
    const vector = localText ? vectorizeSemanticText(textOrVector, this.canonicalAliasGroups(spaceKey)) : textOrVector;
    this.client.prepare(`
      INSERT INTO wiki_page_vectors (space_key, version, page_id, vector_json, is_dense, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(space_key, version, page_id) DO UPDATE SET
        vector_json = excluded.vector_json, is_dense = excluded.is_dense, updated_at = excluded.updated_at
    `).run(spaceKey, version, pageId, JSON.stringify(vector), Number(!localText && isDense), new Date().toISOString());
  }

  semanticSearchWikiPages(spaceKey: string, version: number, queryOrVector: string | number[], opts?: {
    limit?: number; minSimilarity?: number; excludeAudit?: boolean;
  }): Array<{ page_id: string; similarity: number }> {
    const { limit = 16, minSimilarity = 0.16, excludeAudit = true } = opts ?? {};
    const localText = typeof queryOrVector === "string";
    const query = localText ? vectorizeSemanticText(queryOrVector, this.canonicalAliasGroups(spaceKey)) : queryOrVector;
    const rows = this.client.prepare(`
      SELECT page_id, vector_json FROM wiki_page_vectors
      WHERE space_key = ? AND version = ? AND is_dense = ? AND (? = 0 OR page_id <> 'conflicts.md')
    `).all(spaceKey, version, Number(!localText), Number(excludeAudit)) as Array<{ page_id: string; vector_json: string }>;
    return rankVectors(rows, query, limit, minSimilarity).hits;
  }

  // --- Enriched Fact Views & Core Profile Card ---
  enrichFacts(spaceKey: string, claims: Claim[], today = new Date().toISOString().slice(0, 10)): EnrichedFactView[] {
    const telemetryMap = this.listTelemetry(spaceKey);
    const aliasGroups = this.canonicalAliasGroups(spaceKey);
    const views: EnrichedFactView[] = [];
    for (const claim of claims) {
      if (!isFact(claim)) continue;
      const tel = factTelemetry(claim, telemetryMap);
      const { tier, score, state } = computeFactActivation(claim, tel, today);
      const scope = tel?.scope_override ?? claim.scope ?? inferFactScope(claim);
      const archivedReason = tel?.archived_reason ?? claim.archived?.reason ?? null;
      views.push({
        fact_key: tel?.fact_key ?? factStorageKey(claim),
        kind: claim.kind,
        subject: claim.subject,
        predicate: claim.predicate,
        value: tel?.edited_value ?? claim.value,
        original_value: claim.value,
        doc_id: claim.docId,
        locator: claim.locator,
        doc_date: claim.docDate,
        sources: claimAnchors(claim).map((a) => `${a.docId}#${a.locator}`),
        tier,
        scope,
        pinned: Boolean(tel?.pinned || claim.pinned),
        archived: Boolean(archivedReason),
        archived_reason: archivedReason,
        recall_count: tel?.recall_count ?? 0,
        last_recalled_at: tel?.last_recalled_at ?? null,
        activation_score: score,
        decay_state: state,
        aliases: aliasGroups.get(claim.subject) ?? [],
      });
    }
    return views;
  }

  buildCoreProfileCard(
    spaceKey: string,
    activeFacts: Claim[],
    today = new Date().toISOString().slice(0, 10),
    opts?: {
      excludeScopes?: PrivacyScope[];
      rules?: Array<{ trigger_context: string; instruction: string; priority: string; scope?: PrivacyScope; docId?: string; locator?: string }>;
    },
  ): string {
    const excluded = new Set(opts?.excludeScopes ?? []);
    const enriched = this.enrichFacts(spaceKey, activeFacts, today)
      .filter((f) => !f.archived && !excluded.has(f.scope));
    const aliases = this.canonicalAliasGroups(spaceKey);
    const redlines = enriched
      .filter((f) => f.tier === "pinned_redline")
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.recall_count - a.recall_count)
      .slice(0, 14);
    const hotRemember = this.listHotMemories(spaceKey, "active")
      .filter((h) => !excluded.has(h.scope));

    const lines: string[] = [];
    if (aliases.size) {
      const aliasLines = [...aliases.entries()]
        .slice(0, 10)
        .map(([canonical, list]) => `${canonical}（别名：${list.join(" / ")}）`);
      lines.push(`- **称谓与实体映射**：${aliasLines.join("；")}`);
    }
    for (const item of redlines) {
      const src = item.sources[0] ? ` [src:${item.sources[0]}]` : "";
      lines.push(`- **${item.subject} · ${item.predicate}**：${item.value.slice(0, 140)}${src}`);
    }
    for (const hot of hotRemember.slice(0, 6)) {
      const prefix = hot.kind === "forget" ? "【即时忘掉/作废】" : "【即时记住】";
      lines.push(`- ${prefix}${hot.content.slice(0, 140)}`);
    }
    const rules = opts?.rules?.filter((rule) => {
      if (rule.priority !== "redline" && rule.priority !== "high") return false;
      const scope = rule.scope ?? inferFactScope({ subject: rule.trigger_context, predicate: "", value: rule.instruction });
      return !excluded.has(scope);
    });
    if (rules?.length) {
      lines.push("**行为准则**");
      for (const rule of rules) {
        const src = rule.docId && rule.locator ? ` [src:${rule.docId}#${rule.locator}]` : "";
        lines.push(`- ${rule.trigger_context}：${rule.instruction}${src}`);
      }
    }
    return lines.join("\n");
  }

  deleteSpaceState(spaceKey: string): void {
    this.client.transaction(() => {
      for (const table of ["entity_aliases", "fact_telemetry", "hot_memories", "chat_turn_vectors", "wiki_page_vectors"]) {
        this.client.prepare(`DELETE FROM ${table} WHERE space_key = ?`).run(spaceKey);
      }
    }).immediate();
  }
}
