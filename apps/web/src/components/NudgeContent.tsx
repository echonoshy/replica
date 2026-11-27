import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowRight, ArrowUp, BellRing, CalendarClock, Check, ChevronDown, ChevronRight,
  CircleHelp, Clock3, Copy, List, ListChecks, Loader2, MessageSquare, ShieldAlert,
} from "lucide-react";
import { friendlyDocLabel } from "../api";
import type { AckReason, Nudge, ProposedAction } from "../api";
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

const PAYLOAD_FIELD_LABELS = new Map<string, string>(Object.entries({
  draft: "回复草稿",
  reply_draft: "回复草稿",
  message: "消息内容",
  summary: "摘要",
  to: "发送对象",
  recipient: "接收人",
  subject: "主题",
  date: "日期",
  time: "时间",
  new_date: "调整后日期",
  old_date: "原日期",
  reason: "原因",
  location: "地点",
  choice: "选项",
  items: "清单",
  checklist: "核对清单",
  text: "正文",
  content: "内容",
  title: "标题",
  note: "备注",
  channel: "渠道",
  participants: "参与人",
  duration: "时长",
  action: "建议方式",
  target: "对象",
}));

const AUTO_EXPAND_BRIEF_KINDS = new Set<Nudge["kind"]>(["event_trigger", "conflict_check", "risk_alert"]);

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

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return [item.text, item.label, item.title, item.task, item.content].find((v): v is string => typeof v === "string")?.trim() ?? "";
  }
  return "";
}

function extractDraftText(action: ProposedAction): string {
  const { payload } = action;
  for (const key of ["draft", "reply_draft", "message", "text", "content"]) {
    const text = extractText(payload[key]);
    if (text) return text;
  }
  return action.label;
}

function actionPreviewLines(action: ProposedAction) {
  const { payload } = action;
  const skipDraftKey = action.kind === "reply_draft"
    ? ["draft", "reply_draft", "message", "text", "content"].find((k) => extractText(payload[k]))
    : undefined;

  return Object.entries(payload).flatMap(([field, value]) => {
    if (field === skipDraftKey) return [];
    const normalizedKey = field.toLowerCase();
    const label = PAYLOAD_FIELD_LABELS.get(normalizedKey);
    if (Array.isArray(value)) {
      const items = value.map(extractText).filter(Boolean);
      if (!items.length) return [];
      const prefix = label ? `${label}\n` : "";
      return [`${prefix}${items.map((item) => `• ${item}`).join("\n")}`];
    }
    const detail = extractText(value);
    if (!detail) return [];
    return [label ? `${label}：${detail}` : detail];
  });
}

export function NudgeContent({ nudge, showSnoozeOptions = false }: { nudge: Nudge; showSnoozeOptions?: boolean }) {
  const { activeSpace, inspectSource, ackNudge, executeNudgeAction, openNudgeSession, selectSession, openingNudgeSession, sendingMessage } = useApp();
  const [reply, setReply] = useState("");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(() => AUTO_EXPAND_BRIEF_KINDS.has(nudge.kind));
  const [copiedActionId, setCopiedActionId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);
  const pending = nudge.status === "pending";
  const sessionId = nudge.session_id;
  const docLabelMap = Object.fromEntries(nudge.citations.map(({ anchor, filename, doc_date }) =>
    [anchor.split("#")[0], friendlyDocLabel(filename, doc_date)],
  ));
  const disabled = working || openingNudgeSession;
  const chatDisabled = disabled || sendingMessage;

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

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

  async function copyDraft(actionId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedActionId(actionId);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedActionId((curr) => (curr === actionId ? null : curr)), 2000);
    } catch {
      setError("浏览器未授予剪贴板权限，请手动复制草稿内容");
    }
  }

  function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = reply.trim();
    if (text && !chatDisabled) void run(() => openNudgeSession(nudge.nudge_id, text, nudge));
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
      {nudge.why_now ? (
        <p className="rounded-md bg-[var(--bg-canvas)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--ink-secondary)]">
          <span className="font-medium text-[var(--ink-primary)]">为什么现在提醒</span> · {nudge.why_now}
        </p>
      ) : null}
      {nudge.prepared_brief ? (
        <div className="rounded-lg border border-[var(--line-subtle)] bg-[var(--bg-canvas)] px-3 py-2.5 text-sm">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-left text-xs font-semibold text-[var(--ink-primary)]"
            aria-expanded={briefOpen}
            onClick={() => setBriefOpen((open) => !open)}
          >
            {briefOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            <span>事前简报</span>
            <span className="ml-auto font-normal text-[var(--ink-muted)]">{briefOpen ? "收起" : "展开"}</span>
          </button>
          {briefOpen ? (
            <div className="mt-2 border-t border-[var(--line-subtle)] pt-2">
              <RichMarkdown markdown={nudge.prepared_brief} onSource={openSource} docLabelMap={docLabelMap} />
            </div>
          ) : null}
        </div>
      ) : null}
      {nudge.proposed_actions?.length ? (
        <div className="space-y-2">
          {nudge.proposed_actions.map((action) => {
            const isDraft = action.kind === "reply_draft";
            const draftText = isDraft ? extractDraftText(action) : "";
            const metaLines = actionPreviewLines(action);
            const copied = copiedActionId === action.action_id;
            return (
              <div key={action.action_id} className="space-y-2 rounded-lg border border-[var(--line-subtle)] bg-[var(--bg-canvas)] px-3 py-2.5">
                <p className="text-[13px] font-medium text-[var(--ink-primary)]">{action.label}</p>
                {metaLines.length > 0 ? (
                  <div className="space-y-1 text-xs leading-relaxed text-[var(--ink-secondary)]">
                    {metaLines.map((line, idx) => (
                      <p key={idx} className="whitespace-pre-wrap break-words">{line}</p>
                    ))}
                  </div>
                ) : null}
                {isDraft && draftText ? (
                  <blockquote className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--line-default)] bg-[var(--bg-surface)] px-3 py-2 text-xs leading-relaxed text-[var(--ink-primary)]">
                    {draftText}
                  </blockquote>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  {isDraft && draftText ? (
                    <button type="button" className="control" onClick={() => void copyDraft(action.action_id, draftText)}>
                      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                      {copied ? "已复制" : "复制草稿"}
                    </button>
                  ) : null}
                  {isDraft && draftText && nudge.status !== "expired" ? (
                    <button
                      type="button"
                      className="control"
                      disabled={chatDisabled}
                      onClick={() => void run(() => openNudgeSession(
                        nudge.nudge_id,
                        `关于「${nudge.title}」，帮我结合我的记忆和对方情况，润色一下这段回复草稿：\n\n${draftText}`,
                        nudge,
                      ))}
                    >
                      <MessageSquare size={12} aria-hidden="true" /> 去对话里润色
                    </button>
                  ) : null}
                  {pending ? (
                    <button
                      type="button"
                      className="control tone-blue"
                      disabled={disabled}
                      aria-label={`采纳并完成：${action.label}`}
                      onClick={() => void run(() => executeNudgeAction(nudge.nudge_id, action.action_id))}
                    >
                      {isDraft ? "采纳并完成" : "采纳建议"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {nudge.suggested_action ? (
        <p className="border-l-2 border-[var(--blue-line)] pl-2.5 text-xs leading-relaxed whitespace-pre-line text-[var(--ink-secondary)]">
          <span className="font-medium text-[var(--ink-primary)]">建议下一步</span> · {nudge.suggested_action}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {sessionId && !pending ? (
          <button type="button" className="nudge-link" onClick={() => selectSession(sessionId)}>
            回到该对话 <ArrowRight size={13} aria-hidden="true" />
          </button>
        ) : nudge.status !== "expired" ? (
          <button type="button" className="control control-primary" disabled={chatDisabled}
            onClick={() => void run(() => openNudgeSession(nudge.nudge_id, undefined, nudge))}>
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
            <button type="button" className="px-1 text-xs text-[var(--ink-muted)] hover:text-[var(--ink-primary)]" aria-expanded={reasonOpen}
              onClick={() => setReasonOpen(!reasonOpen)}>其他反馈</button>
            {reasonOpen ? (
              <div className="flex flex-wrap gap-1" role="group" aria-label="忽略原因">
                <button type="button" className="control" disabled={disabled}
                  onClick={() => void run(() => ackNudge(nudge.nudge_id, "dismissed"))}>直接忽略</button>
                {(["already_done", "too_early", "not_relevant", "wrong_fact"] as const).map((reason) => (
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
