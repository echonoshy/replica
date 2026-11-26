import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import {
  ArrowUp, ArrowUpRight, BookOpen, Bot, ChevronDown, ChevronRight,
  LayoutGrid, Paperclip, Loader2, MessageSquareQuote, Sparkles, X,
} from "lucide-react";
import type { JobResult } from "@wiki-memory/shared";
import { api, buildDocLabelMap, conversationPreview, formatNumber, spaceDisplayName } from "../api";
import type { ChatAttachmentResponse, ChatMessage } from "../api";
import { getShowcaseMeta, getSpaceTestCases } from "../demoTestCases";
import { RichMarkdown } from "./RichMarkdown";
import { useApp } from "../context/AppContext";
import { nudgeKindLabel } from "./NudgeContent";
import { WhisperBar } from "./WhisperBar";

const promptPills = {
  "tone-violet": "bg-[#f4f1fa] text-[#6c6087]",
  "tone-blue": "bg-[#eef3fc] text-[#526d97]",
  "tone-mint": "bg-[#edf5f2] text-[#4a7064]",
  "tone-rose": "bg-[#f8f1f2] text-[#8b606b]",
};

const promptCard = "rounded-[10px] border border-[#ebedf0] bg-white p-3.5 text-left transition-colors hover:border-[#b9d4ff] hover:bg-[#f8faff] focus-visible:outline-[#3370ff] disabled:opacity-50 sm:p-4";

const BLANK_STARTER_PROMPTS = [
  "先跟你打个招呼！以后给我写方案和汇报都按「先给结论、再列3点以内依据」来，别写大段废话。",
  "帮我记两个生活习惯：我喝咖啡只喝美式不加糖，出差坐高铁喜欢靠窗位置。",
  "下周五下午 3 点我要做 Q4 季度复盘，记得提前一天提醒我准备好核心指标和风险清单。",
  "我最近在跟进一个 AI 个人助理项目，核心搭档是产品经理小周和研发阿杰。",
];

function MemoryRecallBadge({
  message,
  onInspectDetail,
  onChatSource,
}: {
  message: ChatMessage;
  onInspectDetail: () => void;
  onChatSource: (sessionId: string, locator: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const retrieval = message.retrieval;
  const hits = message.conversation_hits ?? [];
  if (!retrieval && !hits.length) return null;

  const hasWiki = Boolean(retrieval?.contexts.length);
  const rules = retrieval?.rules ?? [];
  const strategy = retrieval?.strategy_used;
  const strategyLabel = strategy === "multi_hop"
    ? `多跳联查${retrieval?.hops != null ? `（${retrieval.hops} 跳）` : ""}`
    : strategy === "agentic" ? "自主探索" : null;
  if (!hasWiki && !hits.length && !rules.length && !strategyLabel) {
    return (
      <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-[#f0f2f5] px-3 py-1 text-[11px] text-[#646a73]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#aeb5c0]" />
        <span>
          {retrieval && retrieval.snapshot_version > 0
            ? `已查阅记忆 v${retrieval.snapshot_version} · 本问题无需调取历史记忆`
            : "聊完后点击「整理记忆」，即可保存这场对话的要点"}
        </span>
      </div>
    );
  }

  const toggle = () => setExpanded((value) => !value);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-2.5">
        {hasWiki && retrieval ? (
          <button type="button" aria-expanded={expanded} onClick={toggle} className="status-chip tone-blue">
            <BookOpen size={12} aria-hidden="true" />
            Wiki 长期记忆 · {retrieval.contexts.length} 页 · v{retrieval.snapshot_version}
            <Chevron size={13} aria-hidden="true" />
          </button>
        ) : null}
        {hits.length ? (
          <button type="button" aria-expanded={expanded} onClick={toggle} className="status-chip tone-violet">
            <MessageSquareQuote size={12} aria-hidden="true" />
            原文直搜 · {hits.length} 段原话
            <Chevron size={13} aria-hidden="true" />
          </button>
        ) : null}

        {strategyLabel && <span className="status-chip bg-[#f0f2f5] text-[#646a73]">{strategyLabel}</span>}
        {rules.length > 0 && (
          <button type="button" aria-expanded={expanded} onClick={toggle} className="status-chip tone-mint">
            行为准则 · {rules.length} 条<Chevron size={13} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onInspectDetail}
          className="text-[11.5px] font-medium text-[#8f959e] transition-colors hover:text-[#3370ff]"
        >
          右侧看详情 →
        </button>
      </div>

      {expanded ? (
        <div className="mt-2.5 space-y-3 rounded-[10px] border border-[#eceef2] bg-[#f8f9fb] p-3.5">
          {hasWiki && retrieval ? (
            <section className="space-y-1.5">
              <h3 className="text-xs font-semibold text-[#245bdb]">通道 1 · 长期记忆 Wiki</h3>
              {retrieval.contexts.map((ctx) => (
                <p key={ctx.page_id} className="text-xs leading-relaxed text-[#646a73]">
                  <span className="font-medium text-[#1f2329]">{ctx.title}</span>
                  <span className="mx-1.5 text-[#aeb5c0]">·</span>
                  {ctx.relevance_reason}
                </p>
              ))}
            </section>
          ) : null}
          {rules.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="text-xs font-semibold text-[#047857]">行为准则</h3>
              <ul className="space-y-1.5 text-xs leading-relaxed">
                {rules.map((rule) => (
                  <li key={rule.rule_id} className="break-words">
                    <span className="text-[#646a73]">{rule.trigger_context}：</span>{rule.instruction}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {hits.length ? (
            <section className={hasWiki ? "space-y-1.5 border-t border-[#eceef2] pt-3" : "space-y-1.5"}>
              <h3 className="text-xs font-semibold text-[#6d28d9]">通道 2 · 原始对话检索</h3>
              {hits.map((hit) => {
                const dreamed = hit.session_status === "dreamed";
                return (
                  <button key={`${hit.session_id}#${hit.turn_locator}`} type="button"
                    onClick={() => onChatSource(hit.session_id, hit.turn_locator)}
                    className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-white hover:text-[#6d28d9]">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{hit.session_title}</span>
                      <span className={`status-chip ${dreamed ? "tone-mint" : "tone-violet"}`}>{dreamed ? "已入梦" : "待入梦"}</span>
                      <span className="font-mono-num text-[#646a73]">#{hit.turn_locator}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[#646a73]">{conversationPreview(hit.excerpt)}</span>
                  </button>
                );
              })}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ingestionLabels: Record<JobResult["status"], string> = {
  queued: "等待整理", normalizing: "正在解析文档", extracting: "正在提取事实", organizing: "正在整理记忆",
  linting: "正在校验", published: "已整理入库", failed: "整理失败",
};

function AttachmentStatus({ attachment }: { attachment: ChatAttachmentResponse["attachment"] }) {
  const { refreshSpaceData, overview } = useApp();
  const [job, setJob] = useState<JobResult | null>(null);
  const [pollError, setPollError] = useState("");
  const onPublished = useEffectEvent((version?: number | null) => {
    if (!overview || (version ?? 0) > overview.space.current_version) void refreshSpaceData();
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api.getJob(attachment.job_id);
        if (cancelled) return;
        setPollError("");
        setJob(result);
        if (result.status === "published") onPublished(result.target_version);
        if (result.status === "published" || result.status === "failed") return;
      } catch (err) {
        if (cancelled) return;
        setPollError((err as Error).message);
      }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [attachment.job_id]);

  const status = job?.status ?? "queued";
  return (
    <div className="mt-2 space-y-1 border-t border-[#eceef2] pt-2 text-xs">
      <div role="status" className="flex flex-wrap items-center gap-2">
        <Paperclip size={12} /><span className="min-w-0 break-all">{attachment.filename}</span>
        <span className={`status-chip ${status === "published" ? "tone-mint" : status === "failed" ? "tone-rose" : "tone-blue"}`}>
          {ingestionLabels[status]}{status === "published" && job?.target_version ? ` · v${job.target_version}` : ""}
        </span>
      </div>
      {job?.error_message && <p role="alert" className="text-[#b42318]">{job.error_message}</p>}
      {pollError && <p role="status" className="text-[#646a73]">整理状态读取失败，正在重试。{pollError}</p>}
      {attachment.warnings.map((warning) => <p key={warning} className="text-[#b45309]">{warning}</p>)}
    </div>
  );
}

export function ChatWorkspace() {
  const {
    activeSpace,
    activeSession,
    activeSessionId,
    messages,
    hotMemoryActions,
    loadingMessages,
    sendingMessage,
    streamingStatus,
    openingNudgeSession,
    compareBaseline,
    sendChatMessage,
    uploadingAttachment,
    uploadChatAttachment,
    attachments,
    restoredDraft,
    clearRestoredDraft,
    overview,
    scenarios,
    sessions,
    focusRecall,
    inspectSource,
    inspectChatTurn,
  } = useApp();

  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerBusy = sendingMessage || uploadingAttachment || openingNudgeSession || loadingMessages;
  const [draft, setDraft] = useState("");
  const [casesOpen, setCasesOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const lastMessage = messages.at(-1);
  const sendingInChat = sendingMessage && lastMessage?.role === "user" && lastMessage.id < 0;
  const streamingProgress = lastMessage && lastMessage.role === "assistant" && lastMessage.id < 0
    ? lastMessage.content.length + (lastMessage.baseline_reply?.length ?? 0)
    : 0;

  const docLabelMap = useMemo(() => buildDocLabelMap(overview?.documents), [overview]);
  const showcaseMeta = useMemo(() => getShowcaseMeta(activeSpace), [activeSpace]);
  const spaceTestCases = useMemo(() => getSpaceTestCases(activeSpace, scenarios), [activeSpace, scenarios]);

  useEffect(() => {
    setCasesOpen(false);
  }, [activeSpace?.namespace, activeSpace?.space_id, activeSession?.session_id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  useEffect(() => {
    if (!streamingProgress) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 160) {
      el.scrollTop = el.scrollHeight;
    }
  }, [streamingProgress]);

  useEffect(() => {
    if (!restoredDraft || restoredDraft.sessionId !== activeSessionId) return;
    setDraft(restoredDraft.text);
    clearRestoredDraft(restoredDraft);
  }, [activeSessionId, restoredDraft, clearRestoredDraft]);

  const hasComparisonTurn = useMemo(
    () => messages.some((m) => m.baseline_reply !== null),
    [messages],
  );

  const turnAnchorByMsgId = useMemo(() => {
    const map = new Map<number, string>();
    let turn = 0;
    for (const msg of messages) {
      if (!msg.content.trim()) continue;
      if (msg.role === "user" || turn === 0) turn++;
      if (msg.role === "user") map.set(msg.id, `t${turn}`);
    }
    return map;
  }, [messages]);

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    if (!activeSpace || !draft.trim() || composerBusy) return;
    const text = draft;
    if (await sendChatMessage(text)) setDraft((current) => current === text ? "" : current);
  }

  async function handleAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeSpace || composerBusy) return;
    if (await uploadChatAttachment(activeSessionId, file, draft)) setDraft("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  const isExampleLin = activeSpace?.namespace === "personal" && activeSpace?.space_id === "lin_yuan";
  const isEmpty = !loadingMessages && messages.length === 0;
  const hasTestCases = spaceTestCases.length > 0;

  function triggerTestCase(query: string) {
    if (!activeSpace || composerBusy) return;
    setCasesOpen(false);
    void sendChatMessage(query);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <WhisperBar />
      <div ref={scrollRef} className="@container min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className={`mx-auto w-full ${hasComparisonTurn || compareBaseline ? "max-w-[1060px]" : "max-w-[780px]"}`}>
          {loadingMessages ? (
            <div className="flex items-center justify-center gap-2 py-20 text-xs text-[#8f959e]">
              <Loader2 size={15} className="animate-spin text-[#3370ff]" /> 载入对话记录…
            </div>
          ) : isEmpty ? (
            <div className="mx-auto max-w-[700px] space-y-7 pt-4 pb-3 sm:pt-8">
              <header className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[#edf3ff] text-[#3370ff]">
                  <Sparkles size={19} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[21px] leading-tight font-semibold text-[#1f2329]">
                      {isExampleLin ? scenarios?.default_space.persona ?? "林远 · 产品负责人" : spaceDisplayName(activeSpace)}
                    </h2>
                    {showcaseMeta && <span className="rounded-md bg-[#f5f6f7] px-2 py-0.5 text-[11px] text-[#646a73]">{showcaseMeta.badge}</span>}
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-[#646a73]">{showcaseMeta?.subtitle ?? "个人记忆工作区"}</p>
                  <ul aria-label="空间记忆概况" className="mt-2.5 flex flex-wrap items-center gap-y-1 divide-x divide-[#dee0e3] text-[12px] leading-none text-[#646a73]">
                    <li className="pr-2.5">{sessions.filter((session) => session.status === "dreamed").length} 场已沉淀</li>
                    <li className="px-2.5">{overview?.space.page_count ?? 0} 页知识</li>
                    <li className="pl-2.5">{overview?.stats.fact_count ?? 0} 条记忆事实</li>
                  </ul>
                </div>
              </header>

              <section aria-labelledby="suggested-prompts">
                <div className="mb-3 flex items-baseline gap-2">
                  <h3 id="suggested-prompts" className="text-sm font-semibold text-[#1f2329]">试试这样问</h3>
                  <span className="text-xs text-[#646a73]">{hasTestCases ? spaceTestCases.length : BLANK_STARTER_PROMPTS.length} 个话题</span>
                </div>
                <div className="grid gap-3 @lg:grid-cols-2">
                  {hasTestCases ? spaceTestCases.map((prompt) => (
                    <button key={prompt.id} type="button" disabled={composerBusy}
                      onClick={() => triggerTestCase(prompt.query)}
                      className={`group ${promptCard}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${promptPills[prompt.tone ?? "tone-blue"]}`}>{prompt.badge}</span>
                        <ArrowUpRight size={14} className="text-[#646a73] group-hover:text-[#3370ff]" />
                      </div>
                      <div className="mt-2 text-[13.5px] font-medium leading-snug text-[#1f2329]">{prompt.title}</div>
                      <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-[#646a73]">{prompt.description}</div>
                    </button>
                  )) : BLANK_STARTER_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" disabled={!activeSpace || composerBusy}
                      onClick={() => void sendChatMessage(prompt)}
                      className={`${promptCard} text-[13px] leading-relaxed text-[#4e5969]`}>
                      {prompt}
                    </button>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            /* Message Stream */
            <div className="space-y-5 pb-4">
              {messages.map((msg, index) => {
                if (msg.role === "user") {
                  const anchor = turnAnchorByMsgId.get(msg.id);
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[80%] rounded-[12px] rounded-br-[4px] border border-[#e5e9f2] bg-[#f4f6fa] px-4 py-3 text-[14.5px] leading-[1.75] text-[#1f2329]">
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                        {activeSession?.status === "dreamed" && anchor ? (
                          <div className="mt-1.5 flex justify-end">
                            <span className="status-chip tone-blue font-mono-num">#{anchor}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                }

                const sessionLabelMap = Object.fromEntries((msg.conversation_hits ?? [])
                  .map((hit) => [hit.session_id, hit.session_title]));
                const isStreaming = sendingMessage && msg.id < 0;
                const fromNudge = index === 0 && Boolean(activeSession?.source_nudge_id);
                const snapshotVersion = msg.retrieval?.snapshot_version ?? 0;
                const hotAction = hotMemoryActions[msg.id];
                const rememberedReply = (
                  <>
                    {fromNudge ? (
                      <div className="mb-3 flex flex-wrap items-center gap-1.5">
                        <span className="status-chip tone-violet">
                          <span aria-hidden="true">✦</span> 来自轻提醒 · {nudgeKindLabel(activeSession?.source_nudge_kind)}
                        </span>
                        {snapshotVersion > 0 ? <span className="mono-meta">基于记忆 v{snapshotVersion}</span> : null}
                      </div>
                    ) : <MemoryRecallBadge message={msg} onInspectDetail={() => focusRecall(msg)} onChatSource={inspectChatTurn} />}
                    {hotAction && (
                      <span className={`status-chip mb-2 ${hotAction === "remember" ? "tone-mint" : "tone-amber"}`}>
                        {hotAction === "remember" ? "已添加即时记忆" : "已添加遗忘规则"}
                      </span>
                    )}
                    {isStreaming && !msg.content ? (
                      <div className="flex items-center gap-2 py-1 text-xs text-[#646a73]">
                        <Loader2 size={13} className="animate-spin text-[#3370ff]" />
                        <span>{streamingStatus || "正在检索记忆与历史对话…"}</span>
                      </div>
                    ) : (
                      <>
                        <RichMarkdown
                          markdown={msg.content}
                          docLabelMap={docLabelMap}
                          sessionLabelMap={sessionLabelMap}
                          onChatSource={inspectChatTurn}
                          onSource={(anchor) => {
                            if (!activeSpace) return;
                            const hit = msg.conversation_hits?.find((item) => `${item.dreamed_doc_id}#${item.turn_locator}` === anchor);
                            const dreamedVersion = hit && sessions.find((session) =>
                              session.session_id === hit.session_id && session.dreamed_doc_id === hit.dreamed_doc_id)?.dreamed_version;
                            inspectSource({
                              space: activeSpace,
                              anchor,
                              version: dreamedVersion || snapshotVersion || (fromNudge ? undefined : activeSpace.current_version || undefined),
                            });
                          }}
                        />
                        {isStreaming ? <span className="stream-caret" aria-hidden="true" /> : null}
                      </>
                    )}
                  </>
                );

                if (msg.baseline_reply !== null) {
                  return (
                    <div key={msg.id} className="grid gap-4 @3xl:grid-cols-2">
                      <div className="rounded-[12px] border border-[#e5e7eb] bg-[#f8f9fb] p-5">
                        <div className="mb-3 flex items-center justify-between border-b border-[#eceef2] pb-2.5 text-xs">
                          <span className="inline-flex items-center gap-1.5 font-medium text-[#646a73]">
                            <Bot size={14} /> 无记忆对照组
                          </span>
                          <span className="rounded-full bg-[#eff1f5] px-2 py-0.5 text-[10.5px] text-[#8f959e]">
                            {isStreaming ? "生成中" : "零背景"}
                          </span>
                        </div>
                        {isStreaming && !msg.baseline_reply ? (
                          <div className="flex items-center gap-2 py-1 text-xs text-[#8f959e]">
                            <Loader2 size={13} className="animate-spin" />
                            <span>{msg.retrieval ? "正在生成无记忆回复…" : "等待开始生成…"}</span>
                          </div>
                        ) : (
                          <>
                            <RichMarkdown markdown={msg.baseline_reply} onSource={() => {}} className="text-[#4e5969]" />
                            {isStreaming ? <span className="stream-caret" aria-hidden="true" /> : null}
                          </>
                        )}
                      </div>

                      <div className="card-tactile border-[#cddfff]/80 p-5">
                        <div className="mb-3 flex items-center justify-between border-b border-[#f0f2f5] pb-2.5 text-xs">
                          <span className="inline-flex items-center gap-1.5 font-semibold text-[#245bdb]">
                            <Sparkles size={14} className="text-[#3370ff]" /> Replica · 个人记忆回复
                          </span>
                          {isStreaming ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-[#3370ff]">
                              <Loader2 size={11} className="animate-spin" />
                              {msg.content ? "流式输出中" : "检索记忆中"}
                            </span>
                          ) : msg.latency_ms ? (
                            <span className="font-mono-num text-[11px] text-[#8f959e]">
                              {(msg.latency_ms / 1000).toFixed(1)}s
                            </span>
                          ) : null}
                        </div>
                        {rememberedReply}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={msg.id} className="flex items-start gap-3">
                    <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border border-[#dbeafe] bg-[#eff6ff] text-[#3370ff]">
                      <Sparkles size={13} />
                    </span>
                    <div className="card-tactile min-w-0 flex-1 px-5 py-4">
                      {rememberedReply}
                      {attachments[msg.id] && <AttachmentStatus attachment={attachments[msg.id]} />}
                      {msg.tokens ? (
                        <div className="mt-2.5 font-mono-num text-[10.5px] text-[#a0a6b1]">
                          {formatNumber(msg.tokens)} tokens{msg.latency_ms ? ` · ${(msg.latency_ms / 1000).toFixed(1)}s` : ""}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}

              {sendingInChat ? (
                <div className="flex items-start gap-3">
                  <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#eef4ff] text-[#3370ff]">
                    <Loader2 size={13} className="animate-spin" />
                  </span>
                  <div className="card-tactile px-4 py-3 text-xs text-[#646a73]">
                    正在检索记忆与历史对话…
                  </div>
                </div>
              ) : null}

              <div ref={endRef} />
            </div>
          )}
        </div>
      </div>

      {/* Floating Tactile Composer */}
      <div className="shrink-0 bg-white px-4 pt-2 pb-3 sm:px-6">
        <form
          onSubmit={handleSubmit}
          className={`mx-auto w-full ${hasComparisonTurn || compareBaseline ? "max-w-[1060px]" : "max-w-[780px]"}`}
        >
          {casesOpen && hasTestCases ? (
            <div className="card-tactile mb-2.5 overflow-hidden border-[#cddfff] bg-[#fbfcff]">
              <div className="flex items-center justify-between border-b border-[#eceef2] px-3.5 py-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1f2329]">
                  <LayoutGrid size={13} className="text-[#3370ff]" />
                  快捷场景
                </span>
                <button
                  type="button"
                  onClick={() => setCasesOpen(false)}
                  className="icon-button"
                  aria-label="收起快捷场景"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="grid max-h-56 gap-2 overflow-y-auto p-2.5 sm:grid-cols-2">
                {spaceTestCases.map((prompt) => (
                  <button
                    key={prompt.id}
                    type="button"
                    disabled={composerBusy}
                    onClick={() => triggerTestCase(prompt.query)}
                    className="group rounded-[8px] border border-[#eceef2] bg-white px-3 py-2 text-left transition-all hover:border-[#b9d4ff] hover:bg-[#f8faff] disabled:opacity-50"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${promptPills[prompt.tone ?? "tone-blue"]}`}>{prompt.badge}</span>
                      <ArrowUpRight size={13} className="text-[#8f959e] group-hover:text-[#3370ff]" />
                    </div>
                    <div className="mt-1.5 text-[12.5px] font-medium leading-snug text-[#1f2329]">{prompt.title}</div>
                    <div className="mt-0.5 line-clamp-1 text-[11px] text-[#646a73]">{prompt.description}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-end rounded-[12px] border border-[#dee0e3] bg-white gap-2.5 px-4 py-2.5 transition-all focus-within:border-[#3370ff] focus-within:ring-2 focus-within:ring-[#3370ff]/12">
            <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.md,.txt,.json" onChange={handleAttachment} />
            <button type="button" className="icon-button mb-0.5 disabled:opacity-50" aria-label="上传附件"
              title="上传附件（PDF、Word、Markdown、TXT、JSON）" disabled={!activeSpace || composerBusy} onClick={() => fileRef.current?.click()}>
              {uploadingAttachment ? <Loader2 size={17} className="animate-spin" /> : <Paperclip size={17} />}
            </button>
            <textarea
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!activeSpace || composerBusy}
              aria-label="聊天消息"
              placeholder="和 Replica 聊点什么…（Enter 发送，Shift+Enter 换行）"
              className="max-h-36 min-h-[28px] min-w-0 flex-1 resize-none border-0 bg-transparent py-1 text-[14px] leading-relaxed text-[#1f2329] placeholder:text-[#9ea4ae] focus:outline-none"
            />
            <button
              type="submit"
              disabled={!activeSpace || !draft.trim() || composerBusy}
              aria-label="发送消息"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[#3370ff] text-white transition-colors hover:bg-[#245bdb] disabled:bg-[#e5e7eb] disabled:text-[#a0a6b1] disabled:shadow-none"
            >
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          </div>
          {uploadingAttachment && <p role="status" className="mt-1.5 px-1 text-xs text-[#646a73]">正在上传附件并生成预览…</p>}
          {!isEmpty && hasTestCases ? (
            <button type="button" aria-expanded={casesOpen} onClick={() => setCasesOpen((open) => !open)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[#646a73] hover:bg-[#f5f6f7] aria-expanded:bg-[#eef4ff] aria-expanded:text-[#245bdb]">
              <LayoutGrid size={12} /> 快捷场景（{spaceTestCases.length}）
            </button>
          ) : null}
        </form>
      </div>
    </div>
  );
}

