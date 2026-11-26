import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobResultSchema, retrieveResultSchema } from "@wiki-memory/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SQLiteChatStore } from "../apps/api/src/chat/chat-store.js";
import { readConfig } from "../apps/api/src/config.js";
import { zeroUsage } from "../apps/api/src/db/interfaces.js";
import { SQLiteConnection } from "../apps/api/src/db/sqlite-repo.js";
import { OpenAiGateway } from "../apps/api/src/llm/openai-gateway.js";
import { computeFactActivation, factStorageKey, SQLiteMemoryStateStore } from "../apps/api/src/memory/memory-state.js";
import type { AtomicFact, Claim } from "../apps/api/src/pipeline/analyzer.js";
import { lintDraft } from "../apps/api/src/pipeline/linter.js";
import { Organizer } from "../apps/api/src/pipeline/organizer.js";
import { compileWiki, reconcile } from "../apps/api/src/pipeline/wiki-compiler.js";
import type { memoryControlsView } from "../apps/api/src/routes/memory-controls.js";
import { createService } from "../apps/api/src/service.js";
import { startFixtureGateway } from "./fixtures/gateway.js";
import type { GatewayOptions } from "./fixtures/gateway.js";

const ref = { namespace: "personal", space_id: "kernel" };
const key = "personal:kernel";
const controlsBase = "/v1/memory/spaces/personal/kernel";
const purpose = "记录陈默的身份、偏好和项目进展";
const space = { ...ref, purpose, current_version: 0, incremental_since_dream: 0,
  last_dreamed_at: null, document_count: 0, page_count: 0 };
const today = "2026-11-25";
const now = `${today}T12:00:00.000Z`;
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
  }
});

async function tempDirectory() {
  const data = await mkdtemp(join(tmpdir(), "wiki-memory-v2-"));
  cleanup.push(() => rm(data, { recursive: true, force: true }));
  return data;
}

function openStores(data: string) {
  const connection = new SQLiteConnection(data);
  cleanup.push(() => connection.close());
  const state = new SQLiteMemoryStateStore(connection.client);
  return { state, chat: new SQLiteChatStore(connection.client, state) };
}

async function fixtureConfig(data: string, options: GatewayOptions) {
  const gateway = await startFixtureGateway(options);
  cleanup.push(gateway.close);
  return readConfig({
    DATA_DIR: data, LLM_BASE_URL: gateway.baseUrl, LLM_API_KEY: "fixture",
    PROACTIVE_ENABLED: "false", DREAM_POLL_MINUTES: "0", SYNC_WAIT_MS: "4000",
  });
}

async function setupService(options: GatewayOptions = {}) {
  const data = await tempDirectory();
  const service = createService(await fixtureConfig(data, options));
  cleanup.push(service.close);
  service.start();
  const { app } = service;

  async function request(path: string, method = "GET", payload?: unknown, status = 200) {
    const response = await app.request(path, { method, ...(payload === undefined ? {} : {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }) });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body;
  }
  async function ingest(filename: string, content: string) {
    const result = jobResultSchema.parse(await request("/v1/memories/ingest", "POST", {
      ...ref, purpose, mode: "sync", items: [{ filename, content, doc_date: today }],
    }));
    expect(result.status, result.error_message ?? "").toBe("published");
    return result;
  }
  async function snapshotClaims(version: number): Promise<Claim[]> {
    return JSON.parse(await readFile(join(data, "spaces", ref.namespace, ref.space_id, "snapshots", `v${version}`, "_claims.json"), "utf8"));
  }
  async function sessionPath() {
    const { session } = await request("/v1/chat/spaces/personal/kernel/sessions", "POST", { session_date: today }, 201);
    return `/v1/chat/sessions/${session.session_id}`;
  }
  const controls = (): Promise<ReturnType<typeof memoryControlsView>> => request(`${controlsBase}/controls`);
  await request("/v1/admin/spaces", "POST", { ...ref, purpose });
  return { request, ingest, snapshotClaims, sessionPath, controls, ...openStores(data) };
}

function fact(subject: string, value: string, overrides: Partial<AtomicFact> = {}): AtomicFact {
  return { kind: "entity", subject, predicate: "备注", value, docId: "doc_1", docDate: today,
    locator: "s1", cardinality: "one", related: [], ...overrides };
}

// Read only the answer generation call for this turn. The user history can repeat a hot instruction.
function observeSystemPrompt() {
  const spy = vi.spyOn(OpenAiGateway.prototype, "complete");
  return (userMessage: string) => {
    const calls = spy.mock.calls.filter(([tier, messages]) => tier === "strong"
      && messages.at(-1)?.role === "user" && messages.at(-1)?.content === userMessage);
    expect(calls).toHaveLength(1);
    const system = calls[0][1][0];
    expect(system.role).toBe("system");
    expect(typeof system.content).toBe("string");
    return String(system.content);
  };
}

describe("Memory Kernel V2", () => {
  it("reconciles a single-valued fact across aliases and preserves both sources in the supersession audit", async () => {
    const { state } = openStores(await tempDirectory());
    const subject = "林汐的母亲";
    for (const alias of ["外婆", "妈妈"]) state.registerAlias(key, "entity", subject, alias);
    const older = fact("外婆", "城东", { predicate: "常住地", docDate: "2026-10-01" });
    const newer = fact("妈妈", "城西", { predicate: "常住地", docId: "doc_2" });
    const options = { aliases: state.aliasLookupMap(key), aliasGroups: state.canonicalAliasGroups(key) };
    const claims = [newer, older];
    const { current, audit } = reconcile(claims, today, options);
    expect(current).toMatchObject([{ subject, value: "城西", docId: "doc_2" }]);
    expect(audit).toEqual([expect.stringMatching(/林汐的母亲.*城西.*doc_2#s1.*supersedes:.*城东.*doc_1#s1/)]);
    const draft = new Map<string, string>();
    compileWiki(draft, space, 1, ["doc_1", "doc_2"], [], claims, now, options);
    const entry = draft.get("_index.md")?.split("\n").find((line) => line.includes(`[${subject}]`));
    for (const term of ["别名：", "外婆", "妈妈"]) expect(entry).toContain(term);
    expect(draft.get("conflicts.md")).toContain(audit[0]);
  });

  it("runs the dreaming merge and alias tools, rewriting the ledger and its rendered links", async () => {
    const oldName = "北极星 3.0 项目组";
    const canonical = "北极星 3.0";
    const config = await fixtureConfig(await tempDirectory(), { organize: () => [
      { name: "merge_subjects", arguments: { kind: "topic", source_subjects: [oldName], target_subject: canonical, reason: "同一项目" } },
      { name: "register_alias", arguments: { kind: "topic", canonical_subject: "LightLog", alias: "拾光记" } },
      { name: "finish", arguments: { summary: "已核对项目名称与链接" } },
    ] });
    const claims: Claim[] = [
      fact(oldName, "推进联调", { kind: "topic" }),
      fact("LightLog", "依赖接口", { kind: "topic", locator: "s2", related: [{ kind: "topic", subject: oldName }] }),
    ];
    const draft = new Map<string, string>();
    const documents = ["doc_1"];
    const compiled = compileWiki(draft, space, 1, documents, [], claims, now);
    const context = { space, version: 1, documents, now, claims: compiled.claims, onRegisterAlias: vi.fn() };
    const report = await new Organizer(new OpenAiGateway(config)).organize({
      draft, purpose, dreaming: true, context, usage: zeroUsage(), linting: async () => {},
      evidence: compiled.evidence, required: compiled.required, indexHeader: compiled.indexHeader,
    });
    expect(context.onRegisterAlias.mock.calls).toEqual([["topic", canonical, oldName], ["topic", "LightLog", "拾光记"]]);
    const ledger = JSON.parse(draft.get("_claims.json")!);
    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: canonical, value: "推进联调" }),
      expect.objectContaining({ subject: "LightLog", related: [{ kind: "topic", subject: canonical }] }),
    ]));
    expect(ledger).toHaveLength(2);
    const page = [...draft].find(([path, body]) => path.startsWith("topics/") && body.includes("依赖接口"))?.[1];
    expect(page).toContain(`[${canonical}](`);
    expect(draft.get("_index.md")).toMatch(/\[LightLog\].*别名：拾光记/);
    expect(report.issues).toEqual([]);
    expect(lintDraft(draft, compiled.evidence).issues).toEqual([]);
  });

  it("decays by tier and reinforces a durable fact on distinct recalls", async () => {
    const { state } = openStores(await tempDirectory());
    const durable = fact("陈默", "靠窗", { docDate: "2025-01-01", tier: "durable" });
    const working = { ...durable, tier: "working" } as const;
    const pinned = { ...durable, tier: "pinned_redline" } as const;
    expect(computeFactActivation(pinned, undefined, "2026-05-16")).toEqual({ tier: "pinned_redline", score: 1, state: "pinned" });
    expect(computeFactActivation(working, undefined, durable.docDate).score).toBe(1);
    const after45 = "2025-02-15";
    expect(computeFactActivation(working, undefined, after45)).toMatchObject({ state: "cold" });
    const slow = computeFactActivation(durable, undefined, after45);
    expect(slow.state).toBe("fresh");
    expect(slow.score).toBeGreaterThan(0.8);
    expect(slow.score).toBeLessThan(1);

    const factKey = factStorageKey(durable);
    const at180 = "2025-06-30";
    const recalled = "2025-03-01T12:00:00.000Z";
    const baseline = computeFactActivation(durable, undefined, at180).score;
    expect(baseline).toBeCloseTo(0.5, 2);
    state.recordRecallByFacts(key, [factKey, factKey], recalled);
    const first = state.listTelemetry(key).get(factKey);
    expect(first).toMatchObject({ recall_count: 1, last_recalled_at: recalled });
    const reinforced = computeFactActivation(durable, first, at180).score;
    expect(reinforced).toBeGreaterThan(baseline);
    // Holding the recall date fixed isolates the count boost from the age reset.
    state.recordRecallByFacts(key, [factKey], recalled);
    const second = state.listTelemetry(key).get(factKey);
    expect(second?.recall_count).toBe(2);
    expect(computeFactActivation(durable, second, at180).score).toBeGreaterThan(reinforced);
  });

  it("renders aliases, pinned facts and active hot instructions with per-scope exclusions", async () => {
    const { state } = openStores(await tempDirectory());
    state.registerAlias(key, "entity", "陈默", "小默");
    const redlines = [
      fact("陈默", "青霉素严重过敏", { tier: "pinned_redline", scope: "private_health" }),
      fact("陈默", "每周五接孩子", { tier: "pinned_redline", scope: "family" }),
      fact("陈默", "绩效反馈仅限一对一", { tier: "pinned_redline", scope: "work_internal" }),
      fact("陈默", "发布前确认接口", { tier: "pinned_redline", scope: "work_shareable" }),
    ];
    const hot = (content: string, scope: AtomicFact["scope"]) => state.addHotMemory({ spaceKey: key, kind: "remember", content, scope });
    hot("叫我陈默", "general");
    hot("周末探亲", "family");
    state.updateHotMemoryStatus(key, hot("旧称呼", "general").id, "dismissed");
    const full = state.buildCoreProfileCard(key, redlines, today);
    expect(full).toContain("陈默（别名：小默）");
    for (const { value } of redlines) expect(full).toContain(value);
    expect(full).toContain("【即时记住】叫我陈默");
    expect(full).toContain("周末探亲");
    expect(full).not.toContain("旧称呼");
    const scoped = state.buildCoreProfileCard(key, redlines, today, { excludeScopes: ["private_health", "family", "work_internal"] });
    for (const text of ["青霉素严重过敏", "每周五接孩子", "绩效反馈仅限一对一", "周末探亲"]) expect(scoped).not.toContain(text);
    expect(scoped).toContain("发布前确认接口");
    expect(scoped).toContain("叫我陈默");
  });

  it("persists HTTP fact controls and moves a soft-archived fact into and back out of the audit", async () => {
    const { request, ingest, snapshotClaims, controls, state } = await setupService();
    const job = await ingest("seat.md", "我的高铁座位偏好是靠窗。");
    const ledger = await snapshotClaims(job.target_version!);
    const initial = await controls();
    expect(initial.facts).toMatchObject([{ subject: "差旅偏好", predicate: "高铁座位", value: "靠窗" }]);
    const { fact_key } = initial.facts[0];
    const reconcileControls = () => reconcile(ledger, today, { telemetry: state.listTelemetry(key) });
    const patch = (changes: object) => request(`${controlsBase}/facts`, "PATCH", { fact_key, ...changes });
    await patch({ pinned: true });
    await patch({ edited_value: "过道", scope_override: "work_shareable" });
    const edited = { fact_key, value: "过道", original_value: "靠窗", pinned: true, tier: "pinned_redline", scope: "work_shareable" };
    expect((await controls()).facts).toMatchObject([edited]);
    await patch({ archived_reason: "用户不再使用此偏好" });
    const archived = await controls();
    expect(archived.facts).toEqual([]);
    expect(archived.archived_facts).toMatchObject([{ ...edited, archived_reason: "用户不再使用此偏好" }]);
    expect(reconcileControls()).toMatchObject({
      current: [], audit: [expect.stringMatching(/用户归档.*用户不再使用此偏好.*过道/)],
    });
    await patch({ restore: true });
    const restored = await controls();
    expect(restored.archived_facts).toEqual([]);
    expect(restored.facts).toMatchObject([{ ...edited, archived_reason: null }]);
    expect(reconcileControls()).toMatchObject({ current: [{ subject: "差旅偏好", value: "过道" }], audit: [] });
  });

  it("lists registered aliases and hot memories and persists removal and dismissal through HTTP", async () => {
    const { request, controls } = await setupService();
    const alias = { kind: "entity", alias: "拾光记", canonical_subject: "LightLog" };
    await request(`${controlsBase}/aliases`, "POST", alias, 201);
    const { hot_memory } = await request(`${controlsBase}/hot`, "POST", { kind: "remember", content: "称呼我陈默" }, 201);
    const active = await controls();
    expect(active.aliases).toMatchObject([alias]);
    expect(active.hot_memories).toMatchObject([{ id: hot_memory.id, kind: "remember", content: "称呼我陈默", status: "active" }]);
    expect(active.core_profile_card).toContain("称呼我陈默");
    const query = new URLSearchParams({ kind: alias.kind, alias: alias.alias });
    expect(await request(`${controlsBase}/aliases?${query}`, "DELETE")).toMatchObject({ deleted: true });
    expect(await request(`${controlsBase}/hot/${hot_memory.id}`, "DELETE")).toMatchObject({ dismissed: true });
    const removed = await controls();
    expect(removed.aliases).toEqual([]);
    expect(removed.hot_memories).toMatchObject([{ id: hot_memory.id, status: "dismissed" }]);
    expect(removed.core_profile_card).not.toContain("称呼我陈默");
  });

  it("persists live remember and forget commands and injects each into the following turn before dreaming", async () => {
    const { request, sessionPath, state } = await setupService();
    const path = await sessionPath();
    const prompt = observeSystemPrompt();
    const send = (content: string) => request(`${path}/messages`, "POST", { content });
    const remember = "以后不要叫我陈总，直接叫我陈默";
    const first = await send(`记住：${remember}`);
    expect(first.hot_memory_action).toMatchObject({ session_id: first.session.session_id, kind: "remember", content: remember, status: "active" });
    expect(state.listHotMemories(key)).toContainEqual(first.hot_memory_action);
    const greeting = "今天怎么称呼我？";
    const next = await send(greeting);
    expect(next.session).toMatchObject({ status: "pending", dreamed_doc_id: null });
    expect(next.assistant_message.retrieval.snapshot_version).toBe(0);
    expect(prompt(greeting)).toContain(remember);

    const forget = "陈总这个旧称呼";
    const third = await send(`忘掉：${forget}`);
    expect(third.hot_memory_action).toMatchObject({ kind: "forget", content: forget, target_hint: forget });
    expect(state.listHotMemories(key)).toContainEqual(third.hot_memory_action);
    const followUp = "再打个招呼吧";
    await send(followUp);
    expect(prompt(followUp)).toContain(`忘掉/作废：${forget}`);
  });

  it("ranks the right pending turn first for lexical, alias and semantic queries", async () => {
    const { state, chat } = openStores(await tempDirectory());
    const cases = [
      { id: "pet", text: "芝麻昨天换了原味豆腐砂", query: "宠物厕所垫料", terms: [] },
      { id: "app", text: "拾光记年底发 TestFlight", query: "LightLog", terms: ["拾光", "光记"] },
      { id: "family", text: "外婆血压复查", query: "我妈复查", terms: ["复查"] },
    ];
    for (const { id, text } of cases) {
      chat.createSession({ sessionId: id, spaceKey: key, sessionDate: today, title: "记录" });
      chat.appendMessage({ sessionId: id, role: "user", content: text });
    }
    state.registerAlias(key, "entity", "拾光记", "LightLog");
    state.registerAlias(key, "entity", "外婆", "妈妈");
    for (const { id, text, query, terms } of [...cases, { ...cases[1], query: "TestFlight", terms: ["testflight"] }]) {
      const [hit] = chat.searchConversations(key, query, { limit: 1 });
      expect(hit, query).toMatchObject({ session_id: id, turn_locator: "t1", session_status: "pending",
        dreamed_doc_id: null, excerpt: expect.stringContaining(text) });
      expect(hit.matched_terms.toSorted(), query).toEqual(terms.toSorted());
    }
  });

  it("keeps shareable evidence on a mixed-scope page while removing private facts from the external draft", async () => {
    const facts = [
      { predicate: "用药", value: "青霉素严重过敏", scope: "private_health" },
      { predicate: "人员", value: "小赵绩效反馈仅限一对一", scope: "work_internal" },
      { predicate: "合作", value: "北极星 3.0 项目合作接口", scope: "work_shareable" },
    ] as const;
    const { request, ingest, controls, sessionPath } = await setupService({ extract: ({ segments }) => ({
      summary: "项目进展", facts: facts.map((item) => ({ ...item, kind: "topic", subject: "项目进展", locator: segments[0].locator })),
    }) });
    // All three facts share a page and source anchor. Dropping the whole page would lose public evidence.
    await ingest("progress.md", facts.map(({ value }) => value).join("。"));
    expect((await controls()).facts).toEqual(expect.arrayContaining(facts.map((item) => expect.objectContaining(item))));
    const path = await sessionPath();
    const internal = await request(`${path}/messages`, "POST", { content: "项目进展是什么？" });
    const full = retrieveResultSchema.parse(internal.assistant_message.retrieval);
    const fullText = full.contexts.map((ctx) => ctx.content).join("\n");
    for (const { value } of facts) expect(fullText).toContain(value);

    const prompt = observeSystemPrompt();
    const message = "帮我起草一封发给客户的对外邮件说明项目进展";
    const { assistant_message } = await request(`${path}/messages`, "POST", { content: message });
    const retrieval = retrieveResultSchema.parse(assistant_message.retrieval);
    expect(retrieval.contexts.map((ctx) => ctx.content).join("\n")).toContain(facts[2].value);
    const system = prompt(message);
    expect(system).toContain(facts[2].value);
    for (const { value } of facts.slice(0, 2)) {
      expect(system).not.toContain(value);
      expect(JSON.stringify(retrieval)).not.toContain(value);
    }
  });

  it("appends the attachment preview and receipt to the timeline and publishes the corresponding ingestion job", async () => {
    const { request, sessionPath } = await setupService();
    const path = await sessionPath();
    const filename = "接口说明.md";
    const content = "合作接口每周五更新。";
    const note = "请整理这份说明";
    const uploaded = await request(`${path}/attachments`, "POST", {
      filename, content_text: content, doc_date: today, note,
    }, 201);
    const { doc_id, job_id } = uploaded.attachment;
    expect(uploaded.attachment).toMatchObject({ filename, warnings: [], preview_chars: content.length });
    const timeline = await request(path);
    expect(timeline.session).toMatchObject({ status: "pending", message_count: 2 });
    expect(timeline.messages).toEqual([uploaded.user_message, uploaded.assistant_message]);
    const [user, assistant] = timeline.messages;
    expect(user.role).toBe("user");
    for (const text of [filename, note, content]) expect(user.content).toContain(text);
    expect(assistant).toMatchObject({ role: "assistant", content: expect.stringContaining(doc_id) });
    await vi.waitFor(async () => {
      const job = jobResultSchema.parse(await request(`/v1/memories/jobs/${job_id}`));
      expect(job, job.error_message ?? "").toMatchObject({ job_type: "ingest", status: "published",
        accepted_docs: [{ doc_id, filename, dedup_status: "new" }] });
    }, { timeout: 4000 });
  });
});
