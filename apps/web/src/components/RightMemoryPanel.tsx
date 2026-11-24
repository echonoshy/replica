import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight, BookOpen, Calendar, CheckCircle2, ChevronDown, ChevronRight, FileText, GitPullRequestArrow,
  Hash, Layers, Loader2, MessageSquareQuote, Moon, Sparkles, X,
} from "lucide-react";
import type { SourceResult } from "@replica/shared";
import { api, buildDocLabelMap, conversationPreview, formatNumber, formatShortDate } from "../api";
import type { SessionTurnResult, SnapshotDiffResponse } from "../api";
import { CompileJobTracker } from "./CompileJobTracker";
import { ConflictCard } from "./ConflictCard";
import { RichMarkdown } from "./RichMarkdown";
import { useApp } from "../context/AppContext";
import type { SourceInspectTarget } from "../context/AppContext";

function renderTurnExcerpt(text: string) {
  const parts = text.split(/\n\n(?=\*\*(?:User|Assistant|System|Developer|Tool)\*\*)/);
  const looksLikeChat = parts.some((p) => /^\*\*(?:User|Assistant)\*\*/.test(p.trim()));
  if (!looksLikeChat) {
    return <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#1f2329]">{text}</p>;
  }
  return (
    <div className="space-y-2">
      {parts.map((part, idx) => {
        const match = part.trim().match(/^\*\*(User|Assistant|System|Developer|Tool)\*\*\s*\n+([\s\S]*)$/);
        if (!match) return <p key={idx} className="whitespace-pre-wrap text-xs text-[#4e5969]">{part}</p>;
        const isUser = match[1] === "User";
        return (
          <div
            key={idx}
            className={`rounded-[8px] px-3 py-2 text-[12.5px] leading-relaxed ${
              isUser
                ? "border border-[#d6e4ff] bg-[#eff6ff] text-[#1f2329]"
                : "border border-[#eceef2] bg-white text-[#4e5969]"
            }`}
          >
            <div className="mb-0.5 text-[10px] font-medium text-[#8f959e]">
              {isUser ? "用户原话" : "助理回复"}
            </div>
            <div className="whitespace-pre-wrap wrap-anywhere">{match[2].trim()}</div>
          </div>
        );
      })}
    </div>
  );
}

export function RightMemoryPanel() {
  const {
    activeSpace,
    activeSession,
    sessions,
    pendingCount,
    overview,
    rightTab,
    setRightTab,
    setRightOpen,
    openMemory,
    selectSession,
    focusedRetrieval,
    focusedConversationHits,
    inspectedSource,
    inspectSource,
    inspectChatTurn,
    dreamJobId,
    triggeringDream,
    dreamRunning,
    triggerDream,
    onDreamSettled,
  } = useApp();

  const [sourceResponse, setSourceResponse] = useState<{
    target: SourceInspectTarget;
    data?: SourceResult | SessionTurnResult;
    error?: string;
  } | null>(null);

  const [expandedSnap, setExpandedSnap] = useState<number | null>(null);
  const [diffError, setDiffError] = useState<{ version: number; message: string } | null>(null);
  const [snapDiffs, setSnapDiffs] = useState<Record<number, SnapshotDiffResponse>>({});

  const docLabelMap = useMemo(() => buildDocLabelMap(overview?.documents), [overview]);
  const currentSource = sourceResponse?.target === inspectedSource ? sourceResponse : null;
  const sourceData = currentSource?.data;
  const chatSource = sourceData && "session_id" in sourceData ? sourceData : null;
  const pendingSource = chatSource && chatSource.session_status !== "dreamed";

  useEffect(() => {
    if (!inspectedSource) return;
    let alive = true;
    async function readSource(target: SourceInspectTarget) {
      if (target.kind === "chat") return api.getSessionTurn(target.sessionId, target.locator);
      const [docId, locator] = target.anchor.split("#");
      return api.getSource(target.space, docId, locator, target.version);
    }
    void readSource(inspectedSource)
      .then((data) => { if (alive) setSourceResponse({ target: inspectedSource, data }); })
      .catch((err: Error) => { if (alive) setSourceResponse({ target: inspectedSource, error: err.message }); });
    return () => { alive = false; };
  }, [inspectedSource]);

  async function toggleJournalDiff(version: number) {
    if (expandedSnap === version) {
      setExpandedSnap(null);
      return;
    }
    setExpandedSnap(version);
    setDiffError(null);
    if (!activeSpace || snapDiffs[version]) return;
    try {
      const diff = await api.getDiff(activeSpace, { to: version });
      setSnapDiffs((prev) => ({ ...prev, [version]: diff }));
    } catch (err) {
      setDiffError({ version, message: (err as Error).message });
    }
  }

  const sessionExtracted = useMemo(() => {
    const docId = activeSession?.dreamed_doc_id;
    if (!docId || !overview) return { facts: [], events: [], conflicts: [] };
    return {
      facts: overview.claims.facts.filter((f) => f.docId === docId),
      events: overview.claims.events.filter((e) => e.docId === docId),
      conflicts: overview.conflicts.filter((c) => c.anchors.some((a) => a.startsWith(`${docId}#`))),
    };
  }, [activeSession?.dreamed_doc_id, overview]);

  const pendingSessions = useMemo(
    () => sessions.filter((s) => s.status === "pending" && s.message_count > s.dreamed_message_count),
    [sessions],
  );

  return (
    <aside className="memory-inspector flex h-full min-h-0 flex-col border-l border-[#eceef2] bg-[#fafbfd]" aria-label="记忆细节">
      <header className="flex h-[44px] shrink-0 items-center justify-between gap-2 border-b border-[#eceef2] px-3">
        <div className="recessed-track flex items-center gap-0.5 text-[11.5px] font-medium">
          <button
            type="button"
            aria-pressed={rightTab === "details"}
            onClick={() => setRightTab("details")}
            className={`rounded-[5px] px-3 py-1 transition-all ${
              rightTab === "details" ? "recessed-pill-active text-[#245bdb]" : "text-[#646a73] hover:text-[#1f2329]"
            }`}
          >
            本次引用
          </button>
          <button
            type="button"
            aria-pressed={rightTab === "source"}
            onClick={() => setRightTab("source")}
            className={`rounded-[5px] px-3 py-1 transition-all ${
              rightTab === "source" ? "recessed-pill-active text-[#047857]" : "text-[#646a73] hover:text-[#1f2329]"
            }`}
          >
            原话溯源
          </button>
          <button
            type="button"
            aria-pressed={rightTab === "dream"}
            onClick={() => setRightTab("dream")}
            className={`inline-flex items-center gap-1 rounded-[5px] px-3 py-1 transition-all ${
              rightTab === "dream" ? "recessed-pill-active text-[#6d28d9]" : "text-[#646a73] hover:text-[#1f2329]"
            }`}
          >
            <span>做梦整理</span>
            {pendingCount > 0 ? (
              <span className="status-chip tone-violet font-mono-num px-1 text-[10px]">{pendingCount}</span>
            ) : null}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setRightOpen(false)}
          aria-label="收起记忆细节面板"
          className="rounded-lg p-1.5 text-[#8f959e] transition-colors hover:bg-[#eef0f5] hover:text-[#1f2329]"
        >
          <X size={16} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* TAB 1: Current Chat Memory Details */}
        {rightTab === "details" ? (
          <>
            {focusedRetrieval ? (
              <section className="space-y-2.5">
                <div className="flex items-center justify-between text-xs font-semibold text-[#1f2329]">
                  <span className="inline-flex items-center gap-1.5">
                    <Layers size={14} className="text-[#3370ff]" />
                    通道 1 · 长期 Wiki 记忆
                  </span>
                  <span className="font-mono-num text-[11px] font-normal text-[#8f959e]">
                    {focusedRetrieval.usage.latency_ms}ms · {formatNumber(focusedRetrieval.usage.returned_tokens)} tok
                  </span>
                </div>
                {focusedRetrieval.contexts.length ? (
                  <div className="space-y-2.5">
                    {focusedRetrieval.contexts.map((ctx) => (
                      <div key={ctx.page_id} className="card-tactile p-3.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-[#245bdb]">
                            <BookOpen size={12} className="shrink-0" />
                            <span className="truncate">{ctx.title}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => openMemory(ctx.page_id)}
                            className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-[#646a73] transition-colors hover:text-[#245bdb]"
                          >
                            整页 <ArrowUpRight size={11} />
                          </button>
                        </div>
                        <p className="mt-1 text-[11.5px] leading-relaxed text-[#5c6370]">{ctx.relevance_reason}</p>
                        {ctx.content ? (
                          <div className="mt-2 rounded-[8px] border border-[#eef0f5] bg-[#f8f9fb] px-2.5 py-2">
                            <RichMarkdown
                              markdown={ctx.content}
                              docLabelMap={docLabelMap}
                              className="text-[12px] leading-[1.65]"
                              onSource={(anchor) =>
                                activeSpace &&
                                inspectSource({
                                  space: activeSpace,
                                  anchor,
                                  version: focusedRetrieval.snapshot_version || undefined,
                                })
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[10px] border border-dashed border-[#dde0e7] bg-white p-4 text-xs text-[#8f959e]">
                    本次回复未命中需召回的记忆页。
                  </div>
                )}
              </section>
            ) : null}

            {focusedConversationHits.length ? (
              <section className="space-y-2.5">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold">
                  <MessageSquareQuote size={14} className="text-[#6d28d9]" aria-hidden="true" />
                  通道 2 · 历史原话直搜
                </h3>
                {focusedConversationHits.map((hit) => {
                  const dreamed = hit.session_status === "dreamed";
                  return (
                    <div key={`${hit.session_id}#${hit.turn_locator}`} className="card-tactile space-y-2 p-3.5 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 font-semibold text-[#1f2329]">{hit.session_title}</span>
                        <span className={`status-chip shrink-0 ${dreamed ? "tone-mint" : "tone-violet"}`}>
                          {dreamed ? "已入梦" : "待入梦"}
                        </span>
                      </div>
                      <div className="font-mono-num text-[10.5px] text-[#646a73]">{hit.session_date} · #{hit.turn_locator}</div>
                      <p className="line-clamp-3 wrap-anywhere leading-relaxed text-[#4e5969]">{conversationPreview(hit.excerpt)}</p>
                      {hit.matched_terms.length ? (
                        <p className="wrap-anywhere text-[11px] text-[#646a73]">命中词 · {hit.matched_terms.join("、")}</p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" className={`source-pill ${dreamed ? "" : "source-pill-chat"}`}
                          onClick={() => inspectChatTurn(hit.session_id, hit.turn_locator)}>↗ 查看原话</button>
                        <button type="button" className="control" onClick={() => selectSession(hit.session_id)}>
                          打开会话
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ) : null}

            {activeSession ? (
              <section className="space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-[#1f2329]">
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles size={14} className="text-[#3370ff]" />
                    本场对话的记忆沉淀细节
                  </span>
                  <span className="font-mono-num text-[11px] font-normal text-[#8f959e]">
                    {activeSession.session_date}
                  </span>
                </div>

                {activeSession.status === "pending" && activeSession.message_count > activeSession.dreamed_message_count ? (
                  <div className="rounded-[10px] border border-[#ede9fe] bg-[#f5f3ff] p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#6d28d9]">
                      <Moon size={14} className="text-[#6b5ce7]" /> 待入梦整理（共 {activeSession.message_count} 条消息）
                    </div>
                    <p className="text-xs leading-relaxed text-[#524c78]">
                      为保证聊天轻快且避免碎片噪音，这场对话目前暂存在「待整理队列」。发起离线做梦后，Replica 会统一提炼事实、消解冲突并发布新快照。
                    </p>
                    <button
                      type="button"
                      disabled={triggeringDream || dreamRunning}
                      onClick={() => void triggerDream(false)}
                      className="control control-dark w-full"
                    >
                      <Moon size={13} />
                      {triggeringDream ? "正在启动做梦…" : `立即做梦整理（共 ${pendingCount} 场待入梦）`}
                    </button>
                  </div>
                ) : activeSession.status === "dreamed" ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between rounded-[10px] border border-[#d1fae5] bg-[#ecfdf5] px-3.5 py-2.5 text-xs text-[#047857]">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <CheckCircle2 size={14} /> 已沉淀进记忆快照 v{activeSession.dreamed_version}
                      </span>
                      <span className="font-mono-num text-[11px]">
                        {sessionExtracted.facts.length} 事实 · {sessionExtracted.events.length} 事件
                      </span>
                    </div>

                    {sessionExtracted.conflicts.length > 0 ? (
                      <div className="space-y-2.5">
                        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#b45309]">
                          <GitPullRequestArrow size={13} /> 本场触发的偏好/排期覆盖（{sessionExtracted.conflicts.length}）
                        </div>
                        {sessionExtracted.conflicts.map((c, idx) => (
                          <ConflictCard
                            key={idx}
                            item={c}
                            docLabelMap={docLabelMap}
                            compact
                            onSource={(anchor) =>
                              activeSpace &&
                              inspectSource({ space: activeSpace, anchor, version: activeSpace.current_version || undefined })
                            }
                          />
                        ))}
                      </div>
                    ) : null}

                    {sessionExtracted.facts.length > 0 ? (
                      <div className="space-y-2">
                        <div className="text-[11.5px] font-semibold text-[#5c6370]">提炼的记忆条目</div>
                        {sessionExtracted.facts.map((fact, idx) => (
                          <div key={idx} className="card-tactile p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-[#1f2329]">
                                {fact.subject} · <span className="font-normal text-[#646a73]">{fact.predicate}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  activeSpace &&
                                  inspectSource({
                                    space: activeSpace,
                                    anchor: `${fact.docId}#${fact.locator}`,
                                    version: activeSpace.current_version || undefined,
                                  })
                                }
                                className="source-pill"
                              >
                                #{fact.locator}
                              </button>
                            </div>
                            <p className="mt-1 leading-relaxed text-[#4e5969]">{fact.value}</p>
                            {fact.revision?.explicit ? (
                              <span className="mt-1.5 inline-block rounded-full bg-[#fff6e8] px-2 py-0.5 text-[10px] font-medium text-[#b45309]">
                                显式修订旧值
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {sessionExtracted.events.length > 0 ? (
                      <div className="space-y-2">
                        <div className="text-[11.5px] font-semibold text-[#5c6370]">沉淀的时间线节点</div>
                        {sessionExtracted.events.map((ev, idx) => (
                          <div key={idx} className="card-tactile p-3 text-xs">
                            <div className="flex items-center justify-between">
                              <span className="font-mono-num font-medium text-[#3370ff]">{ev.date}</span>
                              <span className="font-mono-num text-[10px] text-[#8f959e]">#{ev.locator}</span>
                            </div>
                            <p className="mt-1 text-[#4e5969]">{ev.text}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : (
              <div className="card-tactile p-6 text-center space-y-2">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#eff6ff] text-[#3370ff]">
                  <Sparkles size={18} />
                </span>
                <div className="text-xs font-semibold text-[#1f2329]">本场暂无记忆记录</div>
                <p className="text-[11.5px] leading-relaxed text-[#646a73]">
                  发送消息或点击左侧任意历史会话，这里会展示唤醒的记忆页、提炼出的结构化事实以及偏好修订记录。
                </p>
              </div>
            )}
          </>
        ) : null}

        {/* TAB 2: Exact Source Provenance */}
        {rightTab === "source" ? (
          inspectedSource ? (
            !currentSource ? (
              <div className="flex flex-col items-center gap-2 py-12 text-xs text-[#8f959e]">
                <Loader2 size={18} className="animate-spin text-[#3370ff]" />
                <span>正在定位原始聊天锚点…</span>
              </div>
            ) : currentSource.error ? (
              <div className="rounded-[10px] border border-[#fee2e2] bg-[#fef2f2] p-4 text-xs text-[#dc2626]">
                {currentSource.error}
              </div>
            ) : sourceData ? (
              <div className="space-y-4">
                <div className="card-tactile p-3.5 space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <FileText size={13} className="text-[#3370ff]" />
                    <span className="text-[#8f959e]">来源记录</span>
                    <span className="ml-auto min-w-0 truncate font-medium text-[#1f2329]"
                      title={"filename" in sourceData ? sourceData.filename : sourceData.session_title}>
                      {"filename" in sourceData ? sourceData.filename : sourceData.session_title}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar size={13} className="text-[#3370ff]" />
                    <span className="text-[#8f959e]">对话日期</span>
                    <span className="ml-auto font-mono-num font-medium">
                      {"doc_date" in sourceData ? sourceData.doc_date : sourceData.session_date}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Hash size={13} className="text-[#0f9d6e]" />
                    <span className="text-[#8f959e]">锚点定位</span>
                    <span className="ml-auto font-mono-num font-semibold text-[#047857]">
                      #{sourceData.locator}
                    </span>
                  </div>
                  {chatSource ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#eceef2] pt-2">
                      <span className={`status-chip ${pendingSource ? "tone-violet" : "tone-mint"}`}>
                        {pendingSource ? "待入梦 · 原文直搜" : "已入梦"}
                      </span>
                      <button type="button" className="control" onClick={() => selectSession(chatSource.session_id)}>
                        打开原对话
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2.5">
                  {sourceData.previous ? (
                    <div className="rounded-[10px] border border-dashed border-[#dde0e7] bg-white/70 p-3 opacity-75">
                      <div className="mb-1 text-[11px] font-medium text-[#646a73]">上文语境</div>
                      {renderTurnExcerpt(sourceData.previous)}
                    </div>
                  ) : null}

                  <div className={`rounded-[10px] border-2 p-3.5 ${pendingSource
                    ? "border-[#ddd6fe] bg-[#f5f3ff]" : "border-[#0f9d6e]/35 bg-[#ecfdf5]"}`}>
                    <div className="mb-2 flex items-center justify-between">
                      <span className={`status-chip ${pendingSource ? "tone-violet" : "tone-mint"} font-mono-num`}>
                        命中原话 · #{sourceData.locator}
                      </span>
                      <span className={`font-mono-num text-[10px] ${pendingSource ? "text-[#6d28d9]" : "text-[#047857]"}`}>逐字溯源</span>
                    </div>
                    {renderTurnExcerpt(sourceData.raw_excerpt || "")}
                  </div>

                  {sourceData.next ? (
                    <div className="rounded-[10px] border border-dashed border-[#dde0e7] bg-white/70 p-3 opacity-75">
                      <div className="mb-1 text-[11px] font-medium text-[#646a73]">下文语境</div>
                      {renderTurnExcerpt(sourceData.next)}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null
          ) : (
            <div className="card-tactile p-6 text-center space-y-2">
              <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#ecfdf5] text-[#0f9d6e]">
                <MessageSquareQuote size={18} />
              </span>
              <div className="text-xs font-semibold text-[#1f2329]">从记忆引用查看原话</div>
              <p className="text-[11.5px] leading-relaxed text-[#646a73]">
                选择回复或 Wiki 中的引用，或点开历史对话搜索结果，即可查看原话和上下文。
              </p>
            </div>
          )
        ) : null}

        {/* TAB 3: Manual Dreaming Queue & Dream Journal */}
          <div className="space-y-5" hidden={rightTab !== "dream"}>
            <section className="card-tactile p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[#1f2329]">
                  <Moon size={14} className="text-[#6b5ce7]" />
                  <span>待入梦队列</span>
                </div>
                <span className={`rounded-full px-2.5 py-0.5 font-mono-num text-[10.5px] font-medium ${
                  pendingSessions.length ? "bg-[#f5f3ff] text-[#6d28d9]" : "bg-[#ecfdf5] text-[#047857]"
                }`}>
                  {pendingSessions.length} 场待入梦
                </span>
              </div>

              {pendingSessions.length > 0 ? (
                <div className="space-y-1.5">
                  {pendingSessions.map((s) => (
                    <button key={s.session_id} type="button" onClick={() => selectSession(s.session_id)} title={s.title}
                      className="nav-row bg-[#f7f8f9]">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">{s.title}</span>
                      <span className="shrink-0 font-mono-num text-[10.5px] text-[#8f959e]">
                        {s.message_count - s.dreamed_message_count} 条新消息
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[#646a73]">
                  {dreamRunning ? "正在整理本批对话…" : "当前没有待入梦对话。"}
                </p>
              )}

              <div className="pt-1">
                {pendingSessions.length > 0 ? (
                  <button
                    type="button"
                    disabled={triggeringDream || dreamRunning}
                    onClick={() => void triggerDream(false)}
                    className="control control-dark w-full"
                  >
                    <Moon size={14} />
                    {dreamRunning ? "做梦整理中…" : triggeringDream ? "正在启动…" : "开始做梦整理"}
                  </button>
                ) : activeSpace?.current_version && !dreamRunning ? (
                  <button
                    type="button"
                    disabled={triggeringDream || dreamRunning}
                    onClick={() => void triggerDream(true)}
                    className="control control-dark w-full"
                  >
                    <Sparkles size={13} />
                    {triggeringDream ? "启动中…" : "深度做梦压缩"}
                  </button>
                ) : null}
              </div>
            </section>

            {dreamJobId ? (
              <CompileJobTracker
                key={dreamJobId}
                jobId={dreamJobId}
                onSettled={onDreamSettled}
                compact
              />
            ) : null}

            <section className="space-y-2.5">
              <div className="text-xs font-semibold text-[#5c6370]">梦境整理日志</div>
              {overview?.snapshots.length ? (
                <div className="space-y-2">
                  {overview.snapshots.map((snap) => {
                    const isOpen = expandedSnap === snap.version;
                    const diff = snapDiffs[snap.version];
                    const matchingJob = overview.jobs.find((j) => j.job_id === snap.job_id);
                    return (
                      <div key={snap.version} className="card-tactile overflow-hidden">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => void toggleJournalDiff(snap.version)}
                          className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left transition-colors hover:bg-[#f8f9fb]"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="rounded-md bg-[#eff6ff] px-1.5 py-0.5 font-mono-num text-[11px] font-semibold text-[#245bdb]">
                                v{snap.version}
                              </span>
                              <span className="text-[12px] font-medium text-[#1f2329]">
                                {matchingJob?.job_type === "dream" ? "深度整理压缩" : "消化新对话"}
                              </span>
                              <span className="font-mono-num text-[10.5px] text-[#8f959e]">
                                {formatShortDate(snap.created_at)}
                              </span>
                            </div>
                            <div className="mt-1 font-mono-num text-[10.5px] text-[#8f959e]">
                              {snap.document_count} 语料 · {snap.page_count} 页
                              {matchingJob ? ` · ${(matchingJob.usage.latency_ms / 1000).toFixed(1)}s` : ""}
                            </div>
                          </div>
                          {isOpen ? <ChevronDown size={14} className="text-[#8f959e]" /> : <ChevronRight size={14} className="text-[#8f959e]" />}
                        </button>

                        {isOpen ? (
                          <div className="border-t border-[#f0f2f5] bg-[#f8f9fb] p-3 text-xs space-y-2">
                            {diffError?.version === snap.version ? (
                              <p role="alert" className="text-[#dc2626]">{diffError.message}</p>
                            ) : !diff ? (
                              <span className="text-[#8f959e]">加载整理变化中…</span>
                            ) : (
                              <>
                                <div className="flex flex-wrap gap-2.5 font-mono-num text-[11px]">
                                  <span className="text-[#047857]">+{diff.summary.added_pages} 新页</span>
                                  <span className="text-[#245bdb]">~{diff.summary.updated_pages} 更新页</span>
                                  <span className="text-[#b45309]">+{diff.summary.new_conflicts} 冲突覆盖</span>
                                </div>
                                {diff.pages.map((page) => (
                                  <details key={page.path} className="rounded-[8px] border border-[#eceef2] bg-white px-2.5 py-1.5">
                                    <summary className="font-medium text-[#1f2329]">
                                      {page.title}
                                      <span className="ml-1.5 font-mono-num text-[10.5px] text-[#646a73]">
                                        +{page.added_lines.length} / −{page.removed_lines.length}
                                      </span>
                                    </summary>
                                    <ul className="mt-1 space-y-1 break-words border-t border-[#eceef2] pt-1.5">
                                      {page.added_lines.map((line) => <li key={line} className="text-[#047857]">+ {line}</li>)}
                                      {page.removed_lines.map((line) => <li key={line} className="text-[#dc2626]">− {line}</li>)}
                                    </ul>
                                  </details>
                                ))}
                              </>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="card-tactile p-5 text-center text-xs text-[#8f959e]">
                  还没有做梦记录。聊几句后点击上方「开始做梦整理」生成你的 v1 记忆。
                </div>
              )}
            </section>
          </div>
      </div>
    </aside>
  );
}
