import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateResultSchema, executeNudgeActionResultSchema, intentionsResultSchema, jobResultSchema,
  nudgeSchema, proactiveEventResultSchema, proactiveProfileSchema, prospectiveIntentionSchema,
  replayResultSchema, scoutResultSchema,
} from "@wiki-memory/shared";
import type { Nudge, ProactivePolicy, ProposedAction } from "@wiki-memory/shared";
import { readConfig } from "../apps/api/src/config.js";
import { SQLiteConnection } from "../apps/api/src/db/sqlite-repo.js";
import { createService } from "../apps/api/src/service.js";
import { startFixtureGateway, type GatewayOptions, type ProactiveContext } from "./fixtures/gateway.js";

const ref = { namespace: "personal", space_id: "dispatch" };
const query = new URLSearchParams(ref).toString();
const base = "/v1/proactive";
const space = "/spaces/personal/dispatch";
const memory = "/v1/memory" + space;
const now = "2026-12-01T10:00:00+08:00";
const source = "Meridian needs a shipping manifest before dispatch.";
const cue = { event_type: "email_received", summary: "Meridian" };
const goal = "Review the shipping manifest";
const missing = "doc_0000000000000000#s999";
const actions: ProposedAction[] = [
  { action_id: "resolve", label: "Use the signed manifest", kind: "resolve_conflict", payload: { manifest: "signed" } },
  { action_id: "move", label: "Move pickup to Friday", kind: "reschedule", payload: { day: "Friday" } },
];
const utility = { miss_cost: 6, actionability: 3, value_add: 4, interruption_cost: 2, net_utility: 11 };

type DraftFields = Pick<Nudge, "kind" | "urgency" | "prepared_brief" | "why_now" | "proposed_actions" | "utility_score">;
function push(ctx: ProactiveContext, overrides: Partial<DraftFields> = {}) {
  const trigger = ctx.triggers[0];
  const anchor = trigger.anchors[0];
  return { decision: "push", nudges: [{
    trigger_ids: [trigger.trigger_id], kind: "reminder", urgency: "normal", title: "Review dispatch",
    body: "Compare the manifest [src:" + anchor + "]", citations: [anchor], ...overrides,
  }] };
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(options: GatewayOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), "proactive-v2-"));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  const gateway = await startFixtureGateway({ proactive: push, ...options });
  cleanup.push(gateway.close);
  let clock = Date.parse(now);
  const at = (instant: string) => { clock = Date.parse(instant); };
  const service = createService(readConfig({ DATA_DIR: dir, LLM_BASE_URL: gateway.baseUrl, LLM_API_KEY: "fixture" }),
    { clock: () => clock });
  cleanup.push(service.close);
  service.start();
  // A separate connection observes commits even if a write restores the original row values.
  const observer = new SQLiteConnection(dir);
  cleanup.push(() => observer.close());
  const version = () => observer.client.pragma("data_version", { simple: true });

  async function request(path: string, body?: object, method = body ? "POST" : "GET", status = 200) {
    const res = await service.app.request(path, { method, ...(body && {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }) });
    const data = await res.json();
    expect(res.status, JSON.stringify(data)).toBe(status);
    return data;
  }
  const policy = (p: Partial<ProactivePolicy>) => request(base + space + "/policy", p, "PUT");
  await request("/v1/admin/spaces", { ...ref, purpose: "Track dispatch commitments" });
  await policy({ daily_digest_time: null });

  async function ingest(content = source, filename = "manifest.txt") {
    const job = jobResultSchema.parse(await request("/v1/memories/ingest", {
      ...ref, mode: "sync", organize_mode: "skip", items: [{ content, filename, doc_date: "2026-11-20" }],
    }));
    expect(job.status, job.error_message ?? "").toBe("published");
    return job.accepted_docs[0].doc_id;
  }
  const intentions = async (status = "all") => intentionsResultSchema.parse(
    await request(base + "/intentions?" + query + "&status=" + status));
  const create = async (fields: object) => prospectiveIntentionSchema.parse(await request(base + "/intentions", {
    ...ref, kind: "event_based", goal, subjects: ["Meridian"], condition: { match_event_types: ["email_received"] }, ...fields,
  }, "POST", 201));
  const patch = async (id: string, fields: object) => prospectiveIntentionSchema.parse(
    await request(base + "/intentions/" + id, { ...ref, ...fields }, "PATCH"));
  const remove = (id: string) => request(base + "/intentions/" + id + "?" + query, undefined, "DELETE");
  const event = async (fields: object = {}) => proactiveEventResultSchema.parse(
    await request(base + "/events", { ...ref, ...cue, ...fields }));
  const evaluate = async (fields: object = {}) => evaluateResultSchema.parse(
    await request(base + "/evaluate", { ...ref, ...fields }));
  const ack = async (n: Nudge, fields: object) => nudgeSchema.parse(
    await request(base + "/nudges/" + n.nudge_id + "/ack", { ...ref, ...fields }));
  async function arm(fields: object = {}) {
    const anchor = (await ingest()) + "#s1";
    const intention = await create({ evidence_anchors: [anchor], ...fields });
    return { anchor, intention };
  }
  return { request, policy, ingest, intentions, create, patch, remove, event, evaluate, ack, arm, gateway,
    version, at, db: observer.client };
}

describe("prospective intentions", () => {
  it("creates, lists, updates, filters and deletes a user intention", async () => {
    const s = await setup();
    const i = await s.create({});
    expect(i).toMatchObject({ kind: "event_based", goal, source: "user", status: "armed", priority: "normal" });
    expect((await s.intentions("armed")).intentions).toEqual([i]);
    const changes = { goal: "Check the new manifest", priority: "high", status: "snoozed",
      snoozed_until: "2026-12-04T00:00:00Z", condition: { cue_text: "new dispatch" } };
    const updated = await s.patch(i.intention_id, changes);
    expect(updated).toMatchObject({ ...changes, intention_id: i.intention_id });
    expect((await s.intentions("armed")).total).toBe(0);
    expect((await s.intentions("snoozed")).intentions).toEqual([updated]);
    expect(await s.remove(i.intention_id)).toEqual({ deleted: true });
    expect(await s.intentions()).toMatchObject({ total: 0, intentions: [] });
  });

  it.each(["forget", "rollback"])("preserves manual status and deletion on replan and expires retracted claims on %s", async mode => {
    const goals = ["Check the packing list", "Call the carrier", "File the invoice"];
    const s = await setup({ extract: ({ document, segments }) => ({
      summary: document.filename,
      facts: [{ kind: "topic", subject: "Dispatch", predicate: "note", value: segments[0].text, locator: segments[0].locator }],
      intentions: document.filename === "commitments.txt" ? goals.map(goal => ({
        goal, kind: "event_based", subjects: ["Meridian"], cue_text: "dispatch", locator: segments[0].locator,
      })) : [],
    }) });
    await s.ingest();
    const doc = await s.ingest(goals.join(". "), "commitments.txt");
    const extracted = (await s.intentions()).intentions;
    expect(extracted.map(i => i.goal).sort()).toEqual([...goals].sort());
    for (const i of extracted) expect(i).toMatchObject({
      status: "armed", source: "memory", evidence_anchors: [doc + "#s1"], condition: { cue_text: "dispatch" },
    });
    const [done, deleted, live] = goals.map(goal => extracted.find(i => i.goal === goal)!.intention_id);
    await s.patch(done, { status: "fulfilled" });
    expect(await s.remove(deleted)).toEqual({ deleted: true });
    await s.policy({ cooldown_hours: 12 });
    const states = () => s.db.prepare("SELECT intention_id, source, status FROM proactive_intentions ORDER BY intention_id").all();
    function expectStates(status: string) {
      const rows = states();
      expect(rows).toHaveLength(2);
      expect(rows).toContainEqual({ intention_id: done, source: "memory", status: "fulfilled" });
      expect(rows).toContainEqual({ intention_id: live, source: "memory", status });
    }
    expectStates("armed");
    if (mode === "forget") {
      expect(await s.request("/v1/memories/forget", { ...ref, doc_ids: [doc], mode: "sync" })).toMatchObject({ status: "published" });
    } else {
      expect(await s.request("/v1/admin" + space + "/rollback", { version: 1 })).toMatchObject({ current_version: 1 });
    }
    expectStates("expired");
    expect((await s.intentions("expired")).intentions.map(i => i.intention_id)).toEqual([live]);
  });
});

describe("event gating and live memory context", () => {
  it("skips every gateway stage on an L1 miss and uses a registered alias to ground a push and apply updates", async () => {
    const s = await setup();
    const { anchor, intention: i } = await s.arm();
    const brief = "Use the signed manifest [src:" + anchor + "]";
    s.gateway.options.proactive = ctx => ({
      ...push(ctx, { prepared_brief: brief + " [src:" + missing + "]", why_now: "The carrier just wrote",
        proposed_actions: actions, utility_score: utility }),
      intention_updates: [{ intention_id: i.intention_id, status: "triggered" }],
    });
    const callsBefore = s.gateway.requests.length;
    for (const summary of ["Volcanic basalt", "Zaffre"]) {
      expect(await s.event({ summary })).toMatchObject({ l1_matches: [], llm_called: false, decision_summary: "silent", nudges: [] });
    }
    expect(s.gateway.requests).toHaveLength(callsBefore);
    await s.request(memory + "/aliases", { kind: "entity", alias: "Zaffre", canonical_subject: "Meridian" }, "POST", 201);
    const before = s.version();
    const preview = await s.event({ summary: "Zaffre", dry_run: true });
    expect(s.version()).toBe(before);
    expect(preview).toMatchObject({ dry_run: true, decision_summary: "push", updated_intention_ids: [], llm_called: true });
    expect((await s.intentions("armed")).intentions).toEqual([i]);

    const deciderCalls = () => s.gateway.requests.filter(r => r.stage === "proactive").length;
    const calls = deciderCalls();
    const result = await s.event({ summary: "Zaffre" });
    expect(deciderCalls()).toBe(calls + 1);
    expect(result).toMatchObject({ decision_summary: "push", llm_called: true, updated_intention_ids: [i.intention_id],
      l1_matches: [{ intention_id: i.intention_id, matched_by: expect.arrayContaining(["entity", "event_type"]) }],
      nudges: [{ intention_id: i.intention_id, prepared_brief: brief, citations: [{ anchor, raw_excerpt: expect.stringContaining(source) }], why_now: "The carrier just wrote",
        proposed_actions: actions, utility_score: utility }],
    });
    expect((await s.intentions("triggered")).intentions.map(row => row.intention_id)).toEqual([i.intention_id]);
  });

  it("supplies the Decider with the live core card, rule, hot memory, pending chat and engagement profile", async () => {
    const instruction = "Confirm the signed manifest";
    const decide = vi.fn(push);
    const s = await setup({ proactive: decide, extract: ({ segments: [first] }) => ({
      summary: "Dispatch instructions",
      facts: [{ kind: "entity", subject: "Meridian", predicate: "document", value: "shipping manifest", locator: first.locator }],
      procedural_rules: [{ trigger_context: "dispatch", instruction, priority: "high", locator: first.locator }],
    }) });
    await s.arm();
    const content = "Reserve a blue container for Meridian";
    const { hot_memory } = await s.request(memory + "/hot", { kind: "remember", content }, "POST", 201);
    const { session } = await s.request("/v1/chat" + space + "/sessions", {}, "POST", 201);
    await s.request("/v1/chat/sessions/" + session.session_id + "/messages", { content: "Meridian has a signed manifest." });
    const profile = proactiveProfileSchema.parse(await s.request(base + space + "/profile"));
    expect(profile.active_intentions_count).toBe(1);
    expect((await s.event()).decision_summary).toBe("push");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][0]).toMatchObject({
      core_card: expect.stringContaining(content), rules: expect.arrayContaining([expect.objectContaining({ instruction })]),
      hot_memories: expect.arrayContaining([expect.objectContaining({ id: hot_memory.id, content })]),
      pending_chat_hits: expect.arrayContaining([expect.objectContaining({ session_id: session.session_id, session_status: "pending" })]),
      proactive_profile: profile,
    });
  });

  it("updates an expiring fact trigger in place and removes it as soon as the fact is archived", async () => {
    const decide = vi.fn(push);
    const s = await setup({ proactive: decide });
    await s.ingest("通行证需要续期");
    const { facts: [fact] } = await s.request(memory + "/controls");
    const before = await s.evaluate({ dry_run: true });
    expect(before.triggers_processed).toBe(1);
    expect(decide.mock.lastCall?.[0].triggers).toMatchObject([{ source_type: "expiring_fact", text: expect.stringContaining(fact.value) }]);
    const edited = "Collect the replacement permit";
    await s.request(memory + "/facts", { fact_key: fact.fact_key, edited_value: edited }, "PATCH");
    const after = await s.evaluate({ dry_run: true });
    expect(after.nudges[0].snapshot_version).toBe(before.nudges[0].snapshot_version);
    const triggers = decide.mock.lastCall?.[0].triggers;
    expect(triggers).toMatchObject([{ source_type: "expiring_fact", text: expect.stringContaining(edited) }]);
    expect(triggers?.[0].text).not.toContain(fact.value);
    await s.request(memory + "/facts", { fact_key: fact.fact_key, archived_reason: "Permit renewed" }, "PATCH");
    expect(await s.evaluate()).toMatchObject({ triggers_processed: 0, decision_summary: "silent", nudges: [] });
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("suppresses a grounded non-urgent push with negative net utility", async () => {
    const s = await setup({ proactive: ctx => push(ctx, { utility_score: { ...utility, net_utility: -1 } }) });
    await s.arm();
    expect(await s.event()).toMatchObject({ llm_called: true, decision_summary: "silent", nudges: [],
      suppressed_reasons: expect.arrayContaining(["negative_utility"]) });
  });

  it("allows a user-created intention without memory anchors to push while still rejecting fabricated citations", async () => {
    const s = await setup({
      proactive: ctx => ({
        decision: "push",
        nudges: [{
          trigger_ids: [ctx.triggers[0].trigger_id],
          kind: "event_trigger",
          urgency: "normal",
          title: "准备合同发给客户",
          body: "客户已经确认报价，现在可以按报价准备合同。",
          why_now: "刚收到确认报价的邮件，适合马上推进合同。",
          citations: [],
        }],
      }),
    });
    const created = await s.create({
      kind: "event_based",
      goal: "把合同发给星辰科技",
      subjects: ["星辰科技"],
      condition: { cue_text: "星辰科技确认报价", match_event_types: ["email_received"] },
      evidence_anchors: [],
    });
    const ok = await s.event({
      event_type: "email_received",
      summary: "星辰科技确认报价，请按报价准备合同。",
      dry_run: true,
    });
    expect(ok).toMatchObject({
      llm_called: true,
      decision_summary: "push",
      l1_matches: [{ intention_id: created.intention_id }],
      matched_signals: expect.arrayContaining([
        expect.objectContaining({ source: "intention", signal_id: "intention:" + created.intention_id }),
      ]),
      nudges: [{ intention_id: created.intention_id, kind: "event_trigger", citations: [] }],
    });

    // Fabricated citation on a user-authored intention must still be rejected.
    s.gateway.options.proactive = ctx => ({
      decision: "push",
      nudges: [{
        trigger_ids: [ctx.triggers[0].trigger_id],
        kind: "event_trigger",
        urgency: "normal",
        title: "准备合同发给客户",
        body: "附伪造出处 [src:" + missing + "]",
        citations: [missing],
      }],
    });
    const fake = await s.event({
      event_type: "email_received",
      summary: "星辰科技确认报价，请按报价准备合同。",
      dry_run: true,
    });
    expect(fake).toMatchObject({
      llm_called: true,
      decision_summary: "silent",
      nudges: [],
      suppressed_reasons: expect.arrayContaining(["no_valid_citation"]),
    });
  });

  it("matches new calendar conflicts against active upcoming schedules via Chinese date parsing without requiring cancellation words", async () => {
    const s = await setup({
      extract: ({ segments: [first] }) => ({
        summary: "Hospital appointment",
        facts: [],
        timeline_events: [{
          date: "2026-12-05",
          text: "上午陪父亲到同仁医院复查白内障，10:30 报到",
          locator: first.locator,
          related: [{ kind: "entity", subject: "父亲" }],
        }],
      }),
    });
    const docId = await s.ingest("12月5日上午陪父亲去同仁医院复查", "hospital.txt");
    const result = await s.event({
      event_type: "calendar_changed",
      summary: "12月5日上午10点半新增架构评审",
      occurred_at: "2026-11-26T10:30:00+08:00",
      dry_run: true,
    });
    expect(result).toMatchObject({
      llm_called: true,
      decision_summary: "push",
      matched_signals: expect.arrayContaining([
        expect.objectContaining({
          source: "schedule",
          anchor: docId + "#s1",
          match_reason: expect.stringContaining("2026-12-05"),
        }),
      ]),
      nudges: [{ citations: [expect.objectContaining({ anchor: docId + "#s1" })] }],
    });
  });

  it("keeps unrelated small-talk and generic-stopword events silent with zero model calls", async () => {
    const s = await setup({
      extract: ({ segments: [first] }) => ({
        summary: "Family constraint",
        facts: [{
          kind: "entity",
          subject: "家人",
          predicate: "就诊安排红线",
          value: "12月5日陪诊安排不可随意取消",
          tier: "pinned_redline",
          locator: first.locator,
        }],
        timeline_events: [{
          date: "2026-12-05",
          text: "陪家人去医院复查",
          locator: first.locator,
          related: [{ kind: "entity", subject: "家人" }],
        }],
      }),
    });
    await s.ingest("12月5日陪家人去医院复查", "family.txt");
    const callsBefore = s.gateway.requests.length;
    for (const payload of [
      { event_type: "custom", summary: "今天天气晴朗，午饭打算吃面", entities: [] },
      { event_type: "chat_turn", summary: "今天天气晴朗无事发生", entities: ["安排", "明天", "取消"] },
    ]) {
      const res = await s.event({ ...payload, occurred_at: "2026-11-26T10:30:00+08:00", dry_run: true });
      expect(res).toMatchObject({
        l1_matches: [],
        matched_signals: [],
        llm_called: false,
        decision_summary: "silent",
        nudges: [],
        suppressed_reasons: ["no_l1_match"],
      });
    }
    expect(s.gateway.requests).toHaveLength(callsBefore);
  });

  it("surfaces high-relevance durable facts in matched_signals when no intention is pre-registered", async () => {
    const s = await setup({
      extract: ({ segments: [first] }) => ({
        summary: "Boss preference",
        facts: [{
          kind: "entity",
          subject: "林总",
          predicate: "汇报偏好",
          value: "只看一页结论和指标表格，不要长篇铺垫",
          tier: "durable",
          locator: first.locator,
        }],
      }),
    });
    const docId = await s.ingest("林总汇报只要一页结论和表格", "boss.txt");
    const result = await s.event({
      event_type: "calendar_changed",
      summary: "下午临时安排向林总做季度进度汇报",
      occurred_at: "2026-11-26T10:30:00+08:00",
      dry_run: true,
    });
    expect(result).toMatchObject({
      llm_called: true,
      decision_summary: "push",
      matched_signals: expect.arrayContaining([
        expect.objectContaining({ source: "fact", anchor: docId + "#s1" }),
      ]),
      nudges: [{ citations: [expect.objectContaining({ anchor: docId + "#s1" })] }],
    });
  });

  it("coalesces multiple LLM nudge drafts for one event into at most one highest-priority nudge while still applying intention updates", async () => {
    const s = await setup({
      extract: ({ segments: [first] }) => ({
        summary: "Dietary redline",
        facts: [{
          kind: "entity",
          subject: "陈默",
          predicate: "饮食禁忌",
          value: "绝对不吃香菜；痛风忌动物内脏和牛杂",
          tier: "pinned_redline",
          locator: first.locator,
        }],
      }),
    });
    const docId = await s.ingest("陈默绝对不吃香菜，痛风忌动物内脏和牛杂", "diet.txt");
    const anchor = docId + "#s1";
    const intention = await s.create({
      kind: "event_based",
      goal: "筹备苏晴生日晚餐",
      subjects: ["苏晴"],
      condition: { cue_text: "生日晚餐安排", match_event_types: ["chat_turn"] },
      evidence_anchors: [anchor],
    });
    const secondary = await s.create({
      kind: "event_based",
      goal: "确认生日聚餐餐厅预订",
      subjects: ["苏晴"],
      condition: { cue_text: "生日餐厅变动", match_event_types: ["chat_turn"] },
      evidence_anchors: [anchor],
    });
    s.gateway.options.proactive = ctx => {
      const primaryTriggerId = ctx.triggers[0].trigger_id;
      const secondaryTriggerId = ctx.triggers[1]?.trigger_id ?? primaryTriggerId;
      return {
        decision: "push",
        nudges: [
          {
            trigger_ids: [secondaryTriggerId],
            kind: "reminder",
            urgency: "normal",
            title: "提醒：确认生日聚餐准备",
            body: "别忘了提前预订生日晚餐 [src:" + anchor + "]",
            citations: [anchor],
            utility_score: { miss_cost: 4, actionability: 3, value_add: 3, interruption_cost: 2, net_utility: 8 },
          },
          {
            trigger_ids: [primaryTriggerId],
            kind: "risk_alert",
            urgency: "urgent",
            title: "饮食红线冲突：香菜与牛杂禁忌",
            body: "生日改吃香菜牛杂火锅直接触碰忌口与痛风红线 [src:" + anchor + "]",
            why_now: "现在回复换餐厅还能避免踩雷。",
            citations: [anchor],
            utility_score: { miss_cost: 9, actionability: 8, value_add: 8, interruption_cost: 2, net_utility: 23 },
          },
        ],
        intention_updates: [
          { intention_id: intention.intention_id, status: "triggered" },
          { intention_id: secondary.intention_id, status: "triggered" },
        ],
      };
    };

    const result = await s.event({
      event_type: "chat_turn",
      summary: "苏晴说生日改去吃香菜牛杂火锅",
      entities: ["苏晴"],
      occurred_at: "2026-11-26T10:30:00+08:00",
    });

    expect(result.llm_called).toBe(true);
    expect(result.decision_summary).toBe("push");
    expect(result.nudges).toHaveLength(1);
    expect(result.nudges[0]).toMatchObject({
      kind: "risk_alert",
      urgency: "urgent",
      intention_id: intention.intention_id,
      title: "饮食红线冲突：香菜与牛杂禁忌",
    });
    expect(result.updated_intention_ids).toEqual(expect.arrayContaining([intention.intention_id, secondary.intention_id]));
    expect((await s.intentions("triggered")).intentions.map(i => i.intention_id)).toEqual(
      expect.arrayContaining([intention.intention_id, secondary.intention_id]),
    );
    const stored = await s.request(base + "/nudges?" + query + "&status=all");
    expect(stored.total).toBe(1);
  });

  it("does not leak unrelated facts mentioning a person in value or subject without topical overlap and caps matched_signals to top 6", async () => {
    const s = await setup({
      extract: ({ document, segments: [first] }) => {
        if (document.filename === "diet.txt") {
          return {
            summary: "Diet and birthday",
            facts: [
              {
                kind: "entity",
                subject: "陈默",
                predicate: "饮食禁忌",
                value: "绝对不吃香菜；痛风忌动物内脏和牛杂",
                tier: "pinned_redline",
                locator: first.locator,
              },
              {
                kind: "entity",
                subject: "苏晴",
                predicate: "职业背景",
                value: "建筑设计师，平时爱喝燕麦拿铁",
                tier: "durable",
                locator: first.locator,
              },
              {
                kind: "entity",
                subject: "苏晴",
                predicate: "家庭身份",
                value: "陈默的爱人",
                tier: "pinned_redline",
                locator: first.locator,
              },
            ],
            timeline_events: [{
              date: "2026-12-03",
              text: "苏晴生日晚餐，原定城南日料店",
              locator: first.locator,
              related: [{ kind: "entity", subject: "苏晴" }],
            }],
          };
        }
        return {
          summary: "Pet care",
          facts: [
            {
              kind: "entity",
              subject: "芝麻",
              predicate: "家庭喂养分工",
              value: "工作日陈默早晚喂食，苏晴负责周末换猫砂和梳毛",
              tier: "durable",
              locator: first.locator,
            },
            {
              kind: "entity",
              subject: "芝麻",
              predicate: "处方粮禁忌",
              value: "严禁高磷猫粮，周末由苏晴核对配料表",
              tier: "pinned_redline",
              locator: first.locator,
            },
          ],
          timeline_events: [{
            date: "2026-12-08",
            text: "和苏晴一起带芝麻去宠物医院打疫苗",
            locator: first.locator,
            related: [{ kind: "entity", subject: "苏晴" }, { kind: "entity", subject: "芝麻" }],
          }],
        };
      },
    });
    const dietDoc = await s.ingest("陈默绝对不吃香菜，痛风忌牛杂；12月3日苏晴生日晚餐", "diet.txt");
    await s.ingest("芝麻家庭喂养分工：苏晴周末换猫砂，严禁高磷猫粮", "pet.txt");
    await s.request(memory + "/aliases", { kind: "entity", alias: "老婆", canonical_subject: "苏晴" }, "POST", 201);

    const result = await s.event({
      event_type: "chat_turn",
      summary: "苏晴说生日改去吃香菜牛杂火锅",
      entities: ["苏晴"],
      occurred_at: "2026-11-26T10:30:00+08:00",
      dry_run: true,
    });

    expect(result.llm_called).toBe(true);
    expect(result.matched_signals.length).toBeGreaterThanOrEqual(2);
    expect(result.matched_signals.length).toBeLessThanOrEqual(6);
    const labels = result.matched_signals.map(sig => sig.label);
    expect(result.matched_signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "redline", anchor: dietDoc + "#s1" }),
      expect.objectContaining({ source: "schedule", anchor: dietDoc + "#s1" }),
    ]));
    expect(labels.some(l => l.includes("芝麻"))).toBe(false);
    expect(labels.some(l => l.includes("职业背景"))).toBe(false);
    expect(labels.some(l => l.includes("家庭身份"))).toBe(false);
    expect(labels.some(l => l.includes("疫苗"))).toBe(false);
  });

  it("catches relative-date and weekday schedule conflicts like 明天下午2点看牙 without demo word lists while keeping same-day small talk silent", async () => {
    const s = await setup({
      extract: ({ segments: [first] }) => ({
        summary: "Schedules and recurring redline",
        facts: [{
          kind: "entity",
          subject: "周然",
          predicate: "周三固定安排",
          value: "每周三下午固定送孩子学钢琴，不排外部会议",
          tier: "pinned_redline",
          locator: first.locator,
        }],
        timeline_events: [
          {
            date: "2026-11-26",
            text: "上午例行站会同步进度",
            locator: first.locator,
            related: [{ kind: "entity", subject: "周然" }],
          },
          {
            date: "2026-11-27",
            text: "下午两点半与客户签合同",
            locator: first.locator,
            related: [{ kind: "entity", subject: "周然" }],
          },
        ],
      }),
    });
    const docId = await s.ingest("11月26日站会，11月27日下午与客户签合同，每周三下午送孩子学钢琴", "schedule.txt");

    // Relative date ("明天下午2点看牙") catches 2026-11-27 schedule with ZERO hardcoded Demo word list
    const dentist = await s.event({
      event_type: "chat_turn",
      summary: "明天下午2点看牙",
      entities: [],
      occurred_at: "2026-11-26T10:30:00+08:00",
      dry_run: true,
    });
    expect(dentist).toMatchObject({
      llm_called: true,
      decision_summary: "push",
      matched_signals: expect.arrayContaining([
        expect.objectContaining({
          source: "schedule",
          anchor: docId + "#s1",
          match_reason: expect.stringContaining("2026-11-27"),
        }),
      ]),
    });

    // Weekday mention ("周三下午面试") catches recurring Wednesday pinned_redline without Demo words
    const interview = await s.event({
      event_type: "chat_turn",
      summary: "周三下午面试",
      entities: [],
      occurred_at: "2026-11-26T10:30:00+08:00",
      dry_run: true,
    });
    expect(interview).toMatchObject({
      llm_called: true,
      decision_summary: "push",
      matched_signals: expect.arrayContaining([
        expect.objectContaining({
          source: "redline",
          anchor: docId + "#s1",
          match_reason: expect.stringContaining("周三"),
        }),
      ]),
    });

    // Same-day small talk stays 0-LLM silent even though 2026-11-26 has an active schedule!
    const callsBefore = s.gateway.requests.length;
    for (const summary of ["今天天气晴朗，午饭打算吃面", "今天天气不错，下午顺路买杯咖啡"]) {
      const quiet = await s.event({
        event_type: "custom",
        summary,
        entities: [],
        occurred_at: "2026-11-26T10:30:00+08:00",
        dry_run: true,
      });
      expect(quiet).toMatchObject({
        l1_matches: [],
        matched_signals: [],
        llm_called: false,
        decision_summary: "silent",
        nudges: [],
      });
    }
    expect(s.gateway.requests).toHaveLength(callsBefore);
  });
});

describe("dream-time scout", () => {
  it("previews without writes, rejects a finding with an invalid anchor, and deduplicates an armed finding", async () => {
    const s = await setup();
    const anchor = (await s.ingest()) + "#s1";
    const finding = { kind: "open_loop", priority: "high", title: "Missing manifest", goal,
      rationale: "Dispatch is waiting for the manifest", subjects: ["Meridian"], evidence_anchors: [anchor] };
    const scout = vi.fn(() => ({ findings: [finding,
      { ...finding, goal: "Check an unverified order", evidence_anchors: [anchor, missing] }] }));
    s.gateway.options.scout = scout;
    const run = async (dry_run: boolean) => scoutResultSchema.parse(await s.request(base + "/scout", { ...ref, now, dry_run }));
    const before = s.version();
    expect(await run(true)).toMatchObject({ dry_run: true, findings: [finding], created_intentions: [] });
    expect(s.version()).toBe(before);
    expect((await s.intentions()).total).toBe(0);
    const saved = await run(false);
    expect(saved).toMatchObject({ findings: [finding], created_intentions: [{
      kind: finding.kind, goal, priority: "high", status: "armed", source: "scout", evidence_anchors: [anchor],
    }] });
    expect(await run(false)).toMatchObject({ findings: [], created_intentions: [] });
    expect((await s.intentions("armed")).intentions).toEqual(saved.created_intentions);
    expect(scout).toHaveBeenCalledTimes(3);
    expect(scout).toHaveBeenCalledWith(expect.objectContaining({ active_facts: [expect.objectContaining({ anchor })] }));
  });
});

describe("nudge actions and delivery policy", () => {
  it.each(actions)("records the confirmed $kind action in hot memory and completes the nudge", async action => {
    const s = await setup({ proactive: ctx => push(ctx, { proposed_actions: actions }) });
    const { intention } = await s.arm();
    const { nudges: [n] } = await s.event();
    const path = base + "/nudges/" + n.nudge_id + "/execute-action";
    const note = "Confirmed by the dispatcher";
    const body = { ...ref, action_id: action.action_id, note };
    const result = executeNudgeActionResultSchema.parse(await s.request(path, body));
    expect(result).toMatchObject({ executed_action: action, hot_memory_id: expect.any(String),
      nudge: { nudge_id: n.nudge_id, intention_id: intention.intention_id, status: "completed", ack_reason: "helpful" } });
    if (action.kind === "resolve_conflict") {
      expect(result.intention_updated).toBe(true);
      expect((await s.intentions("fulfilled")).intentions.map(i => i.intention_id)).toEqual([intention.intention_id]);
    }
    await s.request(path, body, "POST", 409);
    const { hot_memories } = await s.request(memory + "/controls");
    expect(hot_memories).toMatchObject([{ id: result.hot_memory_id, status: "active", kind: "remember",
      content: expect.stringContaining(action.label) }]);
    expect(hot_memories[0].content).toContain(note);
  });

  it("delivers the next occurrence after read with keep_reminding and aggregates explicit dismissal feedback", async () => {
    const s = await setup();
    const { intention } = await s.arm();
    const { nudges: [first] } = await s.event();
    expect(await s.ack(first, { action: "read", keep_reminding: true })).toMatchObject({ status: "read" });
    s.at("2026-12-01T11:00:00+08:00");
    const again = await s.event();
    expect(again).toMatchObject({ decision_summary: "push", nudges: [{ intention_id: intention.intention_id, dedup_key: first.dedup_key }] });
    const [second] = again.nudges;
    expect(second.nudge_id).not.toBe(first.nudge_id);
    expect(await s.ack(second, { action: "dismissed", reason: "too_early" })).toMatchObject({ status: "dismissed", ack_reason: "too_early" });
    const profile = proactiveProfileSchema.parse(await s.request(base + space + "/profile"));
    expect(profile).toMatchObject({ total_nudges: 2, overall_acceptance_rate: 0.5, active_intentions_count: 1,
      by_kind: [{ kind: "reminder", total: 2, read: 1, dismissed: 1, completed: 0, snoozed: 0, acceptance_rate: 0.5 }],
      top_dismiss_reasons: [{ reason: "too_early", count: 1 }],
    });
  });

  it.each([
    ["unsupported", "event_based", "normal", "reminder", false],
    ["redline", "event_based", "redline", "reminder", true],
    ["risk watch", "risk_watch", "normal", "reminder", true],
    ["model-labeled conflict check", "event_based", "normal", "conflict_check", false],
  ] as const)("applies the strict quiet guard to an urgent %s nudge", async (_, kind, priority, nudgeKind, immediate) => {
    const s = await setup({ proactive: ctx => push(ctx, { kind: nudgeKind, urgency: "urgent" }) });
    await s.arm({ kind, priority });
    await s.policy({ strict_urgent_quiet_guard: true, timezone: "UTC", quiet_start: "22:00", quiet_end: "08:00" });
    const night = "2026-12-01T23:00:00.000Z";
    expect(await s.event({ occurred_at: night })).toMatchObject({ decision_summary: "push", nudges: [{
      urgency: immediate ? "urgent" : "normal", deliver_after: immediate ? night : "2026-12-02T08:00:00.000Z",
    }] });
  });
});

describe("replay and HTTP contract", () => {
  it("sorts mixed timeline steps, scores hits, misses and false alarms, and leaves SQLite unchanged", async () => {
    const decide = vi.fn(push);
    const s = await setup({ proactive: decide });
    // The timer becomes due at noon. Only email events about Meridian pass L1.
    await s.arm({ condition: { fire_at: "2026-12-01T12:00:00+08:00", match_event_types: ["email_received"] } });
    const other = { ...cue, summary: "Volcanic basalt" };
    const steps = [
      { step_id: "premature", kind: "evaluate", expected_decision: "push", critical: true },
      { step_id: "unrelated", kind: "event", event: other, expected_decision: "silent" },
      { step_id: "correct-alert", kind: "event", event: cue, expected_decision: "push", critical: true },
      { step_id: "false-alarm", kind: "event", event: cue, expected_decision: "silent" },
      { step_id: "timer", kind: "evaluate", expected_decision: "push" },
      { step_id: "quiet", kind: "event", event: other, expected_decision: "silent" },
      { step_id: "still-quiet", kind: "event", event: other, expected_decision: "silent" },
    ].map((step, i) => ({ ...step, at: new Date(Date.parse("2026-12-01T08:00:00+08:00") + i * 3600_000).toISOString() }));
    const before = s.version();
    const r = replayResultSchema.parse(await s.request(base + "/replay", { ...ref, steps: [...steps].reverse() }));
    expect(s.version()).toBe(before);
    expect(r).toMatchObject({ total_steps: 7, push_precision: 2 / 3, critical_recall: 1 / 2,
      silence_accuracy: 3 / 4, citation_grounding_rate: 1 });
    expect(r.steps.map(row => row.step_id)).toEqual(steps.map(step => step.step_id));
    expect(r.steps.map(row => row.actual_decision)).toEqual(["silent", "silent", "push", "push", "push", "silent", "silent"]);
    expect(r.steps.map(row => row.matched)).toEqual([false, true, true, false, true, true, true]);
    expect(decide.mock.calls.map(([ctx]) => ctx.now)).toEqual([steps[2].at, steps[3].at, steps[4].at]);
    for (const row of r.steps) {
      const count = row.actual_decision === "push" ? 1 : 0;
      expect(row).toMatchObject({ nudge_count: count, grounded_citations: count, total_citations: count });
    }
  });

  it("documents all nine Proactive 2.0 operations with request parameters and JSON response schemas", async () => {
    const s = await setup();
    const spec = await s.request("/openapi.json");
    expect(spec.openapi).toBe("3.1.0");
    const operations = [
      ["/intentions", "get", 200, "intentions", ["query:namespace", "query:space_id", "query:status"]],
      ["/intentions", "post", 201, "intention_id", ["body:kind", "body:goal"]],
      ["/intentions/{intention_id}", "patch", 200, "status", ["path:intention_id", "body:status"]],
      ["/intentions/{intention_id}", "delete", 200, "deleted", ["path:intention_id", "query:namespace", "query:space_id"]],
      ["/events", "post", 200, "l1_matches", ["body:event_type", "body:summary"]],
      ["/scout", "post", 200, "created_intentions", ["body:dry_run"]],
      ["/spaces/{ns}/{id}/profile", "get", 200, "by_kind", ["path:ns", "path:id"]],
      ["/nudges/{nudge_id}/execute-action", "post", 200, "executed_action", ["path:nudge_id", "body:action_id"]],
      ["/replay", "post", 200, "push_precision", ["body:steps"]],
    ] as const;
    for (const [path, method, status, responseField, inputs] of operations) {
      const op = spec.paths[base + path]?.[method];
      expect(op, method + " " + path).toBeDefined();
      expect(op.responses[status].content["application/json"].schema.properties).toHaveProperty(responseField);
      for (const input of inputs) {
        const [location, name] = input.split(":");
        if (location === "body") {
          expect(op.requestBody.required).toBe(true);
          expect(op.requestBody.content["application/json"].schema.properties).toHaveProperty(name);
        } else {
          expect(op.parameters).toContainEqual(expect.objectContaining({ in: location, name }));
        }
      }
      for (const code of [400, 404, 409]) {
        expect(op.responses[code].content["application/json"].schema.properties.error.properties).toHaveProperty("code");
      }
    }
  });
});
