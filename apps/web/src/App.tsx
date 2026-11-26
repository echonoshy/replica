import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  Bell, BookOpen, Check, ChevronDown, ChevronRight, Columns2, ExternalLink, Menu, MessageSquare, Moon,
  PanelLeftClose, PanelRight, Plus, Search, Settings, Sparkles, Trash2, X,
} from "lucide-react";
import { api, conversationPreview, isAwaitingNudgeReply, spaceDisplayName, spaceKeyOf } from "./api";
import type { ChatSession, ConversationSearchHit } from "./api";
import { SHOWCASE_SPACES } from "./demoTestCases";
import { AppProvider, useApp } from "./context/AppContext";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { MemoryLibraryView } from "./components/MemoryLibraryView";
import { ProactiveInboxView } from "./components/ProactiveInboxView";
import { RightMemoryPanel } from "./components/RightMemoryPanel";
import { SpaceSwitcherModal } from "./components/SpaceSwitcherModal";

const WIKI_LABELS: Record<string, string> = {
  "_index.md": "总览目录",
  "timeline.md": "关键时间线",
  "conflicts.md": "冲突与修订审计",
};

const LEFT_DEFAULT = 248;
const RIGHT_DEFAULT = 380;
const LEFT_STORAGE_KEY = "replica:left-width";
const RIGHT_STORAGE_KEY = "replica:right-width";

function readStoredWidth(key: string, fallback: number, min: number, max: number) {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw >= min && raw <= max) return raw;
  } catch { /* ignore storage errors */ }
  return fallback;
}

function Sidebar({
  sessions, hasQuery, onClose, onSelect, onManage,
}: {
  sessions: ChatSession[];
  hasQuery: boolean;
  onClose: () => void;
  onSelect: () => void;
  onManage: () => void;
}) {
  const app = useApp();
  const version = app.overview?.space ?? app.activeSpace;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const switcher = useRef<HTMLDivElement>(null);
  const switcherButton = useRef<HTMLButtonElement>(null);
  const activeName = spaceDisplayName(app.activeSpace);
  useEffect(() => {
    if (!switcherOpen) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !switcher.current?.contains(event.target)) setSwitcherOpen(false);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [switcherOpen]);

  const quickSpaces = SHOWCASE_SPACES
    .map((meta) => {
      const space = app.spaces.find((s) => spaceKeyOf(s) === meta.key);
      return space ? { space, meta } : null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const awaitingNudgeReplies = sessions.filter(isAwaitingNudgeReply);
  const groups = [
    ...(awaitingNudgeReplies.length ? [{ label: "来自轻提醒", dreamed: false, sessions: awaitingNudgeReplies }] : []),
    { label: "待入梦", dreamed: false, sessions: sessions.filter((s) => s.status !== "dreamed" && !isAwaitingNudgeReply(s)) },
    { label: "已沉淀", dreamed: true, sessions: sessions.filter((s) => s.status === "dreamed") },
  ];

  return (
    <aside className="workspace-sidebar" aria-label="工作区导航">
      <div className="flex h-12 shrink-0 items-center justify-between px-1">
        <div ref={switcher} className="workspace-switcher"
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSwitcherOpen(false); }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && switcherOpen) {
              event.stopPropagation();
              setSwitcherOpen(false);
              switcherButton.current?.focus();
            }
          }}>
          <button ref={switcherButton} type="button" className="switcher-trigger" aria-expanded={switcherOpen}
            title={activeName} aria-label={`切换空间：${activeName}`} onClick={() => setSwitcherOpen(!switcherOpen)}>
            <span className="brand-mark shrink-0" aria-hidden="true"><Sparkles size={14} /></span>
            <span className="truncate font-semibold">{activeName}</span>
            {version && <span className="switcher-version">v{version.current_version}</span>}
            <ChevronDown size={12} className="shrink-0 text-[var(--ink-muted)]" />
          </button>
          {switcherOpen && (
            <div className="space-dropdown" role="group" aria-label="切换空间">
              {quickSpaces.map(({ space, meta }) => {
                const selected = !!app.activeSpace && spaceKeyOf(app.activeSpace) === meta.key;
                return (
                  <button type="button" key={meta.key} className="space-option" aria-pressed={selected}
                    onClick={() => { setSwitcherOpen(false); app.selectSpace(meta.key); onSelect(); switcherButton.current?.focus(); }}>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{spaceDisplayName(space)}</span>
                      <span className="space-subtitle">{meta.subtitle}</span>
                    </span>
                    <span className="switcher-version">v{space.current_version}</span>
                    <span className="w-3.5 shrink-0">{selected && <Check size={14} />}</span>
                  </button>
                );
              })}
              <button type="button" className="manage-spaces" onClick={() => { setSwitcherOpen(false); onManage(); }}>
                <Settings size={14} /> 管理全部空间…
              </button>
            </div>
          )}
        </div>
        <button type="button" onClick={onClose} className="icon-button" aria-label="收起左侧导航" title="收起左侧导航">
          <PanelLeftClose size={14} />
        </button>
      </div>

      <button type="button" className="control sidebar-create" onClick={() => { app.startNewChat(); onSelect(); }}>
        <Plus size={14} /> 新对话
      </button>

      <nav className="mt-3 space-y-0.5" aria-label="记忆工作区">
        <button type="button" className="nav-row" aria-current={app.centerMode === "chat" ? "page" : undefined}
          onClick={() => { app.setCenterMode("chat"); onSelect(); }}>
          <MessageSquare size={14} /> 对话
        </button>
        <button type="button" className="nav-row" aria-current={app.centerMode === "memory" ? "page" : undefined}
          onClick={() => { app.openMemory(); onSelect(); }}>
          <BookOpen size={14} /> <span className="flex-1">记忆库</span>
          {version && version.current_version > 0 && <span className="mono-meta">{version.page_count} 页</span>}
        </button>
        <button type="button" className="nav-row" disabled={!app.proactiveAvailable} aria-current={app.centerMode === "inbox" ? "page" : undefined}
          onClick={() => { app.openInbox(); onSelect(); }}>
          <Bell size={14} /> <span className="flex-1">轻提醒</span>
          {app.pendingNudges.length > 0 && <span className="nudge-count">{app.pendingNudges.length}</span>}
        </button>
      </nav>

      <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto border-t border-[#eceef2] py-3">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <button type="button" className="history-heading" aria-expanded={!collapsedGroups[group.label]}
              onClick={() => setCollapsedGroups(prev => ({ ...prev, [group.label]: !prev[group.label] }))}>
              {collapsedGroups[group.label] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              {group.label}<span className="ml-auto font-mono-num">{group.sessions.length}</span>
            </button>
            {!collapsedGroups[group.label] && group.sessions.map((session) => {
              const current = app.centerMode === "chat" && app.activeSessionId === session.session_id;
              return (
                <div key={session.session_id} className={`thread-row ${current ? "thread-current" : ""}`}>
                  <button type="button" title={session.title} aria-current={current ? "page" : undefined}
                    onClick={() => { app.selectSession(session.session_id); onSelect(); }}>
                    {!group.dreamed && <span className="history-dot" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                    <time className="mono-meta" dateTime={session.session_date}>{session.session_date.slice(5, 10)}</time>
                  </button>
                  <button type="button" className="thread-delete icon-button" aria-label={`删除对话：${session.title}`}
                    onClick={() => void app.deleteSession(session.session_id)}><Trash2 size={13} /></button>
                </div>
              );
            })}
          </section>
        ))}
        {sessions.length === 0 ? <p className="px-2 text-xs text-[#646a73]">{hasQuery ? "暂无匹配对话" : "暂无对话"}</p> : null}
      </div>

      <footer className="sidebar-footer">
        <button type="button" onClick={onManage}><Settings size={14} /> 空间管理</button>
        <a href="/docs" target="_blank" rel="noreferrer">API 文档 <ExternalLink size={12} /></a>
      </footer>
    </aside>
  );
}

function WorkspaceShell() {
  const app = useApp();
  const [spaceModalOpen, setSpaceModalOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftWidth, setLeftWidth] = useState(() => readStoredWidth(LEFT_STORAGE_KEY, LEFT_DEFAULT, 190, 380));
  const [rightWidth, setRightWidth] = useState(() => readStoredWidth(RIGHT_STORAGE_KEY, RIGHT_DEFAULT, 300, 580));
  const [draggingSide, setDraggingSide] = useState<"left" | "right" | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [rawSearch, setRawSearch] = useState<{ key: string; hits: ConversationSearchHit[]; failed?: boolean } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const swallowNextSlashRef = useRef(false);
  const spaceKey = app.activeSpace ? spaceKeyOf(app.activeSpace) : "";
  const term = query.trim().toLowerCase();
  const matchingSessions = app.sessions.filter((s) => [s.title, s.session_date, s.session_id].some((v) => v.toLowerCase().includes(term)));
  const wikiResults = term ? (app.overview?.files ?? [])
    .filter((path) => path.endsWith(".md"))
    .map((path) => ({
      path,
      title: WIKI_LABELS[path] ?? app.overview?.active_snapshot?.page_titles?.[path] ?? path,
    }))
    .filter(({ path, title }) => `${title} ${path}`.toLowerCase().includes(term)) : [];
  const showResults = searchOpen && Boolean(term);
  const namespace = app.activeSpace?.namespace;
  const spaceId = app.activeSpace?.space_id;
  const rawSearchKey = showResults && term.length >= 2 && spaceKey ? `${spaceKey}/${term}` : null;
  const rawResult = rawSearchKey && rawSearch?.key === rawSearchKey ? rawSearch : null;
  const rawHits = rawResult?.hits ?? [];

  function startResize(side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const initial = side === "left" ? leftWidth : rightWidth;
    setDraggingSide(side);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let latest = initial;

    const onMove = (e: PointerEvent) => {
      const delta = e.clientX - startX;
      const minCenter = 400;
      if (side === "left") {
        const rightReserved = app.rightOpen && window.innerWidth >= 1280 ? rightWidth : 0;
        const maxLeft = Math.max(190, Math.min(380, window.innerWidth - rightReserved - minCenter));
        latest = Math.round(Math.min(maxLeft, Math.max(190, initial + delta)));
        setLeftWidth(latest);
      } else {
        const leftReserved = !sidebarCollapsed && window.innerWidth >= 1024 ? leftWidth : 0;
        const maxRight = Math.max(300, Math.min(580, window.innerWidth - leftReserved - minCenter));
        latest = Math.round(Math.min(maxRight, Math.max(300, initial - delta)));
        setRightWidth(latest);
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setDraggingSide(null);
      try {
        localStorage.setItem(side === "left" ? LEFT_STORAGE_KEY : RIGHT_STORAGE_KEY, String(latest));
      } catch { /* ignore */ }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function resetWidth(side: "left" | "right") {
    if (side === "left") {
      setLeftWidth(LEFT_DEFAULT);
      try { localStorage.removeItem(LEFT_STORAGE_KEY); } catch { /* ignore */ }
    } else {
      setRightWidth(RIGHT_DEFAULT);
      try { localStorage.removeItem(RIGHT_STORAGE_KEY); } catch { /* ignore */ }
    }
  }

  useEffect(() => {
    if (!rawSearchKey || !namespace || !spaceId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.searchConversations({ namespace, space_id: spaceId }, term, 5)
        .then(({ hits }) => { if (active) setRawSearch({ key: rawSearchKey, hits }); })
        .catch(() => { if (active) setRawSearch({ key: rawSearchKey, hits: [], failed: true }); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [rawSearchKey, namespace, spaceId, term]);

  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
  }

  function jump(open: () => void) {
    open();
    closeSearch();
    searchInput.current?.blur();
  }

  function jumpToTurn(hit: ConversationSearchHit) {
    jump(() => {
      app.selectSession(hit.session_id);
      app.inspectChatTurn(hit.session_id, hit.turn_locator);
    });
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (event.isComposing || spaceModalOpen) return;
        setSearchOpen(false);
        setQuery("");
        setMobileMenuOpen(false);
        return;
      }
      if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || spaceModalOpen) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      event.stopPropagation();
      swallowNextSlashRef.current = true;
      searchInput.current?.focus();
      setSearchOpen(true);
      window.setTimeout(() => { swallowNextSlashRef.current = false; }, 120);
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [spaceModalOpen]);

  const stats = app.overview?.stats;
  const version = app.overview?.space.current_version ?? app.activeSpace?.current_version ?? 0;

  return (
    <div
      className="workspace-shell"
      style={{ "--sidebar-width": `${leftWidth}px`, "--inspector-width": `${rightWidth}px` } as CSSProperties}
    >
      {mobileMenuOpen ? <button type="button" className="drawer-backdrop lg:hidden" aria-label="关闭对话菜单" onClick={() => setMobileMenuOpen(false)} /> : null}
      <div className={`sidebar-frame ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileMenuOpen ? "sidebar-mobile-open" : ""}`}>
        <Sidebar sessions={matchingSessions} hasQuery={Boolean(term)}
          onClose={() => { setMobileMenuOpen(false); if (window.matchMedia("(min-width: 1024px)").matches) setSidebarCollapsed(true); }}
          onSelect={() => setMobileMenuOpen(false)}
          onManage={() => { setMobileMenuOpen(false); setSpaceModalOpen(true); }} />
      </div>

      {!sidebarCollapsed ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左侧边栏宽度（双击恢复默认）"
          title="拖拽调整左栏宽度，双击恢复默认"
          data-dragging={draggingSide === "left" || undefined}
          onPointerDown={(e) => startResize("left", e)}
          onDoubleClick={() => resetWidth("left")}
          className="pane-resizer pane-resizer-left"
        />
      ) : null}

      <main className="workspace-sheet">
        <header className="utility-bar">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" className={`icon-button ${sidebarCollapsed ? "" : "lg:hidden"}`} aria-label="打开左侧导航"
              onClick={() => { setSidebarCollapsed(false); if (!window.matchMedia("(min-width: 1024px)").matches) setMobileMenuOpen(true); }}>
              <Menu size={16} />
            </button>

            <h1 className="truncate text-[14px] font-semibold" title={app.centerMode === "chat" ? app.activeSession?.title : undefined}>
              {app.centerMode === "chat" ? app.activeSession?.title ?? "新对话" : app.centerMode === "memory" ? "记忆库" : "轻提醒"}
            </h1>
            {app.centerMode === "memory" && <span className="mono-meta hidden md:inline">v{version} · {stats?.fact_count ?? 0} 条事实</span>}
          </div>

          <div className="utility-actions">
            <div className="workspace-search" onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false);
            }}>
              <div className="search-field" role="search">
                <Search size={13} aria-hidden="true" />
                <input ref={searchInput} value={query} type="search" aria-label="搜索对话、记忆或原话"
                  placeholder="搜索对话、记忆或原话…" autoComplete="off"
                  onFocus={() => setSearchOpen(true)}
                  onBeforeInput={(event) => {
                    const data = (event.nativeEvent as InputEvent).data;
                    if (swallowNextSlashRef.current && data === "/") {
                      event.preventDefault();
                      swallowNextSlashRef.current = false;
                    }
                  }}
                  onChange={(event) => {
                    let next = event.target.value;
                    if (swallowNextSlashRef.current && next.startsWith("/") && !query.startsWith("/")) {
                      next = next.slice(1);
                      swallowNextSlashRef.current = false;
                    }
                    setQuery(next);
                    setSearchOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !showResults || event.nativeEvent.isComposing) return;
                    if (matchingSessions[0]) jump(() => app.selectSession(matchingSessions[0].session_id));
                    else if (wikiResults[0]) jump(() => app.openMemory(wikiResults[0].path));
                    else if (rawHits[0]) jumpToTurn(rawHits[0]);
                  }}
                />
                {query ? (
                  <button type="button" className="icon-button search-clear" aria-label="清除搜索"
                    onClick={() => { closeSearch(); searchInput.current?.focus(); }}><X size={12} /></button>
                ) : <kbd className="search-shortcut" aria-hidden="true">/</kbd>}
              </div>
              {showResults ? (
                <div className="search-results" aria-label="搜索结果">
                  {matchingSessions.length > 0 ? <div className="group-label">对话</div> : null}
                  {matchingSessions.map((session) => (
                    <button type="button" key={session.session_id} className="nav-row"
                      onClick={() => jump(() => app.selectSession(session.session_id))}>
                      <MessageSquare size={14} /><span className="min-w-0 flex-1 truncate">{session.title}</span>
                      <span className="mono-meta">{session.session_date}</span>
                    </button>
                  ))}
                  {wikiResults.length > 0 ? <div className="group-label">记忆页</div> : null}
                  {wikiResults.map((page) => (
                    <button type="button" key={page.path} className="nav-row" onClick={() => jump(() => app.openMemory(page.path))}>
                      <BookOpen size={14} /><span className="min-w-0 truncate">{page.title}</span>
                    </button>
                  ))}
                  {rawSearchKey ? (
                    <section aria-label="历史对话原话" aria-busy={!rawResult}>
                      <div className="group-label">历史对话原话</div>
                      {rawHits.map((hit) => {
                        const dreamed = hit.session_status === "dreamed";
                        return (
                          <button type="button" key={`${hit.session_id}#${hit.turn_locator}`}
                            className="nav-row raw-search-result" onClick={() => jumpToTurn(hit)}>
                            <span className={`status-dot ${dreamed ? "bg-[#059669]" : "bg-[#7c3aed]"}`} aria-hidden="true" />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate font-medium">{hit.session_title}</span>
                                <span className="mono-meta shrink-0">{dreamed ? "已入梦" : "待入梦"} · #{hit.turn_locator}</span>
                              </span>
                              <span className="mt-0.5 block truncate text-[11.5px] text-[#646a73]">{conversationPreview(hit.excerpt)}</span>
                            </span>
                          </button>
                        );
                      })}
                      {!rawHits.length ? (
                        <p className="px-2 py-1.5 text-xs text-[#646a73]" role="status">
                          {!rawResult ? "正在搜索原话…" : rawResult.failed ? "原话搜索暂不可用" : "没有找到匹配的原话"}
                        </p>
                      ) : null}
                    </section>
                  ) : !matchingSessions.length && !wikiResults.length ? (
                    <p className="px-2 py-1.5 text-xs text-[#646a73]" role="status">没有找到匹配的对话或记忆页</p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {app.centerMode === "chat" ? (
              <button type="button" className="control" aria-pressed={app.compareBaseline} aria-label="对比无记忆"
                title="开启后同屏对比「无记忆普通 AI」与「Replica 记忆增强」的回答差异"
                onClick={() => app.setCompareBaseline(!app.compareBaseline)}>
                <Columns2 size={13} /><span className="hidden sm:inline">对比无记忆</span>
              </button>
            ) : null}

            <button type="button" className={app.pendingCount > 0 ? "control control-primary" : "control"}
              disabled={app.triggeringDream || app.dreamRunning || (!app.pendingCount && !version)}
              onClick={() => void app.triggerDream(app.pendingCount === 0)}>
              {app.pendingCount || app.dreamRunning || !version ? <Moon size={13} /> : <Sparkles size={13} />}
              <span>
                {app.dreamRunning ? "整理中…" : app.triggeringDream ? "启动中…" : app.pendingCount > 0 ? `整理记忆 (${app.pendingCount})` : "深度整理"}
              </span>
            </button>

            <button type="button" className="control" aria-pressed={app.rightOpen} aria-label="记忆透视" title="展开/收起右侧记忆透视面板"
              onClick={() => app.setRightOpen(!app.rightOpen)}>
              <PanelRight size={13} /><span className="hidden md:inline">记忆透视</span>
            </button>
          </div>
        </header>

        {app.error ? (
          <div role="alert" className="flex items-center justify-between gap-3 border-b border-[#fee2e2] bg-[#fef2f2] px-4 py-2 text-xs text-[#dc2626]">
            <span>{app.error}</span>
            <button type="button" onClick={app.clearError} className="icon-button" aria-label="关闭错误提示"><X size={14} /></button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {app.centerMode === "memory"
              ? <MemoryLibraryView key={`${spaceKey}:${app.memoryTarget.request}`} initialPath={app.memoryTarget.path} />
              : app.centerMode === "inbox"
                ? <ProactiveInboxView key={spaceKey} />
                : <ChatWorkspace key={spaceKey} />}
          </div>
          {app.rightOpen ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整右侧记忆面板宽度（双击恢复默认）"
              title="拖拽调整右栏宽度，双击恢复默认"
              data-dragging={draggingSide === "right" || undefined}
              onPointerDown={(e) => startResize("right", e)}
              onDoubleClick={() => resetWidth("right")}
              className="pane-resizer pane-resizer-right"
            />
          ) : null}
          <div className={`inspector-frame ${app.rightOpen ? "" : "inspector-hidden"}`}>
            {app.rightOpen ? <button type="button" className="drawer-backdrop xl:hidden" aria-label="关闭记忆透视"
              onClick={() => app.setRightOpen(false)} /> : null}
            <RightMemoryPanel key={spaceKey} />
          </div>
        </div>
      </main>

      {spaceModalOpen ? <SpaceSwitcherModal onClose={() => setSpaceModalOpen(false)} /> : null}
    </div>
  );
}

export function App() {
  return <AppProvider><WorkspaceShell /></AppProvider>;
}
