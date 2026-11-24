import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  ArrowUp, ArrowUpRight, BookOpen, Bot, ChevronDown, ChevronRight,
  Loader2, LockKeyhole, MessageSquareQuote, Moon, Sparkles,
} from "lucide-react";
import { buildDocLabelMap, conversationPreview, formatNumber, spaceDisplayName } from "../api";
import type { ChatMessage } from "../api";
import { RichMarkdown } from "./RichMarkdown";
import { useApp } from "../context/AppContext";

const PROMPT_TONES: Record<string, string> = {
  comprehensive: "tone-violet",
  travel_multihop: "tone-blue",
  dual_track: "tone-mint",
  conflict_audit: "tone-rose",
};

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
  if (!hasWiki && !hits.length) {
    return (
      <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-[#f0f2f5] px-3 py-1 text-[11px] text-[#646a73]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#aeb5c0]" />
        <span>
          {retrieval && retrieval.snapshot_version > 0
            ? `已查阅记忆 v${retrieval.snapshot_version} · 本问题无需调取历史记忆`
            : "当前尚未沉淀长期记忆 · 聊完点击左侧「做梦整理」即可记住"}
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

export function ChatWorkspace() {
  const {
    activeSpace,
    activeSession,
    messages,
    loadingMessages,
    sendingMessage,
    compareBaseline,
    sendChatMessage,
    overview,
    scenarios,
    model,
    sessions,
    pendingCount,
    setRightOpen,
    setRightTab,
    focusRecall,
    inspectSource,
    inspectChatTurn,
  } = useApp();

  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const docLabelMap = useMemo(() => buildDocLabelMap(overview?.documents), [overview]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sendingMessage]);

  const hasComparisonTurn = useMemo(
    () => messages.some((m) => Boolean(m.baseline_reply)),
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

  function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    if (!activeSpace || !draft.trim() || sendingMessage || loadingMessages) return;
    const text = draft;
    setDraft("");
    void sendChatMessage(text);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const isExampleLin = activeSpace?.namespace === "personal" && activeSpace?.space_id === "lin_yuan";
  const isEmpty = !loadingMessages && messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="@container flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className={`mx-auto w-full ${hasComparisonTurn || compareBaseline ? "max-w-[1060px]" : "max-w-[780px]"}`}>
          {loadingMessages ? (
            <div className="flex items-center justify-center gap-2 py-20 text-xs text-[#8f959e]">
              <Loader2 size={15} className="animate-spin text-[#3370ff]" /> 载入对话记录…
            </div>
          ) : isEmpty ? (
            <div className="mx-auto max-w-[700px] space-y-5 pt-4 pb-3 sm:pt-8">
              <section className="card-tactile overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-[8px] border border-[#dbeafe] bg-[#eff6ff] text-[#3370ff]">
                    <Sparkles size={17} />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-[20px] leading-tight font-semibold text-[#1f2329]">
                      {isExampleLin ? scenarios?.default_space.persona ?? "林远 · 产品负责人" : spaceDisplayName(activeSpace)}
                    </h2>
                    <p className="mt-1 text-xs text-[#646a73]">个人记忆工作区</p>
                  </div>
                </div>
                <dl className="grid grid-cols-3 divide-x divide-[#eceef2] border-t border-[#eceef2] bg-[#fcfcfd]">
                  {[
                    { value: sessions.filter((session) => session.status === "dreamed").length, label: "已入梦对话" },
                    { value: overview?.space.page_count ?? 0, label: "记忆页" },
                    { value: overview?.stats.fact_count ?? 0, label: "已沉淀事实" },
                  ].map(({ value, label }) => (
                    <div className="flex flex-col-reverse px-3 py-2.5 sm:px-5" key={label}>
                      <dt className="text-xs text-[#646a73]">{label}</dt>
                      <dd className="font-mono-num text-[17px] font-semibold">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section aria-label="示例提问">
                <h3 className="mb-2 text-xs font-semibold text-[#646a73]">从一个问题开始</h3>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {isExampleLin ? scenarios?.prompts.map((prompt) => (
                    <button key={prompt.id} type="button" disabled={sendingMessage}
                      onClick={() => void sendChatMessage(prompt.query)}
                      className="group card-tactile px-3.5 py-3 text-left hover:border-[#b9d4ff] hover:bg-[#fcfdff]">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`status-chip ${PROMPT_TONES[prompt.id] ?? "tone-blue"}`}>{prompt.badge}</span>
                        <ArrowUpRight size={14} className="text-[#646a73] group-hover:text-[#3370ff]" />
                      </div>
                      <div className="mt-2 text-[13.5px] font-medium leading-snug">{prompt.title}</div>
                      <div className="mt-1 text-[11.5px] text-[#646a73]">{prompt.description}</div>
                    </button>
                  )) : BLANK_STARTER_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" disabled={!activeSpace || sendingMessage}
                      onClick={() => void sendChatMessage(prompt)}
                      className="card-tactile px-3.5 py-3 text-left text-[13px] leading-relaxed text-[#4e5969] hover:border-[#b9d4ff]">
                      {prompt}
                    </button>
                  ))}
                </div>
              </section>
            </div>
          ) : (
            /* Message Stream */
            <div className="space-y-5 pb-4">
              {messages.map((msg) => {
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
                const rememberedReply = (
                  <>
                    <MemoryRecallBadge message={msg} onInspectDetail={() => focusRecall(msg)} onChatSource={inspectChatTurn} />
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
                          version: dreamedVersion || msg.retrieval?.snapshot_version || activeSpace.current_version || undefined,
                        });
                      }}
                    />
                  </>
                );

                if (msg.baseline_reply) {
                  return (
                    <div key={msg.id} className="grid gap-4 @3xl:grid-cols-2">
                      <div className="rounded-[12px] border border-[#e5e7eb] bg-[#f8f9fb] p-5">
                        <div className="mb-3 flex items-center justify-between border-b border-[#eceef2] pb-2.5 text-xs">
                          <span className="inline-flex items-center gap-1.5 font-medium text-[#646a73]">
                            <Bot size={14} /> 无记忆对照组
                          </span>
                          <span className="rounded-full bg-[#eff1f5] px-2 py-0.5 text-[10.5px] text-[#8f959e]">零背景</span>
                        </div>
                        <RichMarkdown markdown={msg.baseline_reply} onSource={() => {}} className="text-[#4e5969]" />
                      </div>

                      <div className="card-tactile border-[#cddfff]/80 p-5">
                        <div className="mb-3 flex items-center justify-between border-b border-[#f0f2f5] pb-2.5 text-xs">
                          <span className="inline-flex items-center gap-1.5 font-semibold text-[#245bdb]">
                            <Sparkles size={14} className="text-[#3370ff]" /> Replica · 个人记忆回复
                          </span>
                          {msg.latency_ms ? (
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
                      {msg.tokens ? (
                        <div className="mt-2.5 font-mono-num text-[10.5px] text-[#a0a6b1]">
                          {formatNumber(msg.tokens)} tokens{msg.latency_ms ? ` · ${(msg.latency_ms / 1000).toFixed(1)}s` : ""}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}

              {sendingMessage ? (
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
          <div className="card-floating flex items-end gap-2.5 px-4 py-2.5 transition-all focus-within:border-[#3370ff] focus-within:ring-2 focus-within:ring-[#3370ff]/12">
            <textarea
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!activeSpace || sendingMessage || loadingMessages}
              aria-label="聊天消息"
              placeholder="和 Replica 聊点什么…（Enter 发送，Shift+Enter 换行）"
              className="max-h-36 min-h-[28px] flex-1 resize-none border-0 bg-transparent py-1 text-[14px] leading-relaxed text-[#1f2329] placeholder:text-[#9ea4ae] focus:outline-none"
            />
            <button
              type="submit"
              disabled={!activeSpace || !draft.trim() || sendingMessage || loadingMessages}
              aria-label="发送消息"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[#18181b] text-white shadow-xs transition-colors hover:bg-[#27272a] disabled:bg-[#e5e7eb] disabled:text-[#a0a6b1] disabled:shadow-none"
            >
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-2 text-[11px] text-[#8f959e]">
            {model ? (
              <span className="inline-flex items-center gap-1.5 text-[#646a73]">
                <LockKeyhole size={11} aria-hidden="true" /> 模型：{model.label}（{model.note}）
              </span>
            ) : <span />}
            {pendingCount > 0 ? (
              <button
                type="button"
                onClick={() => { setRightTab("dream"); setRightOpen(true); }}
                className="inline-flex items-center gap-1 font-medium text-[#6d28d9] hover:underline"
              >
                <Moon size={11} /> {pendingCount} 场对话待入梦
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}
