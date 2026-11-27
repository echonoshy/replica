import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactResultSchema, hotMemorySummarySchema, jobResultSchema, retrieveResultSchema, sourceResultSchema,
  toolIndexResultSchema, toolPageResultSchema, toolSearchResultSchema, treeResultSchema,
} from "@wiki-memory/shared";
import type { CompactMessage } from "@wiki-memory/shared";
import { atlasDataset } from "../apps/api/scripts/datasets/atlas-platform.js";
import { salesDataset } from "../apps/api/scripts/datasets/enterprise-q4.js";
import { zhouRanDataset } from "../apps/api/scripts/datasets/zhou-ran.js";
import type { Dataset } from "../apps/api/scripts/realistic-datasets.js";
import { readConfig } from "../apps/api/src/config.js";
import { SQLiteConnection } from "../apps/api/src/db/sqlite-repo.js";
import { PENDING_DEMO_CHATS, PERSONAL_DEMO_DAYS } from "../apps/api/src/demo/scenarios.js";
import { OpenAiGateway } from "../apps/api/src/llm/openai-gateway.js";
import { inferFactScope, inferFactTier, cosineSimilarity, vectorizeSemanticText } from "../apps/api/src/memory/memory-state.js";
import { classifyFactsWithLlm } from "../apps/api/src/pipeline/fact-classifier.js";
import { readPage } from "../apps/api/src/pipeline/wiki-markdown.js";
import { ChatRouter } from "../apps/api/src/retrieval/chat-router.js";
import { countTokens, relevantMarkdown } from "../apps/api/src/retrieval/token-budget.js";
import type { memoryControlsView } from "../apps/api/src/routes/memory-controls.js";
import { createService } from "../apps/api/src/service.js";
import { startFixtureGateway, type GatewayOptions } from "./fixtures/gateway.js";

const ref = { namespace: "integration", space_id: "v3" };
const controlsPath = "/v1/memory/spaces/integration/v3";
const admin = "/v1/admin/spaces/integration/v3";
const tools = "/v1/memories/tools";
const purpose = "Keep sourced project decisions and instructions";
const finish = { name: "finish", arguments: { summary: "Reviewed evidence" } };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(options: GatewayOptions = {}, embeddings = false) {
  const dir = await mkdtemp(join(tmpdir(), "memory-v3-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const fixture = await startFixtureGateway(options);
  cleanup.push(fixture.close);
  const config = readConfig({
    DATA_DIR: dir, LLM_BASE_URL: fixture.baseUrl, LLM_API_KEY: "fixture",
    LLM_EMBEDDING_MODEL: embeddings ? "fixture-vector" : undefined,
    SYNC_WAIT_MS: "8000", DREAM_POLL_MINUTES: "0", PROACTIVE_ENABLED: "false",
  });
  const service = createService(config);
  cleanup.push(service.close);
  service.start();

  async function request(path: string, body?: object, status = 200, method?: string) {
    const response = await service.app.request(path, body ? {
      method: method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : method ? { method } : undefined);
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  }
  const ingest = async (content: string, mode: "skip" | "full" = "skip", filename = "project.md") => {
    const result = jobResultSchema.parse(await request("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync", organize_mode: mode, items: [{ filename, content, doc_date: "2020-01-01" }],
    }));
    expect(result.status, result.error_message ?? "").toBe("published");
    return result;
  };
  const dream = async (expected = "published") => {
    const queued = jobResultSchema.parse(await request("/v1/memories/dream", { ...ref, mode: "consolidate" }, 202));
    return vi.waitFor(async () => {
      const job = jobResultSchema.parse(await request("/v1/memories/jobs/" + queued.job_id));
      expect(job.status, job.error_message ?? "").toBe(expected);
      return job;
    }, { timeout: 8000 });
  };
  const getTool = (name: string, params: Record<string, string> = {}) =>
    request(tools + "/" + name + "?" + new URLSearchParams({ ...ref, ...params }));
  const page = async (path: string) => toolPageResultSchema.parse(await getTool("page", { path }));
  const tree = async () => treeResultSchema.parse(await request(admin + "/tree"));
  const controls = (): Promise<ReturnType<typeof memoryControlsView>> => request(controlsPath + "/controls");
  const retrieve = async (query: string, flags: object = {}) =>
    retrieveResultSchema.parse(await request("/v1/memories/retrieve", { ...ref, query, ...flags }));
  const chat = async (content: string) => {
    const { session } = await request("/v1/chat/spaces/integration/v3/sessions", {}, 201);
    return request("/v1/chat/sessions/" + session.session_id + "/messages", { content });
  };
  return { dir, config, fixture, request, ingest, dream, getTool, page, tree, controls, retrieve, chat };
}

const dispatch = { kind: "topic", subject: "Dispatch" };
const keeper = { kind: "entity", subject: "Harbor keeper" };
const graph: GatewayOptions["extract"] = ({ segments: [first, second] }) => ({
  summary: "Dispatch and custody",
  facts: [
    { ...dispatch, predicate: "Signal", value: first.text, locator: first.locator, related: [keeper] },
    { ...keeper, predicate: "Locker", value: second.text, locator: second.locator },
  ],
});
const graphDocument = "beaconquartz\n\nCopper cabinet seventeen";
const graphPaths = (titles: Record<string, string>) => {
  const pathFor = (title: string) => {
    const found = Object.keys(titles).find((path) => titles[path] === title);
    if (!found) throw new Error("Missing Wiki page for " + title);
    return found;
  };
  return { dispatchPath: pathFor(dispatch.subject), keeperPath: pathFor(keeper.subject) };
};

describe("Memory v3 publication and retrieval", () => {
  it("verifies raw neighbors before correcting a claim and clears stale and older tool results", async () => {
    const address = { ...dispatch, predicate: "Destination" };
    const raw = "Signed manifest gives the destination as Harbor East.";
    const previous = "Opening line of manifest.";
    const next = "Closing line of manifest.";
    const s = await setup({ extract: ({ segments }) => ({
      summary: "Manifest", facts: [{ ...address, value: "Harbor West", locator: segments[1].locator }],
    }) });
    const { accepted_docs: [doc] } = await s.ingest([previous, raw, next].join("\n\n"));
    const path = (await s.tree()).files.find((p) => p.startsWith("topics/"))!;
    const source = { doc_id: doc.doc_id, locator: "s2" };
    const anchor = doc.doc_id + "#s2";
    const transcripts: Array<Array<{ tool_call_id?: string; content?: string }>> = [];
    s.fixture.options.organize = ({ messages }) => {
      const turn = transcripts.push(messages.filter((m) => m.role === "tool")) - 1;
      if (turn === 0) return [
        { name: "read_page", arguments: { page_path: path } }, { name: "read_source", arguments: source },
      ];
      if (turn === 1) return [{ name: "correct_claim", arguments: {
        ...address, ...source, old_value: "Harbor West", new_value: "Harbor East", reason: "Checked signed manifest",
      } }];
      return turn < 6 ? [{ name: "list_pages", arguments: {} }] : [finish];
    };
    await s.dream();
    const [oldPage, rawSource] = transcripts[1];
    expect(JSON.parse(oldPage.content!).markdown).toContain("Harbor West");
    expect(JSON.parse(rawSource.content!)).toMatchObject({ anchor, raw_excerpt: raw, previous, next });
    const resultAt = (turn: number, id?: string) =>
      JSON.parse(transcripts[turn].find((m) => m.tool_call_id === id)!.content!);
    expect(resultAt(2, oldPage.tool_call_id)).toEqual({ cleared: true, page_path: path, reason: "stale_after_recompile" });
    expect(resultAt(2, rawSource.tool_call_id).raw_excerpt).toBe(raw);
    expect(resultAt(6, rawSource.tool_call_id)).toEqual({ cleared: true, anchor, reason: "older_than_four_turns" });
    expect((await s.controls()).facts.map((f) => f.value)).toEqual(["Harbor East"]);
    expect((await s.page(path)).markdown).toContain("Harbor East [src:" + anchor + "]");
    expect((await s.page("conflicts.md")).markdown).toContain("梦境纠错（Checked signed manifest） · “Harbor West” → “Harbor East” [src:" + anchor + "]");
  });

  it("keeps API and chat instructions active after failed Dream lint and consumes only published acknowledgements", async () => {
    const s = await setup();
    await s.ingest("Keep the original railway receipt");
    const hot = async (content: string) => hotMemorySummarySchema.parse((await s.request(controlsPath + "/hot", {
      kind: "remember", content,
    }, 201)).hot_memory);
    const apiItem = await hot("Bring the invoice");
    const chatResult = await s.chat("Remember that reminders use amber labels");
    const chatItem = hotMemorySummarySchema.parse(chatResult.hot_memory_action);
    expect(chatItem).toMatchObject({ kind: "remember", content: "reminders use amber labels", status: "active" });
    const unresolved = await hot("Confirm the date later");
    const ids = [apiItem.id, chatItem.id];
    const flags = { include_hot_memories: true, include_core_card: true, include_pending_chats: true };
    const immediate = await s.retrieve("amber", flags);
    for (const item of [apiItem, chatItem]) {
      expect(immediate.hot_memories).toContainEqual(expect.objectContaining({ id: item.id, status: "active" }));
      expect(immediate.core_card).toContain(item.content);
    }
    expect(immediate.pending_chat_hits).toContainEqual(expect.objectContaining({
      session_id: chatResult.session.session_id, session_status: "pending", turn_locator: "t1", excerpt: expect.stringContaining("amber"),
    }));

    let failLint = true;
    const acknowledged: string[] = [];
    s.fixture.options.organize = ({ messages }) => {
      const results = messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content!));
      if (!results.length) return ids.map((hot_id) => ({
        name: "mark_hot_memory_processed", arguments: { hot_id, action: "reviewed" },
      }));
      acknowledged.push(...results.flatMap((r) => r.processed ? [r.processed] : []));
      return failLint ? [{ name: "update_index", arguments: { markdown_body: "# Invalid\n\n[missing](missing.md)" } }, finish] : [finish];
    };
    const failure = await s.dream("failed");
    expect(failure.error_message).toMatch(/lint|validation/i);
    expect(new Set(acknowledged)).toEqual(new Set(ids));
    expect((await s.tree()).snapshot?.version).toBe(1);
    const statuses = async () => Object.fromEntries((await s.controls()).hot_memories.map((m) => [m.id, m.status]));
    expect(await statuses()).toEqual({ [apiItem.id]: "active", [chatItem.id]: "active", [unresolved.id]: "active" });
    failLint = false;
    await s.dream();
    expect(await statuses()).toEqual({ [apiItem.id]: "consumed", [chatItem.id]: "consumed", [unresolved.id]: "active" });
    expect((await s.retrieve("reminders", flags)).hot_memories?.map((m) => m.id)).toEqual([unresolved.id]);
  });

  it("follows linked entity evidence, explores and verifies it across agentic turns, and falls back on invalid output", async () => {
    const s = await setup({ extract: graph });
    const { accepted_docs: [doc] } = await s.ingest(graphDocument);
    const { dispatchPath, keeperPath } = graphPaths((await s.tree()).titles);
    const fast = await s.retrieve("beaconquartz");
    expect(fast.contexts.map((c) => c.page_id)).toEqual([dispatchPath]);
    expect((await s.page(dispatchPath)).markdown).toContain("## 关联页面");
    const secondHop = { page_id: keeperPath, relevance_reason: "关联页面", content: expect.stringContaining("Copper cabinet seventeen") };
    const multi = await s.retrieve("beaconquartz", { retrieval_strategy: "multi_hop" });
    expect(multi).toMatchObject({ strategy_used: "multi_hop", hops: 2 });
    expect(multi.contexts).toContainEqual(expect.objectContaining(secondHop));

    type Step = Parameters<NonNullable<GatewayOptions["agentic"]>>[0];
    const steps: Step[] = [];
    s.fixture.options.agentic = (step) => {
      steps.push(step);
      return steps.length === 1 ? { read_pages: [keeperPath], read_source: doc.doc_id + "#s1" } : { read_pages: [] };
    };
    const agentic = await s.retrieve("beaconquartz", { retrieval_strategy: "agentic", verify_raw_sources: true });
    expect(agentic).toMatchObject({ strategy_used: "agentic", hops: 3 });
    expect(steps).toHaveLength(2);
    expect(steps[0].candidates).toContain(keeperPath);
    expect(steps[1].verified).toBe("beaconquartz");
    expect(steps[1].evidence.map((p) => p.path)).toContain(keeperPath);
    expect(agentic.contexts).toContainEqual(expect.objectContaining(secondHop));

    s.fixture.options.agentic = () => ({ read_pages: "wrong shape" });
    const fallback = await s.retrieve("beaconquartz", { retrieval_strategy: "agentic" });
    expect(fallback).toMatchObject({ strategy_used: "multi_hop", hops: 2, contexts: multi.contexts });
  });

  it("serves composable index, search, page, source and hot tools and documents their HTTP contracts", async () => {
    const s = await setup({ extract: graph });
    const { accepted_docs: [doc] } = await s.ingest(graphDocument);
    const { dispatchPath, keeperPath } = graphPaths((await s.tree()).titles);
    const { hot_memory } = await s.request(tools + "/hot", { ...ref, kind: "remember", content: "Print a dispatch label" }, 201);
    const index = toolIndexResultSchema.parse(await s.getTool("index"));
    expect(index.snapshot_version).toBe(1);
    expect(index.index_markdown).toContain(dispatchPath);
    expect(index.hot_memories).toContainEqual(expect.objectContaining({ id: hot_memory.id, content: "Print a dispatch label" }));
    const hits = toolSearchResultSchema.parse(await s.request(tools + "/search", { ...ref, query: "beaconquartz" }));
    expect(hits.wiki_hits).toContainEqual(expect.objectContaining({ page_id: dispatchPath, excerpt: expect.stringContaining("beaconquartz") }));
    const page = await s.page(dispatchPath);
    expect(page.outgoing_links).toContain(keeperPath);
    expect((await s.page(keeperPath)).markdown).toContain("Copper cabinet seventeen");
    const source = sourceResultSchema.parse(await s.getTool("source", { doc_id: doc.doc_id, locator: "s1" }));
    expect(source).toMatchObject({ anchor: doc.doc_id + "#s1", raw_excerpt: "beaconquartz", previous: null, next: "Copper cabinet seventeen" });

    const { paths } = await s.request("/openapi.json");
    for (const [path, method, status] of [
      [tools + "/index", "get", "200"], [tools + "/search", "post", "200"], [tools + "/page", "get", "200"],
      [tools + "/source", "get", "200"], [tools + "/hot", "post", "201"], ["/v1/memories/compact", "post", "200"],
      ["/v1/memory/spaces/{ns}/{id}/hot", "post", "201"],
    ]) {
      const operation = paths[path]?.[method];
      expect(operation?.responses[status]?.description, method + " " + path).toBeTruthy();
      if (method === "post") expect(operation.requestBody.content["application/json"].schema).toBeDefined();
      else expect(operation.parameters.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(["namespace", "space_id"]));
    }
  });

  it("publishes procedural rules, projects private scopes out of retrieval, and revises the rule set during Dream", async () => {
    const publicRule = { trigger_context: "For a release", instruction: "Include the build number", priority: "high", scope: "work_shareable", locator: "s1" };
    const privateRule = { trigger_context: "For home delivery", instruction: "Use the violet passphrase", priority: "redline", scope: "family", locator: "s2" };
    const updated = { ...publicRule, trigger_context: "For package handoff", instruction: "Include the build number on the label" };
    const privateFact = "Cabinet code amethyst";
    const publicFact = "Blue labels";
    const privateHot = "Use receipt code nickel";
    const s = await setup({ extract: () => ({
      summary: "Packing instructions", procedural_rules: [publicRule, privateRule],
      facts: [
        { ...dispatch, locator: "s1", predicate: "Packing", value: publicFact, scope: "work_shareable", tier: "pinned_redline" },
        { ...dispatch, locator: "s2", predicate: "Access", value: privateFact, scope: "work_internal", tier: "pinned_redline" },
      ],
    }) });
    const { accepted_docs: [doc] } = await s.ingest([publicRule.instruction + ". " + publicFact + ". " + updated.instruction,
      privateRule.instruction + ". " + privateFact].join("\n\n"));
    const published = await s.tree();
    expect(published.snapshot?.lint.issues).toEqual([]);
    expect(published.files).toContain("rules.md");
    const rulesPage = (await s.page("rules.md")).markdown;
    for (const r of [publicRule, privateRule]) {
      expect(rulesPage).toContain(r.instruction + " [src:" + doc.doc_id + "#" + r.locator + "]");
    }
    const controls = await s.controls();
    expect(controls.rules).toEqual(expect.arrayContaining([expect.objectContaining(publicRule), expect.objectContaining(privateRule)]));
    await s.request(tools + "/hot", { ...ref, kind: "remember", scope: "private_health", content: privateHot }, 201);
    await s.request(tools + "/hot", { ...ref, kind: "remember", scope: "general", content: "Save tracking number" }, 201);
    const flags = { include_rules: true, include_hot_memories: true, include_core_card: true, verify_raw_sources: true };
    const full = await s.retrieve("Dispatch", flags);
    expect(full.contexts.map((c) => c.content).join("\n")).toContain(privateFact);
    expect(full.rules).toContainEqual(expect.objectContaining(privateRule));
    expect(full.hot_memories).toContainEqual(expect.objectContaining({ content: privateHot }));
    for (const secret of [privateFact, privateRule.instruction, privateHot]) expect(full.core_card).toContain(secret);

    const safe = await s.retrieve("Dispatch", { ...flags, privacy_mode: "external_safe" });
    expect(safe.contexts.map((c) => c.content).join("\n")).toContain(publicFact);
    expect(safe.rules).toMatchObject([publicRule]);
    expect(safe.hot_memories).toMatchObject([{ content: "Save tracking number" }]);
    expect(safe.core_card).toContain(publicRule.instruction);
    for (const secret of [privateFact, privateRule.trigger_context, privateRule.instruction, privateHot]) {
      expect(JSON.stringify(safe)).not.toContain(secret);
    }
    const withdrawn = controls.rules.find((r) => r.instruction === publicRule.instruction)!;
    s.fixture.options.organize = () => [
      { name: "upsert_rule", arguments: { ...updated, doc_id: doc.doc_id } },
      { name: "archive_rule", arguments: { rule_id: withdrawn.rule_id, reason: "Replaced by the handoff instruction" } }, finish,
    ];
    await s.dream();
    const after = await s.controls();
    expect(after.rules.map((r) => r.instruction).sort()).toEqual([privateRule.instruction, updated.instruction].sort());
    expect(after.core_profile_card).toContain(updated.instruction);
    expect((await s.page("rules.md")).markdown).not.toContain(publicRule.trigger_context);
    expect((await s.page("conflicts.md")).markdown).toContain("Replaced by the handoff instruction");
    expect((await s.tree()).snapshot?.lint.issues).toEqual([]);
  });

  it("retains the Organizer's cited overview and canonical fact section on the next incremental compile", async () => {
    const overview = "Receipts are required for this route.";
    const s = await setup({ organize: ({ messages }) => {
      const result = messages.find((m) => m.role === "tool");
      if (!result) {
        const { pages } = JSON.parse(messages[1].content!) as { pages: string[] };
        return [{ name: "read_page", arguments: { page_path: pages.find((p) => p.startsWith("topics/"))! } }];
      }
      const { page_path, markdown } = JSON.parse(result.content!);
      const { frontmatter, body } = readPage(markdown);
      const [title, ...facts] = body.trim().split("\n");
      const citation = body.match(/\[src:[^\]]+\]/)![0];
      return [{ name: "upsert_page", arguments: { page_path, frontmatter,
        markdown_body: [title, "## 概览与关键结论", overview + " " + citation, "## 事实清单", facts.join("\n").trim()].join("\n\n"),
      } }, finish];
    } });
    const first = await s.ingest("Keep the original railway receipt", "full");
    const path = (await s.tree()).files.find((p) => p.startsWith("topics/"))!;
    const citation = "[src:" + first.accepted_docs[0].doc_id + "#s1]";
    const expected = "## 概览与关键结论\n\n" + overview + " " + citation + "\n\n## 事实清单";
    const check = async () => {
      const { markdown } = await s.page(path);
      expect(markdown).toContain(expected);
      expect(markdown).toContain("Keep the original railway receipt " + citation);
      expect((await s.tree()).snapshot?.lint.issues).toEqual([]);
    };
    await check();
    const second = await s.ingest("Submit travel reimbursements within fourteen days", "skip", "deadline.md");
    expect(second.target_version).toBe(2);
    await check();
    expect((await s.page(path)).markdown).toContain("Submit travel reimbursements within fourteen days");
  });

  it("publishes a hierarchical index on fast-path ingest without an Organizer call", async () => {
    const names = Array.from({ length: 112 }, (_, i) => "Station " + i);
    const s = await setup({ extract: ({ segments: [seg] }) => ({
      summary: "Station inventory", facts: names.map((subject, i) => ({
        subject, kind: i % 2 ? "entity" : "topic", predicate: "Label", value: "Sign " + i, locator: seg.locator,
        tier: "durable", scope: "general",
      })),
    }) });
    await s.ingest(names.join(", "), "skip");
    expect(s.fixture.requests.map((r) => r.stage)).toEqual(["analyzer"]);
    const { snapshot, titles, files } = await s.tree();
    expect(snapshot?.lint).toMatchObject({ issues: [], broken_links: 0, orphan_pages: 0 });
    const index = await s.page("_index.md");
    expect(index.markdown.trimEnd().split("\n").length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(index.markdown)).toBeLessThanOrEqual(25_600);
    const hubs = index.outgoing_links.filter((p) => p.startsWith("topics/hub-"));
    expect(hubs.length).toBeGreaterThan(0);
    const direct = index.outgoing_links.filter((p) => names.includes(titles[p]));
    const members = (await Promise.all(hubs.map(s.page))).flatMap((hub) => hub.outgoing_links);
    expect(direct).toHaveLength(80);
    expect([...direct, ...members].map((p) => titles[p]).sort()).toEqual([...names].sort());
    expect(files.some((p) => /\/collection-\d+\.md$/.test(p))).toBe(false);
  });

  it("projects the same snapshot at the validity boundaries and excludes evidence before its document date", async () => {
    const s = await setup({ extract: () => ({ summary: "Delivery zones", facts: [
      { ...dispatch, predicate: "Zone", value: "Amber district", locator: "s1", valid_from: "2019-12-01", valid_to: "2020-01-31" },
      { ...dispatch, predicate: "Zone", value: "Copper district", locator: "s2", valid_from: "2020-02-02" },
    ] }) });
    await s.ingest("Amber district until January 31.\n\nCopper district from February 2.");
    const zones = async (as_of_date?: string) => {
      const result = await s.retrieve("Dispatch", { as_of_date, include_index: false });
      expect(result.snapshot_version).toBe(1);
      return result.contexts.map((c) => c.content).join("\n");
    };
    expect(await zones("2019-12-31")).toBe("");
    const lastDay = await zones("2020-01-31");
    expect(lastDay).toContain("Amber district");
    expect(lastDay).not.toContain("Copper district");
    expect(await zones("2020-02-01")).toBe("");
    for (const date of ["2020-02-02", undefined]) {
      const current = await zones(date);
      expect(current).toContain("Copper district");
      expect(current).not.toContain("Amber district");
    }
  });

  it("passes short histories through and compacts older turns into a bounded context with opt-in hot memory persistence", async () => {
    const content = "Print blue labels";
    const calls: CompactMessage[][] = [];
    const s = await setup({ compact: (input) => {
      calls.push(input.messages);
      return { summary: "Packing approved. ".repeat(500), active_goals: ["Prepare dispatch"], confirmed_constraints: [],
        recent_decisions: [], open_questions: [], extracted_hot_memories: [{ kind: "remember", content }] };
    } });
    await s.request("/v1/admin/spaces", { ...ref, purpose });
    const limit = 384;
    const compact = async (messages: CompactMessage[], persist = false) =>
      compactResultSchema.parse(await s.request("/v1/memories/compact", {
        ...ref, messages, max_tokens: limit, keep_recent_turns: 1, persist_hot_memories: persist,
      }));
    const recent: CompactMessage[] = [{ role: "user", content: "Ready to ship?" }, { role: "assistant", content: "Ready." }];
    const short = await compact(recent);
    expect(short).toMatchObject({ kept_recent_messages: recent, summary: "", extracted_hot_memories: [], persisted_hot_ids: [] });
    expect(short.compacted_tokens).toBe(short.original_tokens);
    expect(s.fixture.requests).toHaveLength(0);
    const older: CompactMessage[] = [{ role: "user", content: "Remember that " + content },
      ...Array.from({ length: 9 }, (_, i): CompactMessage => ({ role: i % 2 ? "user" : "assistant", content: ("packing step " + i + " ").repeat(35) }))];
    for (const persist of [false, true]) {
      const result = await compact([...older, ...recent], persist);
      expect(calls.at(-1)).toEqual(older);
      expect(result.summary).toMatch(/^Packing approved/);
      expect(result.kept_recent_messages).toEqual(recent);
      const { original_tokens, compacted_tokens, persisted_hot_ids, ...context } = result;
      expect(original_tokens).toBeGreaterThan(limit);
      expect(countTokens(JSON.stringify(context))).toBeLessThanOrEqual(limit);
      expect(compacted_tokens).toBeLessThanOrEqual(limit);
      expect(result.extracted_hot_memories).toEqual([{ kind: "remember", content }]);
      const hot = (await s.controls()).hot_memories;
      expect(hot.map((m) => m.id)).toEqual(persisted_hot_ids);
      expect(hot).toHaveLength(persist ? 1 : 0);
      if (persist) expect(hot[0]).toMatchObject({ status: "active", content });
    }
    expect(calls).toHaveLength(2);
  });
});

describe("dense embeddings", () => {
  it("returns deterministic unit vectors over HTTP and preserves input order across batches", async () => {
    const s = await setup({}, true);
    const texts = ["quartz", "amber", "quartz"];
    const response = await fetch(s.fixture.baseUrl + "/embeddings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "fixture-vector", input: texts }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ embedding: number[]; index: number }> };
    expect(body.data.map((row) => row.index)).toEqual([0, 1, 2]);
    expect(body.data[0].embedding).toEqual(body.data[2].embedding);
    expect(body.data[0].embedding).not.toEqual(body.data[1].embedding);
    for (const row of body.data) expect(Math.hypot(...row.embedding)).toBeCloseTo(1, 10);

    const batches: string[][] = [];
    s.fixture.options.embed = (input) => {
      batches.push(input);
      return input.map((text) => [3, Number(text)]);
    };
    const inputs = Array.from({ length: 67 }, (_, i) => String(i + 1));
    const vectors = await new OpenAiGateway(s.config).embed(inputs);
    expect(batches.map((batch) => batch.length)).toEqual([32, 32, 3]);
    expect(batches.flat()).toEqual(inputs);
    expect(vectors).toHaveLength(inputs.length);
    for (const [i, vector] of vectors!.entries()) {
      const norm = Math.hypot(3, i + 1);
      expect(vector[0]).toBeCloseTo(3 / norm, 10);
      expect(vector[1]).toBeCloseTo((i + 1) / norm, 10);
    }
  });

  it.each([[404, "Endpoint not found"], [400, "Unsupported embeddings model"]] as const)(
    "falls back to local indexing and retrieval when embeddings return %i", async (status, message) => {
      const s = await setup({ embed: () => ({ status, message }), extract: graph }, true);
      const gateway = new OpenAiGateway(s.config);
      expect(await gateway.embed(["test"])).toBeNull();
      expect(gateway.hasEmbeddings()).toBe(false);
      expect(await gateway.embed(["again"])).toBeNull();
      expect(s.fixture.requests.filter((r) => r.stage === "embeddings")).toHaveLength(1);
      await s.ingest(graphDocument);
      const hits = toolSearchResultSchema.parse(await s.request(tools + "/search", { ...ref, query: "beaconquartz" }));
      expect(hits.wiki_hits[0]?.title).toBe(dispatch.subject);
      const db = new SQLiteConnection(s.dir);
      cleanup.push(() => db.close());
      expect(db.client.prepare("SELECT DISTINCT is_dense FROM wiki_page_vectors").all()).toEqual([{ is_dense: 0 }]);
    },
  );

  it("finds Wiki pages and pending chat turns by dense similarity without lexical overlap", async () => {
    const s = await setup({ extract: graph, embed: (texts) => texts.map((t) =>
      /Copper cabinet|moonstone|ultramarine/i.test(t) ? [5, 0] : [0, 2]) }, true);
    await s.ingest(graphDocument);
    const { keeperPath } = graphPaths((await s.tree()).titles);
    const match = await s.chat("The moonstone is ready.");
    const other = await s.chat("A yellow parcel arrived.");
    const db = new SQLiteConnection(s.dir);
    cleanup.push(() => db.close());
    await vi.waitFor(() => {
      const row = db.client.prepare("SELECT vector_json FROM wiki_page_vectors WHERE version = 1 AND page_id = ? AND is_dense = 1")
        .get(keeperPath) as { vector_json: string } | undefined;
      expect(row && JSON.parse(row.vector_json)).toEqual([1, 0]);
      expect(db.client.prepare("SELECT count(*) AS n FROM chat_turn_vectors WHERE is_dense = 1").get()).toEqual({ n: 2 });
    });
    const result = toolSearchResultSchema.parse(await s.request(tools + "/search", {
      ...ref, query: "ultramarine", include_pending_chats: true,
    }));
    expect(result.wiki_hits[0]).toMatchObject({ page_id: keeperPath, source: "vector" });
    expect(result.chat_hits.map((h) => h.session_id)).toContain(match.session.session_id);
    expect(result.chat_hits.map((h) => h.session_id)).not.toContain(other.session.session_id);
    expect(result.chat_hits[0]).toMatchObject({ matched_terms: [], excerpt: expect.stringContaining("moonstone") });
  });
});

describe("dataset regressions", () => {
  it("keeps demo-specific names out of the memory state implementation", async () => {
    const source = await readFile(new URL("../apps/api/src/memory/memory-state.ts", import.meta.url), "utf8");
    const demoNames = [
      "陈默", "小默", "苏晴", "芝麻", "老周", "小赵", "北极星", "林远", "朵朵", "星河",
      "周凯", "赵琳", "许宁", "陆明轩", "顾承泽", "林嘉", "郑洋", "青鸾", "云启科技", "华辰金融",
      "林汐", "周明远", "乐乐", "周然", "小宇", "糖糖", "拾光记", "LightLog",
      "Atlas", "赵峰", "李博", "孙悦", "林凯", "星海制造", "锦程医药", "远景能源", "王志强", "高敏", "刘伟",
    ];
    for (const name of demoNames) expect(source, name).not.toContain(name);
  });

  function chats(dataset: Dataset) {
    return [...dataset.batches.flat(), ...dataset.pending, ...(dataset.followUp ? [dataset.followUp] : [])];
  }
  it.each([
    { name: "zhou-ran", sessions: chats(zhouRanDataset) },
    { name: "atlas-platform", sessions: chats(atlasDataset) },
    { name: "enterprise-q4", sessions: chats(salesDataset) },
    { name: "scenarios", sessions: [...PERSONAL_DEMO_DAYS, ...PENDING_DEMO_CHATS] },
  ])("$name averages at least 350 characters per assistant reply", ({ sessions }) => {
    const replies = sessions.flatMap((s) => s.messages.filter((m) => m.role === "assistant"));
    expect(replies.length).toBeGreaterThan(0);
    const characters = replies.reduce((sum, m) => sum + [...m.content.trim()].length, 0);
    expect(characters / replies.length).toBeGreaterThanOrEqual(350);
  });
});

describe("LLM fact classification and redline controls", () => {
  it("never regex-guesses pinned_redline for trips or arrangements mentioning family members", () => {
    const tripFact = {
      subject: "北海道圣诞周家庭旅行",
      predicate: "出行时间与人员",
      value: "2026年12月24日从杭州出发，30日返回；同行四人：林汐、明远、乐乐、林汐的母亲",
    };
    expect(inferFactTier(tripFact)).toBe("durable");
    expect(inferFactTier({ ...tripFact, expires_on: "2026-12-31" })).toBe("working");
    expect(inferFactTier({ ...tripFact, pinned: true })).toBe("pinned_redline");
    expect(inferFactScope(tripFact)).toBe("general");
  });

  it("assigns LLM-judged tier, scope, and expires_on to unlabeled facts and supports clean redline downgrades", async () => {
    const s = await setup({
      extract: ({ segments: [seg] }) => ({
        summary: "家庭旅行与过敏记录",
        facts: [
          {
            kind: "topic", subject: "北海道圣诞周家庭旅行", predicate: "住宿分房安排",
            value: "母亲单独一间安静房；林汐、明远、乐乐一间", locator: seg.locator,
          },
          {
            kind: "entity", subject: "乐乐", predicate: "花生过敏",
            value: "严重花生过敏，严禁任何花生制品，随身带肾上腺素笔", locator: seg.locator,
          },
          {
            kind: "entity", subject: "林汐", predicate: "12月7日安排",
            value: "上午陪母亲复查血压，中午接乐乐，当天不排提审", locator: seg.locator,
          },
        ],
      }),
      classifyFacts: ({ facts }) => ({
        classifications: facts.map((fact) => {
          if (fact.subject === "乐乐") {
            return { index: fact.index, tier: "pinned_redline", scope: "private_health" };
          }
          if (fact.predicate === "12月7日安排") {
            return { index: fact.index, tier: "working", scope: "family", expires_on: "2026-12-08" };
          }
          return { index: fact.index, tier: "working", scope: "family", expires_on: "2026-12-31" };
        }),
      }),
    });

    // Direct unit check on classifyFactsWithLlm
    const gateway = new OpenAiGateway(s.config);
    const usage = { llm_calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, latency_ms: 0 };
    const direct = await classifyFactsWithLlm(gateway, [
      { kind: "topic", subject: "北海道圣诞周家庭旅行", predicate: "住宿分房安排", value: "母亲单独一间安静房" },
      { kind: "entity", subject: "乐乐", predicate: "花生过敏", value: "严重花生过敏" },
    ], usage);
    expect(direct[0]).toMatchObject({ tier: "working", scope: "family", expires_on: "2026-12-31" });
    expect(direct[1]).toMatchObject({ tier: "pinned_redline", scope: "private_health" });
    expect(usage.llm_calls).toBe(1);

    // End-to-end compile pipeline classifies unlabeled facts before publishing
    await s.ingest("北海道住宿分房、乐乐花生过敏、12月7日安排", "skip", "family.md");
    const initial = await s.controls();
    const byPred = new Map(initial.facts.map((f) => [f.predicate, f]));
    expect(byPred.get("住宿分房安排")).toMatchObject({ tier: "working", scope: "family", expires_on: "2026-12-31" });
    expect(byPred.get("12月7日安排")).toMatchObject({ tier: "working", scope: "family", expires_on: "2026-12-08" });
    expect(byPred.get("花生过敏")).toMatchObject({ tier: "pinned_redline", scope: "private_health" });

    // Cleanly downgrade a pinned_redline fact via PATCH .../facts
    const allergy = byPred.get("花生过敏")!;
    await s.request(controlsPath + "/facts", {
      fact_key: allergy.fact_key,
      tier_override: "durable",
      pinned: false,
    }, 200, "PATCH");
    const afterDowngrade = await s.controls();
    expect(afterDowngrade.facts.find((f) => f.fact_key === allergy.fact_key)).toMatchObject({
      tier: "durable",
      pinned: false,
    });
    expect(afterDowngrade.stats.pinned_count).toBe(0);

    // Re-pin and then downgrade to working even without explicitly passing pinned: false
    await s.request(controlsPath + "/facts", {
      fact_key: allergy.fact_key,
      pinned: true,
      tier_override: "pinned_redline",
    }, 200, "PATCH");
    expect((await s.controls()).facts.find((f) => f.fact_key === allergy.fact_key)).toMatchObject({
      tier: "pinned_redline",
      pinned: true,
    });
    await s.request(controlsPath + "/facts", {
      fact_key: allergy.fact_key,
      tier_override: "working",
    }, 200, "PATCH");
    expect((await s.controls()).facts.find((f) => f.fact_key === allergy.fact_key)).toMatchObject({
      tier: "working",
      pinned: false,
    });
  });

  it("trusts LLM ChatRouter decisions directly without regex overrides on hot_memory, privacy_mode, or safety_check", async () => {
    const s = await setup({
      router: ({ message }) => ({
        memory_mode: "personal",
        search_queries: [message],
        needs_inventory: false,
        safety_check: false,
        needs_audit_history: false,
        privacy_mode: "full",
        hot_memory: null,
      }),
    });
    const gateway = new OpenAiGateway(s.config);
    const router = new ChatRouter(gateway);

    // Document-editing request must NOT be hijacked into a forget hot_memory
    const editPlan = await router.route({
      message: "把第二段关于预算的描述删掉",
      recentHistory: [],
      hasMemory: true,
      today: "2026-11-26",
    });
    expect(editPlan.hot_memory).toBeNull();
    expect(editPlan.safety_check).toBe(false);

    // Private question mentioning "给客户发邮件" must NOT be forced into external_safe
    const quotePlan = await router.route({
      message: "之前给客户发邮件一般怎么报价，烧钱的大约预算怎么盘点？",
      recentHistory: [],
      hasMemory: true,
      today: "2026-11-26",
    });
    expect(quotePlan.privacy_mode).toBe("full");
    expect(quotePlan.safety_check).toBe(false);
    expect(quotePlan.needs_inventory).toBe(false);

    // End-to-end chat turn does not persist a bogus forget hot_memory
    await s.request("/v1/admin/spaces", { ...ref, purpose });
    const chatRes = await s.chat("把第二段关于预算的描述删掉");
    expect(chatRes.hot_memory_action).toBeUndefined();
    expect((await s.controls()).hot_memories).toEqual([]);
  });

  it("classifies chat-captured hot memories with LLM and excludes private_health hot memories under external_safe", async () => {
    const s = await setup({
      extract: ({ segments: [seg] }) => ({
        summary: "合作进展",
        facts: [{
          kind: "topic", subject: "合作进展", predicate: "对外同步", value: "下周交付公开演示版本",
          locator: seg.locator, tier: "durable", scope: "work_shareable",
        }],
      }),
      classifyFacts: ({ facts }) => ({
        classifications: facts.map((f) => ({
          index: f.index,
          tier: f.value.includes("花生过敏") ? "pinned_redline" : "durable",
          scope: f.value.includes("花生过敏") ? "private_health" : "general",
        })),
      }),
      router: ({ message }) => {
        if (message.startsWith("记住：")) {
          return {
            memory_mode: "personal",
            search_queries: [message],
            needs_inventory: false,
            safety_check: true,
            needs_audit_history: false,
            privacy_mode: "full",
            hot_memory: { kind: "remember", content: message.slice(3) },
          };
        }
        return {
          memory_mode: "personal",
          search_queries: ["合作进展"],
          needs_inventory: false,
          safety_check: false,
          needs_audit_history: false,
          privacy_mode: "external_safe",
          hot_memory: null,
        };
      },
    });
    await s.ingest("下周交付公开演示版本", "skip", "work.md");
    const remembered = await s.chat("记住：乐乐花生过敏，随身带肾上腺素笔");
    expect(remembered.hot_memory_action).toMatchObject({
      kind: "remember",
      tier: "pinned_redline",
      scope: "private_health",
    });

    const spy = vi.spyOn(OpenAiGateway.prototype, "complete");
    cleanup.push(() => spy.mockRestore());
    await s.chat("帮我起草一封发给投资人的项目进展更新");
    const strongCall = spy.mock.calls.find(([tier]) => tier === "strong")!;
    const systemPrompt = String(strongCall[1][0].content);
    expect(systemPrompt).toContain("下周交付公开演示版本");
    expect(systemPrompt).not.toContain("花生过敏");
    expect(systemPrompt).not.toContain("肾上腺素笔");
  });

  it("does not force ordinary single-slot facts containing 不得/出境 into cardinality=many, while protecting pinned_redline", async () => {
    const s = await setup({
      extract: ({ document, segments: [seg] }) => {
        if (document.filename === "v1.md") {
          return {
            summary: "初版计划",
            facts: [
              { kind: "entity", subject: "林汐", predicate: "出差状态", value: "不得不推迟出差到下周", locator: seg.locator, cardinality: "one", tier: "working", scope: "work_internal" },
              { kind: "topic", subject: "旅行计划", predicate: "目的地", value: "日本出境游计划", locator: seg.locator, cardinality: "one", tier: "working", scope: "family" },
              { kind: "entity", subject: "乐乐", predicate: "过敏红线", value: "严重花生过敏，严禁坚果制品", locator: seg.locator, cardinality: "one", tier: "pinned_redline", scope: "private_health" },
            ],
          };
        }
        return {
          summary: "更新计划",
          facts: [
            { kind: "entity", subject: "林汐", predicate: "出差状态", value: "改为本周五照常出差", locator: seg.locator, cardinality: "one", tier: "working", scope: "work_internal" },
            { kind: "topic", subject: "旅行计划", predicate: "目的地", value: "改为三亚国内度假", locator: seg.locator, cardinality: "one", tier: "working", scope: "family" },
            { kind: "entity", subject: "乐乐", predicate: "过敏红线", value: "误食立即送附近急诊", locator: seg.locator, cardinality: "one", tier: "pinned_redline", scope: "private_health" },
          ],
        };
      },
    });
    await s.ingest("不得不推迟出差；日本出境游计划；乐乐花生过敏", "skip", "v1.md");
    await s.request("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync", organize_mode: "skip",
      items: [{ filename: "v2.md", content: "改为本周五照常出差；改为三亚国内度假；误食立即送急诊", doc_date: "2020-01-05" }],
    });
    const controls = await s.controls();
    const tripFacts = controls.facts.filter((f) => f.predicate === "出差状态" || f.predicate === "目的地");
    expect(tripFacts.map((f) => f.value).sort()).toEqual(["改为三亚国内度假", "改为本周五照常出差"]);
    // LLM-classified pinned_redline preserves both coexisting redline details
    const allergyFacts = controls.facts.filter((f) => f.predicate === "过敏红线");
    expect(allergyFacts.map((f) => f.value).sort()).toEqual(["严重花生过敏，严禁坚果制品", "误食立即送附近急诊"]);
  });

  it("admits conflicts.md via router needs_audit_history=true even without legacy audit keywords, and blocks it when false", async () => {
    const s = await setup({
      extract: ({ document, segments: [seg] }) => ({
        summary: document.filename,
        facts: [{
          kind: "topic", subject: "拾光记", predicate: "年费定价",
          value: document.filename === "p1.md" ? "每年 99 元" : "每年 128 元",
          locator: seg.locator, cardinality: "one", tier: "durable", scope: "work_shareable",
        }],
      }),
      router: ({ message }) => ({
        memory_mode: "personal",
        search_queries: ["拾光记 年费定价"],
        needs_inventory: false,
        safety_check: false,
        needs_audit_history: message.includes("最早"),
        privacy_mode: "full",
        hot_memory: null,
      }),
    });
    await s.ingest("拾光记最初年费 99 元", "skip", "p1.md");
    await s.request("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync", organize_mode: "skip",
      items: [{ filename: "p2.md", content: "拾光记年费调整为 128 元", doc_date: "2020-02-01" }],
    });

    const auditChat = await s.chat("拾光记最早卖多少钱？");
    const auditPages = (auditChat.assistant_message.retrieval.contexts as Array<{ page_id: string; content: string }>)
      .map((ctx) => ctx.page_id);
    expect(auditPages).toContain("conflicts.md");
    expect(JSON.stringify(auditChat.assistant_message.retrieval.contexts)).toContain("99 元");

    const nonAuditChat = await s.chat("罗马历史和拾光记现在卖多少钱？");
    const nonAuditPages = (nonAuditChat.assistant_message.retrieval.contexts as Array<{ page_id: string }>)
      .map((ctx) => ctx.page_id);
    expect(nonAuditPages).not.toContain("conflicts.md");
  });

  it("uses structured redlineAnchors in relevantMarkdown without single-char query/禁 false positives or pet single-char collisions", () => {
    const page = [
      "# 记录",
      "- **游记 · 行程** · 参观紫禁城和故宫博物院非常震撼 [src:doc_1#s1]",
      "- **备忘 · 提醒** · 周五提交普通月度汇总材料 [src:doc_1#s2]",
      "- **安全 · 须知** · 支架术后按时服药不可自行停药 [src:doc_1#s3]",
    ].join("\n");
    const redlineAnchors = new Set(["doc_1#s3"]);
    const boosted = relevantMarkdown(page, "周末安排", 36, true, redlineAnchors);
    expect(boosted).toContain("支架术后按时服药");
    expect(boosted).not.toContain("紫禁城");

    // Without boostSafety, query words like 吃/喝/烧 no longer force safety boosting
    const unboosted = relevantMarkdown(page, "参观紫禁城吃面", 36, false, redlineAnchors);
    expect(unboosted).toContain("紫禁城");

    // Offline concept vector does not conflate 天猫/热狗 with pet_animal
    const sim = cosineSimilarity(vectorizeSemanticText("天猫买热狗优惠券"), vectorizeSemanticText("宠物兽医体检"));
    expect(sim).toBeLessThan(0.25);
  });
});
