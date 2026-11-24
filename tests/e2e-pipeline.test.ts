import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobResultSchema, retrieveResultSchema, treeResultSchema } from "@replica/shared";
import type { JobResult, RetrieveResult } from "@replica/shared";
import { readConfig } from "../apps/api/src/config.js";
import { createService } from "../apps/api/src/service.js";
import { startFixtureGateway } from "./fixtures/gateway.js";

const ref = { namespace: "personal_agent", space_id: "user_10086" };
const purpose = "为差旅助手管理高铁偏好、报销政策和上海项目复盘事项";
const spacePath = "/v1/admin/spaces/personal_agent/user_10086";
const cleanup: Array<() => Promise<void>> = [];
const readFixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

async function setup({
  rejectTools = false, rejectJson = false, lint = "accept",
}: { rejectTools?: boolean; rejectJson?: boolean; lint?: "accept" | "repair" | "reject" } = {}) {
  const data = await mkdtemp(join(tmpdir(), "replica-tests-"));
  cleanup.push(() => rm(data, { recursive: true, force: true }));
  const fast = await startFixtureGateway({ rejectJson });
  const strong = await startFixtureGateway({ rejectTools, lint });
  cleanup.push(fast.close, strong.close);
  const config = readConfig({
    DATA_DIR: data,
    DREAM_POLL_MINUTES: "0",
    LLM_BASE_URL: fast.baseUrl, LLM_API_KEY: "fixture-fast", LLM_FAST_MODEL: "fast-v1",
    LLM_STRONG_BASE_URL: strong.baseUrl, LLM_STRONG_API_KEY: "fixture-strong", LLM_STRONG_MODEL: "strong-v1",
  });
  const service = createService(config);
  cleanup.push(service.close);
  service.start();
  const app = service.app;
  async function json(path: string, payload: unknown, method = "POST") {
    return app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  async function job(id: string) {
    const response = await app.request(`/v1/memories/jobs/${id}`);
    expect(response.status).toBe(200);
    return jobResultSchema.parse(await response.json());
  }
  async function wait(id: string) {
    let value: JobResult | undefined;
    await expect.poll(async () => {
      value = await job(id);
      return ["published", "failed"].includes(value.status);
    }, { timeout: 10_000, interval: 30 }).toBe(true);
    return value!;
  }
  async function retrieve(query: string, options: Record<string, unknown> = {}): Promise<RetrieveResult> {
    const response = await json("/v1/memories/retrieve", { ...ref, query, ...options });
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(200);
    return retrieveResultSchema.parse(data);
  }
  return { app, json, job, wait, retrieve, data, config, fast, strong };
}

afterEach(async () => {
  const failures = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures);
});

describe("Wiki Memory API", () => {
  it("publishes a mixed corpus, grounds multi-hop queries, deduplicates, and isolates rollbacks and history", async () => {
    const test = await setup({ rejectJson: true, lint: "repair" });
    const multipart = new FormData();
    for (const [key, value] of Object.entries({ ...ref, purpose, mode: "async", idempotency_key: "initial",
      doc_dates: JSON.stringify({ "turns.json": "2026-11-20", "review.md": "2026-11-21" }),
    })) multipart.append(key, value);
    const files = ["review.md", "turns.json", "rollout.txt", "travel_policy.pdf", "checklist.docx", "scan.pdf"];
    for (const filename of files) {
      const bytes = await readFixture(filename);
      multipart.append("files", new Blob([new Uint8Array(bytes)]), filename);
    }
    const accepted = await test.app.request("/v1/memories/ingest", { method: "POST", body: multipart });
    const payload = await accepted.json();
    expect(accepted.status, JSON.stringify(payload)).toBe(202);
    expect(payload.accepted_docs).toHaveLength(6);
    expect(payload.accepted_docs.find((doc: { filename: string }) => doc.filename === "scan.pdf").warnings)
      .toEqual(["SCANNED_PDF_NO_TEXT_LAYER"]);
    const first = await test.wait(payload.job_id);
    expect(first, first.error_message ?? "").toMatchObject({ status: "published", target_version: 1 });
    expect(first.usage.total_tokens).toBeGreaterThan(0);
    expect(test.fast.requests.some(({ model, authorization, native }) => model === "fast-v1" && authorization === "Bearer fixture-fast" && !native)).toBe(true);
    expect(test.strong.requests.filter(({ stage }) => stage === "organizer")).toHaveLength(3);
    expect(test.strong.requests.every(({ model, authorization }) => model === "strong-v1" && authorization === "Bearer fixture-strong")).toBe(true);

    const root = join(test.data, "spaces", ref.namespace, ref.space_id);
    expect(await readdir(join(root, "raw", "blobs"))).toHaveLength(6);
    expect(await readdir(join(root, "raw", "normalized"))).toHaveLength(6);
    expect(await readdir(join(root, "staging", first.job_id, "notes"))).toHaveLength(6);
    const tree = treeResultSchema.parse(await (await test.app.request(`${spacePath}/tree`)).json());
    expect(tree.snapshot?.lint).toMatchObject({ broken_links: 0, orphan_pages: 0, issues: [] });
    expect(tree.snapshot?.document_count).toBe(6);
    expect(tree.files).toEqual(expect.arrayContaining(["_index.md", "timeline.md", "conflicts.md"]));
    expect(JSON.parse(await readFile(join(root, "space.json"), "utf8")).current_version).toBe(1);

    const multiHop = await test.retrieve("张明的上海复盘要准备什么？差旅有哪些高铁座位偏好和报销要求？", {
      return_mode: "both", verify_raw_sources: true, max_tokens: 1000,
    });
    const pages = multiHop.contexts.flatMap((page) => page.citations);
    expect(multiHop.index_excerpt).toContain("Memory Index");
    expect(multiHop.answer).toContain("[src:");
    expect(multiHop.answer).toContain("靠窗");
    expect(pages.some((source) => source.filename === "review.md" && source.raw_excerpt?.includes("张明"))).toBe(true);
    expect(pages.some((source) => source.filename === "turns.json" && source.raw_excerpt?.includes("靠窗"))).toBe(true);
    expect(pages.some((source) => source.filename === "travel_policy.pdf" && source.anchor.endsWith("#p1")
      && source.raw_excerpt?.includes("railway receipt"))).toBe(true);
    expect(pages.some((source) => source.filename === "scan.pdf")).toBe(false);
    expect(multiHop.usage.returned_tokens).toBeLessThanOrEqual(1000);
    const fts = await test.retrieve("Where is RLS-2026-B?", { include_index: false });
    expect(fts.index_excerpt).toBeNull();
    expect(fts.contexts[0]).toMatchObject({ relevance_reason: "FTS5 关键词匹配", content: expect.stringContaining("RLS-2026-B") });

    const oldCitation = pages.find(({ filename }) => filename === "turns.json")!;
    const locator = oldCitation.anchor.split("#")[1];
    const sourceQuery = new URLSearchParams({ doc_id: oldCitation.doc_id, locator, version: "1" });
    const original = await test.app.request(`${spacePath}/source?${sourceQuery}`);
    expect(await original.json()).toMatchObject({ locator: "t1", doc_date: "2026-11-20", raw_excerpt: expect.stringContaining("靠窗") });

    const secondWriter = createService(test.config);
    cleanup.push(secondWriter.close);
    secondWriter.start();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    test.fast.options.beforeAnalysis = async ({ document }) => {
      if (document.filename !== "revision.md") return;
      entered.resolve();
      await gate.promise;
    };
    const update = {
      ...ref, mode: "async", idempotency_key: "update-seat",
      items: [{ filename: "revision.md", doc_date: "2026-11-23", content: "差旅座位从靠窗改为过道。此更新替换之前的高铁座位偏好。" }],
    };
    const updating = await test.json("/v1/memories/ingest", update);
    const { job_id: updatingId } = await updating.json();
    expect(updating.status).toBe(202);
    try {
      await Promise.race([entered.promise, new Promise<void>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Analyzer did not reach the gate")), 3000);
        timer.unref();
      })]);
      expect(await test.job(updatingId)).toMatchObject({ status: "extracting", progress: { completed: 0, total: 1 } });
      const observed = await Promise.all(Array.from({ length: 7 }, () => test.retrieve("高铁座位偏好是什么？")));
      expect(observed.every(({ snapshot_version, contexts }) => snapshot_version === 1 && contexts.some(({ content }) => content.includes("靠窗")))).toBe(true);
      const rollbackBusy = await secondWriter.app.request(`${spacePath}/rollback`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1 }),
      });
      expect(rollbackBusy.status).toBe(409);
    } finally {
      gate.resolve();
    }
    const second = await test.wait(updatingId);
    expect(second, second.error_message ?? "").toMatchObject({ status: "published", target_version: 2 });
    const latest = await test.retrieve("高铁座位偏好是什么？", { return_mode: "answer", verify_raw_sources: true });
    expect(latest).toMatchObject({ snapshot_version: 2, contexts: [], answer: expect.stringContaining("过道") });
    expect(latest.answer).not.toContain("靠窗");
    expect(latest.citations[0]).toMatchObject({ filename: "revision.md", raw_excerpt: expect.stringContaining("从靠窗改为过道") });
    const audit = await test.retrieve("高铁座位偏好有哪些冲突修订记录？");
    expect(audit.contexts.some(({ content }) => /过道.*supersedes:.*靠窗/.test(content))).toBe(true);

    const same = await test.json("/v1/memories/ingest", { ...update, mode: "sync" });
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ job_id: updatingId, target_version: 2 });
    const mismatch = await test.json("/v1/memories/ingest", { ...update, items: [{ ...update.items[0], content: "其他内容" }] });
    expect(mismatch.status).toBe(409);
    const calls = test.fast.requests.length + test.strong.requests.length;
    const duplicate = await test.json("/v1/memories/ingest", { ...update, mode: "sync", idempotency_key: "another-key" });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      status: "published", target_version: 2, usage: { total_tokens: 0, llm_calls: 0 },
      accepted_docs: [{ dedup_status: "duplicate" }],
    });
    expect(test.fast.requests.length + test.strong.requests.length).toBe(calls);

    const dream = await test.json("/v1/memories/dream", ref);
    expect(dream.status).toBe(202);
    expect(await test.wait((await dream.json()).job_id)).toMatchObject({ status: "published", job_type: "dream", target_version: 3 });
    const rollback = await test.json(`${spacePath}/rollback`, { version: 1 });
    expect(await rollback.json()).toMatchObject({ current_version: 1 });
    expect((await test.retrieve("高铁座位偏好是什么？")).contexts[0].content).toContain("靠窗");
    expect((await test.retrieve("高铁座位偏好是什么？", { snapshot_version: 2 })).contexts[0].content).toContain("过道");
    const callsBeforeReplay = test.fast.requests.length + test.strong.requests.length;
    const replay = await test.json("/v1/memories/ingest", { ...update, mode: "sync", idempotency_key: "after-rollback" });
    expect(await replay.json()).toMatchObject({ status: "published", target_version: 1, usage: { llm_calls: 0 } });
    expect(test.fast.requests.length + test.strong.requests.length).toBe(callsBeforeReplay);
    const updated = await test.json(spacePath, { purpose: "维护已确认的会议安排" }, "PATCH");
    expect(await updated.json()).toMatchObject({ purpose: "维护已确认的会议安排", current_version: 1 });
    expect(await test.app.request(`${spacePath}/file?path=../raw/blobs`)).toHaveProperty("status", 400);
  }, 20_000);

  it("publishes through a tool-less gateway and leaves the previous snapshot visible when lint repair is exhausted", async () => {
    const test = await setup({ rejectTools: true });
    const upload = (name: string, content: string) => test.json("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync", items: [{ filename: name, content }],
    });
    const accepted = await upload("baseline.md", "上海差旅时，我的高铁座位偏好是靠窗。");
    expect(await accepted.json()).toMatchObject({ status: "published", target_version: 1 });
    expect(test.strong.requests.map(({ native }) => native)).toEqual([true, false]);

    test.strong.options.lint = "reject";
    const rejected = await upload("change.md", "高铁座位从靠窗改为过道。");
    expect(await rejected.json()).toMatchObject({ status: "failed", error_message: expect.stringContaining("after two repairs") });
    const tree = treeResultSchema.parse(await (await test.app.request(`${spacePath}/tree`)).json());
    expect(tree.snapshot?.version).toBe(1);
    expect(tree.versions).toHaveLength(1);
    expect((await test.retrieve("高铁座位偏好是什么？")).contexts[0].content).toContain("靠窗");
    expect(await readdir(join(test.data, "spaces", ref.namespace, ref.space_id, "snapshots"))).toEqual(["v1"]);
  }, 14_000);

  it("documents both ingest media types and serves the OpenAPI 3.1 contract", async () => {
    const test = await setup();
    const spec = await test.app.request("/openapi.json");
    const payload = await spec.json();
    expect(spec.status, JSON.stringify(payload)).toBe(200);
    expect(payload.openapi).toBe("3.1.0");
    expect(payload.paths["/v1/memories/ingest"].post.requestBody).toMatchObject({
      required: true,
      content: { "application/json": expect.any(Object), "multipart/form-data": expect.any(Object) },
    });
    expect(await (await test.app.request("/docs")).text()).toContain("/openapi.json");
  });
});
