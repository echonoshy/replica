import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight, ArrowUp, BellRing, ListChecks, ShieldAlert, CalendarClock, CircleHelp, Clock3, List, Loader2, MessageSquare } from "lucide-react";
import { friendlyDocLabel } from "../api";
import type { AckReason, Nudge } from "../api";
import { useApp } from "../context/AppContext";
import { RichMarkdown } from "./RichMarkdown";

export const nudgeKinds = {
  event_trigger: { label: "事件触发", tone: "tone-blue", icon: BellRing },
  risk_alert: { label: "风险预警", tone: "tone-rose", icon: ShieldAlert },
  open_loop: { label: "待闭环跟进", tone: "tone-violet", icon: ListChecks },
  conflict_check: { label: "冲突待确认", tone: "tone-amber", icon: CircleHelp },
  reminder: { label: "准备提醒", tone: "tone-blue", icon: CalendarClock },
  digest: { label: "轻简报", tone: "tone-violet", icon: List },
  follow_up: { label: "后续跟进", tone: "tone-blue", icon: MessageSquare },
} satisfies Record<Nudge["kind"], { label: string; tone: string; icon: typeof CircleHelp }>;

export const feedbackLabels = {
  already_done: "已办完", too_early: "太早了", not_relevant: "不相关", too_frequent: "太频繁",
  helpful: "有帮助", wrong_fact: "信息有误",
} satisfies Record<AckReason, string>;

export function nudgeKindLabel(kind: string | null | undefined) {
  return kind && Object.hasOwn(nudgeKinds, kind) ? nudgeKinds[kind as Nudge["kind"]].label : "提醒";
}

export function NudgeKindChip({ nudge }: { nudge: Nudge }) {
  const { icon: Icon, label, tone } = nudgeKinds[nudge.kind];
  return (
    <span className={`status-chip ${nudge.urgency === "urgent" ? "nudge-tone-urgent" : tone}`}>
      <Icon size={12} aria-hidden="true" /> {label}
    </span>
  );
}

function snoozeTime(tomorrow: boolean) {
  const date = new Date();
  if (!tomorrow) return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function actionPreview(payload: Record<string, unknown>) {
  function text(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      return [item.text, item.label, item.title, item.task].find((v): v is string => typeof v === "string")?.trim() ?? "";
    }
    return "";
  }
  const labels = new Map(Object.entries({
    summary: "摘要", new_date: "新日期", choice: "选项", draft: "草稿", reply_draft: "回复草稿", text: "正文",
    content: "内容", items: "清单", checklist: "清单",
  }));
  return Object.entries(payload).flatMap(([field, value]) => {
    const label = labels.get(field) ?? field;
    if (Array.isArray(value)) {
      const items = value.map(text).filter(Boolean);
      return items.length ? [label + "\n" + items.map(item => "• " + item).join("\n")] : [];
    }
    const detail = text(value);
    return detail ? [label + "：" + detail] : [];
  }).join("\n");
}

export function NudgeContent({ nudge, showSnoozeOptions = false }: { nudge: Nudge; showSnoozeOptions?: boolean }) {
  const { activeSpace, inspectSource, ackNudge, executeNudgeAction, openNudgeSession, selectSession, openingNudgeSession, sendingMessage } = useApp();
  const [reply, setReply] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const pending = nudge.status === "pending";
  const sessionId = nudge.session_id;
  const docLabelMap = Object.fromEntries(nudge.citations.map(({ anchor, filename, doc_date }) =>
    [anchor.split("#")[0], friendlyDocLabel(filename, doc_date)],
  ));
  const disabled = working || openingNudgeSession;
  const chatDisabled = disabled || sendingMessage;

  async function run(action: () => Promise<void>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "暂时无法处理这条提醒，请稍后再试");
    } finally {
      actionInFlight.current = false;
      setWorking(false);
    }
  }

  function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reply.trim();
    if (text && !chatDisabled) void run(() => openNudgeSession(nudge.nudge_id, text));
  }

  function openSource(anchor: string) {
    if (activeSpace) inspectSource({ space: activeSpace, anchor, version: nudge.snapshot_version || undefined });
  }

  return (
    <div className="space-y-3">
      <RichMarkdown
        markdown={nudge.body}
        docLabelMap={docLabelMap}
        onSource={openSource}
      />
      {nudge.why_now || nudge.utility_score ? (
        <p className="text-xs leading-relaxed text-[var(--ink-muted)]">
          此时提醒原因：{nudge.why_now || `综合考虑错过这件事的影响和打扰你的成本，提醒得分为 ${nudge.utility_score?.net_utility.toFixed(1)}。`}
        </p>
      ) : null}
      {nudge.prepared_brief ? (
        <details className="rounded-lg bg-[var(--bg-recessed)] px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">查看事前简报</summary>
          <div className="mt-2"><RichMarkdown markdown={nudge.prepared_brief} onSource={openSource} docLabelMap={docLabelMap} /></div>
        </details>
      ) : null}
      {nudge.proposed_actions?.length ? (
        <div className="space-y-2">
          {nudge.proposed_actions.map(action => {
            const preview = actionPreview(action.payload);
            return (
              <div key={action.action_id} className="space-y-1.5 rounded-lg bg-[var(--bg-recessed)] px-3 py-2">
                <p className="text-sm font-medium">{action.label}</p>
                {preview && <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--ink-secondary)]">{preview}</p>}
                {pending && (
                  <button type="button" className="control tone-blue" disabled={disabled}
                    aria-label={`采纳建议：${action.label}`} onClick={() => void run(() => executeNudgeAction(nudge.nudge_id, action.action_id))}>
                    采纳建议
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {nudge.suggested_action ? (
        <p className="border-l-2 border-[var(--blue-line)] pl-2.5 text-xs leading-relaxed whitespace-pre-line text-[var(--ink-secondary)]">
          <span className="font-medium">建议下一步</span> · {nudge.suggested_action}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {sessionId && !pending ? (
          <button type="button" className="nudge-link" onClick={() => selectSession(sessionId)}>
            回到该对话 <ArrowRight size={13} aria-hidden="true" />
          </button>
        ) : nudge.status !== "expired" ? (
          <button type="button" className="control control-primary" disabled={chatDisabled}
            onClick={() => void run(() => openNudgeSession(nudge.nudge_id))}>
            展开聊聊 <ArrowRight size={13} aria-hidden="true" />
          </button>
        ) : null}
        {pending ? (
          <>
            <button type="button" className="control" disabled={disabled}
              onClick={() => void run(() => ackNudge(nudge.nudge_id, "completed"))}>知道了</button>
            {showSnoozeOptions ? null : (
              <button type="button" className="control" title="3 小时后提醒" disabled={disabled}
                onClick={() => void run(() => ackNudge(nudge.nudge_id, "snooze", snoozeTime(false)))}>
                <Clock3 size={12} aria-hidden="true" /> 晚点提醒
              </button>
            )}
            {showSnoozeOptions ? (
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className="control" disabled={disabled}
                  onClick={() => void run(() => ackNudge(nudge.nudge_id, "snooze", snoozeTime(false)))}>
                  3 小时后
                </button>
                <button type="button" className="control" disabled={disabled}
                  onClick={() => void run(() => ackNudge(nudge.nudge_id, "snooze", snoozeTime(true)))}>明早 09:00</button>
              </div>
            ) : null}
            <button type="button" className="control" disabled={disabled}
              onClick={() => void run(() => ackNudge(nudge.nudge_id, "dismissed", undefined, { reason: "too_frequent" }))}>少提这类</button>
            <button type="button" className="text-xs text-[var(--ink-muted)]" aria-expanded={reasonOpen}
              onClick={() => setReasonOpen(!reasonOpen)}>其他反馈</button>
            {reasonOpen ? (
              <div className="flex flex-wrap gap-1" role="group" aria-label="忽略原因">
                <button type="button" className="control" disabled={disabled}
                  onClick={() => void run(() => ackNudge(nudge.nudge_id, "dismissed"))}>直接忽略</button>
                {(["already_done", "too_early", "not_relevant", "too_frequent"] as const).map((reason) => (
                  <button key={reason} type="button" className="control" disabled={disabled}
                    onClick={() => void run(() => ackNudge(nudge.nudge_id, "dismissed", undefined, { reason }))}>
                    {feedbackLabels[reason]}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

      </div>

      {pending ? (
        <form className="nudge-reply" onSubmit={submitReply}>
          <input
            type="text"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            }}
            placeholder="直接回复以开启专属讨论…（Enter 发送）"
            aria-label="直接回复轻提醒"
            disabled={chatDisabled}
          />
          <button type="submit" className="icon-button" aria-label="发送并开启专属讨论" disabled={chatDisabled || !reply.trim()}>
            {working ? <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : <ArrowUp size={15} aria-hidden="true" />}
          </button>
        </form>
      ) : null}
      {error ? <p className="text-xs text-[var(--ink-secondary)]" role="status">{error}</p> : null}
    </div>
  );
}

