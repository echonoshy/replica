import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateResultSchema, jobResultSchema, nudgeSchema, nudgesResultSchema, openNudgeSessionResultSchema,
} from "@wiki-memory/shared";
import { SQLiteChatStore } from "../apps/api/src/chat/chat-store.js";
import { readConfig } from "../apps/api/src/config.js";
import { spaceKey } from "../apps/api/src/db/interfaces.js";
import { SQLiteConnection } from "../apps/api/src/db/sqlite-repo.js";
import { ServiceError } from "../apps/api/src/errors.js";
import { OpenAiGateway } from "../apps/api/src/llm/openai-gateway.js";
import { Store } from "../apps/api/src/plugins/proactive/store.js";
import { createService } from "../apps/api/src/service.js";
import { startFixtureGateway } from "./fixtures/gateway.js";
import type { ProactiveContext } from "./fixtures/gateway.js";

const ref = { namespace: "personal", space_id: "travel" };
const proactive = "/v1/proactive";
const chat = "/v1/chat/spaces/personal/travel";
const admin = "/v1/admin/spaces/personal/travel";
const policyPath = proactive + "/spaces/personal/travel/policy";
const collection = proactive + "/nudges?" + new URLSearchParams(ref);
const meeting = "2026-12-02 张明负责上海项目复盘";
const eve = "2026-12-01T09:00:00+08:00";
const title = "12月2日上海复盘";
const suggestedAction = "确认预算表版本";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function draft(trigger: ProactiveContext["triggers"][number]) {
  const [anchor] = trigger.anchors;
  return {
    trigger_ids: [trigger.trigger_id], title, body: `带上预算表 [src:${anchor}]`,
    citations: [anchor], kind: "reminder", urgency: "normal", suggested_action: suggestedAction,
  };
}

async function setup(options: { proactive?: (ctx: ProactiveContext) => unknown; pollSeconds?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "proactive-session-"));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  const gateway = await startFixtureGateway({
    proactive: options.proactive ?? ((ctx) => ({ decision: "push", nudges: [draft(ctx.triggers[0])] })),
  });
  cleanup.push(gateway.close);
  let ms = Date.parse("2026-11-30T08:00:00+08:00");
  const service = createService(readConfig({
    DATA_DIR: dir, LLM_BASE_URL: gateway.baseUrl, LLM_API_KEY: "fixture",
    PROACTIVE_POLL_SECONDS: String(options.pollSeconds ?? 0),
  }), { clock: () => ms });
  cleanup.push(service.close);
  service.start();
  const observer = new SQLiteConnection(dir);
  cleanup.push(() => observer.close());
  const { app } = service;
  const json = (path: string, value: unknown, method = "POST") => app.request(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  const read = async (response: Response | Promise<Response>, status = 200) => {
    const res = await response;
    const data = await res.json();
    expect(res.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  const policy = (value: unknown) => read(json(policyPath, value, "PUT"));
  await read(json("/v1/admin/spaces", { ...ref, purpose: "个人差旅与日程" }));
  expect(await policy({ daily_digest_time: null })).toMatchObject({ max_daily_pushes: 3 });
  let nextDoc = 0;
  async function ingest(...contents: string[]) {
    const job = jobResultSchema.parse(await read(json("/v1/memories/ingest", {
      ...ref, mode: "sync", items: contents.map((content) => ({
        content, filename: `note${nextDoc++}.txt`, doc_date: "2026-11-29",
      })),
    })));
    expect(job.status, job.error_message ?? "").toBe("published");
    return job;
  }
  const at = (time: string) => { ms = Date.parse(time); };
  async function evaluate() {
    const data = await read(json(proactive + "/evaluate", ref));
    for (const nudge of data.nudges) expect(nudge).toHaveProperty("session_id", null);
    return evaluateResultSchema.parse(data);
  }
  async function createNudge() {
    await ingest(meeting);
    at(eve);
    const { nudges } = await evaluate();
    expect(nudges).toHaveLength(1);
    return nudges[0];
  }
  const nudgePath = (id: string) => `${proactive}/nudges/${id}`;
  const openRequest = (id: string, space: unknown = ref) => json(nudgePath(id) + "/session", space);
  const open = async (id: string) => openNudgeSessionResultSchema.parse(await read(openRequest(id)));
  const listChats = () => read(app.request(chat + "/sessions"));
  return {
    app, observer, db: observer.client, at, json, read, ingest, evaluate, createNudge,
    policy, nudgePath, openRequest, open, listChats,
  };
}

describe("Proactive nudge session promotion", () => {
  it("keeps the seeded opening out of the first no-memory comparison", async () => {
    const s = await setup();
    const nudge = await s.createNudge();
    const opened = await s.open(nudge.nudge_id);
    const seeded = opened.messages[0].content;
    const content = "应该怎么准备？";
    const complete = vi.spyOn(OpenAiGateway.prototype, "complete");

    const reply = await s.read(s.json(`/v1/chat/sessions/${opened.session.session_id}/messages`, {
      content, compare_baseline: true,
    }));

    expect(reply.assistant_message.baseline_reply).toBe("已记录。");
    const prompts = complete.mock.calls.map(([, messages]) => messages);
    const baseline = prompts.find(([system]) => String(system.content).includes("目前没有接入任何关于该用户的长期记忆"));
    expect(baseline).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content },
    ]);
    expect(prompts).toContainEqual(expect.arrayContaining([{ role: "assistant", content: seeded }]));
  });

  it("creates a chat only on open, pins the source snapshot, and queues Dreaming after a reply", async () => {
    const s = await setup();
    const n = await s.createNudge();
    expect(await s.listChats()).toMatchObject({ sessions: [], pending_count: 0 });
    expect(await s.read(s.app.request(collection))).toMatchObject({ nudges: [{ session_id: null, status: "pending" }] });

    const newer = await s.ingest("Keep the original railway receipt");
    expect(newer.target_version).toBeGreaterThan(n.snapshot_version);
    await s.policy({ timezone: "Pacific/Auckland" });
    const openedAt = "2026-12-01T12:30:00.000Z";
    s.at(openedAt);
    const results = await Promise.all([s.open(n.nudge_id), s.open(n.nudge_id)]);
    const opened = results.find(({ created }) => created)!;
    expect(opened).toBeDefined();
    const id = opened.session.session_id;
    expect(results.find(({ created }) => !created)).toEqual({ ...opened, created: false });
    expect(opened.nudge).toMatchObject({ status: "read", acked_at: openedAt, session_id: id });
    expect(opened.session).toMatchObject({
      title, session_date: "2026-12-02", status: "pending", source_nudge_id: n.nudge_id, source_nudge_kind: n.kind,
      message_count: 1, dreamed_message_count: 1, dreamed_version: null, created_at: openedAt, updated_at: openedAt,
    });
    expect(opened.messages).toHaveLength(1);
    expect(opened.messages[0]).toMatchObject({
      role: "assistant", session_id: id, content: `## ${title}\n\n${n.body}\n\n> 建议下一步：${suggestedAction}`,
      created_at: openedAt, citations: n.citations,
      retrieval: {
        snapshot_version: n.snapshot_version, index_excerpt: null, contexts: [], answer: null, citations: n.citations,
        usage: { selected_pages: 0, returned_tokens: 0, latency_ms: 0 },
      },
    });
    expect(await s.listChats()).toMatchObject({ sessions: [opened.session], pending_count: 0 });
    const chatPath = "/v1/chat/sessions/" + id;
    expect(await s.read(s.app.request(chatPath))).toEqual({ session: opened.session, messages: opened.messages });
    expect(await s.read(s.app.request(chatPath + "/turn?locator=t1"))).toMatchObject({ raw_excerpt: expect.stringContaining(n.body) });

    const content = "我会带上风险清单和新版预算表。";
    const reply = await s.read(s.json(chatPath + "/messages", { content }));
    const reopened = await s.open(n.nudge_id);
    expect(reopened).toEqual({
      nudge: opened.nudge, session: reply.session, created: false,
      messages: [...opened.messages, reply.user_message, reply.assistant_message],
    });
    expect(await s.listChats()).toMatchObject({ pending_count: 1 });

    const dream = await s.read(s.json(chat + "/dream", {}), 202);
    expect(dream).toMatchObject({ mode: "digest_pending", digested_sessions: [{ session_id: id }] });
    const [doc] = jobResultSchema.parse(dream.job).accepted_docs;
    expect(doc).toMatchObject({ filename: `session_${id}_m3.json` });
    expect(doc.analyze_from_turn).toBeUndefined();
    await vi.waitFor(async () => {
      const job = await s.read(s.app.request("/v1/memories/jobs/" + dream.job.job_id));
      expect(job.status, job.error_message ?? "").toBe("published");
    });
    for (const [locator, excerpt] of [["t1", n.body], ["t2", content]]) {
      const query = new URLSearchParams({ doc_id: doc.doc_id, locator });
      expect(await s.read(s.app.request(admin + "/source?" + query))).toMatchObject({
        raw_excerpt: expect.stringContaining(excerpt),
      });
    }
  });

  it("cancels a pending snooze, clears the link on deletion, and can reopen a fresh session", async () => {
    const s = await setup();
    const n = await s.createNudge();
    await s.read(s.json(s.nudgePath(n.nudge_id) + "/ack", {
      ...ref, action: "snooze", snooze_until: "2026-12-01T10:00:00+08:00",
    }));
    const snoozeStatus = () => s.db.prepare("SELECT status FROM proactive_triggers WHERE dedup_key = ?")
      .pluck().get("snooze:" + n.nudge_id);
    expect(snoozeStatus()).toBe("pending");
    expect(await s.listChats()).toMatchObject({ sessions: [] });
    const openedAt = "2026-12-01T01:10:00.000Z";
    s.at(openedAt);
    const opened = await s.open(n.nudge_id);
    const id = opened.session.session_id;
    expect(opened.nudge).toMatchObject({ status: "read", acked_at: openedAt, session_id: id });
    expect(snoozeStatus()).toBe("cancelled");
    expect(await s.listChats()).toMatchObject({ pending_count: 0 });

    expect(await s.read(s.app.request("/v1/chat/sessions/" + id, { method: "DELETE" }))).toMatchObject({ deleted: true });
    expect(await s.listChats()).toMatchObject({ sessions: [] });
    const list = nudgesResultSchema.parse(await s.read(s.app.request(collection + "&status=read")));
    expect(list.nudges).toEqual([{ ...opened.nudge, session_id: null }]);
    s.at("2026-12-01T02:00:00.000Z");
    const reopened = await s.open(n.nudge_id);
    expect(reopened.created).toBe(true);
    expect(reopened.session.session_id).not.toBe(id);
    expect(reopened.nudge).toMatchObject({ status: "read", acked_at: openedAt, session_id: reopened.session.session_id });
    expect(reopened.messages).toHaveLength(1);
  });

  it("validates the request and rejects missing, out-of-space, and expired nudges", async () => {
    const s = await setup();
    await s.ingest("Keep the original railway receipt");
    const n = await s.createNudge();
    const elsewhere = { ...ref, space_id: "elsewhere" };
    await s.read(s.json("/v1/admin/spaces", { ...elsewhere, purpose: "另一处记忆空间" }));
    expect(await s.read(s.openRequest(n.nudge_id, {}), 400)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(await s.read(s.openRequest("a".repeat(129)), 400)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(await s.read(s.openRequest("missing"), 404)).toMatchObject({ error: { code: "NUDGE_NOT_FOUND" } });
    expect(await s.read(s.openRequest(n.nudge_id, elsewhere), 404)).toMatchObject({ error: { code: "NUDGE_NOT_FOUND" } });
    expect(await s.read(s.openRequest(n.nudge_id, { ...ref, space_id: "unknown" }), 404))
      .toMatchObject({ error: { code: "SPACE_NOT_FOUND" } });
    await s.read(s.json(admin + "/rollback", { version: 1 }));
    expect(await s.read(s.openRequest(n.nudge_id), 409))
      .toMatchObject({ error: { code: "NUDGE_CLOSED", message: "This nudge has expired" } });
    expect(await s.listChats()).toMatchObject({ sessions: [] });
  });

  it("preserves legacy chat and outbox rows when the constructors add the promotion columns", async () => {
    const s = await setup();
    const { session } = await s.read(s.json(chat + "/sessions", { title: "已有对话" }), 201);
    const { session_id, ...legacyNudge } = await s.createNudge();
    expect(nudgeSchema.parse(legacyNudge)).toEqual({ ...legacyNudge, session_id });
    s.db.exec(`
      ALTER TABLE chat_sessions DROP COLUMN source_nudge_id;
      ALTER TABLE chat_sessions DROP COLUMN source_nudge_kind;
      ALTER TABLE proactive_outbox DROP COLUMN session_id;
    `);

    for (let attempt = 0; attempt < 2; attempt++) {
      const chats = new SQLiteChatStore(s.db);
      const outbox = new Store(s.observer);
      expect(chats.getSession(session.session_id)).toEqual(session);
      expect(outbox.getNudge(spaceKey(ref), legacyNudge.nudge_id)).toEqual({ ...legacyNudge, session_id: null });
    }
    expect((await s.open(legacyNudge.nudge_id)).created).toBe(true);
  });

  it("rolls back the seeded chat and outbox changes when promotion fails", async () => {
    const s = await setup();
    const n = await s.createNudge();
    const original = Store.prototype.linkSession;
    const fail = vi.spyOn(Store.prototype, "linkSession").mockImplementationOnce(function (this: Store, ...args) {
      original.apply(this, args);
      throw new ServiceError(409, "TEST_PROMOTION_FAILED", "Injected promotion failure");
    });
    expect(await s.read(s.openRequest(n.nudge_id), 409)).toMatchObject({ error: { code: "TEST_PROMOTION_FAILED" } });
    expect(fail).toHaveBeenCalledOnce();
    expect(await s.listChats()).toMatchObject({ sessions: [], pending_count: 0 });
    expect(s.db.prepare("SELECT id FROM chat_messages").all()).toEqual([]);
    expect(s.db.prepare("SELECT session_id FROM chat_turns_fts").all()).toEqual([]);
    expect(await s.read(s.app.request(collection))).toMatchObject({ nudges: [n] });
    expect((await s.open(n.nudge_id)).created).toBe(true);
  });

  it("publishes the OpenAPI 3.1 session contract with structured messages", async () => {
    const s = await setup();
    const spec = await s.read(s.app.request("/openapi.json"));
    expect(spec.openapi).toBe("3.1.0");
    const op = spec.paths[proactive + "/nudges/{nudge_id}/session"].post;
    expect(op.parameters).toContainEqual(expect.objectContaining({ name: "nudge_id", in: "path", required: true }));
    expect(op.requestBody).toMatchObject({
      required: true, content: { "application/json": { schema: { required: ["namespace", "space_id"] } } },
    });
    const schema = op.responses["200"].content["application/json"].schema;
    expect(schema.required).toEqual(["nudge", "created", "session", "messages"]);
    expect(schema.properties).toMatchObject({
      nudge: { properties: { session_id: { type: ["string", "null"], default: null } } },
      session: { properties: { source_nudge_id: { type: ["string", "null"] }, source_nudge_kind: { type: ["string", "null"] } } },
      messages: { type: "array", items: { type: "object", properties: {
        id: { type: "integer" }, session_id: { type: "string" }, role: { enum: ["user", "assistant"] },
        content: { type: "string" }, citations: { type: "array" }, created_at: { format: "date-time" },
      } } },
    });
    for (const code of ["400", "404", "409"]) {
      expect(op.responses[code].content["application/json"].schema.properties.error.properties).toHaveProperty("code");
    }
  });

  it("exposes kinds, acknowledgement timestamps, and boolean engagement in the decider's working state", async () => {
    let seen: ProactiveContext | undefined;
    const s = await setup({ proactive(ctx) {
      seen = ctx;
      if (ctx.triggers.some(({ source_type }) => source_type === "daily_digest")) return { decision: "silent" };
      return { decision: "push", nudges: ctx.triggers.map(draft) };
    } });
    await s.ingest(meeting, "通行证需要续期");
    s.at(eve);
    const { nudges } = await s.evaluate();
    expect(nudges).toHaveLength(2);
    const [opened, unread] = nudges;
    await s.open(opened.nudge_id);
    await s.policy({ daily_digest_time: "09:30" });
    s.at("2026-12-01T09:30:00+08:00");
    await s.evaluate();
    expect(seen?.working_state).toEqual(expect.arrayContaining([
      expect.objectContaining({ dedup_key: opened.dedup_key, kind: "reminder", status: "read", engaged: true, acked_at: new Date(eve).toISOString() }),
      expect.objectContaining({ dedup_key: unread.dedup_key, kind: "reminder", status: "pending", engaged: false, acked_at: null }),
    ]));
  });

  it("evaluates a newly published conflict immediately when polling is enabled", async () => {
    const s = await setup({ pollSeconds: 3600 });
    await s.ingest("偏好是靠窗", "优先前排");
    await expect.poll(async () => (await s.read(s.app.request(collection))).total).toBe(1);
    expect(await s.listChats()).toMatchObject({ sessions: [], pending_count: 0 });
  });

  it("runs a follow-up poll for a publication that arrives during evaluation", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const decide = vi.fn(async (ctx: ProactiveContext) => {
      entered.resolve();
      await resume.promise;
      return { decision: "push", nudges: [draft(ctx.triggers[0])] };
    });
    const s = await setup({ pollSeconds: 3600, proactive: decide });
    let latestVersion: number | null | undefined;
    try {
      await s.ingest("偏好是靠窗", "优先前排");
      await entered.promise;
      const publication = await s.ingest("Keep the original railway receipt");
      latestVersion = publication.target_version;
      expect(decide).toHaveBeenCalledOnce();
      expect(await s.read(s.app.request(collection))).toMatchObject({ total: 0 });
    } finally {
      resume.resolve();
    }

    await expect.poll(async () => (await s.read(s.app.request(collection))).nudges).toMatchObject([
      { snapshot_version: latestVersion },
    ]);
    expect(decide).toHaveBeenCalledTimes(2);
  });
});
