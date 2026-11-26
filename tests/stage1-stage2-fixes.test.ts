import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobResultSchema, retrieveResultSchema } from "@wiki-memory/shared";
import { SQLiteChatStore } from "../apps/api/src/chat/chat-store.js";
import { readConfig } from "../apps/api/src/config.js";
import { SQLiteConnection, SQLiteLexicalSearch } from "../apps/api/src/db/sqlite-repo.js";
import { OpenAiGateway } from "../apps/api/src/llm/openai-gateway.js";
import type { Claim } from "../apps/api/src/pipeline/analyzer.js";
import { compileWiki } from "../apps/api/src/pipeline/wiki-compiler.js";
import { relevantMarkdown } from "../apps/api/src/retrieval/token-budget.js";
import { createService } from "../apps/api/src/service.js";
import { startFixtureGateway } from "./fixtures/gateway.js";
import type { GatewayOptions } from "./fixtures/gateway.js";

const ref = { namespace: "personal", space_id: "stage12" };
const key = "personal:stage12";
const purpose = "记住陈默的个人约束、家庭安排与工作决定";
const admin = "/v1/admin/spaces/personal/stage12";
const chat = "/v1/chat/spaces/personal/stage12";
const finish = { name: "finish", arguments: { summary: "Draft reviewed" } };
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(options: GatewayOptions = {}) {
  const data = await mkdtemp(join(tmpdir(), "wiki-stage12-"));
  cleanup.push(() => rm(data, { recursive: true, force: true }));
  const gateway = await startFixtureGateway(options);
  cleanup.push(gateway.close);
  const config = readConfig({
    DATA_DIR: data, LLM_BASE_URL: gateway.baseUrl, LLM_API_KEY: "fixture",
    PROACTIVE_ENABLED: "false", DREAM_POLL_MINUTES: "0", SYNC_WAIT_MS: "4000",
  });
  const service = createService(config);
  cleanup.push(service.close);
  service.start();
  const app = service.app;
  const connection = new SQLiteConnection(data);
  cleanup.push(() => connection.close());
  const chatStore = new SQLiteChatStore(connection.client);
  const lexical = new SQLiteLexicalSearch(connection);
  const json = (path: string, payload: unknown) => app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const file = (version: number, path: string) =>
    readFile(join(data, "spaces", ref.namespace, ref.space_id, "snapshots", `v${version}`, path), "utf8");
  const claims = async (version: number) => JSON.parse(await file(version, "_claims.json")) as Claim[];
  const wait = (id: string) => vi.waitFor(async () => {
    const result = jobResultSchema.parse(await (await app.request(`/v1/memories/jobs/${id}`)).json());
    expect(result.status, result.error_message ?? "").toBe("published");
    return result;
  }, { timeout: 5000 });
  expect((await json("/v1/admin/spaces", { ...ref, purpose })).status).toBe(200);
  return { app, gateway, chatStore, lexical, json, file, claims, wait };
}

describe("Stage 1 & Stage 2 truth, consistency, and Personal Agent quality fixes", () => {
  it("P0-2: unmerges distinct retracted claims instead of leaving retracted clauses on unrelated citations", async () => {
    const test = await setup({
      extract: ({ segments }) => ({
        summary: "pickup", entities: [], conflicts: [], timeline_events: [],
        facts: segments.flatMap(({ locator, text }) => {
          if (text.includes("固定接送")) return [{
            kind: "entity", subject: "周然", predicate: "常规接送",
            value: "每周二、周四 17:30 周然本人固定接糖糖学游泳", locator, cardinality: "one", related: [],
          }];
          if (text.includes("外婆")) return [{
            kind: "entity", subject: "周然", predicate: "出差代接授权",
            value: "周然出差时周四可由外婆代接糖糖，需最迟周三通知外婆", locator, cardinality: "one", related: [],
          }];
          return [];
        }),
      }),
      organize: ({ stage, messages }) => {
        if (stage === "organizer") return [finish];
        if (messages.length === 2) return [{
          name: "merge_claims",
          arguments: {
            kind: "entity", subject: "周然",
            source_predicates: ["常规接送", "出差代接授权"],
            target_predicate: "接送安排（含出差外婆代接）",
            merged_value: "每周二四17:30周然固定接糖糖；出差时周四可由外婆代接（最迟周三通知）",
          },
        }];
        return [finish];
      },
    });
    const r1 = await test.json("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync",
      items: [
        { filename: "routine.md", doc_date: "2026-10-13", content: "每周二四17:30固定接送糖糖。" },
        { filename: "grandma.md", doc_date: "2026-11-22", content: "如果出差周四外婆可以代接糖糖。" },
      ],
    });
    const [routineDoc, grandmaDoc] = jobResultSchema.parse(await r1.json()).accepted_docs.map((d) => d.doc_id);
    const dreamRes = await test.json("/v1/memories/dream", ref);
    await test.wait(jobResultSchema.parse(await dreamRes.json()).job_id);
    const treeV2 = await (await test.app.request(`${admin}/tree`)).json() as { files: string[] };
    const zhouPage = treeV2.files.find((p) => p.startsWith("entities/"))!;
    expect(await test.file(2, zhouPage)).toContain("外婆");

    // Retract the ONLY document supporting Grandma authorization.
    const forgetRes = await test.json("/v1/memories/forget", { ...ref, mode: "sync", doc_ids: [grandmaDoc] });
    expect(jobResultSchema.parse(await forgetRes.json())).toMatchObject({ status: "published", target_version: 3 });
    const pageV3 = await test.file(3, zhouPage);
    expect(pageV3).not.toContain("外婆");
    expect(pageV3).toContain("周然本人固定接糖糖");
    expect(pageV3).toContain(`[src:${routineDoc}#s1]`);
  });

  it("P0-3: preserves real turn calendar dates when continuing an older session on a later day", async () => {
    const test = await setup({
      extract: ({ segments }) => ({
        summary: "coffee", entities: [], conflicts: [], timeline_events: [],
        facts: segments.flatMap(({ locator, text }) => {
          if (text.includes("300")) return [{
            kind: "entity", subject: "陈默", predicate: "每月咖啡预算", value: "300 元", locator, cardinality: "one", related: [],
          }];
          if (text.includes("500")) return [{
            kind: "entity", subject: "陈默", predicate: "每月咖啡预算", value: "500 元", locator, cardinality: "one", related: [],
          }];
          if (text.includes("清零")) return [{
            kind: "entity", subject: "陈默", predicate: "每月咖啡预算", value: "0 元（清零）", locator, cardinality: "one", related: [],
          }];
          return [];
        }),
      }),
    });
    // Session A created 2026-10-01
    test.chatStore.createSession({ sessionId: "sess_a", spaceKey: key, sessionDate: "2026-10-01", createdAt: "2026-10-01T02:00:00.000Z" });
    test.chatStore.appendMessage({ sessionId: "sess_a", role: "user", content: "每月咖啡预算 300 元", createdAt: "2026-10-01T02:00:01.000Z" });
    test.chatStore.appendMessage({ sessionId: "sess_a", role: "assistant", content: "记下了。", createdAt: "2026-10-01T02:00:02.000Z" });
    const d1 = await (await test.json(`${chat}/dream`, {})).json() as { job: { job_id: string } };
    await test.wait(d1.job.job_id);

    // Session B created 2026-10-10
    test.chatStore.createSession({ sessionId: "sess_b", spaceKey: key, sessionDate: "2026-10-10", createdAt: "2026-10-10T02:00:00.000Z" });
    test.chatStore.appendMessage({ sessionId: "sess_b", role: "user", content: "每月咖啡预算改为 500 元", createdAt: "2026-10-10T02:00:01.000Z" });
    test.chatStore.appendMessage({ sessionId: "sess_b", role: "assistant", content: "已更新。", createdAt: "2026-10-10T02:00:02.000Z" });
    const d2 = await (await test.json(`${chat}/dream`, {})).json() as { job: { job_id: string } };
    await test.wait(d2.job.job_id);

    // Continue Session A on 2026-10-20
    test.chatStore.appendMessage({ sessionId: "sess_a", role: "user", content: "复查后不喝咖啡了，预算清零", createdAt: "2026-10-20T02:00:01.000Z" });
    test.chatStore.appendMessage({ sessionId: "sess_a", role: "assistant", content: "好的，已清零。", createdAt: "2026-10-20T02:00:02.000Z" });
    const d3 = await (await test.json(`${chat}/dream`, {})).json() as { job: { job_id: string } };
    await test.wait(d3.job.job_id);

    const v3Claims = await test.claims(3);
    const zeroClaim = v3Claims.find((c) => "value" in c && c.value.includes("清零"));
    expect(zeroClaim?.docDate).toBe("2026-10-20");
    const treeV3 = await (await test.app.request(`${admin}/tree`)).json() as { files: string[] };
    const page = await test.file(3, treeV3.files.find((p) => p.startsWith("entities/"))!);
    expect(page).toContain("0 元（清零）");
    expect(page).not.toContain("500 元");
  });

  it("P0-4: reconciles chat_sessions on rollback so rolled-back sessions reset to pending and never emit dead src tags", async () => {
    const test = await setup();
    test.chatStore.createSession({ sessionId: "s1", spaceKey: key, sessionDate: "2026-11-01" });
    test.chatStore.appendMessage({ sessionId: "s1", role: "user", content: "高铁座位偏好是靠窗。" });
    const d1 = await (await test.json(`${chat}/dream`, {})).json() as { job: { job_id: string } };
    await test.wait(d1.job.job_id);

    test.chatStore.createSession({ sessionId: "s2", spaceKey: key, sessionDate: "2026-11-05" });
    test.chatStore.appendMessage({ sessionId: "s2", role: "user", content: "高铁座位从靠窗改为过道。" });
    const d2 = await (await test.json(`${chat}/dream`, {})).json() as { job: { job_id: string } };
    await test.wait(d2.job.job_id);
    await test.app.request(`${chat}/sessions`);
    expect(test.chatStore.getSession("s2")?.status).toBe("dreamed");

    // Roll back to v1
    const rb = await test.json(`${admin}/rollback`, { version: 1 });
    expect(rb.status).toBe(200);
    expect(test.chatStore.getSession("s1")).toMatchObject({ status: "dreamed", dreamed_version: 1 });
    expect(test.chatStore.getSession("s2")).toMatchObject({ status: "pending", dreamed_version: null, dreamed_doc_id: null, dreamed_message_count: 0 });
  });

  it("P1-4: serializes concurrent sends on the same session so turns never interleave", async () => {
    const test = await setup();
    test.chatStore.createSession({ sessionId: "race", spaceKey: key });
    const [res1, res2] = await Promise.all([
      test.json("/v1/chat/sessions/race/messages", { content: "第一条问题" }),
      test.json("/v1/chat/sessions/race/messages", { content: "第二条问题" }),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const messages = test.chatStore.getMessages("race");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const t1 = test.chatStore.getSessionTurn("race", "t1");
    const t2 = test.chatStore.getSessionTurn("race", "t2");
    expect(t1?.raw_excerpt).toContain("**User**");
    expect(t1?.raw_excerpt).toContain("**Assistant**");
    expect(t2?.raw_excerpt).toContain("**User**");
    expect(t2?.raw_excerpt).toContain("**Assistant**");
  });

  it("Stage 2: routes general-knowledge questions to memory_mode=none, denoises FTS, and protects safety lines", async () => {
    const test = await setup();
    await test.json("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync",
      items: [{ filename: "work.md", doc_date: "2026-11-20", content: "张明负责上海项目复盘，内部评审准备预算表。" }],
    });
    // Noisy Chinese astronomy question must not match Wiki FTS on generic bigram "内部"
    expect(await test.lexical.search(key, 1, "黑洞的内部是什么样的", 5, false)).toEqual([]);

    // Noisy Chinese casual query must not match unrelated CLI tool conversation
    test.chatStore.createSession({ sessionId: "cli", spaceKey: key, title: "批量改名工具" });
    test.chatStore.appendMessage({ sessionId: "cli", role: "user", content: "帮我推荐一个批量改名工具" });
    test.chatStore.appendMessage({ sessionId: "cli", role: "assistant", content: "我推荐 rename 命令。" });
    expect(test.chatStore.searchConversations(key, "帮我推荐个好吃的")).toEqual([]);
    expect(test.chatStore.searchConversations(key, "解释一下通货膨胀")).toEqual([]);

    // Safety lines survive tight relevantMarkdown budget on compound queries
    const entityPage = [
      "# 陈默",
      "- **陈默 · 出差偏好** · 高铁二等座靠窗，不坐红眼航班 [src:doc_a#t1]",
      "- **陈默 · 办公习惯** · 每周二上午写周报汇总进度 [src:doc_a#t2]",
      "- **陈默 · 饮食禁忌** · 乳糖不耐受，不能喝普通牛奶，咖啡只喝燕麦奶 [src:doc_a#t3]",
      "- **陈默 · 药物过敏** · 对青霉素严重过敏，绝对不能使用 [src:doc_a#t4]",
      "- **陈默 · 运动爱好** · 周末偶尔去奥森跑步五公里 [src:doc_a#t5]",
    ].join("\n");
    const sliced = relevantMarkdown(entityPage, "我想带老婆吃火锅配全脂鲜奶酪，再吃点阿莫西林", 95, true);
    expect(sliced).toContain("乳糖不耐受");
    expect(sliced).toContain("青霉素严重过敏");

    // Router memory_mode="none" skips Wiki retrieval & injects clean GENERAL_CHAT_SYSTEM
    test.chatStore.createSession({ sessionId: "gen", spaceKey: key });
    const spy = vi.spyOn(OpenAiGateway.prototype, "complete").mockImplementation(async (tier, messages) => {
      if (tier === "fast" && String(messages[0]?.content).startsWith("Route this")) {
        return {
          id: "r1", object: "chat.completion", created: 0, model: "fast",
          choices: [{ index: 0, finish_reason: "stop", logprobs: null,
            message: { role: "assistant", refusal: null, content: JSON.stringify({ memory_mode: "none", search_queries: [], needs_inventory: false, safety_check: false }) } }],
        };
      }
      return {
        id: "c1", object: "chat.completion", created: 0, model: "strong",
        choices: [{ index: 0, finish_reason: "stop", logprobs: null,
          message: { role: "assistant", refusal: null, content: "霍金辐射源于黑洞事件视界附近的弯曲时空量子场效应。" } }],
      };
    });
    cleanup.push(() => spy.mockRestore());
    const genRes = await test.json("/v1/chat/sessions/gen/messages", { content: "为什么黑洞会有霍金辐射？" });
    expect(genRes.status).toBe(200);
    const body = await genRes.json() as { assistant_message: { content: string; retrieval: { contexts: unknown[] }; conversation_hits: unknown[] } };
    expect(body.assistant_message.retrieval.contexts).toEqual([]);
    expect(body.assistant_message.conversation_hits).toEqual([]);
    const strongCall = spy.mock.calls.find(([tier]) => tier === "strong")!;
    expect(String(strongCall[1][0].content)).not.toContain("【通道 1");
    expect(body.assistant_message.content).not.toContain("[src:");
  });

  it("P1-5: handles tight max_tokens=300 on /v1/memories/retrieve without 502", async () => {
    const test = await setup();
    await test.json("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync",
      items: [{ filename: "travel.md", doc_date: "2026-11-20", content: "我的高铁座位偏好是靠窗。" }],
    });
    const res = await test.json("/v1/memories/retrieve", {
      ...ref, query: "高铁座位偏好是什么？", return_mode: "both", max_tokens: 300, verify_raw_sources: true,
    });
    expect(res.status).toBe(200);
    const parsed = retrieveResultSchema.parse(await res.json());
    expect(parsed.answer).toContain("靠窗");
  });

  it("P0-1: fixes year hallucination on timeline events and enforces safety cardinality=many", () => {
    const draft = new Map<string, string>();
    const space = {
      ...ref, purpose, current_version: 0, incremental_since_dream: 0, last_dreamed_at: null, document_count: 0, page_count: 0,
    };
    const claims: Claim[] = [
      {
        kind: "entity", subject: "小宇", predicate: "花生过敏", value: "严重花生过敏，花生酱绝对不能碰",
        locator: "t1", cardinality: "many", related: [], docId: "doc_1", docDate: "2026-10-08",
      },
      {
        kind: "entity", subject: "小宇", predicate: "花生过敏", value: "误食立刻送儿研所急诊",
        locator: "t2", cardinality: "many", related: [], docId: "doc_2", docDate: "2026-10-20",
      },
    ];
    compileWiki(draft, space, 1, ["doc_1", "doc_2"], [], claims, "2026-11-25T00:00:00Z");
    const page = [...draft.entries()].find(([k]) => k.startsWith("entities/"))![1];
    expect(page).toContain("花生酱绝对不能碰");
    expect(page).toContain("儿研所急诊");
  });

  it("Stage 3: reconciles event state transitions immediately on incremental compile and retires superseded dates", () => {
    const draft = new Map<string, string>();
    const space = {
      ...ref, purpose, current_version: 0, incremental_since_dream: 0, last_dreamed_at: null, document_count: 0, page_count: 0,
    };
    const claims: Claim[] = [
      {
        date: "2026-12-15", text: "栖木咖啡第一轮提案", locator: "t1",
        related: [{ kind: "topic", subject: "栖木咖啡" }],
        event_key: "栖木咖啡第一轮提案", status: "planned",
        docId: "doc_1", docDate: "2026-11-10",
      },
      {
        date: "2026-12-18", text: "栖木咖啡第一轮提案改期至 12 月 18 日", locator: "t2",
        related: [{ kind: "topic", subject: "栖木咖啡" }],
        event_key: "栖木咖啡第一轮提案", status: "rescheduled", previous_date: "2026-12-15",
        docId: "doc_2", docDate: "2026-11-15",
      },
      {
        date: "2026-10-12", text: "开车去店里换前刹车片", locator: "t1",
        related: [{ kind: "entity", subject: "陈默" }],
        event_key: "换前刹车片", status: "planned",
        docId: "doc_3", docDate: "2026-10-12",
      },
      {
        date: "2026-10-15", text: "前刹车片已更换完成", locator: "t2",
        related: [{ kind: "entity", subject: "陈默" }],
        event_key: "换前刹车片", status: "completed",
        docId: "doc_4", docDate: "2026-10-21",
      },
    ];
    compileWiki(draft, space, 1, ["doc_1", "doc_2", "doc_3", "doc_4"], [], claims, "2026-11-25T00:00:00Z");
    const timeline = draft.get("timeline.md")!;
    const conflicts = draft.get("conflicts.md")!;
    expect(timeline).toContain("2026-12-18");
    expect(timeline).not.toContain("2026-12-15");
    expect(timeline).not.toContain("2026-10-12");
    expect(conflicts).toContain("事件改期");
    expect(conflicts).toContain("2026-12-15");
    expect(conflicts).toContain("事件已完成");
  });

  it("Stage 3: gracefully fits validly cited oversized answer within tight max_tokens=300 on retrieve(answer)", async () => {
    const test = await setup();
    const ingested = await test.json("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync",
      items: [{ filename: "budget.md", doc_date: "2026-11-22", content: "青岚项目现行差旅预算为每月 1600 元。" }],
    });
    const docId = jobResultSchema.parse(await ingested.json()).accepted_docs[0].doc_id;
    const tag = `[src:${docId}#s1]`;
    const complete = OpenAiGateway.prototype.complete;
    const spy = vi.spyOn(OpenAiGateway.prototype, "complete").mockImplementation(function (this: OpenAiGateway, ...args) {
      if (String(args[1][0]?.content ?? "").startsWith("Answer in")) {
        const longValid = [
          `青岚项目现行差旅预算为每月 1600 元 ${tag}。`,
          ...Array.from({ length: 12 }, (_, i) => `补充背景说明第 ${i + 1} 条：该预算适用于本季度全部差旅报销并已覆盖旧口径 ${tag}。`),
        ].join("\n\n");
        return Promise.resolve({
          id: "synth-long", object: "chat.completion", created: 0, model: "strong",
          choices: [{ index: 0, finish_reason: "stop", logprobs: null,
            message: { role: "assistant", refusal: null, content: JSON.stringify({ answer: longValid }) } }],
        });
      }
      return complete.apply(this, args);
    });
    cleanup.push(() => spy.mockRestore());

    const res = await test.json("/v1/memories/retrieve", {
      ...ref, query: "青岚项目现行差旅预算和全部历史详情是什么？", return_mode: "answer", max_tokens: 300, verify_raw_sources: true,
    });
    expect(res.status).toBe(200);
    const body = retrieveResultSchema.parse(await res.json());
    expect(body.answer).toContain("1600 元");
    expect(body.citations).toHaveLength(1);
  });

  it("Stage 3: accepts GFM comparison tables with cited body rows without requiring citations in table header cells", async () => {
    const test = await setup();
    const ingested = await test.json("/v1/memories/ingest", {
      ...ref, purpose, mode: "sync",
      items: [{ filename: "projects.md", doc_date: "2026-11-22", content: "青岚项目由陈明负责，预算 1600 元。" }],
    });
    const docId = jobResultSchema.parse(await ingested.json()).accepted_docs[0].doc_id;
    const tag = `[src:${docId}#s1]`;
    const complete = OpenAiGateway.prototype.complete;
    const spy = vi.spyOn(OpenAiGateway.prototype, "complete").mockImplementation(function (this: OpenAiGateway, ...args) {
      if (String(args[1][0]?.content ?? "").startsWith("Answer in")) {
        const tableAnswer = [
          "| 项目 | 负责人 | 现行预算 |",
          "| --- | --- | --- |",
          `| 青岚项目 | 陈明 | 每月 1600 元 ${tag} |`,
        ].join("\n");
        return Promise.resolve({
          id: "synth-table", object: "chat.completion", created: 0, model: "strong",
          choices: [{ index: 0, finish_reason: "stop", logprobs: null,
            message: { role: "assistant", refusal: null, content: JSON.stringify({ answer: tableAnswer }) } }],
        });
      }
      return complete.apply(this, args);
    });
    cleanup.push(() => spy.mockRestore());

    const res = await test.json("/v1/memories/retrieve", {
      ...ref, query: "用表格对比青岚项目负责人和预算", return_mode: "both", max_tokens: 1500, verify_raw_sources: true,
    });
    expect(res.status).toBe(200);
    const body = retrieveResultSchema.parse(await res.json());
    expect(body.answer).toContain("陈明");
    expect(body.citations).toHaveLength(1);
  });
});
