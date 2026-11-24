import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteConnection } from "../apps/api/src/db/sqlite-repo.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateResultSchema, jobResultSchema, nudgeSchema, nudgesResultSchema, proactivePolicySchema,
} from "@replica/shared";
import type { Nudge, ProactivePolicy } from "@replica/shared";
import { readConfig } from "../apps/api/src/config.js";
import { createService } from "../apps/api/src/service.js";
import { countTokens } from "../apps/api/src/retrieval/token-budget.js";
import { localTime, wallTime } from "../apps/api/src/plugins/proactive/time.js";
import { startFixtureGateway } from "./fixtures/gateway.js";
import type { GatewayOptions, ProactiveContext } from "./fixtures/gateway.js";

const ref = { namespace: "personal", space_id: "travel" };
const base = "/v1/proactive";
const collection = base + "/nudges?" + new URLSearchParams(ref);
const policyPath = base + "/spaces/personal/travel/policy";
const admin = "/v1/admin/spaces/personal/travel";
const meeting = "2026-12-02 张明负责上海项目复盘";
const eve = "2026-12-01T09:00:00+08:00";
const eventDay = "2026-12-02T08:30:00+08:00";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function push(ctx: ProactiveContext, urgency = "normal") {
  const anchor = ctx.triggers.flatMap((t) => t.anchors)[0];
  return { decision: "push", nudges: [{
    trigger_ids: ctx.triggers.map((t) => t.trigger_id), title: "准备复盘", body: "带上预算表 [src:" + anchor + "]",
    citations: [anchor], kind: "reminder", urgency,
  }] };
}

async function setup(env: Record<string, string> = {}, options: GatewayOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "proactive-test-"));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  const gateway = await startFixtureGateway({ proactive: push, ...options });
  cleanup.push(gateway.close);
  let ms = Date.parse("2026-11-30T08:00:00+08:00");
  const clock = () => ms;
  const config = readConfig({ DATA_DIR: dir, LLM_BASE_URL: gateway.baseUrl, LLM_API_KEY: "fixture", ...env });
  const service = createService(config, { clock });
  cleanup.push(service.close);
  service.start();
  const observer = new SQLiteConnection(dir);
  const db = observer.client;
  cleanup.push(() => observer.close());
  const { app } = service;
  const json = (path: string, value: unknown, method = "POST") => app.request(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  async function ok(r: Response) {
    const data = await r.json();
    expect(r.status, JSON.stringify(data)).toBe(200);
    return data;
  }
  await ok(await json("/v1/admin/spaces", { ...ref, purpose: "个人差旅与日程" }));
  async function policy(p: Partial<ProactivePolicy>) {
    return proactivePolicySchema.parse(await ok(await json(policyPath, p, "PUT")));
  }
  if (config.PROACTIVE_ENABLED) await policy({ daily_digest_time: null });
  async function ingest(contents = [meeting]) {
    const job = jobResultSchema.parse(await ok(await json("/v1/memories/ingest", {
      ...ref, mode: "sync", items: contents.map((content, i) => ({ content, filename: "note" + i + ".txt", doc_date: "2026-11-29" })),
    })));
    expect(job.status, job.error_message ?? "").toBe("published");
    return job;
  }
  const evaluate = async (params = {}) => evaluateResultSchema.parse(await ok(await json(base + "/evaluate", { ...ref, ...params })));
  const list = async (params = "") => nudgesResultSchema.parse(await ok(await app.request(collection + params)));
  const ack = (n: Nudge, action: string, extra = {}) => json(base + "/nudges/" + n.nudge_id + "/ack", { ...ref, action, ...extra });
  const calls = () => gateway.requests.filter((r) => r.stage === "proactive").length;
  const at = (time: string) => { ms = Date.parse(time); };
  const tables = () => ["triggers", "outbox", "policies", "leases", "nudge_sources", "plans"]
    .map((table) => db.prepare("SELECT * FROM proactive_" + table + " ORDER BY rowid").all());
  return { app, config, clock, at, json, ok, ingest, db, gateway, evaluate, policy, list, ack, calls, tables };
}

describe("Proactive Nudge Plugin V1", () => {
  it("parses explicit switches and keeps the entire plugin unmounted when disabled", async () => {
    expect(readConfig({})).toMatchObject({ PROACTIVE_ENABLED: true, PROACTIVE_POLL_SECONDS: 0 });
    for (const [value, enabled] of [["true", true], ["1", true], ["false", false], ["0", false]] as const)
      expect(readConfig({ PROACTIVE_ENABLED: value }).PROACTIVE_ENABLED).toBe(enabled);
    expect(() => readConfig({ PROACTIVE_POLL_SECONDS: "86401" })).toThrow();
    const s = await setup({ PROACTIVE_ENABLED: "false", PROACTIVE_POLL_SECONDS: "1" });
    expect((await s.app.request(collection)).status).toBe(404);
    expect((await s.json(base + "/evaluate", ref)).status).toBe(404);
    expect((await s.app.request(policyPath)).status).toBe(404);
    await s.ingest();
    expect(s.gateway.requests.map((r) => r.stage)).toEqual(["analyzer", "organizer"]);
    expect(s.tables().every((rows) => rows.length === 0)).toBe(true);
    expect(Object.keys((await (await s.app.request("/openapi.json")).json()).paths).filter((p) => p.startsWith(base))).toEqual([]);
  });

  it("plans events, expirations and unresolved conflicts during publication without waking the decider", async () => {
    const s = await setup();
    await s.ingest([meeting + " 通行证需要续期 偏好是靠窗", "优先前排"]);
    const timers = s.db.prepare("SELECT source_type,fire_at FROM proactive_triggers ORDER BY fire_at").all();
    expect(timers).toEqual([
      { source_type: "conflict", fire_at: new Date(s.clock()).toISOString() },
      ...["memory_event", "expiring_fact"].map((source_type) => ({ source_type, fire_at: new Date(eve).toISOString() })),
      { source_type: "memory_event", fire_at: new Date(eventDay).toISOString() },
    ]);
    expect(s.gateway.requests.map((r) => r.stage)).toEqual(["analyzer", "analyzer", "organizer"]);
  });

  it("coalesces all due items in one fast call and verifies every output citation against raw evidence", async () => {
    let input: ProactiveContext | undefined;
    const s = await setup({}, { proactive(ctx) {
      input = ctx;
      const answer = push(ctx);
      const n = answer.nudges[0], wrong = n.citations[0].split("#")[0] + "#p999";
      n.body += " [src:" + wrong + "] [src:doc_fabricated#p1] [src:bad]";
      n.citations.push(wrong, "doc_fabricated#p1");
      return answer;
    } });
    await s.ingest([meeting + " 通行证需要续期"]);
    expect((await s.evaluate()).triggers_processed).toBe(0);
    s.at(eve);
    const result = await s.evaluate();
    expect(result.triggers_processed).toBe(2);
    expect(s.calls()).toBe(1);
    expect(input?.triggers).toHaveLength(2);
    expect(input?.index).toContain("Memory Index");
    expect(input?.related_memory.join(" ")).toContain("预算表");
    const [n] = result.nudges;
    expect(n.trigger_ids).toHaveLength(2);
    expect(n.citations).toHaveLength(1);
    expect(n.citations[0].raw_excerpt).toContain("通行证");
    expect(n.body).toContain("[src:" + n.citations[0].anchor + "]");
    expect(n.body).not.toMatch(/p999|fabricated|src:bad/);
    expect((await s.evaluate()).triggers_processed).toBe(0);
    expect((await s.list()).nudges).toEqual([n]);
  });

  it("settles silent and unsupported decisions without an Outbox entry", async () => {
    const s = await setup({}, { rejectJson: true, proactive: () => ({ decision: "silent" }) });
    await s.ingest();
    s.at(eve);
    expect(await s.evaluate()).toMatchObject({ decision_summary: "silent", nudges: [], triggers_processed: 1 });
    expect(s.gateway.requests.filter((r) => r.stage === "proactive").at(-1)?.native).toBe(false);
    s.gateway.options.proactive = (ctx) => {
      const result = push(ctx);
      Object.assign(result.nudges[0], { body: "Unsupported [src:doc_fake#p1]", citations: [] });
      return result;
    };
    s.at(eventDay);
    expect((await s.evaluate()).suppressed_reasons).toContain("no_valid_citation");
    expect((await s.list("&status=all")).total).toBe(0);
  });

  it.each([
    ["22:00", "08:00", "2026-12-01T23:00:00+08:00", "2026-12-02T00:00:00.000Z"],
    ["12:00", "14:00", "2026-12-01T12:00:00+08:00", "2026-12-01T06:00:00.000Z"],
  ])("defers normal delivery for quiet window %s–%s up to its exact end", async (start, end, when, due) => {
    const s = await setup();
    await s.policy({ quiet_start: start, quiet_end: end });
    await s.ingest();
    s.at(when);
    expect((await s.evaluate()).nudges[0].deliver_after).toBe(due);
    expect((await s.list()).total).toBe(0);
    expect((await s.list("&now=" + new Date(Date.parse(due) - 1).toISOString())).total).toBe(0);
    s.at(due);
    expect((await s.list()).total).toBe(1);
  });

  it("admits urgent delivery in quiet hours and accounts for the next local day", async () => {
    const s = await setup({}, { proactive: (ctx) => push(ctx, "urgent") });
    await s.policy({ cooldown_hours: 0, max_daily_pushes: 1 });
    await s.ingest();
    s.at("2026-12-01T23:00:00+08:00");
    expect((await s.evaluate()).nudges[0].deliver_after).toBe(new Date(s.clock()).toISOString());
    expect((await s.list()).total).toBe(1);
    s.at(eventDay);
    expect((await s.evaluate()).nudges).toHaveLength(1);
  });

  it("enforces the daily cap within a single batch, and same-source cooldown before a second call", async () => {
    const s = await setup({}, { proactive(ctx) {
      return { decision: "push", nudges: ctx.triggers.flatMap((t) => push({ ...ctx, triggers: [t] }).nudges) };
    } });
    await s.policy({ max_daily_pushes: 1 });
    await s.ingest([meeting + " 通行证需要续期"]);
    s.at(eve);
    const first = await s.evaluate();
    expect(first.nudges).toHaveLength(1);
    expect(first.suppressed_reasons).toContain("daily_limit");
    // The eve and day-of slots are 23.5 hours apart.
    const separate = await setup();
    await separate.ingest();
    separate.at(eve);
    await separate.evaluate();
    separate.at(eventDay);
    expect((await separate.evaluate()).suppressed_reasons).toContain("cooldown");
    expect(separate.calls()).toBe(1);
  });

  it.each(["read", "dismissed", "completed"])("records %s and blocks the next occurrence even after cooldown", async (action) => {
    const s = await setup();
    await s.policy({ cooldown_hours: 0 });
    await s.ingest();
    s.at(eve);
    const [n] = (await s.evaluate()).nudges;
    expect(await (await s.ack(n, action, { space_id: "elsewhere" })).json()).toMatchObject({ error: { code: "NUDGE_NOT_FOUND" } });
    expect(nudgeSchema.parse(await s.ok(await s.ack(n, "read"))).status).toBe("read");
    expect(nudgeSchema.parse(await s.ok(await s.ack(n, action)))).toMatchObject({ status: action, acked_at: new Date(s.clock()).toISOString() });
    expect((await s.list()).total).toBe(0);
    expect((await s.list("&status=" + action)).total).toBe(1);
    s.at(eventDay);
    expect((await s.evaluate()).suppressed_reasons).toContain("feedback");
    expect(s.calls()).toBe(1);
  });

  it("validates snooze, updates its single timer on retry and wakes at the requested instant", async () => {
    const s = await setup();
    await s.ingest();
    s.at(eve);
    const [n] = (await s.evaluate()).nudges;
    for (const extra of [{}, { snooze_until: eve }, { snooze_until: "tomorrow" }, { snooze_until: "2026-12-01T09:00:00+99:99" }]) {
      const res = await s.ack(n, "snooze", extra);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    }
    const until = "2026-12-01T02:00:00.000Z";
    for (let i = 0; i < 2; i++) expect(await s.ok(await s.ack(n, "snooze", { snooze_until: until }))).toMatchObject({ status: "snoozed" });
    expect((await s.evaluate()).triggers_processed).toBe(0);
    s.at(until);
    const result = await s.evaluate();
    expect(result.triggers_processed).toBe(1);
    expect(result.nudges[0].dedup_key).toBe(n.dedup_key);
    expect(result.nudges[0].nudge_id).not.toBe(n.nudge_id);
    expect((await s.evaluate()).triggers_processed).toBe(0);
    const again = "2026-12-01T02:30:00.000Z";
    await s.ok(await s.ack(result.nudges[0], "snooze", { snooze_until: again }));
    s.at(again);
    expect((await s.evaluate()).nudges).toHaveLength(1);
  });

  it("limits follow-up ancestry and enforces the minimum interval on a silent chain", async () => {
    const s = await setup({}, { proactive(ctx) {
      return { decision: "silent", follow_ups: [14, 15].map((minutes) => ({
        parent_trigger_id: ctx.triggers[0].trigger_id, fire_at: new Date(Date.parse(ctx.now) + minutes * 60_000).toISOString(), text: "确认复盘安排",
      })) };
    } });
    await s.ingest();
    s.at(eve);
    expect((await s.evaluate()).suppressed_reasons).toContain("follow_up_too_soon");
    s.at("2026-12-01T09:15:00+08:00");
    await s.evaluate();
    s.at("2026-12-01T09:30:00+08:00");
    expect((await s.evaluate()).suppressed_reasons).toContain("chain_depth");
    expect(s.db.prepare("SELECT chain_depth,status FROM proactive_triggers WHERE source_type='follow_up' ORDER BY fire_at").all())
      .toEqual([{ chain_depth: 1, status: "done" }, { chain_depth: 2, status: "done" }]);
  });

  it("streams a visible snapshot and committed deliveries only, with a side-effect-free dry run", async () => {
    const s = await setup();
    await s.ingest();
    s.at(eve);
    const abort = new AbortController();
    const response = await s.app.request(collection, { headers: { Accept: "application/json, text/event-stream" }, signal: abort.signal });
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toContain('event: snapshot\ndata: {"space":{"namespace":"personal","space_id":"travel"},"nudges":[],"total":0}');
    const before = s.tables();
    const event = read();
    const revision = s.db.pragma("data_version", { simple: true });
    const preview = await s.evaluate({ dry_run: true });
    expect(s.db.pragma("data_version", { simple: true })).toBe(revision);
    expect(preview).toMatchObject({ dry_run: true, triggers_processed: 1 });
    expect(preview.nudges).toHaveLength(1);
    expect(s.tables()).toEqual(before);
    const [n] = (await s.evaluate()).nudges;
    const frame = await event;
    expect(frame).toContain("event: nudge");
    expect(frame).toContain(n.nudge_id);
    expect(frame).not.toContain(preview.nudges[0].nudge_id);
    abort.abort();
    expect((await reader.read()).done).toBe(true);
  });

  it("cancels rolled-back schedules and fences a decision already in flight", async () => {
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const s = await setup({}, { async proactive(ctx) { entered.resolve(); await resume.promise; return push(ctx); } });
    await s.ingest(["基础笔记"]);
    await s.ingest();
    s.at(eve);
    const request = s.json(base + "/evaluate", ref);
    await entered.promise;
    try {
      expect((await s.json(base + "/evaluate", ref)).status).toBe(409);
      expect(await s.ok(await s.json(admin + "/rollback", { version: 1 }))).toMatchObject({ current_version: 1 });
    } finally { resume.resolve(); }
    expect((await request).status).toBe(409);
    expect(s.db.prepare("SELECT status FROM proactive_triggers WHERE source_type='memory_event'").all())
      .toEqual([{ status: "cancelled" }, { status: "cancelled" }]);
    s.at(eventDay);
    expect((await s.evaluate()).triggers_processed).toBe(0);
    expect((await s.list()).total).toBe(0);
    expect(s.calls()).toBe(1);
  });

  it("backfills today's and tomorrow's digest using the policy time zone without persisting previews", async () => {
    const s = await setup();
    await s.ingest();
    await s.policy({ timezone: "America/New_York", daily_digest_time: "08:30" });
    for (const invalid of [{ timezone: "Mars/Base" }, { quiet_end: "24:00" }, { daily_digest_time: "8:30" }])
      expect((await s.json(policyPath, invalid, "PUT")).status).toBe(400);
    expect(await s.ok(await s.app.request(policyPath))).toMatchObject({ timezone: "America/New_York" });
    const now = "2027-03-14T12:30:00.000Z";
    s.gateway.options.proactive = () => ({ decision: "silent" });
    const before = s.tables();
    await s.evaluate({ now, dry_run: true });
    expect(s.tables()).toEqual(before);
    await s.evaluate({ now });
    expect(s.db.prepare("SELECT fire_at,status FROM proactive_triggers WHERE source_type='daily_digest' ORDER BY fire_at").all())
      .toEqual([{ fire_at: now, status: "done" }, { fire_at: "2027-03-15T12:30:00.000Z", status: "pending" }]);
    expect(localTime(wallTime("2027-03-14", "02:30", "America/New_York"), "America/New_York").time).toBe("03:30");
    expect(new Date(wallTime("2027-11-07", "01:30", "America/New_York")).toISOString()).toBe("2027-11-07T05:30:00.000Z");
  });

  it("expires a queued quiet-hours delivery when its source is rolled back without consuming quota or cooldown", async () => {
    const s = await setup();
    await s.ingest(["基础笔记"]);
    await s.ok(await s.json(policyPath, { daily_digest_time: null, max_daily_pushes: 1, cooldown_hours: 24 }, "PUT"));
    await s.ingest();
    s.at("2026-12-01T23:00:00+08:00");
    const [n] = (await s.evaluate()).nudges;
    expect((await s.list()).total).toBe(0);
    await s.ok(await s.json(admin + "/rollback", { version: 1 }));
    s.at(n.deliver_after);
    expect((await s.list()).total).toBe(0);
    expect((await s.list("&status=expired")).nudges[0].nudge_id).toBe(n.nudge_id);
    // Rolling back to v2 restores the event: the expired undelivered nudge must not eat daily quota or cooldown.
    await s.ok(await s.json(admin + "/rollback", { version: 2 }));
    const restored = await s.evaluate({ now: "2026-12-02T08:30:00+08:00" });
    expect(restored.nudges).toHaveLength(1);
    expect(restored.suppressed_reasons).not.toContain("cooldown");
    expect(restored.suppressed_reasons).not.toContain("daily_limit");
  });

  it("streams deferred deliveries at the boundary and allows reader cancellation", async () => {
    const s = await setup();
    await s.ingest();
    s.at("2026-12-01T23:00:00+08:00");
    const [n] = (await s.evaluate()).nudges;
    s.at(new Date(Date.parse(n.deliver_after) - 40).toISOString());
    const response = await s.app.request(collection, { headers: { Accept: "text/event-stream" } });
    const reader = response.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toContain('"nudges":[]');
    s.at(n.deliver_after);
    expect(await read()).toContain(n.nudge_id);
    await reader.cancel();
  });

  it("hydrates an existing space after enabling the plugin and polls only due work", async () => {
    const s = await setup({ PROACTIVE_ENABLED: "0" });
    await s.ingest();
    s.at(eve);
    const service = createService({ ...s.config, PROACTIVE_ENABLED: true, PROACTIVE_POLL_SECONDS: 1 }, { clock: s.clock });
    cleanup.push(service.close);
    const first = s.tables();
    const preview = await service.app.request(base + "/evaluate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...ref, dry_run: true }),
    });
    expect(evaluateResultSchema.parse(await s.ok(preview)).nudges).toHaveLength(1);
    expect(s.tables()).toEqual(first);
    service.start();
    await expect.poll(async () => (await (await service.app.request(collection)).json()).total, { timeout: 3500 }).toBe(1);
    expect(s.calls()).toBe(2);
  });

  it("builds a grounded digest from the next three days and includes acknowledged working state", async () => {
    let seen: ProactiveContext | undefined;
    const s = await setup({}, { proactive(ctx) {
      seen = ctx;
      if (ctx.triggers.some((t) => t.source_type === "daily_digest")) {
        const anchor = ctx.upcoming[0].anchors[0];
        return { decision: "digest", nudges: [{ trigger_ids: ctx.triggers.map((t) => t.trigger_id),
          kind: "digest", urgency: "low", title: "明日安排", body: "复盘 [src:" + anchor + "]", citations: [anchor] }] };
      }
      return push(ctx);
    } });
    await s.ingest();
    s.at(eve);
    const [early] = (await s.evaluate()).nudges;
    await s.ok(await s.ack(early, "read"));
    await s.ingest(["通行证需要续期"]);
    await s.policy({ daily_digest_time: "09:30" });
    const result = await s.evaluate({ now: "2026-12-01T09:30:00+08:00" });
    expect(result).toMatchObject({ decision_summary: "digest", nudges: [{ kind: "digest" }] });
    expect(seen?.upcoming[0].text).toContain("通行证");
    expect(seen?.upcoming).toHaveLength(1);
    expect(seen?.working_state).toContainEqual(expect.objectContaining({ status: "read" }));
  });

  it("rejects raw locators from a document retained on disk outside the current snapshot", async () => {
    const s = await setup();
    await s.ingest();
    const old = await s.ingest(["另一份来源"]);
    const foreign = old.accepted_docs[0].doc_id + "#p1";
    await s.ok(await s.json(admin + "/rollback", { version: 1 }));
    s.gateway.options.proactive = (ctx) => {
      const result = push(ctx);
      result.nudges[0].citations.push(foreign);
      result.nudges[0].body += " [src:" + foreign + "]";
      return result;
    };
    s.at(eve);
    const [n] = (await s.evaluate()).nudges;
    expect(n.citations).toHaveLength(1);
    expect(n.citations[0].anchor).not.toBe(foreign);
    expect(n.body).not.toContain(foreign);
  });

  it("checks a persisted foreign lease, recovers after expiry and enforces a zero daily allowance before a model call", async () => {
    const s = await setup();
    await s.ingest();
    s.at(eve);
    s.db.prepare("INSERT INTO proactive_leases VALUES (?,?,?)").run("personal:travel", "another-process", Date.now() + 60_000);
    for (const dry_run of [false, true]) expect((await s.json(base + "/evaluate", { ...ref, dry_run })).status).toBe(409);
    s.db.exec("UPDATE proactive_leases SET valid_until=0");
    await s.policy({ max_daily_pushes: 0 });
    expect(await s.evaluate()).toMatchObject({ suppressed_reasons: ["daily_limit"], nudges: [], triggers_processed: 1 });
    expect(s.calls()).toBe(0);
    expect(s.db.prepare("SELECT * FROM proactive_leases").all()).toEqual([]);
  });

  it("represents a large due batch within the context budget and expands grouped decisions back to their sources", async () => {
    let seen: ProactiveContext | undefined;
    const s = await setup({}, { proactive(ctx) {
      seen = ctx;
      const result = push(ctx);
      result.nudges[0].trigger_ids.push(...ctx.trigger_groups.map((g) => g.group_id));
      return result;
    } });
    await s.ingest([Array.from({ length: 36 }, (_, i) => "Agenda item " + i + " due 2026-12-02").join("\n")]);
    s.at(eve);
    const result = await s.evaluate();
    expect(result.triggers_processed).toBe(36);
    expect(seen?.trigger_groups.length).toBeGreaterThan(0);
    expect(countTokens(JSON.stringify(seen))).toBeLessThanOrEqual(2500);
    expect(result.nudges[0].trigger_ids).toHaveLength(36);
    expect(s.calls()).toBe(1);
  });

  it("serializes concurrent previews and commits across processes without persisting a preview lease", async () => {
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const s = await setup({}, { async proactive(ctx) { entered.resolve(); await resume.promise; return push(ctx); } });
    await s.ingest();
    s.at(eve);
    const lockDir = join(s.config.DATA_DIR, "proactive-locks");
    async function lockFiles() {
      return Promise.all((await readdir(lockDir)).sort().map(async (file) => {
        const info = await stat(join(lockDir, file));
        return { file, size: info.size, modified: info.mtimeMs };
      }));
    }
    const before = await lockFiles();
    const tables = s.tables();
    const script = `
      import { createService } from "./src/service.ts";
      const [config, payload] = process.argv.slice(1).map(JSON.parse);
      const service = createService(config);
      try {
        const response = await service.app.request("/v1/proactive/evaluate", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (response.status !== 200) throw new Error(await response.text());
      } finally { await service.close(); }
    `;
    const child = promisify(execFile)(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(s.config), JSON.stringify({ ...ref, dry_run: true, now: eve }),
    ], { cwd: new URL("../apps/api/", import.meta.url), timeout: 10_000 });
    try {
      await Promise.race([entered.promise, child.then(() => { throw new Error("Preview ended before model call"); })]);
      for (const dry_run of [false, true]) expect((await s.json(base + "/evaluate", { ...ref, dry_run })).status).toBe(409);
      expect(s.db.prepare("SELECT * FROM proactive_leases").all()).toEqual([]);
    } finally { resume.resolve(); await child; }
    expect(s.tables()).toEqual(tables);
    expect(await lockFiles()).toEqual(before);
    expect((await s.evaluate()).nudges).toHaveLength(1);
  }, 15_000);

  it("publishes OpenAPI 3.1 request and response contracts for every operation and both delivery formats", async () => {
    const s = await setup();
    const spec = await s.ok(await s.app.request("/openapi.json"));
    expect(spec.openapi).toBe("3.1.0");
    for (const [path, method, field] of [
      ["/nudges", "get", "nudges"], ["/nudges/{nudge_id}/ack", "post", "citations"], ["/evaluate", "post", "triggers_processed"],
      ["/spaces/{ns}/{id}/policy", "put", "timezone"], ["/spaces/{ns}/{id}/policy", "get", "timezone"],
    ]) {
      const op = spec.paths[base + path][method];
      expect(op.responses["200"].content["application/json"].schema.properties).toHaveProperty(field);
      for (const code of ["400", "404", "409"]) expect(op.responses[code].content["application/json"].schema.properties.error.properties).toHaveProperty("code");
      if (method !== "get") expect(op.requestBody.content["application/json"].schema).toBeDefined();
    }
    expect(spec.paths[base + "/nudges"].get.responses["200"].content["text/event-stream"].schema.type).toBe("string");
  });
});
