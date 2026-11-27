import { randomUUID } from "node:crypto";
import type {
  Nudge, ProactiveEventInput, ProactiveEventMatch, ProactiveEventResult, ProactiveEventSignal, ProactivePolicy, SpaceRef,
} from "@wiki-memory/shared";
import { spaceKey } from "../../db/interfaces.js";
import { queryTerms } from "../../db/tokenize.js";
import { ServiceError } from "../../errors.js";
import { cosineSimilarity, inferFactTier, vectorizeSemanticText } from "../../memory/memory-state.js";
import { anchorKey, claimAnchors, claimKey } from "../../pipeline/analyzer.js";
import type { VerifiedNudge } from "./decider.js";
import type { Engine } from "./engine.js";
import { deliveries, eligible, followUps, hasDeliveryBudget } from "./guardrails.js";
import { activeLedger, controlState, timer } from "./planner.js";
import type { Payload, Trigger } from "./planner.js";
import { iso, localTime, shiftDay, wallTime } from "./time.js";

const MAX_EVENT_SIGNALS = 6;

const NUDGE_KIND_RANK: Record<Nudge["kind"], number> = {
  risk_alert: 4,
  conflict_check: 3,
  event_trigger: 2,
  reminder: 1,
  open_loop: 1,
  follow_up: 1,
  digest: 1,
};

const URGENCY_RANK: Record<Nudge["urgency"], number> = {
  urgent: 3,
  normal: 2,
  low: 1,
};

function compareEventDrafts(a: VerifiedNudge, b: VerifiedNudge) {
  return (NUDGE_KIND_RANK[b.kind] - NUDGE_KIND_RANK[a.kind])
    || (URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency])
    || ((b.utility_score?.net_utility ?? 0) - (a.utility_score?.net_utility ?? 0));
}

const stateChange = /取消|改期|改到|改去|改为|变更|变动|挪到|推迟|延后|延期|提前|已完成|搞定了|不去了|不办了|黄了|泡汤|\b(?:cancel(?:led|ed)?|reschedul(?:e|ed)|postpon(?:e|ed)|delay(?:ed)?|done|completed)\b/i;

const GENERIC_ENTITIES = new Set([
  "安排", "事情", "会议", "客户", "明天", "今天", "后天", "昨天", "取消", "提醒", "邮件", "通知", "消息",
  "时间", "上午", "下午", "晚上", "中午", "早上", "晚间", "日程", "计划", "待办", "工作", "项目", "例会",
  "预约", "活动", "问题", "确认", "改期", "推迟", "提前", "完成", "更新", "变化", "对话",
  "新增", "临时", "其他", "自己", "我们", "家人", "朋友", "老板", "同事", "公司", "大家", "天气", "午饭",
  "晚饭", "早饭", "吃饭", "今日", "明日", "本周", "下周", "周末", "顺路", "打算", "不错", "晴朗",
  "meeting", "client", "customer", "email", "calendar", "tomorrow", "today", "event", "schedule",
  "cancel", "cancelled", "reminder", "update", "custom", "chat", "turn", "notification", "app", "signal",
]);

const WEEKDAY_MAP: Record<string, number> = { "日": 0, "天": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6 };
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function validCalendarDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  const d = new Date(`${candidate}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return undefined;
  return candidate;
}

function inferYear(month: number, baseYear: number, baseMonth: number) {
  return month < baseMonth - 6 ? baseYear + 1 : baseYear;
}

function resolveWeekday(baseDay: string, targetDow: number, prefix?: string): string {
  const baseDow = new Date(`${baseDay}T12:00:00Z`).getUTCDay();
  if (prefix === "下") {
    const monBasedBase = (baseDow + 6) % 7;
    const monBasedTarget = (targetDow + 6) % 7;
    const daysToNextMonday = 7 - monBasedBase;
    return shiftDay(baseDay, daysToNextMonday + monBasedTarget);
  }
  const delta = (targetDow - baseDow + 7) % 7;
  return shiftDay(baseDay, delta);
}

interface TimeRefs {
  explicitDates: Set<string>;
  todayDates: Set<string>;
  futureRelativeDates: Set<string>;
  weekdayDates: Set<string>;
  weekdays: Set<number>;
  hasClockTime: boolean;
}

function extractTimeRefs(text: string, baseDay: string): TimeRefs {
  const baseYear = Number(baseDay.slice(0, 4));
  const baseMonth = Number(baseDay.slice(5, 7));
  const explicitDates = new Set<string>();
  const todayDates = new Set<string>();
  const futureRelativeDates = new Set<string>();
  const weekdayDates = new Set<string>();
  const weekdays = new Set<number>();

  // YYYY-MM-DD, YYYY/MM/DD, YYYY年M月D日/号
  for (const m of text.matchAll(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/g)) {
    const d = validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) explicitDates.add(d);
  }
  // M月D日 至/到/- D2日 (date range in same month, e.g. 12 月 2 日至 5 日)
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(?:至|到|-|~|—)\s*(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*[日号]/g)) {
    const m1 = Number(m[1]), d1 = Number(m[2]);
    const m2 = m[3] ? Number(m[3]) : m1, d2 = Number(m[4]);
    const y1 = inferYear(m1, baseYear, baseMonth);
    const y2 = m2 < m1 ? y1 + 1 : y1;
    const start = validCalendarDate(y1, m1, d1);
    const end = validCalendarDate(y2, m2, d2);
    if (start && end && start <= end) {
      let cur = start;
      for (let i = 0; i < 14 && cur <= end; i++, cur = shiftDay(cur, 1)) explicitDates.add(cur);
    }
  }
  // M月D日 / M月D号
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) {
    const month = Number(m[1]), day = Number(m[2]);
    const d = validCalendarDate(inferYear(month, baseYear, baseMonth), month, day);
    if (d) explicitDates.add(d);
  }
  // MM-DD / M/D (avoiding YYYY-MM-DD and decimals/times)
  for (const m of text.matchAll(/(?<![\d./:-])(1[0-2]|0?[1-9])[-/](3[01]|[12]\d|0?[1-9])(?![\d./:-])/g)) {
    const month = Number(m[1]), day = Number(m[2]);
    const d = validCalendarDate(inferYear(month, baseYear, baseMonth), month, day);
    if (d) explicitDates.add(d);
  }
  // Relative days
  if (/今天|今日|今晚|今早|\btoday\b|\btonight\b/i.test(text)) todayDates.add(baseDay);
  if (/明天|明日|明晚|明早|\btomorrow\b/i.test(text)) futureRelativeDates.add(shiftDay(baseDay, 1));
  if (/后天|后日/.test(text)) futureRelativeDates.add(shiftDay(baseDay, 2));
  if (/大后天/.test(text)) futureRelativeDates.add(shiftDay(baseDay, 3));

  // Weekday ranges: 周三到周五 / 周二至周四
  for (const m of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天])\s*(?:至|到|-|~)\s*(?:周|星期|礼拜)?([一二三四五六日天])/g)) {
    const a = WEEKDAY_MAP[m[1]], b = WEEKDAY_MAP[m[2]];
    if (a !== undefined && b !== undefined) {
      let cur = a;
      for (let i = 0; i < 7; i++) {
        weekdays.add(cur);
        if (cur === b) break;
        cur = (cur + 1) % 7;
      }
    }
  }
  // Individual weekdays: (下|本|这|每)?(周|星期|礼拜)[一..日天]
  for (const m of text.matchAll(/(下|本|这|每)?(?:周|星期|礼拜)([一二三四五六日天])/g)) {
    const dow = WEEKDAY_MAP[m[2]];
    if (dow === undefined) continue;
    weekdays.add(dow);
    if (m[1] !== "每") weekdayDates.add(resolveWeekday(baseDay, dow, m[1]));
  }
  // Enumerated weekdays like 周二、周四 or 周二/四
  for (const m of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天])(?:[、,，/和与](?:周|星期|礼拜)?([一二三四五六日天]))+/g)) {
    for (const ch of m[0].matchAll(/[一二三四五六日天]/g)) {
      const dow = WEEKDAY_MAP[ch[0]];
      if (dow !== undefined) weekdays.add(dow);
    }
  }

  return {
    explicitDates,
    todayDates,
    futureRelativeDates,
    weekdayDates,
    weekdays,
    hasClockTime: /\d{1,2}\s*[:：点时]|今晚|今早|\btonight\b/i.test(text),
  };
}

function expandSubjects(subjects: string[], allowGeneric: boolean) {
  const out = new Set<string>();
  for (const raw of subjects) {
    const full = claimKey(raw);
    if (full.length >= 2 && (allowGeneric || !GENERIC_ENTITIES.has(full))) out.add(full);
    for (const part of raw.split(/[与和及、，,（）()/\s]+|的/)) {
      const k = claimKey(part);
      if (k.length >= 2 && (allowGeneric || !GENERIC_ENTITIES.has(k))) out.add(k);
    }
  }
  return [...out];
}

function addEntityNameTokens(target: Set<string>, raw: string) {
  const full = claimKey(raw);
  if (full.length >= 2 && !GENERIC_ENTITIES.has(full)) {
    target.add(full);
    if (full.length <= 3) {
      for (const term of queryTerms(full)) {
        if (!GENERIC_ENTITIES.has(term)) target.add(term);
      }
    }
  }
}

function matcher(contentText: string, expandedText: string, entities: string[], knownEntityTokens: Set<string>) {
  const expandedNormalized = claimKey(expandedText);
  const allTerms = new Set(queryTerms(contentText));
  const specificTerms = new Set([...allTerms].filter(t => !GENERIC_ENTITIES.has(t)));
  const vector = vectorizeSemanticText(contentText);
  const meaningfulEntities = entities
    .map(e => claimKey(e))
    .filter(k => k.length >= 2 && !GENERIC_ENTITIES.has(k));
  const eventEntityTokens = new Set<string>();
  for (const e of meaningfulEntities) addEntityNameTokens(eventEntityTokens, e);

  return (goal: string, subjects: string[], opts: { allowGenericSubjects?: boolean; includeBodyEntities?: boolean } = {}) => {
    const allowGeneric = opts.allowGenericSubjects ?? false;
    const includeBodyEntities = opts.includeBodyEntities ?? false;
    const subjectKeys = expandSubjects(subjects, allowGeneric);
    const goalKey = claimKey(goal);
    const subjectHit = subjectKeys.some(k => expandedNormalized.includes(k))
      || meaningfulEntities.some(e => subjectKeys.some(k => k.includes(e) || e.includes(k)))
      || (includeBodyEntities && meaningfulEntities.some(e => goalKey.includes(e)));
    const terms = allowGeneric ? allTerms : specificTerms;
    const bodyTokens = queryTerms(goal).filter(t => allowGeneric || !GENERIC_ENTITIES.has(t));
    const common = bodyTokens.filter(t => terms.has(t));
    const topicalBodyTokens = bodyTokens.filter(t => !knownEntityTokens.has(t));
    const topicalCommon = common.filter(t => !knownEntityTokens.has(t));
    const nonEventEntityTopical = topicalCommon.filter(t => !eventEntityTokens.has(t));
    const lexical = common.length / Math.max(1, Math.min(terms.size, Math.max(1, bodyTokens.length)));
    const topicalLexical = topicalCommon.length / Math.max(1, Math.min(terms.size, Math.max(1, topicalBodyTokens.length)));
    const semanticRaw = cosineSimilarity(vector, vectorizeSemanticText(goal));
    const semantic = Number.isFinite(semanticRaw) ? semanticRaw : 0;
    const matched_by: string[] = [];
    if (subjectHit) matched_by.push("entity");
    if (common.length && (common.length >= 2 || lexical >= 0.4)) matched_by.push("lexical");
    if (semantic >= 0.56) matched_by.push("semantic");
    const topicalBoost = topicalCommon.length
      ? Math.min(0.45, topicalCommon.length * 0.16 + topicalLexical * 0.35)
      : lexical * 0.25;
    return {
      subject: subjectHit,
      common,
      topicalCommon,
      nonEventEntityTopical,
      lexical,
      topicalLexical,
      semantic,
      matched_by,
      score: Math.min(1, (subjectHit ? 0.55 : 0) + topicalBoost + Math.min(0.35, semantic * 0.4)),
    };
  };
}

function occursOnMs(occursOn: string, timezone: string) {
  return occursOn.length === 10 ? wallTime(occursOn, "08:30", timezone) : Date.parse(occursOn);
}

function consolidateEventTriggers(
  ref: SpaceRef,
  version: number,
  eventId: string,
  input: ProactiveEventInput,
  ms: number,
  policy: ProactivePolicy,
  eligibleRaw: Trigger[],
): Trigger[] {
  if (eligibleRaw.length <= 1) return eligibleRaw;
  const primaryIntention = eligibleRaw.find(t => t.payload.intention_id);
  const seenIntentions = new Set<string>(primaryIntention?.payload.intention_id ? [primaryIntention.payload.intention_id] : []);
  const extraIntentions: Trigger[] = [];
  for (const t of eligibleRaw) {
    if (t.payload.intention_id && !seenIntentions.has(t.payload.intention_id) && extraIntentions.length < 2) {
      seenIntentions.add(t.payload.intention_id);
      extraIntentions.push(t);
    }
  }
  const extraSet = new Set(extraIntentions);
  const mainGroup = eligibleRaw.filter(t => !extraSet.has(t));
  const prefix = `${input.event_type}: ${input.summary}\n`;
  const lines = mainGroup.map(t => {
    const body = t.payload.text.startsWith(prefix) ? t.payload.text.slice(prefix.length) : t.payload.text;
    return `- ${summarize(body, 72)}`;
  });
  const itemKeys = [...new Set(mainGroup.flatMap(t => t.payload.item_keys))].sort();
  const anchors = [...new Set(mainGroup.flatMap(t => t.payload.anchors))].slice(0, 6);
  const subjects = [...new Set(mainGroup.flatMap(t => t.payload.subjects))];
  const occursList = mainGroup.map(t => t.payload.occurs_on).filter((v): v is string => Boolean(v));
  const closestOccurs = occursList.sort((a, b) =>
    Math.abs(occursOnMs(a, policy.timezone) - ms) - Math.abs(occursOnMs(b, policy.timezone) - ms),
  )[0];
  const consolidated = timer(ref, version, "event_trigger", eventId + ":consolidated", ms, {
    text: `${prefix}${lines.join("\n")}`,
    anchors,
    subjects,
    item_keys: itemKeys,
    ...(primaryIntention?.payload.intention_id && { intention_id: primaryIntention.payload.intention_id }),
    ...(mainGroup.some(t => t.payload.redline) && { redline: true }),
    ...(mainGroup.some(t => t.payload.risk_watch) && { risk_watch: true }),
    ...(mainGroup.every(t => t.payload.user_authored) && { user_authored: true }),
    ...(closestOccurs && { occurs_on: closestOccurs }),
  });
  return [consolidated, ...extraIntentions];
}

function formatReason(parts: string[]): string {
  const unique = [...new Set(parts.filter(Boolean))];
  return unique.slice(0, 2).join(" · ") || "与记忆内容相关";
}

function summarize(text: string, max = 56) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

export class Events {
  constructor(private readonly engine: Engine) {}

  ingest(input: ProactiveEventInput) {
    return this.engine.withEventGate(input, () => this.run(input));
  }

  private async run(input: ProactiveEventInput): Promise<ProactiveEventResult> {
    const { port, store } = this.engine;
    const ref = { namespace: input.namespace, space_id: input.space_id };
    const key = spaceKey(ref), version = port.version(ref), policy = store.policy(key);
    const ms = input.occurred_at ? Date.parse(input.occurred_at) : this.engine.clock();
    const now = iso(ms), day = localTime(ms, policy.timezone).date;
    const event_id = "event_" + randomUUID(), dry = input.dry_run;
    const result: ProactiveEventResult = {
      event_id, evaluated_at: now, l1_matches: [], matched_signals: [], llm_called: false,
      decision_summary: "silent", nudges: [], updated_intention_ids: [], suppressed_reasons: [], dry_run: dry,
    };
    const log = () => store.connection.client.prepare(`INSERT INTO proactive_events_log (event_id,space_key,event_type,
      summary,entities_json,occurred_at,l1_match_count,llm_called,decision_summary,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(event_id, key, input.event_type, input.summary, JSON.stringify(input.entities), now,
        Math.max(result.l1_matches.length, result.matched_signals.length),
        Number(result.llm_called), result.decision_summary, iso(this.engine.clock()));

    const controls = controlState(port, ref);
    const [ledger, snapshot] = await Promise.all([activeLedger(port, ref, version, day), port.snapshot(ref, version)]);
    const docs = new Set(snapshot?.documents ?? []);
    const rebuild = store.planned(key) !== version;
    const armed = rebuild ? store.intentions.project(ref, ledger.intentions, docs, policy.timezone, version, now, false)
      : store.intentions.armed(key);

    const meaningfulEntities = input.entities.filter(e => {
      const k = claimKey(e);
      return k.length >= 2 && !GENERIC_ENTITIES.has(k);
    });
    const contentText = [input.summary, ...meaningfulEntities].join(" ").trim();
    const expandedText = port.expandAliases?.(ref, contentText) ?? contentText;
    const knownEntityTokens = new Set<string>();
    for (const f of ledger.current) {
      if (f.kind === "entity") addEntityNameTokens(knownEntityTokens, f.subject);
    }
    for (const ev of ledger.events) {
      for (const r of ev.related) {
        if (r.kind === "entity") addEntityNameTokens(knownEntityTokens, r.subject);
      }
    }
    for (const i of armed) {
      for (const s of i.subjects) addEntityNameTokens(knownEntityTokens, s);
    }
    for (const [alias, canonical] of port.aliases?.(ref) ?? []) {
      addEntityNameTokens(knownEntityTokens, alias);
      addEntityNameTokens(knownEntityTokens, canonical);
    }
    const match = matcher(contentText, expandedText, input.entities, knownEntityTokens);
    const changed = stateChange.test(input.summary);
    const eventTime = extractTimeRefs(input.summary, day);
    const isCalendar = input.event_type === "calendar_changed";
    const activeDates = new Set<string>([
      ...eventTime.explicitDates,
      ...eventTime.futureRelativeDates,
      ...eventTime.weekdayDates,
      ...((isCalendar || eventTime.hasClockTime) ? eventTime.todayDates : []),
    ]);
    const activeWeekdays = eventTime.weekdays;

    const triggerCandidates: Array<{ signalId: string; rank: number; trigger: Trigger; isIntention?: boolean }> = [];
    const signals: Array<{ signal: ProactiveEventSignal; rank: number }> = [];
    const seenSignals = new Set<string>();
    const coveredAnchors = new Set<string>();

    const pushSignal = (signal: ProactiveEventSignal, rank: number) => {
      if (seenSignals.has(signal.signal_id)) return;
      seenSignals.add(signal.signal_id);
      signals.push({ signal, rank });
    };
    const addTrigger = (triggerKey: string, rank: number, payload: Omit<Payload, "item_keys">, isIntention = false) => {
      triggerCandidates.push({
        signalId: triggerKey,
        rank,
        isIntention,
        trigger: timer(ref, version, "event_trigger", event_id + ":" + triggerKey, ms, {
          ...payload, text: input.event_type + ": " + input.summary + "\n" + payload.text, item_keys: [triggerKey],
        }),
      });
    };

    const facts = ledger.current.map(f => ({
      fact: f,
      tier: f.tier ?? inferFactTier(f),
      anchor: anchorKey(f),
      hit: match(f.predicate + " " + f.value, [f.subject]),
      timeRefs: extractTimeRefs(`${f.predicate} ${f.value}`, day),
    }));
    const upcomingRaw = ledger.events
      .filter(ev => ev.status !== "cancelled" && ev.status !== "completed" && ev.date >= day)
      .map(ev => {
        const subjects = [...ev.related.map(r => r.subject), ...(ev.event_key ? [ev.event_key] : [])];
        return { ev, subjects, anchor: anchorKey(ev), hit: match(ev.text, subjects) };
      });
    const fallback = [...new Set([
      ...facts.filter(f => f.hit.topicalCommon.length > 0 || (f.hit.subject && f.hit.matched_by.length > 1))
        .sort((a, b) => b.hit.score - a.hit.score)
        .flatMap(f => claimAnchors(f.fact).map(anchorKey)),
      ...upcomingRaw.filter(e => e.hit.topicalCommon.length > 0 || e.hit.subject).map(e => e.anchor),
    ])].slice(0, 6);

    // 1. Armed prospective intentions
    for (const i of armed) {
      const c = i.condition;
      if ((c.not_before && Date.parse(c.not_before) > ms) || (c.deadline && Date.parse(c.deadline) < ms)) continue;
      if (c.match_event_types?.length && !c.match_event_types.includes(input.event_type)) continue;
      const goalAndCue = i.goal + " " + (c.cue_text ?? "");
      const hit = match(goalAndCue, i.subjects, { allowGenericSubjects: true, includeBodyEntities: true });
      const iTime = extractTimeRefs(goalAndCue, day);
      if (c.fire_at) iTime.explicitDates.add(localTime(Date.parse(c.fire_at), policy.timezone).date);
      const overlapDate = [...activeDates].find(d => iTime.explicitDates.has(d));
      const overlapWeekday = [...activeWeekdays].find(w => iTime.weekdays.has(w));
      if (!hit.matched_by.length && !overlapDate && overlapWeekday === undefined) continue;
      if (overlapDate) hit.matched_by.push("date");
      if (overlapWeekday !== undefined) hit.matched_by.push("weekday");
      if (c.match_event_types?.length) hit.matched_by.push("event_type");
      if (changed && hit.subject) hit.matched_by.push("state_change");
      const score = Math.min(1, hit.score + (overlapDate ? 0.45 : 0) + (overlapWeekday !== undefined ? 0.35 : 0));
      const rank = 100 + score * 10;
      const record: ProactiveEventMatch = {
        intention_id: i.intention_id, goal: i.goal, kind: i.kind, matched_by: hit.matched_by, score,
      };
      result.l1_matches.push(record);
      for (const a of i.evidence_anchors) coveredAnchors.add(a);

      const reasonParts: string[] = [];
      if (overlapDate) reasonParts.push(`日期重合（${overlapDate}）`);
      if (overlapWeekday !== undefined) reasonParts.push(`周期条件重合（${WEEKDAY_NAMES[overlapWeekday]}）`);
      if (hit.subject) reasonParts.push("命中关注对象");
      if (c.match_event_types?.length) reasonParts.push("符合监听事件类型");
      if (!reasonParts.length) reasonParts.push("符合已设定的提醒条件");
      pushSignal({
        signal_id: "intention:" + i.intention_id,
        source: "intention",
        label: summarize(i.goal, 60),
        detail: c.cue_text ?? "",
        match_reason: formatReason(reasonParts),
        priority: i.priority,
        ...(i.evidence_anchors[0] && { anchor: i.evidence_anchors[0] }),
      }, rank);

      const userAuthored = i.source === "user" && !i.evidence_anchors.length;
      addTrigger("intention:" + i.intention_id, rank, {
        intention_id: i.intention_id,
        subjects: i.subjects,
        text: `留意事项（${i.kind}）：${i.goal}${c.cue_text ? `（触发条件：${c.cue_text}）` : ""}`,
        anchors: i.evidence_anchors.length ? i.evidence_anchors : fallback,
        redline: i.priority === "redline",
        risk_watch: i.kind === "risk_watch",
        occurs_on: c.fire_at ?? undefined,
        ...(userAuthored && { user_authored: true }),
      }, true);
    }

    // 2. Pinned redline facts (top 6)
    const redlineHits = facts
      .filter(f => f.tier === "pinned_redline")
      .map(item => {
        const overlapDate = [...activeDates].find(d => item.timeRefs.explicitDates.has(d));
        const overlapWeekday = [...activeWeekdays].find(w => item.timeRefs.weekdays.has(w));
        const hasDate = Boolean(overlapDate) || overlapWeekday !== undefined;
        const hasTopical = item.hit.topicalCommon.length >= 1;
        const constraintTokenHit = item.fact.kind === "entity"
          ? item.hit.nonEventEntityTopical.length >= 1
          : hasTopical;
        const directWithTopical = item.hit.subject && (hasTopical || hasDate || item.hit.semantic >= 0.58);
        const topicalConstraintHit = !item.hit.subject && (
          hasDate
          || constraintTokenHit
          || (item.hit.topicalCommon.length >= 2 && item.hit.topicalLexical >= 0.35)
          || (item.hit.semantic >= 0.62 && hasTopical)
        );
        const matched = directWithTopical || topicalConstraintHit;
        const score = Math.min(1, item.hit.score + (overlapDate ? 0.55 : 0) + (overlapWeekday !== undefined ? 0.45 : 0)
          + (constraintTokenHit ? 0.2 : 0));
        return { ...item, overlapDate, overlapWeekday, matched, score };
      })
      .filter(x => x.matched)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    for (const item of redlineHits) {
      coveredAnchors.add(item.anchor);
      const rank = 90 + item.score * 10;
      const reasonParts: string[] = [];
      if (item.overlapDate) reasonParts.push(`撞上红线日期（${item.overlapDate}）`);
      if (item.overlapWeekday !== undefined) reasonParts.push(`撞上${WEEKDAY_NAMES[item.overlapWeekday]}固定红线`);
      if (item.hit.subject) reasonParts.push(`涉及红线对象「${item.fact.subject}」`);
      if (item.hit.topicalCommon.length || item.hit.semantic >= 0.58) reasonParts.push("触发红线约束关键词");
      pushSignal({
        signal_id: "redline:" + item.anchor,
        source: "redline",
        label: `${item.fact.subject} · ${item.fact.predicate}`,
        detail: summarize(item.fact.value, 90),
        match_reason: formatReason(reasonParts),
        priority: "redline",
        anchor: item.anchor,
      }, rank);
      addTrigger("redline:" + item.anchor, rank, {
        subjects: [item.fact.subject],
        text: `个人红线：${item.fact.subject} · ${item.fact.predicate}：${item.fact.value}`,
        redline: true,
        anchors: claimAnchors(item.fact).map(anchorKey),
      });
    }

    // 3. Procedural rules (top 4)
    const ruleHits = ledger.rules
      .map(rule => {
        const hit = match(`${rule.trigger_context} ${rule.instruction}`, [rule.trigger_context]);
        const rTime = extractTimeRefs(`${rule.trigger_context} ${rule.instruction}`, day);
        const overlapDate = [...activeDates].find(d => rTime.explicitDates.has(d));
        const overlapWeekday = [...activeWeekdays].find(w => rTime.weekdays.has(w));
        const hasDate = Boolean(overlapDate) || overlapWeekday !== undefined;
        const hasTopical = hit.topicalCommon.length >= 1;
        const matched = hasDate
          || (hit.subject && (hasTopical || hit.common.length >= 1 || hit.semantic >= 0.45))
          || (hit.topicalCommon.length >= 2 && hit.topicalLexical >= 0.35)
          || (hit.semantic >= 0.6 && hasTopical)
          || (rule.priority === "redline" && hit.nonEventEntityTopical.length >= 1);
        const score = Math.min(1, hit.score + (overlapDate ? 0.5 : 0) + (overlapWeekday !== undefined ? 0.4 : 0));
        return { rule, hit, overlapDate, overlapWeekday, matched, score, anchor: anchorKey(rule) };
      })
      .filter(x => x.matched)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const item of ruleHits) {
      coveredAnchors.add(item.anchor);
      const rank = 80 + item.score * 10;
      const reasonParts: string[] = [];
      if (item.overlapDate) reasonParts.push(`适用日期（${item.overlapDate}）`);
      if (item.overlapWeekday !== undefined) reasonParts.push(`适用${WEEKDAY_NAMES[item.overlapWeekday]}规则`);
      if (item.hit.topicalCommon.length || item.hit.subject) reasonParts.push("触发既定行为准则");
      pushSignal({
        signal_id: "rule:" + item.rule.rule_id,
        source: "rule",
        label: summarize(item.rule.trigger_context, 56),
        detail: summarize(item.rule.instruction, 90),
        match_reason: formatReason(reasonParts),
        priority: item.rule.priority ?? "normal",
        anchor: item.anchor,
      }, rank);
      addTrigger("rule:" + item.rule.rule_id, rank, {
        subjects: [item.rule.trigger_context],
        text: `行为准则（${item.rule.trigger_context}）：${item.rule.instruction}`,
        redline: item.rule.priority === "redline",
        anchors: [item.anchor],
      });
    }

    // 4. Active upcoming schedules (state changes + date overlaps + topical subject/content conflicts)
    const scheduleCandidates = upcomingRaw
      .map(item => {
        const dateOverlap = activeDates.has(item.ev.date);
        const hasTopical = item.hit.topicalCommon.length >= 1;
        const subjectWithTopic = item.hit.subject && (hasTopical || item.hit.semantic >= 0.56);
        const strongContent = subjectWithTopic
          || (item.hit.topicalCommon.length >= 2 && item.hit.topicalLexical >= 0.45)
          || (item.hit.semantic >= 0.6 && hasTopical);
        const stateHit = changed && (subjectWithTopic || item.hit.topicalCommon.length >= 2 || (item.hit.semantic >= 0.56 && hasTopical));
        const matched = dateOverlap || stateHit || strongContent;
        const score = Math.min(1, item.hit.score + (dateOverlap ? 0.7 : 0) + (stateHit ? 0.25 : 0));
        return { ...item, dateOverlap, stateHit, matched, score };
      })
      .filter(x => x.matched)
      .sort((a, b) => b.score - a.score || a.ev.date.localeCompare(b.ev.date));

    const dedupedSchedules: typeof scheduleCandidates = [];
    for (const cand of scheduleCandidates) {
      const sameKey = cand.ev.event_key
        ? dedupedSchedules.find(s => s.ev.date === cand.ev.date && s.ev.event_key && claimKey(s.ev.event_key) === claimKey(cand.ev.event_key!))
        : dedupedSchedules.find(s => s.ev.date === cand.ev.date && claimKey(s.ev.text) === claimKey(cand.ev.text));
      if (!sameKey) dedupedSchedules.push(cand);
      if (dedupedSchedules.length >= 6) break;
    }

    for (const item of dedupedSchedules) {
      coveredAnchors.add(item.anchor);
      const rank = (item.dateOverlap || item.stateHit ? 88 : 75) + item.score * 10;
      const reasonParts: string[] = [];
      if (item.dateOverlap) reasonParts.push(`与 ${item.ev.date} 已有日程撞期`);
      if (item.stateHit) reasonParts.push("涉及已有安排变更/取消");
      if (item.hit.subject) reasonParts.push("涉及同一日程人物/事项");
      if (!reasonParts.length) reasonParts.push("与近期日程高度相关");
      pushSignal({
        signal_id: "event:" + item.anchor,
        source: "schedule",
        label: `${item.ev.date} · ${summarize(item.ev.text, 44)}`,
        detail: summarize(item.ev.text, 90),
        match_reason: formatReason(reasonParts),
        priority: item.dateOverlap || item.stateHit ? "high" : "normal",
        anchor: item.anchor,
      }, rank);
      addTrigger("event:" + item.anchor, rank, {
        subjects: item.subjects,
        text: `已有日程（${item.ev.date}）：${item.ev.text}`,
        anchors: [item.anchor],
        occurs_on: item.ev.date,
      });
    }

    // 5. High-relevance durable/working facts (top 6, deduplicated against covered anchors)
    const factHits = facts
      .filter(f => f.tier !== "pinned_redline" && !coveredAnchors.has(f.anchor))
      .map(item => {
        const overlapDate = [...activeDates].find(d => item.timeRefs.explicitDates.has(d));
        const hasTopical = item.hit.topicalCommon.length >= 1;
        const directWithTopic = item.hit.subject && (hasTopical || Boolean(overlapDate) || item.hit.semantic >= 0.58);
        const highLexical = item.hit.topicalCommon.length >= 2 && item.hit.topicalLexical >= 0.45;
        const highSemantic = item.hit.semantic >= 0.62 && hasTopical;
        const matched = directWithTopic || highLexical || highSemantic || Boolean(overlapDate);
        const score = Math.min(1, item.hit.score + (overlapDate ? 0.45 : 0));
        return { ...item, overlapDate, matched, score };
      })
      .filter(x => x.matched)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    for (const item of factHits) {
      coveredAnchors.add(item.anchor);
      const rank = 60 + item.score * 10;
      const reasonParts: string[] = [];
      if (item.overlapDate) reasonParts.push(`命中相关日期（${item.overlapDate}）`);
      if (item.hit.subject) reasonParts.push(`关联记忆对象「${item.fact.subject}」`);
      if (!reasonParts.length) reasonParts.push("与长期记忆高度相关");
      pushSignal({
        signal_id: "fact:" + item.anchor,
        source: "fact",
        label: `${item.fact.subject} · ${item.fact.predicate}`,
        detail: summarize(item.fact.value, 90),
        match_reason: formatReason(reasonParts),
        priority: item.tier === "working" ? "normal" : "low",
        anchor: item.anchor,
      }, rank);
      addTrigger("fact:" + item.anchor, rank, {
        subjects: [item.fact.subject],
        text: `相关记忆：${item.fact.subject} · ${item.fact.predicate}：${item.fact.value}`,
        anchors: claimAnchors(item.fact).map(anchorKey),
      });
    }

    // 6. Active pending nudges that may be superseded/affected by the event
    const pendingNudges = store.list({ ...ref, status: "pending", limit: 30 }, now).nudges;
    for (const n of pendingNudges) {
      const hit = match(`${n.title} ${n.body}`, []);
      const strong = (changed && (hit.topicalCommon.length >= 2 || (hit.semantic >= 0.56 && hit.topicalCommon.length >= 1)))
        || (hit.topicalCommon.length >= 3 && hit.topicalLexical >= 0.45);
      if (!strong) continue;
      const rank = 50 + hit.score * 10;
      const firstAnchor = n.citations[0]?.anchor;
      pushSignal({
        signal_id: "nudge:" + n.nudge_id,
        source: "nudge",
        label: summarize(n.title, 56),
        detail: summarize(n.body, 90),
        match_reason: changed ? "可能影响已有待处理提醒" : "与当前待处理提醒相关",
        priority: n.urgency === "urgent" ? "high" : "normal",
        ...(firstAnchor && { anchor: firstAnchor }),
      }, rank);
      if (n.citations.length) {
        addTrigger("nudge:" + n.nudge_id, rank, {
          subjects: [],
          text: `已有待处理提醒（请勿重复发送，仅在需更新时合并说明）：${n.title} — ${summarize(n.body, 120)}`,
          anchors: n.citations.map(c => c.anchor),
          nudge_id: n.nudge_id,
          ...(n.intention_id && { intention_id: n.intention_id }),
        });
      }
    }

    result.l1_matches.sort((a, b) => b.score - a.score || a.intention_id.localeCompare(b.intention_id));
    signals.sort((a, b) => b.rank - a.rank || a.signal.signal_id.localeCompare(b.signal.signal_id));
    const keptSignals = signals.slice(0, MAX_EVENT_SIGNALS);
    result.matched_signals = keptSignals.map(s => s.signal);
    const keptSignalIds = new Set(keptSignals.map(s => s.signal.signal_id));
    const triggers = triggerCandidates
      .filter(c => c.isIntention || keptSignalIds.has(c.signalId))
      .sort((a, b) => b.rank - a.rank || a.signalId.localeCompare(b.signalId))
      .map(c => c.trigger);

    const reasons = new Set<string>();
    const window = { ref, version, policy, ms };
    const eligibleRaw = eligible(store, window, triggers, reasons);
    const batch = consolidateEventTriggers(ref, version, event_id, input, ms, policy, eligibleRaw);
    const matchedIds = new Set(result.l1_matches.map(i => i.intention_id));
    const matched = armed.filter(i => matchedIds.has(i.intention_id));
    // A pending projection can introduce or revive a row. Fence its stored revision
    // before applying that projection, and its evaluated revision afterwards.
    const priorRevisions = rebuild ? matched.map(i => ({
      id: i.intention_id, updatedAt: store.intentions.get(key, i.intention_id)?.updated_at,
    })) : [];
    let evaluation: Awaited<ReturnType<Engine["decider"]["decide"]>> | undefined;
    if (!triggers.length) reasons.add("no_l1_match");
    else if (!policy.enabled) reasons.add("policy_disabled");
    else if (!hasDeliveryBudget(store, window)) reasons.add("daily_limit");
    else if (batch.length) {
      result.llm_called = true;
      evaluation = await this.engine.decider.decide(ref, snapshot ?? { version, documents: [] }, policy, ms, batch, matched);
    }

    const finish = () => {
      this.engine.fence(ref, version, policy, controls);
      if (evaluation) {
        const intentionChanged = () => new ServiceError(409, "PROACTIVE_STATE_CHANGED", "A matched intention changed during evaluation");
        for (const { id, updatedAt } of priorRevisions) {
          if (store.intentions.get(key, id)?.updated_at !== updatedAt) throw intentionChanged();
        }
        const current = rebuild ? store.intentions.project(ref, ledger.intentions, docs, policy.timezone, version, now, !dry)
          : store.intentions.armed(key);
        const revisions = new Map(current.map(i => [i.intention_id, i.updated_at]));
        for (const i of matched) {
          if (revisions.get(i.intention_id) !== i.updated_at) throw intentionChanged();
        }
        const available = eligible(store, window, batch, reasons);
        const parents = new Map(available.map(t => [t.trigger_id, t]));
        const { decision, drafts, agenda } = evaluation;
        const orderedDrafts = drafts.length > 1 ? [...drafts].sort(compareEventDrafts) : drafts;
        const delivered = deliveries(store, window, parents, decision, orderedDrafts, agenda, reasons);
        const accepted = delivered.slice(0, 1);
        result.nudges = accepted.map(item => item.nudge);
        result.decision_summary = accepted.length ? decision.decision : "silent";
        if (!accepted.length && decision.decision === "silent" && !reasons.size) {
          reasons.add("model_silent");
        }
        if (!dry) {
          result.updated_intention_ids = this.engine.applyUpdates(ref, version, decision, parents, now);
          for (const { nudge, items } of accepted) store.insert(key, nudge, items);
          for (const t of followUps(window, parents, decision, reasons)) store.schedule(key, t, now);
        }
      }
      result.suppressed_reasons = [...reasons];
      if (!dry) log();
    };
    if (dry) finish();
    else {
      store.connection.transaction(finish);
      if (result.nudges.length) this.engine.notify(key);
    }
    return result;
  }
}
