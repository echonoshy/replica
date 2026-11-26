import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findAnchors, INDEX_MAX_BYTES, INDEX_MAX_LINES, jobResultSchema, retrieveResultSchema, treeResultSchema } from "@wiki-memory/shared";
import type { Space } from "@wiki-memory/shared";
import { SQLiteChatStore } from "../apps/api/src/chat/chat-store.js";
import { readConfig } from "../apps/api/src/config.js";
import { SQLiteConnection } from "../apps/api/src/db/sqlite-repo.js";
import { OpenAiGateway } from "../apps/api/src/llm/openai-gateway.js";
import type { AtomicFact, Claim } from "../apps/api/src/pipeline/analyzer.js";
import { lintDraft } from "../apps/api/src/pipeline/linter.js";
import { compileWiki, vocabularyOf } from "../apps/api/src/pipeline/wiki-compiler.js";
import { extractWikiLinks } from "../apps/api/src/retrieval/navigator.js";
import { readPage } from "../apps/api/src/pipeline/wiki-markdown.js";
import { createService } from "../apps/api/src/service.js";
import { startFixtureGateway } from "./fixtures/gateway.js";
import type { GatewayOptions } from "./fixtures/gateway.js";

const ref = { namespace: "agent", space_id: "optimizations" };
const key = "agent:optimizations";
const purpose = "Record durable preferences, procedures and project decisions";
const admin = "/v1/admin/spaces/agent/optimizations";
const chat = "/v1/chat/spaces/agent/optimizations";
const now = "2026-11-24T02:00:00.000Z";
const finish = { name: "finish", arguments: { summary: "Draft reviewed" } };
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.useRealTimers();
  }
});

async function setup(options: GatewayOptions = {}, env: NodeJS.ProcessEnv = {}) {
  const data = await mkdtemp(join(tmpdir(), "memory-optimizations-"));
  cleanup.push(() => rm(data, { recursive: true, force: true }));
  const gateway = await startFixtureGateway(options);
  cleanup.push(gateway.close);
  const config = readConfig({
    DATA_DIR: data, LLM_BASE_URL: gateway.baseUrl, LLM_API_KEY: "fixture",
    PROACTIVE_ENABLED: "false", DREAM_POLL_MINUTES: "0", SYNC_WAIT_MS: "4000", ...env,
  });
  const service = createService(config);
  cleanup.push(service.close);
  service.start();
  const app = service.app;
  const connection = new SQLiteConnection(data);
  cleanup.push(() => connection.close());
  const chatStore = new SQLiteChatStore(connection.client);
  const json = (path: string, payload: unknown) => app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const ingest = async (...items: Array<{ filename: string; content: string; doc_date?: string }>) => {
    const response = await json("/v1/memories/ingest", { ...ref, purpose, mode: "sync", items });
    expect(response.status).toBe(200);
    const result = jobResultSchema.parse(await response.json());
    expect(result.status, result.error_message ?? "").toBe("published");
    return result;
  };
  const file = (version: number, path: string) =>
    readFile(join(data, "spaces", ref.namespace, ref.space_id, "snapshots", `v${version}`, path), "utf8");
  const claims = async (version: number) => JSON.parse(await file(version, "_claims.json")) as Claim[];
  const tree = async () => treeResultSchema.parse(await (await app.request(`${admin}/tree`)).json());
  const wait = (id: string, status = "published") => vi.waitFor(async () => {
    const result = jobResultSchema.parse(await (await app.request(`/v1/memories/jobs/${id}`)).json());
    expect(result.status, result.error_message ?? "").toBe(status);
    return result;
  }, { timeout: 4000 });
  const addSpace = async () => expect((await json("/v1/admin/spaces", { ...ref, purpose })).status).toBe(200);
  const createChat = async () => {
    const response = await json(`${chat}/sessions`, { session_date: "2026-11-20" });
    expect(response.status).toBe(201);
    const { session } = await response.json() as { session: { session_id: string } };
    return session.session_id;
  };
  const send = async (id: string, content: string) => {
    const response = await json(`/v1/chat/sessions/${id}/messages`, { content });
    expect(response.status).toBe(200);
  };
  const digest = async () => {
    const response = await json(`${chat}/dream`, {});
    expect(response.status).toBe(202);
    const body = await response.json() as { mode: string; job: unknown };
    expect(body.mode).toBe("digest_pending");
    return jobResultSchema.parse(body.job);
  };
  const source = (doc_id: string, locator: string, version?: number) => {
    const params = new URLSearchParams({ doc_id, locator });
    if (version) params.set("version", String(version));
    return app.request(`${admin}/source?${params}`);
  };
  return { app, gateway, chatStore, json, ingest, file, claims, tree, wait, addSpace, createChat, send, digest, source };
}

type ExtractionInput = Parameters<NonNullable<GatewayOptions["extract"]>>[0];
const extraction = (facts: object[], summary = "Source evidence reviewed") => ({
  summary, entities: [], facts, conflicts: [], timeline_events: [],
});
const workflow = { kind: "topic", subject: "Release workflow" } as const;

describe("memory pipeline optimizations", () => {
  it("consolidates overlapping claims and archives a completed schedule across later ingests", async () => {
    const test = await setup({
      extract: ({ segments }) => extraction(segments.flatMap(({ locator, text }) => {
        if (text.includes("guide-old")) return [{
          ...workflow, locator, predicate: "Schema check", value: "Validate the response schema",
          related: [{ kind: "topic", subject: "API guide" }],
        }];
        if (text.includes("guide-new")) return [{
          ...workflow, locator, predicate: "Response validation", value: "Validate responses against their schema",
          related: [{ kind: "topic", subject: "Testing guide" }],
        }];
        if (text.includes("guide-middle")) return [{
          ...workflow, locator, predicate: "Response schema", value: "Check the schema on every response",
        }];
        if (text.includes("schedule-closed")) return [{
          ...workflow, locator, predicate: "One-time walkthrough", value: "Walkthrough on 2001-01-21 was completed",
        }];
        return [{ kind: "topic", subject: "Shipping", locator, predicate: "Access", value: "Open a review request first" }];
      })),
      organize: ({ stage, messages, tools }) => {
        if (stage === "organizer") return [finish];
        expect(tools).toEqual(expect.arrayContaining(["merge_claims", "archive_claim"]));
        if (messages.length === 2) return [
          { name: "merge_claims", arguments: {
            ...workflow, source_predicates: ["Schema check", "Response schema", "Response validation"],
            target_predicate: "Schema validation", merged_value: "Validate each response against its schema",
          } },
          { name: "archive_claim", arguments: {
            ...workflow, predicate: "One-time walkthrough", reason: "Completed on 2001-01-21",
          } },
        ];
        const results = messages.filter(({ role }) => role === "tool").map(({ content }) => JSON.parse(content!));
        expect(results).toMatchObject([{ merged: 3 }, { archived: 1 }]);
        return [finish];
      },
    });
    const first = await test.ingest(
      { filename: "original.md", content: "schedule-closed\n\nguide-old", doc_date: "2001-01-21" },
      { filename: "reference.md", content: "guide-middle", doc_date: "2001-01-22" },
      { filename: "update.md", content: "guide-new", doc_date: "2001-01-23" },
    );
    const [old, middle, newest] = first.accepted_docs.map(({ doc_id }) => doc_id);
    const path = (await test.tree()).files.find((entry) => entry.startsWith("topics/release-workflow-"))!;
    expect(await test.file(1, path)).toContain("One-time walkthrough");
    const response = await test.json("/v1/memories/dream", ref);
    expect(response.status).toBe(202);
    await test.wait(jobResultSchema.parse(await response.json()).job_id);
    expect((await test.tree()).snapshot?.lint.issues).toEqual([]);

    const mergedLine = `- **Release workflow · Schema validation** · Validate each response against its schema [src:${newest}#s1] [src:${old}#s2] [src:${middle}#s1]`;
    const archivedLine = `梦境归档（Completed on 2001-01-21） · “Walkthrough on 2001-01-21 was completed”（2001-01-21） [src:${old}#s1]`;
    async function expectConsolidated(version: number) {
      const page = await test.file(version, path);
      expect(page).toContain(mergedLine);
      expect(page.match(/^-\s\*\*/gm)).toHaveLength(1);
      expect(page).not.toMatch(/Response validation|Response schema|Schema check|One-time walkthrough/);
      expect(await test.file(version, "conflicts.md")).toContain(archivedLine);
      expect(await test.claims(version)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          predicate: "Schema validation", docId: newest, extra_sources: [{ docId: old, locator: "s2" }, { docId: middle, locator: "s1" }],
          related: expect.arrayContaining([{ kind: "topic", subject: "API guide" }, { kind: "topic", subject: "Testing guide" }]),
        }),
        expect.objectContaining({
          predicate: "One-time walkthrough", archived: {
            reason: "Completed on 2001-01-21", archived_at: expect.any(String),
          },
        }),
      ]));
    }
    await expectConsolidated(2);
    const overview = await test.app.request("/v1/demo/spaces/agent/optimizations/overview");
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({
      stats: { fact_count: 1 },
      claims: { facts: [{ predicate: "Schema validation" }] },
      conflicts: [{ type: "archived", anchors: [`${old}#s1`], parsed: null }],
    });
    await test.ingest({ filename: "later.md", content: "new shipping procedure" });
    await expectConsolidated(3);
    expect((await test.tree()).snapshot?.lint.issues).toEqual([]);

    const forgotten = await test.json("/v1/memories/forget", { ...ref, mode: "sync", doc_ids: [newest] });
    expect(jobResultSchema.parse(await forgotten.json())).toMatchObject({ status: "published", target_version: 4, usage: { llm_calls: 0 } });
    expect(findAnchors(await test.file(4, path)).map(({ anchor }) => anchor)).toEqual([`${old}#s2`, `${middle}#s1`]);
    expect(await test.claims(4)).toEqual(expect.arrayContaining([expect.objectContaining({
      predicate: "Schema validation", docId: old, locator: "s2", docDate: "2001-01-21",
      extra_sources: [{ docId: middle, locator: "s1" }],
    })]));
    expect((await test.source(old, "s2")).status).toBe(200);
    expect(await test.file(4, "conflicts.md")).toContain(archivedLine);

    const secondary = await test.json("/v1/memories/forget", { ...ref, mode: "sync", doc_ids: [middle] });
    expect(jobResultSchema.parse(await secondary.json())).toMatchObject({ status: "published", target_version: 5, usage: { llm_calls: 0 } });
    expect(findAnchors(await test.file(5, path)).map(({ anchor }) => anchor)).toEqual([`${old}#s2`]);

    const lastSource = await test.json("/v1/memories/forget", { ...ref, mode: "sync", doc_ids: [old] });
    expect(jobResultSchema.parse(await lastSource.json())).toMatchObject({ status: "published", target_version: 6, usage: { llm_calls: 0 } });
    expect(await test.file(6, "conflicts.md")).not.toContain(old);
    expect(await test.claims(6)).toMatchObject([{ subject: "Shipping" }]);
  });

  it("extracts only new turns when re-dreaming a session and keeps citations in both versions", async () => {
    const analyzed: ExtractionInput[] = [];
    const test = await setup({
      beforeAnalysis: async (input) => { analyzed.push(input); },
      extract: ({ segments }) => extraction(segments.flatMap(({ locator, text }) => {
        if (text.includes("turn-one")) return [
          { ...workflow, locator, predicate: "Seat", value: "靠窗" },
          { ...workflow, locator, predicate: "Runbook", value: "Open the deployment runbook" },
        ];
        if (text.includes("turn-two")) return [{ ...workflow, locator, predicate: "Receipt", value: "Keep the original receipt" }];
        return [
          { ...workflow, locator, predicate: "Seat", value: " “靠窗。” " },
          { ...workflow, locator, predicate: "Checklist", value: "Run the smoke tests" },
        ];
      })),
    });
    await test.addSpace();
    const sessionId = await test.createChat();
    await test.send(sessionId, "turn-one seat");
    await test.send(sessionId, "turn-two receipt");
    const first = await test.digest();
    const previousDoc = first.accepted_docs[0].doc_id;
    await test.wait(first.job_id);
    expect(analyzed.map(({ segments }) => segments.map(({ locator }) => locator))).toEqual([["t1", "t2"]]);

    await test.send(sessionId, "turn-three checklist");
    const currentSession = await (await test.app.request(`/v1/chat/sessions/${sessionId}`)).json();
    expect(currentSession).toMatchObject({ session: { status: "pending", dreamed_message_count: 4, message_count: 6 } });
    const second = await test.digest();
    const nextDoc = second.accepted_docs[0].doc_id;
    expect(second.accepted_docs[0]).toMatchObject({ replaces_doc_id: previousDoc, analyze_from_turn: 3 });
    expect(nextDoc).not.toBe(previousDoc);
    await test.wait(second.job_id);
    expect(analyzed.map(({ segments }) => segments.map(({ locator }) => locator))).toEqual([["t1", "t2"], ["t3"]]);
    expect(analyzed[1].segments[0].text).toContain("turn-three checklist");
    expect(analyzed[1].segments[0].text).not.toMatch(/turn-one|turn-two/);

    const v2 = await test.tree();
    expect(v2.snapshot).toMatchObject({ version: 2, document_count: 1, lint: { issues: [] } });
    const path = v2.files.find((entry) => entry.startsWith("topics/release-workflow-"))!;
    expect(await test.file(2, path)).toContain(`Open the deployment runbook [src:${nextDoc}#t1]`);
    expect(await test.file(2, path)).toContain(`Keep the original receipt [src:${nextDoc}#t2]`);
    expect(await test.file(2, path)).toContain(`Run the smoke tests [src:${nextDoc}#t3]`);
    expect(await test.file(2, "conflicts.md")).not.toMatch(/supersedes|同日冲突/);
    expect((await test.claims(2)).map(({ docId }) => docId)).toEqual(Array(5).fill(nextDoc));
    for (const [index, text] of ["turn-one seat", "turn-two receipt", "turn-three checklist"].entries()) {
      const response = await test.source(nextDoc, `t${index + 1}`, 2);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ raw_excerpt: expect.stringContaining(text) });
    }
    expect((await test.source(previousDoc, "t1", 2)).status).toBe(404);
    expect((await test.json(`${admin}/rollback`, { version: 1 })).status).toBe(200);
    expect(await (await test.source(previousDoc, "t1")).json()).toMatchObject({
      raw_excerpt: expect.stringContaining("turn-one seat"),
    });
  });

  it("restores the last published chat document after a failed digest and tracks messages added in flight", async () => {
    const test = await setup();
    await test.addSpace();
    const session = await test.createChat();
    await test.send(session, "Record the original release policy");
    const first = await test.digest();
    await test.wait(first.job_id);
    await test.app.request(`${chat}/sessions`);
    const docId = first.accepted_docs[0].doc_id;

    await test.send(session, "Add the fallback release policy");
    test.gateway.options.lint = "reject";
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    test.gateway.options.beforeAnalysis = async () => { entered.resolve(); await gate.promise; };
    const second = await test.digest();
    try {
      await entered.promise;
      test.chatStore.appendMessage({ sessionId: session, role: "user", content: "Add another release rule" });
      expect(test.chatStore.getSession(session)?.status).toBe("dreaming");
    } finally {
      gate.resolve();
    }
    await test.wait(second.job_id, "failed");
    await test.app.request(`${chat}/sessions`);
    expect(test.chatStore.getSession(session)).toMatchObject({
      status: "pending", dreamed_version: 1, dreamed_doc_id: docId, dreamed_message_count: 2, message_count: 5,
    });

    test.gateway.options.lint = "accept";
    const retry = await test.digest();
    expect(retry.accepted_docs[0]).toMatchObject({ replaces_doc_id: docId, analyze_from_turn: 2 });
    await test.wait(retry.job_id);
    await test.app.request(`${chat}/sessions`);
    expect(test.chatStore.getSession(session)).toMatchObject({ status: "dreamed", dreamed_message_count: 5 });
  });

  it("auto-digests idle pending chats at the threshold and leaves a recent session pending", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const test = await setup({}, { DREAM_POLL_MINUTES: "1", DREAM_MIN_INCREMENTAL: "2" });
    await test.addSpace();
    const idle = new Date(Date.now() - 90_000).toISOString();
    for (const id of ["idle-one", "idle-two", "recent"]) {
      const createdAt = id === "recent" ? new Date().toISOString() : idle;
      test.chatStore.createSession({ sessionId: id, spaceKey: key, createdAt });
      test.chatStore.appendMessage({ sessionId: id, role: "user", content: "Keep the original railway receipt", createdAt });
    }
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => {
      const response = await test.app.request(`${chat}/sessions`);
      expect(await response.json()).toMatchObject({ pending_count: 1, dreaming_count: 0 });
    }, { timeout: 4000 });
    expect(test.chatStore.listSessions(key)).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: "idle-one", status: "dreamed", dreamed_version: 1 }),
      expect.objectContaining({ session_id: "idle-two", status: "dreamed", dreamed_version: 1 }),
      expect.objectContaining({ session_id: "recent", status: "pending", dreamed_version: null }),
    ]));
    expect((await test.tree()).snapshot).toMatchObject({ version: 1, document_count: 2, lint: { issues: [] } });
  });

  it("prioritizes historical vocabulary and makes large collections navigable within the index limits", () => {
    const subjects = Array.from({ length: 250 }, (_, index): AtomicFact => ({
      tier: index >= 100 ? "pinned_redline" : "working",
      kind: index % 2 ? "entity" : "topic", subject: `运营项目${String(index).padStart(3, "0")}`,
      predicate: `Rule ${index}`, value: `Field ${index}`, cardinality: "one", related: [],
      docId: `doc_${index}`, docDate: "2026-11-20", locator: "s1",
    }));
    expect(vocabularyOf(subjects, "请查阅运营项目０００的工作说明", 180)[0]).toMatchObject({
      subject: "运营项目000", predicate: "Rule 0",
    });
    expect(vocabularyOf(subjects)).toHaveLength(250);

    const space: Space = {
      ...ref, purpose, current_version: 0, incremental_since_dream: 0, last_dreamed_at: null, document_count: 0, page_count: 0,
    };
    const claims = subjects.slice(0, 140);
    const draft = new Map<string, string>();
    const { evidence, required } = compileWiki(draft, space, 1, claims.map(({ docId }) => docId), [], claims, now);
    const index = draft.get("_index.md")!;
    const direct = extractWikiLinks("_index.md", index);
    const hubs = direct.filter((path) => path.startsWith("topics/hub-"));
    const priority = direct.filter((path) => /^(entities|topics)\//.test(path) && !hubs.includes(path));
    expect(priority).toHaveLength(80);
    expect([...draft.keys()].some((path) => /\/collection-\d+\.md$/.test(path))).toBe(false);
    const tail = hubs.flatMap((hub) => extractWikiLinks(hub, draft.get(hub)!));
    expect(tail.some((path) => path.startsWith("entities/"))).toBe(true);
    expect(tail.some((path) => path.startsWith("topics/"))).toBe(true);
    const reachable = [...priority, ...tail];
    expect(reachable).toHaveLength(claims.length);
    const subjectsByTitle = new Map(reachable.map((path) => [readPage(draft.get(path)!).frontmatter?.title, path]));
    for (const claim of claims) {
      const path = subjectsByTitle.get(claim.subject)!;
      expect(path).toMatch(claim.kind === "entity" ? /^entities\// : /^topics\//);
      expect(draft.get(path)).toContain(`${claim.value} [src:${claim.docId}#s1]`);
      if (claim.tier === "pinned_redline") expect(priority).toContain(path);
    }
    const report = lintDraft(draft, evidence, required);
    expect(report).toMatchObject({ orphan_pages: 0, broken_links: 0 });
    expect(report.index_lines).toBeLessThanOrEqual(INDEX_MAX_LINES);
    expect(report.index_bytes).toBeLessThanOrEqual(INDEX_MAX_BYTES);
    expect(report.issues).toEqual([]);
  });

  it("passes bounded staging note summaries to Organizer and exposes claim tools only during Dreaming", async () => {
    const received: Array<{ doc_id: string; summary: string }> = [];
    const test = await setup({
      extract: () => extraction([], `Procedure review notes. ${"Supporting details. ".repeat(35)}`),
      organize: ({ tools, staging_notes }) => {
        expect(tools).not.toContain("merge_claims");
        expect(tools).not.toContain("archive_claim");
        received.push(...staging_notes ?? []);
        return [finish];
      },
    });
    const first = await test.ingest(...Array.from({ length: 13 }, (_, index) => ({
      filename: `note-${index}.md`, content: `Guidance ${index}`,
    })));
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThanOrEqual(12);
    expect(received.every(({ doc_id, summary }) => first.accepted_docs.some((doc) => doc.doc_id === doc_id)
      && summary.includes("Procedure review notes") && summary.length <= 400)).toBe(true);
    expect(received.reduce((total, note) => total + note.summary.length, 0)).toBeLessThanOrEqual(4000);
  });

  it("retracts a document from current memory without an LLM call and forgets a deleted chat's Wiki memory", async () => {
    const test = await setup({
      extract: ({ segments }) => extraction(segments.map(({ locator, text }) => {
        const record = text.includes("forgetquartz") ? "forgetquartz"
          : text.includes("chatamethyst") ? "chatamethyst" : "keepcitrine";
        return { kind: "topic", subject: record, predicate: "Current procedure", value: `Documented ${record} rule`, locator };
      })),
    });
    const first = await test.ingest(
      { filename: "forget.md", content: "forgetquartz original" }, { filename: "keep.md", content: "keepcitrine original" },
    );
    const [forgotten, kept] = first.accepted_docs.map(({ doc_id }) => doc_id);
    const retrieve = async (query: string) => retrieveResultSchema.parse(
      await (await test.json("/v1/memories/retrieve", { ...ref, query })).json());
    expect((await retrieve("forgetquartz")).contexts).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining("Documented forgetquartz rule") }),
    ]));
    const requests = test.gateway.requests.length;
    const forget = { ...ref, doc_ids: [forgotten], mode: "sync", idempotency_key: "forget-quartz" };
    const response = await test.json("/v1/memories/forget", forget);
    expect(response.status).toBe(200);
    const result = jobResultSchema.parse(await response.json());
    expect(result).toMatchObject({ status: "published", target_version: 2, usage: { llm_calls: 0 } });
    expect(jobResultSchema.parse(await (await test.json("/v1/memories/forget", forget)).json()).job_id).toBe(result.job_id);
    expect((await test.json("/v1/memories/forget", { ...forget, doc_ids: [kept] })).status).toBe(409);
    expect(test.gateway.requests).toHaveLength(requests);
    const v2 = await test.tree();
    expect(v2.snapshot).toMatchObject({ version: 2, document_count: 1, lint: { issues: [] } });
    expect(v2.files.some((path) => path.includes("forgetquartz"))).toBe(false);
    expect(await test.file(2, "_index.md")).not.toContain("forgetquartz");
    expect(await test.claims(2)).toMatchObject([{ docId: kept, value: "Documented keepcitrine rule" }]);
    expect((await retrieve("forgetquartz")).contexts).toEqual([]);
    expect((await retrieve("keepcitrine")).contexts[0]?.citations[0]?.doc_id).toBe(kept);
    expect((await test.source(forgotten, "s1")).status).toBe(404);
    expect((await test.source(forgotten, "s1", 1)).status).toBe(200);

    const session = await test.createChat();
    await test.send(session, "chatamethyst original");
    const digest = await test.digest();
    await test.wait(digest.job_id);
    expect((await retrieve("chatamethyst")).contexts).toHaveLength(1);
    const beforeDelete = test.gateway.requests.length;
    const deleted = await test.app.request(`/v1/chat/sessions/${session}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const body = await deleted.json() as { deleted: boolean; forget_job_id: string };
    expect(body).toMatchObject({ deleted: true, forget_job_id: expect.stringMatching(/^job_/) });
    expect(await test.wait(body.forget_job_id)).toMatchObject({ target_version: 4, usage: { llm_calls: 0 } });
    expect(test.gateway.requests).toHaveLength(beforeDelete);
    expect((await retrieve("chatamethyst")).contexts).toEqual([]);
    expect((await retrieve("keepcitrine")).contexts).toHaveLength(1);
    expect(test.chatStore.searchConversations(key, "chatamethyst")).toEqual([]);
    expect(await test.claims(4)).toMatchObject([{ docId: kept }]);
  });

  it("accepts framing and missing-evidence paragraphs while enforcing citations on factual answers", async () => {
    const test = await setup();
    const { accepted_docs: [doc] } = await test.ingest({ filename: "rail.md", content: "我的高铁座位偏好是靠窗。" });
    const tag = `[src:${doc.doc_id}#s1]`;
    const cited = `高铁座位偏好是靠窗。${tag}`;
    const gap = "现有资料未提及违约金条款。";
    let answer = "";
    const complete = OpenAiGateway.prototype.complete;
    const mock = vi.spyOn(OpenAiGateway.prototype, "complete").mockImplementation(function (this: OpenAiGateway, ...args) {
      if (args[1][0]?.content?.toString().startsWith("Answer in")) {
        return Promise.resolve({
          id: "synthesis", object: "chat.completion", created: 0, model: "fixture",
          choices: [{ index: 0, finish_reason: "stop", logprobs: null,
            message: { role: "assistant", content: JSON.stringify({ answer }), refusal: null } }],
        });
      }
      return complete.apply(this, args);
    });
    cleanup.push(() => { mock.mockRestore(); });
    const retrieve = () => test.json("/v1/memories/retrieve", {
      ...ref, query: "高铁座位偏好是什么？违约金条款呢？", return_mode: "answer",
    });
    for (const disclaimer of [gap, "根据现有资料，无法确认违约金。", "The supplied passages do not cover penalties."]) {
      answer = ["关于这两个问题，说明如下：", cited, disclaimer].join("\n\n");
      const response = await retrieve();
      expect(response.status, answer).toBe(200);
      expect(await response.json()).toMatchObject({ answer, citations: [{ anchor: `${doc.doc_id}#s1` }] });
    }

    for (answer of [
      gap,
      [cited, "- 违约金是五万元。"].join("\n\n"),
      [cited, "违约金是五万元："].join("\n\n"),
      [cited, gap + "违约金是五万元。"].join("\n\n"),
      [cited, gap + "[src:doc_missing#s1]"].join("\n\n"),
      [cited, gap + "[src:broken]"].join("\n\n"),
    ]) {
      const invalid = await retrieve();
      expect(invalid.status, answer).toBe(502);
      expect(await invalid.json()).toMatchObject({ error: { code: "LLM_INVALID_OUTPUT" } });
    }
  });

  it("recalls pending evidence for both clients when the first clause fills the available slots", async () => {
    const { chatStore } = await setup();
    const first = "星海制造最终报价和违约金条款是什么";
    const second = "锦程医药 12 月 3 日演示有什么注意事项";
    for (const id of ["报价一", "报价二", "报价三", "锦程", "当前"]) {
      chatStore.createSession({ sessionId: id, title: id, spaceKey: key });
      const content = id === "锦程" ? "锦程医药的演示只用脱敏数据。" : id === "当前" ? second : first;
      for (let turn = 0; turn < 3; turn++) chatStore.appendMessage({ sessionId: id, role: "user", content });
    }
    const opts = { limit: 6, maxPerSession: 2, excludeSessionId: "当前" };
    expect(chatStore.searchConversations(key, first + " " + second, opts).every((hit) => hit.session_id !== "锦程")).toBe(true);
    const hits = chatStore.searchConversations(key, first + "？" + second + "？", opts);
    expect(hits).toHaveLength(6);
    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_status: "pending", session_id: expect.stringMatching(/^报价/) }),
      expect.objectContaining({ session_status: "pending", session_id: "锦程", excerpt: expect.stringContaining("脱敏数据") }),
    ]));
    expect(hits.some((hit) => hit.session_id === "当前")).toBe(false);
    expect(chatStore.searchConversations(key, ["unmatched", first, second].join("；"), opts))
      .toEqual(expect.arrayContaining([expect.objectContaining({ session_id: "锦程" })]));
    for (const id of new Set(hits.map(({ session_id }) => session_id))) {
      expect(hits.filter((hit) => hit.session_id === id).length).toBeLessThanOrEqual(2);
    }
  });

  it("prefers pending conversation turns on a lexical tie while preserving match priority", async () => {
    const test = await setup();
    for (const id of ["dreamed", "pending"]) {
      test.chatStore.createSession({
        sessionId: id, spaceKey: key, title: "Planning", status: id === "dreamed" ? "dreamed" : "pending",
      });
      test.chatStore.appendMessage({ sessionId: id, role: "user", content: "release checklist", preserveStatus: true });
    }
    expect(test.chatStore.searchConversations(key, "checklist").map(({ session_id }) => session_id))
      .toEqual(["pending", "dreamed"]);
    test.chatStore.appendMessage({ sessionId: "dreamed", role: "user", content: "release checklist emergency", preserveStatus: true });
    expect(test.chatStore.searchConversations(key, "checklist emergency")[0]?.session_id).toBe("dreamed");
  });

  it("prioritizes multi-turn pending sessions over dreamed sessions when prioritizePending is enabled", async () => {
    const { chatStore } = await setup();
    for (const id of ["old_1", "old_2", "old_3"]) {
      chatStore.createSession({ sessionId: id, spaceKey: key, title: "莫干山攻略", status: "dreamed" });
      chatStore.appendMessage({ sessionId: id, role: "user", content: "莫干山住宿预算方案参考", preserveStatus: true });
      chatStore.appendMessage({ sessionId: id, role: "assistant", content: "记下了。", preserveStatus: true });
    }
    chatStore.createSession({ sessionId: "pending_trip", spaceKey: key, title: "莫干山滑梯房能带狗吗", status: "pending" });
    chatStore.appendMessage({ sessionId: "pending_trip", role: "user", content: "12月19号带娃和狗去莫干山住一晚。" });
    chatStore.appendMessage({ sessionId: "pending_trip", role: "assistant", content: "好的，先按一晚看。" });
    chatStore.appendMessage({ sessionId: "pending_trip", role: "user", content: "预算卡死每晚不超过 1500 元，含清洁费。" });
    chatStore.appendMessage({ sessionId: "pending_trip", role: "assistant", content: "实付总价 1500 元以内。" });
    chatStore.appendMessage({ sessionId: "pending_trip", role: "user", content: "莫干山庭院房要确认狗能进滑梯房，今天先不订。" });
    chatStore.appendMessage({ sessionId: "pending_trip", role: "assistant", content: "已记为待选住宿。" });

    const hits = chatStore.searchConversations(key, "海鲜过敏怎么办？拾光记怎么收费？莫干山住宿预算多少？", {
      limit: 8, maxPerSession: 2, maxPendingPerSession: 4, prioritizePending: true,
    });
    const pendingHits = hits.filter((h) => h.session_id === "pending_trip");
    expect(pendingHits.length).toBe(3);
    expect(pendingHits.some((h) => h.excerpt.includes("1500 元"))).toBe(true);
    expect(hits[0]?.session_status).toBe("pending");
  });
});
