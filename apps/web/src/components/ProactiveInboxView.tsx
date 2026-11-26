import { useId, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Bell, Loader2, RefreshCw } from "lucide-react";
import { formatShortDate, spaceKeyOf } from "../api";
import type { Nudge, ProactivePolicy, ProactiveEventInput, ProactiveEventResult, ProspectiveIntention } from "../api";
import { useApp } from "../context/AppContext";
import { feedbackLabels, NudgeContent, NudgeKindChip } from "./NudgeContent";

const historyStatus = {
  read: "已展开对话",
  completed: "已处理",
  dismissed: "已忽略",
  snoozed: "已延后",
  expired: "已过期",
};

function InboxCard({ nudge }: { nudge: Nudge }) {
  const isSimulated = nudge.nudge_id.startsWith("sim_");
  return (
    <article className="card-tactile space-y-3 p-4 sm:p-5">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <NudgeKindChip nudge={nudge} />
          {isSimulated ? <span className="status-chip tone-blue">仅供预览</span> : null}
          {nudge.status !== "pending" ? <span className="status-chip nudge-status">{historyStatus[nudge.status]}</span> : null}
          <time dateTime={nudge.deliver_after} className="mono-meta ml-auto">{formatShortDate(nudge.deliver_after)}</time>
        </div>
        <h2 className="text-[14.5px] font-semibold [overflow-wrap:anywhere]">{nudge.title}</h2>
      </header>
      <NudgeContent nudge={nudge} showSnoozeOptions />
    </article>
  );
}

const SIMULATE_PRESETS: Record<string, Array<{ label: string; iso: string; hint: string }>> = {
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
          <button type="submit" className="control" disabled={!dirty || saving}>{saving ? "保存中…" : "保存设置"}</button>
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

function TimePanel({ id }: { id: string }) {
  const { activeSpace, evaluatingProactive, simulateProactive, simulatedNudgeCount, clearSimulatedNudges } = useApp();
  const presets = (activeSpace && SIMULATE_PRESETS[spaceKeyOf(activeSpace)]) ?? [relativePreset(1), relativePreset(3)];
  const [custom, setCustom] = useState(presets[0].iso.slice(0, 16));
  return <section id={id} aria-label="模拟时间" className="card-tactile space-y-3 p-4">
    <h2 className="text-sm font-semibold">看看那时会提醒什么</h2>
    <div className="flex flex-wrap gap-2">{presets.map((p) => <button key={p.iso} type="button" className="control"
      disabled={evaluatingProactive} onClick={() => void simulateProactive(p.iso, p.label)}>{p.label}</button>)}</div>
    <form className="flex flex-wrap items-center gap-2 text-xs" onSubmit={(e) => {
      e.preventDefault();
      void simulateProactive(`${custom}:00+08:00`, custom.replace("T", " "));
    }}>
      <label>北京时间 <input className="control" type="datetime-local" value={custom} required onChange={(e) => setCustom(e.target.value)} /></label>
      <button className="control" disabled={evaluatingProactive || !custom}>预览提醒</button>
      {simulatedNudgeCount > 0 && <button type="button" className="control" onClick={clearSimulatedNudges}>清空预览</button>}
    </form>
  </section>;
}

const eventPresets = [
  { label: "收到客户确认邮件", type: "email_received", summary: "客户确认报价，请按报价准备合同。", entities: ["客户", "确认报价", "合同"] },
  { label: "日历新增撞车会议", type: "calendar_changed", summary: "日历新增客户会议，与明天的项目例会时间重叠。", entities: ["会议", "客户", "项目例会"] },
  { label: "刚在对话里取消了明天安排", type: "chat_turn", summary: "刚在对话里取消了明天的安排，请撤销原先的约定。", entities: ["明天", "取消", "安排"] },
] as const;

const eventTypes = {
  custom: "自定义", email_received: "收到邮件", calendar_changed: "日历变化", chat_turn: "对话更新",
  location_changed: "位置变化", topic_entered: "聊到某个话题", app_signal: "应用通知",
} satisfies Record<ProactiveEventInput["event_type"], string>;

function EventPanel({ id }: { id: string }) {
  const { simulateEvent } = useApp();
  const [preview, setPreview] = useState(true);
  const [summary, setSummary] = useState("");
  const [type, setType] = useState<ProactiveEventInput["event_type"]>("custom");
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<ProactiveEventResult | null>(null);
  const [error, setError] = useState("");
  async function submit(event_type: ProactiveEventInput["event_type"], text: string, entities: readonly string[] = []) {
    setWorking(true);
    setResult(null);
    setError("");
    try {
      setResult(await simulateEvent({ event_type, summary: text.trim(), dry_run: preview, entities: [...entities], metadata: {} }));
    } catch {
      setError("事件未能处理，请稍后再试");
    } finally {
      setWorking(false);
    }
  }
  return (
    <section id={id} aria-label="模拟事件" className="card-tactile space-y-3 p-4">
      <h2 className="text-sm font-semibold">试试一件刚发生的事</h2>
      <fieldset disabled={working} className="space-y-3">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
          只看预览{preview ? "（待办保持原样）" : "（已关闭，本次会记录事件并更新待办）"}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {eventPresets.map((p) => <button key={p.type} className="control" type="button"
            onClick={() => { setSummary(p.summary); setType(p.type); void submit(p.type, p.summary, p.entities); }}>{p.label}</button>)}
        </div>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void submit(type, summary); }}>
          <select aria-label="事件类型" className="control" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {Object.entries(eventTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input aria-label="事件内容" placeholder="发生了什么？" className="control min-w-0 flex-1" maxLength={4000}
            value={summary} onChange={(e) => setSummary(e.target.value)} required />
          <button type="submit" className="control" disabled={!summary.trim()}>{preview ? "预览结果" : "记录事件"}</button>
        </form>
      </fieldset>
      <div role="status" className="space-y-1 text-xs leading-relaxed text-[var(--ink-muted)]">
        {working ? "正在对照你的待办…" : error}
        {result && <>
          <p className="font-medium text-[var(--ink-primary)]">{result.dry_run ? "预览结果" : "事件已记录"} · {{
            push: "立即提醒", digest: "收入简报", silent: "保持安静",
          }[result.decision_summary]}</p>
          <p>初步匹配 {result.l1_matches.length} 条待办 · {result.llm_called ? "已请模型进一步判断" : "未调用模型"} · {result.nudges.length} 条提醒</p>
          {result.l1_matches.map((match) => <p key={match.intention_id}>匹配待办 · {match.goal}</p>)}
          {result.nudges.map((n) => <p key={n.nudge_id}>提醒 · {n.title}</p>)}
        </>}
      </div>
    </section>
  );
}

const kindLabels = { time_based: "定时", event_based: "等条件触发", open_loop: "未闭环", recurring: "周期", risk_watch: "风险预警" };
const priorityLabels = { redline: "红线", high: "高优先", normal: "普通", low: "低优先" };
const statusLabels = { armed: "等待提醒", snoozed: "已延后", triggered: "已提醒", fulfilled: "已完成", cancelled: "已取消", expired: "已过期" };

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
      setError("暂时无法更新这条待办，请再试一次");
    } finally {
      setBusy(false);
    }
  }
  return <article className="card-tactile space-y-2 p-4">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="status-chip tone-blue">{kindLabels[item.kind]}</span>
      <span className={`status-chip ${["high", "redline"].includes(item.priority) ? "tone-amber" : "nudge-status"}`}>{priorityLabels[item.priority]}</span>
      <span className="ml-auto text-[var(--ink-muted)]">{statusLabels[item.status]}</span>
    </div>
    <h3 className="break-words text-sm font-semibold">{item.goal}</h3>
    <div className="space-y-1 text-xs text-[var(--ink-muted)]">
      {condition.cue_text && <p>提醒条件 · {condition.cue_text}</p>}
      {condition.match_event_types?.length ? <p>留意 · {condition.match_event_types.map((type) => eventTypes[type]).join("、")}</p> : null}
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
      <button type="button" className="control" onClick={() => { if (window.confirm("删除这条待办？")) void change("delete"); }}>删除</button>
    </fieldset>
    {error && <p role="status" className="text-xs">{error}</p>}
  </article>;
}

function IntentionForm() {
  const { createIntention } = useApp();
  const [kind, setKind] = useState<"event_based" | "time_based" | "open_loop">("event_based");
  const [cue, setCue] = useState("");
  const [goal, setGoal] = useState("");
  const [time, setTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const details = e.currentTarget.closest("details");
    setSaving(true);
    setError("");
    try {
      await createIntention({
        kind, goal: goal.trim(), condition: kind === "time_based" ? { fire_at: new Date(time).toISOString() } : { cue_text: cue.trim() },
        priority: "normal", source: "user", subjects: [], evidence_anchors: [],
      });
      setGoal(""); setCue(""); setTime("");
      if (details) details.open = false;
    } catch {
      setError("暂时无法添加，请检查内容后再试");
    } finally {
      setSaving(false);
    }
  }
  return <details className="card-tactile p-4">
    <summary className="cursor-pointer text-sm font-medium">+ 添加一条待提醒的条件</summary>
    <form onSubmit={save} className="mt-3">
      <fieldset disabled={saving} className="grid gap-3 text-xs sm:grid-cols-2">
        <label className="grid gap-1">什么时候提醒
          <select className="control" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="event_based">等条件触发</option><option value="open_loop">有件事待跟进</option><option value="time_based">到指定时间</option>
          </select>
        </label>
        {kind === "time_based"
          ? <label className="grid gap-1">提醒时间<input type="datetime-local" required className="control" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          : <label className="grid gap-1">提醒条件<input className="control" placeholder="例如：客户确认报价" maxLength={600} required value={cue} onChange={(e) => setCue(e.target.value)} /></label>}
        <label className="grid gap-1 sm:col-span-2">提醒我做什么<input className="control" placeholder="例如：把合同发给客户" maxLength={1000} required value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
        <button type="submit" className="control w-fit" disabled={!goal.trim() || !(kind === "time_based" ? time : cue.trim())}>{saving ? "保存中…" : "保存提醒条件"}</button>
      </fieldset>
      {error && <p role="status" className="mt-2 text-xs">{error}</p>}
    </form>
  </details>;
}

const tabs = ["pending", "intentions", "history"] as const;

export function ProactiveInboxView() {
  const {
    pendingNudges, historyNudges, intentions, intentionsTotal, intentionsLoadFailed, refreshProactiveExtras, runProactiveScout, proactivePolicy, evaluatingProactive, proactiveNotice,
    evaluateProactive, loadingProactiveInbox,
  } = useApp();
  const [tab, setTab] = useState<typeof tabs[number]>("pending");
  const [panel, setPanel] = useState<"event" | "time" | "policy" | null>(null);
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
            <button type="button" className="control" disabled={scouting} onClick={async () => {
              setScouting(true);
              setTab("intentions");
              try { await runProactiveScout(); } finally { setScouting(false); }
            }}>{scouting ? "排查中…" : "排查潜在风险"}</button>
            {([["event", "模拟事件"], ["time", "模拟时间"], ["policy", "设置"]] as const).map(([value, label]) => (
              <button type="button" key={value} className="control" aria-expanded={panel === value}
                disabled={value === "policy" && !proactivePolicy} aria-controls={panel === value ? `${id}-tools` : undefined}
                onClick={() => { setPanel(panel === value ? null : value); if (value === "time") setTab("pending"); }}>{label}</button>
            ))}
          </div>
        </header>
        {proactiveNotice ? <p className="text-xs text-[var(--ink-muted)]" role="status">{proactiveNotice}</p> : null}
        {panel === "event" && <EventPanel id={`${id}-tools`} />}
        {panel === "time" && <TimePanel id={`${id}-tools`} />}
        {panel === "policy" && proactivePolicy && <PolicyPanel id={`${id}-tools`} policy={proactivePolicy} />}
        <div className="recessed-track inline-flex gap-0.5 text-xs font-medium" role="tablist" aria-label="轻提醒记录" onKeyDown={handleTabKey}>
          {([
            ["pending", "待处理", pendingNudges.length],
            ["intentions", "待办意图", intentionsTotal ?? "…"],
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
          {tab === "intentions" ? <>
            <IntentionForm />
            {intentionsLoadFailed && <p role="status" className="text-xs">待办尚未刷新。 <button className="nudge-link" onClick={() => void refreshProactiveExtras()}>重新加载</button></p>}
            {intentionsTotal !== null && intentionsTotal > intentions.length && <p className="text-xs">显示最近更新的 {intentions.length} 条，共 {intentionsTotal} 条。</p>}
            {intentions.length ? intentions.map((item) => <IntentionCard key={item.intention_id} item={item} />)
              : !intentionsLoadFailed && <p className="nudge-empty rounded-lg p-6 text-center text-sm">
                {intentionsTotal === null ? "正在读取待办…" : "还没有待办。添加一个条件，让助理在合适的时候提醒你。"}
              </p>}
          </> : nudges.length ? nudges.map((nudge) => <InboxCard key={nudge.nudge_id} nudge={nudge} />) : (
            <div className="nudge-empty rounded-[11px] px-4 py-10 text-center">
              <span className="mx-auto mb-2.5 grid size-9 place-items-center rounded-full border border-[var(--line-subtle)] bg-[var(--bg-surface)] text-[var(--ink-muted)]">
                <Bell size={16} aria-hidden="true" />
              </span>
              <h2 className="text-sm font-semibold">
                {tab === "pending" ? "此刻很安静" : loadingHistory ? "正在载入历史记录…" : "暂无历史记录"}
              </h2>
              {loadingHistory ? null : (
                <p className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">
                  {tab === "pending" ? "有值得留意的事项时，助理会轻声提醒你。" : "处理过的提醒会留在这里，方便日后回看。"}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
