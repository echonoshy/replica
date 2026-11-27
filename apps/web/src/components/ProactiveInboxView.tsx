import { useEffect, useId, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  Bell, CheckCircle2, ChevronDown, ChevronRight, Clock, FlaskConical,
  Loader2, Plus, RefreshCw, ScanSearch, SlidersHorizontal, Sparkles, X,
} from "lucide-react";
import { formatShortDate, spaceKeyOf } from "../api";
import type {
  Nudge, ProactiveEventInput, ProactiveEventResult, ProactiveEventSignal,
  ProactiveEventSignalSource, ProactivePolicy, ProspectiveIntention,
} from "../api";
import { useApp } from "../context/AppContext";
import { feedbackLabels, NudgeContent, NudgeKindChip } from "./NudgeContent";

const historyStatus = {
  read: "已展开对话",
  completed: "已处理",
  dismissed: "已忽略",
  snoozed: "已延后",
  expired: "已过期",
};

function InboxCard({ nudge, previewLabel }: { nudge: Nudge; previewLabel?: string }) {
  const isSimulated = nudge.nudge_id.startsWith("sim_");
  return (
    <article className="card-tactile space-y-3 p-4 sm:p-5">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <NudgeKindChip nudge={nudge} />
          {previewLabel ? <span className="status-chip tone-blue">{previewLabel}</span> : isSimulated ? <span className="status-chip tone-blue">仅供预览</span> : null}
          {nudge.status !== "pending" ? <span className="status-chip nudge-status">{historyStatus[nudge.status]}</span> : null}
          <time dateTime={nudge.deliver_after} className="mono-meta ml-auto">{formatShortDate(nudge.deliver_after)}</time>
        </div>
        <h2 className="text-[14.5px] font-semibold [overflow-wrap:anywhere]">{nudge.title}</h2>
      </header>
      <NudgeContent nudge={nudge} showSnoozeOptions />
    </article>
  );
}

const SIMULATE_TIME_PRESETS: Record<string, Array<{ label: string; iso: string; hint: string }>> = {
  "personal:chen_mo": [
    { label: "11-27 09:00 · 苏晴生日前一天", iso: "2026-11-27T09:00:00+08:00", hint: "触发 11-28 苏晴生日晚餐准备提醒" },
    { label: "12-04 09:00 · 父亲复查前一天", iso: "2026-12-04T09:00:00+08:00", hint: "触发 12-05 同仁医院白内障陪诊提醒" },
    { label: "01-09 09:00 · 北极星灰度前一天", iso: "2027-01-09T09:00:00+08:00", hint: "触发 2027-01-10 灰度 10% 合规确认提醒" },
  ],
  "personal:lin_xi": [
    { label: "11-29 09:00 · 月末对账前一天", iso: "2026-11-29T09:00:00+08:00", hint: "触发 11-30 家庭月末对账准备提醒" },
    { label: "12-01 09:00 · 周明远出差前一天", iso: "2026-12-01T09:00:00+08:00", hint: "触发 12-02 深圳出差与接娃排班提醒" },
    { label: "12-04 09:00 · 妈妈复诊与拾光记装机", iso: "2026-12-04T09:00:00+08:00", hint: "触发同日多事项整合轻提醒" },
  ],
};

interface EventPreset {
  id: string;
  label: string;
  hint: string;
  type: ProactiveEventInput["event_type"];
  summary: string;
  entities: readonly string[];
  quietTest?: boolean;
}

const PERSONA_EVENT_PRESETS: Record<string, EventPreset[]> = {
  "personal:chen_mo": [
    {
      id: "chenmo_conflict_hosp",
      label: "周六 10:30 临时加架构评审",
      hint: "撞父亲 12/5 同仁医院复查",
      type: "calendar_changed",
      summary: "日历新增：12月5日上午10:30临时加了架构评审会。",
      entities: ["12月5日", "架构评审"],
    },
    {
      id: "chenmo_suqing_hotpot",
      label: "苏晴说生日改去吃香菜牛杂火锅",
      hint: "撞忌口红线 + 11/28 生日",
      type: "chat_turn",
      summary: "苏晴说 11月28日生日晚饭改去吃香菜牛杂火锅配全脂鲜奶酪。",
      entities: ["苏晴", "香菜", "牛杂火锅", "奶酪"],
    },
    {
      id: "chenmo_wed_meeting",
      label: "老板把周三晚加了项目复盘会",
      hint: "撞每周三晚间羽毛球承诺",
      type: "calendar_changed",
      summary: "老板发通知把周三晚上临时加了一场项目复盘会。",
      entities: ["周三晚上", "复盘会"],
    },
    {
      id: "chenmo_compliance_mail",
      label: "收到北极星 3.0 合规书面确认邮件",
      hint: "命中北极星 3.0 灰度留意事项",
      type: "email_received",
      summary: "收到合规团队邮件：已书面确认北极星 3.0 灰度 10% 方案范围，可推进上线前准备。",
      entities: ["北极星 3.0", "合规", "灰度"],
    },
    {
      id: "chenmo_noise",
      label: "今天天气晴朗，午饭打算吃面",
      hint: "无关小事 · 验证保持安静",
      type: "custom",
      summary: "今天天气晴朗，午饭打算吃面。",
      entities: [],
      quietTest: true,
    },
  ],
  "personal:lin_xi": [
    {
      id: "linxi_night_review",
      label: "品牌客户约 12 月 3 日晚线上看稿",
      hint: "撞明远出差晚间红线",
      type: "email_received",
      summary: "品牌客户发邮件，想约 12 月 3 日晚上 20:00 线上共享屏幕看设计稿。",
      entities: ["12月3日", "品牌客户", "晚上"],
    },
    {
      id: "linxi_tue_pickup",
      label: "周二客户会拖到 16:15 以后",
      hint: "撞接乐乐放学红线",
      type: "calendar_changed",
      summary: "周二下午和品牌客户的会议延长，要拖到 16:15 以后才能收工。",
      entities: ["周二", "16:15", "品牌客户"],
    },
    {
      id: "linxi_allergy_snack",
      label: "幼儿园通知明天点心换成了坚果曲奇",
      hint: "撞乐乐花生坚果过敏红线",
      type: "app_signal",
      summary: "幼儿园班级通知：明天下午点心临时换成了坚果曲奇。",
      entities: ["乐乐", "幼儿园", "坚果", "点心"],
    },
    {
      id: "linxi_noise",
      label: "今天天气不错，下午顺路买杯咖啡",
      hint: "无关小事 · 验证保持安静",
      type: "custom",
      summary: "今天天气不错，下午顺路买杯咖啡。",
      entities: [],
      quietTest: true,
    },
  ],
};

const FALLBACK_EVENT_PRESETS: EventPreset[] = [
  {
    id: "generic_calendar",
    label: "日历新增撞车会议",
    hint: "检查日程冲突",
    type: "calendar_changed",
    summary: "日历新增客户会议，与明天下午既定安排时间重叠。",
    entities: [],
  },
  {
    id: "generic_email",
    label: "收到重要确认邮件",
    hint: "检查已设置的留意事项",
    type: "email_received",
    summary: "收到对方书面确认邮件，请按先前约定准备下一步材料。",
    entities: [],
  },
  {
    id: "generic_noise",
    label: "今天天气晴朗，午饭打算吃面",
    hint: "无关小事 · 验证保持安静",
    type: "custom",
    summary: "今天天气晴朗，午饭打算吃面。",
    entities: [],
    quietTest: true,
  },
];

const eventTypes = {
  email_received: "收到邮件",
  calendar_changed: "日历变化",
  chat_turn: "聊天新消息",
  app_signal: "应用通知",
  location_changed: "位置变化",
  topic_entered: "聊到某个话题",
  custom: "其他动态",
} satisfies Record<ProactiveEventInput["event_type"], string>;

const SIGNAL_SOURCE_META: Record<ProactiveEventSignalSource, { label: string; tone: string }> = {
  redline: { label: "红线", tone: "tone-rose" },
  schedule: { label: "日程", tone: "tone-amber" },
  intention: { label: "留意事项", tone: "tone-blue" },
  rule: { label: "行为准则", tone: "tone-violet" },
  fact: { label: "相关记忆", tone: "tone-mint" },
  nudge: { label: "已有提醒", tone: "nudge-status" },
};

const SUPPRESSED_REASON_LABELS: Record<string, string> = {
  no_l1_match: "未撞上任何红线、日程、行为准则或留意事项，本地直接过滤",
  policy_disabled: "轻提醒总开关已关闭",
  daily_limit: "今天的提醒次数已达上限，为避免打扰本次暂不推送",
  daily_cap: "今天的提醒次数已达上限，为避免打扰本次暂不推送",
  cooldown: "同一事项近期刚提醒过，尚在冷却期内",
  feedback: "你此前已处理或忽略过这项提醒，不再重复打扰",
  snoozed: "该提醒正处于延后状态，到点后再提醒你",
  stale: "相关事项已过时效窗口，无需再打扰",
  quiet_hours: "当前处于免打扰时段，非紧急提醒会推迟到安静时段结束后送达",
  negative_utility: "助理评估此时打扰成本高于收益，选择保持安静",
  no_valid_citation: "缺少可靠的记忆出处，安全守卫拦截了这条提醒",
  invalid_trigger: "触发来源已失效，跳过推送",
  duplicate: "与已有提醒重复，已自动去重",
  model_silent: "助理综合上下文后判断此刻无需打扰",
};

function explainSuppressedReason(reason: string): string {
  return SUPPRESSED_REASON_LABELS[reason] ?? `已按防打扰规则暂缓（${reason}）`;
}

function toBeijingLocalInput(date: Date): string {
  const beijing = new Date(date.getTime() + 8 * 3_600_000);
  return beijing.toISOString().slice(0, 16);
}

function defaultEventClock(spaceKey: string | null, mode: "day" | "quiet" | "now"): string {
  if (mode === "now") return toBeijingLocalInput(new Date());
  const isDemo2026 = spaceKey === "personal:chen_mo" || spaceKey === "personal:lin_xi";
  const day = isDemo2026 ? "2026-11-26" : toBeijingLocalInput(new Date()).slice(0, 10);
  return `${day}T${mode === "day" ? "10:30" : "23:00"}`;
}

function PolicyPanel({ policy, id }: { policy: ProactivePolicy; id: string }) {
  const { updateProactivePolicy, proactiveProfile } = useApp();
  const [strict, setStrict] = useState(policy.strict_urgent_quiet_guard ?? false);
  const [enabled, setEnabled] = useState(policy.enabled);
  const [quietStart, setQuietStart] = useState(policy.quiet_start);
  const [quietEnd, setQuietEnd] = useState(policy.quiet_end);
  const [digestOn, setDigestOn] = useState(policy.daily_digest_time !== null);
  const [digestTime, setDigestTime] = useState(policy.daily_digest_time ?? "08:30");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dailyDigest = digestOn ? digestTime : null;
  const dirty = enabled !== policy.enabled || quietStart !== policy.quiet_start || quietEnd !== policy.quiet_end
    || strict !== (policy.strict_urgent_quiet_guard ?? false) || dailyDigest !== policy.daily_digest_time;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateProactivePolicy({
        enabled, strict_urgent_quiet_guard: strict, quiet_start: quietStart, quiet_end: quietEnd, daily_digest_time: dailyDigest,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法保存设置，请稍后再试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form id={id} aria-label="免打扰设置" className="card-tactile nudge-policy p-4" onSubmit={(event) => void save(event)}>
      <fieldset disabled={saving} className="space-y-3">
        <label className="flex w-fit items-center gap-2 text-sm font-medium">
          <input type="checkbox" role="switch" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          启用轻提醒
        </label>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
          <span className="font-medium">安静时段</span>
          <input type="time" className="control" value={quietStart} aria-label="安静时段开始" required
            onChange={(event) => setQuietStart(event.target.value)} />
          <span aria-hidden="true">–</span>
          <input type="time" className="control" value={quietEnd} aria-label="安静时段结束" required
            onChange={(event) => setQuietEnd(event.target.value)} />
          <span className="break-all font-mono-num">{policy.timezone}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" role="switch" checked={digestOn} onChange={(event) => setDigestOn(event.target.checked)} />
            每日简报
          </label>
          {digestOn ? (
            <input type="time" className="control" value={digestTime} aria-label="每日简报时间" required
              onChange={(event) => setDigestTime(event.target.value)} />
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" role="switch" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
          安静时段严格保护（仅红线或 2 小时内紧急事项可打扰）
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-[var(--ink-muted)]">打扰分寸由助理结合你的反馈自动把握</p>
          <button type="submit" className="control control-primary" disabled={!dirty || saving}>{saving ? "保存中…" : "保存设置"}</button>
        </div>
      </fieldset>
      <section className="mt-3 space-y-1 border-t border-[var(--line-subtle)] pt-3 text-xs text-[var(--ink-muted)]">
        <h3 className="font-semibold text-[var(--ink-primary)]">互动反馈统计</h3>
        {proactiveProfile?.total_nudges ? <>
          <p>共 {proactiveProfile.total_nudges} 条提醒 · 采纳率 {Math.round(proactiveProfile.overall_acceptance_rate * 100)}%</p>
          <p>常见忽略原因 · {proactiveProfile.top_dismiss_reasons.slice(0, 3).map(({ reason, count }) => `${feedbackLabels[reason]}（${count} 次）`).join("、") || "暂无"}</p>
        </> : <p>{proactiveProfile ? "还没有可统计的提醒" : "暂无统计数据"}</p>}
      </section>
      {error ? <p className="mt-2 text-xs text-[var(--ink-muted)]" role="status">{error}</p> : null}
    </form>
  );
}

function relativePreset(days: number) {
  const day = new Date(Date.now() + (8 + days * 24) * 3600000).toISOString().slice(0, 10);
  return { label: `+${days}天 09:00`, iso: `${day}T09:00:00+08:00`, hint: `${day} 09:00（北京时间）` };
}

function TimeSubPanel({ onPreview }: { onPreview: () => void }) {
  const { activeSpace, evaluatingProactive, simulateProactive, simulatedNudgeCount, clearSimulatedNudges } = useApp();
  const presets = (activeSpace && SIMULATE_TIME_PRESETS[spaceKeyOf(activeSpace)]) ?? [relativePreset(1), relativePreset(3)];
  const [custom, setCustom] = useState(presets[0].iso.slice(0, 16));

  useEffect(() => {
    setCustom(presets[0].iso.slice(0, 16));
  }, [activeSpace?.namespace, activeSpace?.space_id]);

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
        把时钟拨到未来的某个时间点，看看助理届时会为你提前准备什么提醒（仅预览，不改动真实记录）。
      </p>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.iso}
            type="button"
            className="control"
            title={p.hint}
            disabled={evaluatingProactive}
            onClick={() => {
              onPreview();
              void simulateProactive(p.iso, p.label);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={(e) => {
        e.preventDefault();
        onPreview();
        void simulateProactive(`${custom}:00+08:00`, custom.replace("T", " "));
      }}>
        <label className="flex items-center gap-1.5 text-[var(--ink-secondary)]">
          北京时间
          <input className="control" type="datetime-local" value={custom} required onChange={(e) => setCustom(e.target.value)} />
        </label>
        <button className="control control-primary" disabled={evaluatingProactive || !custom}>
          {evaluatingProactive ? "推演中…" : "预览该时刻提醒"}
        </button>
        {simulatedNudgeCount > 0 ? (
          <button type="button" className="control" onClick={clearSimulatedNudges}>清空时间预览</button>
        ) : null}
      </form>
    </div>
  );
}

function EventSubPanel({ onCommittedImmediate }: { onCommittedImmediate: () => void }) {
  const { activeSpace, simulateEvent, inspectSource } = useApp();
  const spaceKey = activeSpace ? spaceKeyOf(activeSpace) : null;
  const presets = (spaceKey ? PERSONA_EVENT_PRESETS[spaceKey] : undefined) ?? FALLBACK_EVENT_PRESETS;

  const [type, setType] = useState<ProactiveEventInput["event_type"]>(presets[0]?.type ?? "calendar_changed");
  const [summary, setSummary] = useState("");
  const [entities, setEntities] = useState<string[]>([]);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [clockMode, setClockMode] = useState<"day" | "quiet" | "now" | "custom">("day");
  const [occurredAtLocal, setOccurredAtLocal] = useState(() => defaultEventClock(spaceKey, "day"));
  const [working, setWorking] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<ProactiveEventResult | null>(null);
  const [commitBanner, setCommitBanner] = useState<{ tone: "mint" | "amber" | "neutral"; text: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setOccurredAtLocal(defaultEventClock(spaceKey, "day"));
    setClockMode("day");
    setSummary("");
    setEntities([]);
    setActivePresetId(null);
    setResult(null);
    setCommitBanner(null);
    setError("");
  }, [spaceKey]);

  function occurredIso(localVal = occurredAtLocal) {
    return localVal ? `${localVal}:00+08:00` : undefined;
  }

  async function runEvent(opts: {
    event_type: ProactiveEventInput["event_type"];
    text: string;
    entityHints?: readonly string[];
    dry_run: boolean;
    clockOverride?: string;
  }) {
    const trimmed = opts.text.trim();
    if (!trimmed) return;
    if (opts.dry_run) {
      setWorking(true);
      setResult(null);
    } else {
      setCommitting(true);
    }
    setCommitBanner(null);
    setError("");
    try {
      const res = await simulateEvent({
        event_type: opts.event_type,
        summary: trimmed,
        dry_run: opts.dry_run,
        entities: [...(opts.entityHints ?? [])],
        occurred_at: occurredIso(opts.clockOverride ?? occurredAtLocal),
        metadata: {},
      });
      if (!res) return;
      setResult(res);
      if (!opts.dry_run) {
        if (res.nudges.length > 0) {
          const deferred = res.nudges.filter((n) => Date.parse(n.deliver_after) > Date.parse(res.evaluated_at));
          if (deferred.length === res.nudges.length) {
            const firstDeliver = formatShortDate(deferred[0].deliver_after);
            setCommitBanner({
              tone: "amber",
              text: `已按免打扰规则排期到 ${firstDeliver} 送达（到点前暂不打扰「待处理」列表，下方为你保留完整预览）`,
            });
          } else {
            setCommitBanner({
              tone: "mint",
              text: `已正式存入「待处理」轻提醒（共 ${res.nudges.length} 条），随时可处理或展开聊聊。`,
            });
            onCommittedImmediate();
          }
        } else {
          const reasonText = res.suppressed_reasons.length
            ? res.suppressed_reasons.map(explainSuppressedReason).join("；")
            : "本次正式提交未生成新提醒";
          setCommitBanner({ tone: "neutral", text: reasonText });
        }
      }
    } catch {
      setError("事件未能处理，请稍后再试");
    } finally {
      setWorking(false);
      setCommitting(false);
    }
  }

  function applyClockPreset(mode: "day" | "quiet" | "now") {
    const next = defaultEventClock(spaceKey, mode);
    setClockMode(mode);
    setOccurredAtLocal(next);
  }

  const matchedSignals: ProactiveEventSignal[] = result?.matched_signals?.length
    ? result.matched_signals
    : (result?.l1_matches ?? []).map((m) => ({
      signal_id: m.intention_id,
      source: "intention" as const,
      label: m.goal,
      detail: "",
      match_reason: m.matched_by.join(" / ") || "命中留意事项",
    }));

  const topSignalLabels = matchedSignals
    .slice(0, 3)
    .map((s) => (s.label.length > 18 ? `${s.label.slice(0, 18)}…` : s.label));
  const signalSummaryHint = topSignalLabels.length
    ? `（${topSignalLabels.join("、")}${matchedSignals.length > 3 ? "等" : ""}）`
    : "";

  const silentReason = result
    ? (result.suppressed_reasons.length > 0
      ? (result.suppressed_reasons.length === 1 && result.suppressed_reasons[0] === "no_l1_match" && !result.llm_called
        ? "未撞上你的红线、日程或留意事项，本地直接过滤，未调用模型。"
        : result.suppressed_reasons.map(explainSuppressedReason).join("；"))
      : result.llm_called
        ? "助理结合上下文评估后判断此刻无需打扰。"
        : "未撞上你的红线、日程或留意事项，本地直接过滤，未调用模型。")
    : "";

  const busy = working || committing;

  const signalsDisclosure = result ? (
    <details
      key={`${result.evaluated_at}-signals`}
      className="group rounded-lg border border-[var(--line-subtle)] bg-[var(--bg-surface)]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={13}
          className="shrink-0 text-[var(--ink-muted)] transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        <span className="min-w-0 truncate text-[var(--ink-secondary)]">
          {matchedSignals.length > 0
            ? `查看判断依据 · 对照了 ${matchedSignals.length} 条记忆${signalSummaryHint}`
            : "查看判断依据"}
        </span>
        <span className="status-chip nudge-status ml-auto shrink-0">
          {result.llm_called ? "已请模型评估" : "本地直判"}
        </span>
      </summary>
      <div className="space-y-2 border-t border-[var(--line-subtle)] px-3 py-2.5">
        {result.nudges.length > 0 && result.suppressed_reasons.length > 0 ? (
          <div className="space-y-1 text-xs leading-relaxed text-[var(--ink-muted)]">
            {result.suppressed_reasons.map((reason) => (
              <p key={reason}>• {explainSuppressedReason(reason)}</p>
            ))}
          </div>
        ) : null}
        {matchedSignals.length > 0 ? (
          <ul className="space-y-1.5">
            {matchedSignals.map((sig) => {
              const meta = SIGNAL_SOURCE_META[sig.source] ?? SIGNAL_SOURCE_META.fact;
              return (
                <li
                  key={sig.signal_id}
                  className="flex flex-wrap items-baseline gap-1.5 rounded-md border border-[var(--line-subtle)] bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs"
                >
                  <span className={`status-chip ${meta.tone}`}>{meta.label}</span>
                  <span className="font-medium text-[var(--ink-primary)]">{sig.label}</span>
                  {sig.match_reason ? <span className="text-[var(--ink-muted)]">· {sig.match_reason}</span> : null}
                  {sig.anchor && activeSpace ? (
                    <button
                      type="button"
                      className="nudge-link ml-auto !min-h-0 !py-0.5 text-[11px]"
                      onClick={() => inspectSource({ space: activeSpace, anchor: sig.anchor!.replace(/^\[src:(.*)\]$/, "$1") })}
                    >
                      查看出处
                    </button>
                  ) : null}
                  {sig.detail ? <p className="w-full text-[11.5px] leading-relaxed text-[var(--ink-secondary)]">{sig.detail}</p> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-[var(--ink-muted)]">本次未列出具体命中记忆项。</p>
        )}
      </div>
    </details>
  ) : null;

  return (
    <div className="space-y-3.5">
      <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
        挑一个贴近生活的突发动态，或自己输入一件刚发生的事——看看助理如何对照红线、日程与留意事项，决定要不要提醒你。
      </p>

      <fieldset disabled={busy} className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="control"
              aria-pressed={activePresetId === p.id}
              title={p.hint}
              onClick={() => {
                setActivePresetId(p.id);
                setType(p.type);
                setSummary(p.summary);
                setEntities([...p.entities]);
                void runEvent({ event_type: p.type, text: p.summary, entityHints: p.entities, dry_run: true });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void runEvent({ event_type: type, text: summary, entityHints: entities, dry_run: true });
          }}
        >
          <select
            aria-label="事件类型"
            className="control"
            value={type}
            onChange={(e) => setType(e.target.value as ProactiveEventInput["event_type"])}
          >
            {Object.entries(eventTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input
            aria-label="事件内容"
            placeholder="发生了什么？例如：12月5日上午10:30临时加了评审会"
            className="control min-w-0 flex-1 text-left font-normal"
            maxLength={4000}
            value={summary}
            onChange={(e) => {
              setSummary(e.target.value);
              setActivePresetId(null);
              setEntities([]);
            }}
            required
          />
          <button type="submit" className="control control-primary" disabled={!summary.trim() || busy}>
            {working ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" /> : null}
            {result ? "重新预览" : "预览判断"}
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
          <Clock size={12} aria-hidden="true" />
          <span className="font-medium text-[var(--ink-secondary)]">模拟发生时间</span>
          <button type="button" className="control" aria-pressed={clockMode === "day"} onClick={() => applyClockPreset("day")}>
            白天 10:30
          </button>
          <button type="button" className="control" aria-pressed={clockMode === "quiet"} onClick={() => applyClockPreset("quiet")}>
            深夜免打扰 23:00
          </button>
          <button type="button" className="control" aria-pressed={clockMode === "now"} onClick={() => applyClockPreset("now")}>
            此刻时间
          </button>
          <input
            aria-label="模拟发生时间"
            type="datetime-local"
            className="control font-mono-num"
            value={occurredAtLocal}
            onChange={(e) => {
              setOccurredAtLocal(e.target.value);
              setClockMode("custom");
            }}
          />
        </div>
      </fieldset>

      {working ? (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-[var(--line-subtle)] bg-[var(--bg-canvas)] px-3 py-2.5 text-xs text-[var(--ink-secondary)]">
          <Loader2 size={14} className="motion-safe:animate-spin text-[var(--blue)]" aria-hidden="true" />
          <span>正在对照你的红线、日程、行为准则与留意事项…</span>
        </div>
      ) : null}

      {error ? <p role="status" className="text-xs text-[#dc2626]">{error}</p> : null}

      {result && !working ? (
        <div className="space-y-2.5 rounded-xl border border-[var(--line-default)] bg-[var(--bg-canvas)] p-3.5">
          {result.nudges.length > 0 ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--ink-primary)]">
                    {result.dry_run ? "提醒效果预览" : "已生成的正式提醒"}
                  </span>
                  {result.decision_summary === "digest" ? (
                    <span className="status-chip tone-violet">建议收入简报</span>
                  ) : null}
                </div>
                {result.dry_run ? (
                  <button
                    type="button"
                    className="control control-primary"
                    disabled={committing}
                    onClick={() => void runEvent({ event_type: type, text: summary, entityHints: entities, dry_run: false })}
                  >
                    {committing ? <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
                    {committing ? "存入中…" : "正式存入轻提醒"}
                  </button>
                ) : null}
              </div>

              {commitBanner ? (
                <div
                  role="status"
                  className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                    commitBanner.tone === "mint"
                      ? "border-[var(--mint-line)] bg-[var(--mint-wash)] text-[var(--mint-deep)]"
                      : commitBanner.tone === "amber"
                        ? "border-[#fde68a] bg-[#fffbeb] text-[#92400e]"
                        : "border-[var(--line-default)] bg-[var(--bg-surface)] text-[var(--ink-secondary)]"
                  }`}
                >
                  {commitBanner.text}
                </div>
              ) : null}

              <div className="space-y-2.5">
                {result.nudges.map((n) => {
                  const displayNudge: Nudge = result.dry_run
                    ? { ...n, nudge_id: n.nudge_id.startsWith("sim_") ? n.nudge_id : `sim_event_${n.nudge_id}`, status: "pending" }
                    : n;
                  const deferred = Date.parse(n.deliver_after) > Date.parse(result.evaluated_at);
                  const badge = result.dry_run
                    ? (deferred ? `预览 · 排期 ${formatShortDate(n.deliver_after)}` : "事件预览")
                    : (deferred ? `已排期 ${formatShortDate(n.deliver_after)}` : "已存入收件箱");
                  return <InboxCard key={displayNudge.nudge_id} nudge={displayNudge} previewLabel={badge} />;
                })}
              </div>

              {signalsDisclosure}
            </>
          ) : (
            <>
              <div className="card-tactile space-y-1.5 px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--ink-primary)]">保持安静，不打扰</span>
                  <span className="status-chip nudge-status ml-auto">
                    {result.llm_called ? "已请模型评估" : "本地直判"}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
                  {silentReason}
                </p>
              </div>
              {matchedSignals.length > 0 ? signalsDisclosure : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SandboxDrawer({
  id,
  onSelectPendingTab,
}: {
  id: string;
  onSelectPendingTab: () => void;
}) {
  const [mode, setMode] = useState<"event" | "time">("event");
  return (
    <section id={id} aria-label="情景演练" className="card-tactile space-y-3.5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FlaskConical size={15} className="text-[var(--blue)]" aria-hidden="true" />
          <h2 className="text-sm font-semibold">情景演练</h2>
        </div>
        <div className="recessed-track inline-flex gap-0.5 text-xs font-medium" role="tablist" aria-label="演练方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "event"}
            className={`rounded-[5px] px-2.5 py-1 ${mode === "event" ? "recessed-pill-active" : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"}`}
            onClick={() => setMode("event")}
          >
            模拟外部事件
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "time"}
            className={`rounded-[5px] px-2.5 py-1 ${mode === "time" ? "recessed-pill-active" : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"}`}
            onClick={() => setMode("time")}
          >
            模拟未来时间
          </button>
        </div>
      </div>
      {mode === "event"
        ? <EventSubPanel onCommittedImmediate={onSelectPendingTab} />
        : <TimeSubPanel onPreview={onSelectPendingTab} />}
    </section>
  );
}

const kindLabels = { time_based: "定时", event_based: "等条件触发", open_loop: "未闭环", recurring: "周期", risk_watch: "风险预警" };
const priorityLabels = { redline: "红线", high: "重要", normal: "普通", low: "低优先" };
const statusLabels = { armed: "留意中", snoozed: "已延后", triggered: "已提醒", fulfilled: "已完成", cancelled: "已取消", expired: "已过期" };

function IntentionCard({ item }: { item: ProspectiveIntention }) {
  const { activeSpace, inspectSource, updateIntentionStatus, deleteIntention } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { condition } = item;
  const active = ["armed", "snoozed", "triggered"].includes(item.status);
  async function change(action: "fulfilled" | "cancelled" | "delete") {
    setBusy(true);
    setError("");
    try {
      if (action === "delete") await deleteIntention(item.intention_id);
      else await updateIntentionStatus(item.intention_id, action);
    } catch {
      setError("暂时无法更新这条留意事项，请再试一次");
    } finally {
      setBusy(false);
    }
  }
  return <article className="card-tactile space-y-2 p-4">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="status-chip tone-blue">{kindLabels[item.kind]}</span>
      <span className={`status-chip ${item.priority === "redline" ? "tone-rose" : item.priority === "high" ? "tone-amber" : "nudge-status"}`}>
        {priorityLabels[item.priority]}
      </span>
      <span className="ml-auto text-[var(--ink-muted)]">{statusLabels[item.status]}</span>
    </div>
    <h3 className="break-words text-sm font-semibold">{item.goal}</h3>
    <div className="space-y-1 text-xs text-[var(--ink-muted)]">
      {condition.cue_text && <p>触发条件 · {condition.cue_text}</p>}
      {condition.match_event_types?.length ? <p>留意动态 · {condition.match_event_types.map((type) => eventTypes[type]).join("、")}</p> : null}
      {condition.fire_at && <p>提醒时间 · {formatShortDate(condition.fire_at)}</p>}
      {condition.stale_after_days && <p>超过 {condition.stale_after_days} 天未处理时跟进</p>}
      {condition.deadline && <p>截止时间 · {formatShortDate(condition.deadline)}</p>}
    </div>
    {item.evidence_anchors.length > 0 && <div className="flex flex-wrap gap-2">
      {item.evidence_anchors.map((anchor, index) => <button type="button" className="nudge-link" key={anchor}
        title={anchor} onClick={() => activeSpace && inspectSource({ space: activeSpace, anchor: anchor.replace(/^\[src:(.*)\]$/, "$1") })}>查看出处 {index + 1}</button>)}
    </div>}
    <fieldset disabled={busy} className="flex flex-wrap gap-2">
      {active && <>
        <button type="button" className="control" onClick={() => void change("fulfilled")}>标已完成</button>
        <button type="button" className="control" onClick={() => void change("cancelled")}>取消</button>
      </>}
      <button type="button" className="control" onClick={() => { if (window.confirm("删除这条留意事项？")) void change("delete"); }}>删除</button>
    </fieldset>
    {error && <p role="status" className="text-xs">{error}</p>}
  </article>;
}

const WATCHABLE_EVENT_TYPES: Array<ProactiveEventInput["event_type"]> = [
  "email_received", "calendar_changed", "chat_turn", "app_signal", "location_changed",
];

function IntentionForm({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { createIntention } = useApp();
  const [kind, setKind] = useState<"event_based" | "time_based" | "open_loop">("event_based");
  const [cue, setCue] = useState("");
  const [goal, setGoal] = useState("");
  const [time, setTime] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [priority, setPriority] = useState<"normal" | "redline">("normal");
  const [selectedTypes, setSelectedTypes] = useState<ProactiveEventInput["event_type"][]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  function toggleEventType(evType: ProactiveEventInput["event_type"]) {
    setSelectedTypes((curr) => curr.includes(evType) ? curr.filter((t) => t !== evType) : [...curr, evType]);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const condition = kind === "time_based"
        ? { fire_at: new Date(time).toISOString() }
        : {
          cue_text: cue.trim(),
          ...(selectedTypes.length ? { match_event_types: selectedTypes } : {}),
        };
      await createIntention({
        kind,
        goal: goal.trim(),
        condition,
        priority,
        source: "user",
        subjects: [],
        evidence_anchors: [],
      });
      setGoal("");
      setCue("");
      setTime("");
      setPriority("normal");
      setSelectedTypes([]);
      setAdvancedOpen(false);
      onClose();
    } catch {
      setError("暂时无法添加，请检查内容后再试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card-tactile space-y-3 p-4" aria-label="添加留意事项">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">添加一条留意事项</h2>
        <button type="button" className="icon-button" aria-label="收起表单" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <form onSubmit={save} className="space-y-3">
        <fieldset disabled={saving} className="grid gap-3 text-xs sm:grid-cols-2">
          <label className="grid gap-1 text-[var(--ink-secondary)]">
            什么时候提醒
            <select className="control" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="event_based">等某件事发生时触发</option>
              <option value="open_loop">持续跟进直到闭环</option>
              <option value="time_based">到指定时间提醒</option>
            </select>
          </label>
          {kind === "time_based" ? (
            <label className="grid gap-1 text-[var(--ink-secondary)]">
              提醒时间
              <input type="datetime-local" required className="control" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          ) : (
            <label className="grid gap-1 text-[var(--ink-secondary)]">
              触发条件
              <input
                className="control text-left font-normal"
                placeholder="例如：收到合规书面确认，或有人约周三晚开会"
                maxLength={600}
                required
                value={cue}
                onChange={(e) => setCue(e.target.value)}
              />
            </label>
          )}
          <label className="grid gap-1 text-[var(--ink-secondary)] sm:col-span-2">
            提醒我做什么
            <input
              className="control text-left font-normal"
              placeholder="例如：核对灰度范围，或提醒我婉拒会议"
              maxLength={1000}
              required
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </label>

          <div className="sm:col-span-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              {advancedOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              更多选项（重要程度与监听类型）
            </button>
            {advancedOpen ? (
              <div className="mt-2.5 space-y-2.5 rounded-lg border border-[var(--line-subtle)] bg-[var(--bg-canvas)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-[var(--ink-secondary)]">优先级</span>
                  <button type="button" className="control" aria-pressed={priority === "normal"} onClick={() => setPriority("normal")}>
                    普通
                  </button>
                  <button type="button" className="control" aria-pressed={priority === "redline"} onClick={() => setPriority("redline")}>
                    红线重要（免打扰也可提醒）
                  </button>
                </div>
                {kind !== "time_based" ? (
                  <div className="space-y-1.5">
                    <span className="block font-medium text-[var(--ink-secondary)]">监听事件类型（不选则默认全部留意）</span>
                    <div className="flex flex-wrap gap-1.5">
                      {WATCHABLE_EVENT_TYPES.map((evType) => (
                        <button
                          key={evType}
                          type="button"
                          className="control"
                          aria-pressed={selectedTypes.includes(evType)}
                          onClick={() => toggleEventType(evType)}
                        >
                          {eventTypes[evType]}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2 sm:col-span-2">
            <button
              type="submit"
              className="control control-primary"
              disabled={!goal.trim() || !(kind === "time_based" ? time : cue.trim())}
            >
              {saving ? "保存中…" : "保存留意事项"}
            </button>
            <button type="button" className="control" onClick={onClose}>取消</button>
          </div>
        </fieldset>
        {error && <p role="status" className="text-xs text-[#dc2626]">{error}</p>}
      </form>
    </section>
  );
}

const tabs = ["pending", "intentions", "history"] as const;

export function ProactiveInboxView() {
  const {
    pendingNudges, historyNudges, intentions, intentionsTotal, intentionsLoadFailed, refreshProactiveExtras,
    runProactiveScout, proactivePolicy, evaluatingProactive, proactiveNotice, clearProactiveNotice,
    evaluateProactive, loadingProactiveInbox,
  } = useApp();
  const [tab, setTab] = useState<typeof tabs[number]>("pending");
  const [panel, setPanel] = useState<"sandbox" | "policy" | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [scouting, setScouting] = useState(false);
  const id = useId();
  const nudges = tab === "pending" ? pendingNudges : historyNudges;
  const loadingHistory = tab === "history" && loadingProactiveInbox && !nudges.length;
  const CheckIcon = evaluatingProactive ? Loader2 : RefreshCw;

  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
    setTab(next);
    document.getElementById(`${id}-${next}`)?.focus();
  }

  async function triggerScout() {
    if (scouting) return;
    setScouting(true);
    try {
      await runProactiveScout();
    } finally {
      setScouting(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-canvas)] text-[var(--ink-primary)]">
      <div className="mx-auto w-full max-w-[780px] space-y-4 px-4 py-6 sm:px-6 sm:py-9">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold">轻提醒</h1>
            <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">需要准备、确认或跟进的事，都在这里。</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" className="control" disabled={evaluatingProactive} onClick={() => void evaluateProactive(false)}>
              <CheckIcon size={13} className={evaluatingProactive ? "motion-safe:animate-spin" : undefined} aria-hidden="true" />
              检查新提醒
            </button>
            <button
              type="button"
              className="control"
              aria-pressed={panel === "sandbox"}
              aria-expanded={panel === "sandbox"}
              aria-controls={panel === "sandbox" ? `${id}-tools` : undefined}
              onClick={() => setPanel(panel === "sandbox" ? null : "sandbox")}
            >
              <FlaskConical size={13} aria-hidden="true" />
              情景演练
            </button>
            <button
              type="button"
              className="control"
              aria-pressed={panel === "policy"}
              aria-expanded={panel === "policy"}
              disabled={!proactivePolicy}
              aria-controls={panel === "policy" ? `${id}-tools` : undefined}
              onClick={() => setPanel(panel === "policy" ? null : "policy")}
            >
              <SlidersHorizontal size={13} aria-hidden="true" />
              设置
            </button>
          </div>
        </header>

        {proactiveNotice ? (
          <div role="status" className="flex items-center justify-between gap-2 rounded-lg border border-[var(--blue-line)] bg-[var(--blue-wash)] px-3 py-2 text-xs text-[var(--blue-deep)]">
            <span className="leading-relaxed">{proactiveNotice}</span>
            <button type="button" className="icon-button !size-5 text-[var(--blue-deep)]" aria-label="关闭提示" onClick={clearProactiveNotice}>
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {panel === "sandbox" ? <SandboxDrawer id={`${id}-tools`} onSelectPendingTab={() => setTab("pending")} /> : null}
        {panel === "policy" && proactivePolicy ? <PolicyPanel id={`${id}-tools`} policy={proactivePolicy} /> : null}

        <div className="recessed-track inline-flex gap-0.5 text-xs font-medium" role="tablist" aria-label="轻提醒记录" onKeyDown={handleTabKey}>
          {([
            ["pending", "待处理", pendingNudges.length],
            ["intentions", "留意事项", intentionsTotal ?? "…"],
            ["history", "已处理", historyNudges.length],
          ] as const).map(([value, label, count]) => (
            <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-controls={`${id}-records`}
              aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}
              className={`rounded-[5px] px-3 py-1.5 ${tab === value ? "recessed-pill-active" : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"}`}>
              {label} <span className="font-mono-num">({count})</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`${id}-records`} aria-labelledby={`${id}-${tab}`} aria-busy={loadingHistory} className="space-y-3">
          {tab === "intentions" ? (
            <>
              <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
                你让助理长期盯着的条件或红线——平时安静守着，撞上情况才会发到「待处理」。
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="control"
                  aria-expanded={formOpen}
                  onClick={() => setFormOpen((open) => !open)}
                >
                  <Plus size={13} aria-hidden="true" />
                  添加一条留意事项
                </button>
                <button type="button" className="control" disabled={scouting} onClick={() => void triggerScout()}>
                  {scouting
                    ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />
                    : <ScanSearch size={13} aria-hidden="true" />}
                  {scouting ? "排查中…" : "排查潜在风险"}
                </button>
              </div>
              <IntentionForm open={formOpen} onClose={() => setFormOpen(false)} />
              {intentionsLoadFailed && (
                <p role="status" className="text-xs text-[var(--ink-muted)]">
                  留意事项尚未刷新。 <button type="button" className="nudge-link" onClick={() => void refreshProactiveExtras()}>重新加载</button>
                </p>
              )}
              {intentionsTotal !== null && intentionsTotal > intentions.length && (
                <p className="text-xs text-[var(--ink-muted)]">显示最近更新的 {intentions.length} 条，共 {intentionsTotal} 条。</p>
              )}
              {intentions.length ? (
                intentions.map((item) => <IntentionCard key={item.intention_id} item={item} />)
              ) : !intentionsLoadFailed ? (
                <div className="card-tactile space-y-3 px-5 py-8 text-center">
                  <span className="mx-auto grid size-10 place-items-center rounded-full border border-[var(--blue-line)] bg-[var(--blue-wash)] text-[var(--blue)]">
                    <Sparkles size={17} aria-hidden="true" />
                  </span>
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold">
                      {intentionsTotal === null ? "正在读取留意事项…" : "还没有留意事项"}
                    </h2>
                    {intentionsTotal !== null ? (
                      <p className="mx-auto max-w-[440px] text-xs leading-relaxed text-[var(--ink-muted)]">
                        让助理通读你的已沉淀记忆，自动找出潜在日程撞期、遗漏跟进和风险；你也可以手动写下“等某件事发生时提醒我”。
                      </p>
                    ) : null}
                  </div>
                  {intentionsTotal !== null ? (
                    <div className="flex flex-wrap justify-center gap-2 pt-1">
                      <button type="button" className="control control-primary" disabled={scouting} onClick={() => void triggerScout()}>
                        {scouting
                          ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />
                          : <ScanSearch size={13} aria-hidden="true" />}
                        {scouting ? "正在通读记忆排查…" : "排查潜在风险"}
                      </button>
                      <button type="button" className="control" onClick={() => setFormOpen(true)}>
                        <Plus size={13} aria-hidden="true" /> 手动添加一条
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {tab === "pending" ? (
                <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
                  已经触发、现在需要你确认或处理的提醒。
                </p>
              ) : null}
              {nudges.length ? (
                nudges.map((nudge) => <InboxCard key={nudge.nudge_id} nudge={nudge} />)
              ) : (
                <div className="nudge-empty rounded-[11px] border border-[var(--line-subtle)] px-4 py-10 text-center">
                  <span className="mx-auto mb-2.5 grid size-9 place-items-center rounded-full border border-[var(--line-subtle)] bg-[var(--bg-surface)] text-[var(--ink-muted)]">
                    <Bell size={16} aria-hidden="true" />
                  </span>
                  <h2 className="text-sm font-semibold">
                    {tab === "pending" ? "此刻很安静" : loadingHistory ? "正在载入历史记录…" : "暂无历史记录"}
                  </h2>
                  {loadingHistory ? null : (
                    <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
                      {tab === "pending" ? "有值得留意的事项时，助理会轻声提醒你；你也可以点上方「情景演练」先试试效果。" : "处理过的提醒会留在这里，方便日后回看。"}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
