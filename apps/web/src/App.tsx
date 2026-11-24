import { useEffect, useRef, useState } from "react";
import {
  BookOpen, Columns2, ExternalLink, Flag, LockKeyhole, Menu, MessageSquare, Moon,
  PanelLeftClose, PanelRight, Plus, Search, Settings, Sparkles, Trash2, X,
} from "lucide-react";
import { api, conversationPreview, spaceKeyOf } from "./api";
import type { ChatSession, ConversationSearchHit } from "./api";
import { AppProvider, useApp } from "./context/AppContext";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { MemoryLibraryView } from "./components/MemoryLibraryView";
import { RightMemoryPanel } from "./components/RightMemoryPanel";
import { SpaceSwitcherModal } from "./components/SpaceSwitcherModal";

const WIKI_LABELS: Record<string, string> = {
  "_index.md": "总览目录",
  "timeline.md": "关键时间线",
  "conflicts.md": "冲突与修订审计",
};

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
  const linSpace = app.spaces.find((s) => spaceKeyOf(s) === "personal:lin_yuan");
  const blankSpace = app.spaces.find((s) => spaceKeyOf(s) === "personal:my_space");
  const groups = [
    { label: "待入梦整理", dreamed: false, sessions: sessions.filter((s) => s.status !== "dreamed") },
    { label: "已沉淀进记忆", dreamed: true, sessions: sessions.filter((s) => s.status === "dreamed") },
  ];

  return (
    <aside className="workspace-sidebar" aria-label="工作区导航">
      <div className="flex h-12 shrink-0 items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="brand-mark" aria-hidden="true"><Sparkles size={13} strokeWidth={2} /></span>
          <span className="text-sm font-semibold">Replica</span>
        </div>
        <button type="button" onClick={onClose} className="icon-button" aria-label="收起对话菜单">
          <PanelLeftClose size={14} />
        </button>
      </div>

      <button type="button" className="control sidebar-create" onClick={() => { app.startNewChat(); onSelect(); }}>
        <Plus size={14} /> 新建对话
      </button>

      <nav className="mt-3 space-y-0.5" aria-label="记忆工作区">
        <button type="button" className="nav-row" aria-current={app.centerMode === "memory" ? "page" : undefined}
          onClick={() => { app.openMemory(); onSelect(); }}>
          <BookOpen size={14} /> <span className="flex-1">我的记忆库</span>
          <span className="mono-meta">{version?.current_version ? `v${version.current_version} · ${version.page_count}页` : "空白"}</span>
        </button>
        <button type="button" className="nav-row" aria-pressed={app.rightOpen && app.rightTab === "dream"}
          onClick={() => { app.setRightTab("dream"); app.setRightOpen(true); onSelect(); }}>
          <Moon size={14} /> <span className="flex-1">做梦整理</span>
          {app.pendingCount > 0 ? <span className="status-chip tone-violet font-mono-num">{app.pendingCount}</span> : null}
        </button>
      </nav>

      <div className="mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto border-t border-[#eceef2] py-3">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <div className="group-label">
              <span>{group.label}</span><span className="font-mono-num">{group.sessions.length}</span>
            </div>
            {group.sessions.map((session) => {
              const current = app.centerMode === "chat" && app.activeSessionId === session.session_id;
              return (
                <div key={session.session_id} className={`thread-row ${current ? "thread-current" : ""}`}>
                  <button type="button" title={session.title} aria-current={current ? "page" : undefined}
                    onClick={() => { app.selectSession(session.session_id); onSelect(); }}>
                    <span className={`status-dot ${group.dreamed ? "bg-[#059669]" : "bg-[#7c3aed]"}`} />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px]">{session.title}</span>
                      <span className="mono-meta block">
                        {session.session_date}
                        {!group.dreamed ? ` · ${session.message_count} 条消息` : ""}
                      </span>
                    </span>
                  </button>
                  {group.dreamed ? <span className="thread-version status-chip tone-mint font-mono-num">v{session.dreamed_version}</span> : null}
                  <button type="button" className="thread-delete icon-button" aria-label={`删除对话：${session.title}`}
                    onClick={() => void app.deleteSession(session.session_id)}><Trash2 size={13} /></button>
                </div>
              );
            })}
          </section>
        ))}
        {sessions.length === 0 ? <p className="px-2 text-xs text-[#646a73]">{hasQuery ? "暂无匹配对话" : "暂无对话"}</p> : null}
      </div>

      <footer className="space-y-0.5 border-t border-[#eceef2] pt-2 pb-2">
        {linSpace && blankSpace ? (
          <div className="recessed-track mb-1.5 grid grid-cols-[1.25fr_1fr] text-[11.5px]" aria-label="切换工作区">
            {[{ space: linSpace, label: "林远 · 复杂样例" }, { space: blankSpace, label: "我的空间" }].map(({ space, label }) => {
              const selected = app.activeSpace?.namespace === space.namespace && app.activeSpace.space_id === space.space_id;
              return (
                <button key={space.space_id} type="button" aria-pressed={selected}
                  onClick={() => { app.selectSpace(spaceKeyOf(space)); onSelect(); }}
                  className={`rounded-[5px] px-1 py-1 ${selected ? "recessed-pill-active" : "text-[#646a73]"}`}>
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
        <button type="button" className="nav-row" onClick={onManage}><Settings size={14} /> 空间管理</button>
        <a href="/docs" target="_blank" rel="noreferrer" className="nav-row"><ExternalLink size={14} /> OpenAPI 文档</a>
      </footer>
    </aside>
  );
}

function WorkspaceShell() {
  const app = useApp();
  const [spaceModalOpen, setSpaceModalOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [spaceModalOpen]);

  const stats = app.overview?.stats;
  const version = app.overview?.space.current_version ?? app.activeSpace?.current_version ?? 0;
  const dreamedCount = app.sessions.filter((s) => s.status === "dreamed").length;
  const totalCount = app.sessions.filter((s) => s.message_count > 0).length;
  const showDream = () => { app.setRightTab("dream"); app.setRightOpen(true); };

  return (
    <div className="workspace-shell">
      {mobileMenuOpen ? <button type="button" className="drawer-backdrop lg:hidden" aria-label="关闭对话菜单" onClick={() => setMobileMenuOpen(false)} /> : null}
      <div className={`sidebar-frame ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileMenuOpen ? "sidebar-mobile-open" : ""}`}>
        <Sidebar sessions={matchingSessions} hasQuery={Boolean(term)}
          onClose={() => { setMobileMenuOpen(false); if (window.matchMedia("(min-width: 1024px)").matches) setSidebarCollapsed(true); }}
          onSelect={() => setMobileMenuOpen(false)}
          onManage={() => { setMobileMenuOpen(false); setSpaceModalOpen(true); }} />
      </div>

      <main className="workspace-sheet">
        <header className="utility-bar">
          <button type="button" className={`icon-button ${sidebarCollapsed ? "" : "lg:hidden"}`} aria-label="打开对话菜单"
            onClick={() => { setSidebarCollapsed(false); if (!window.matchMedia("(min-width: 1024px)").matches) setMobileMenuOpen(true); }}>
            <Menu size={16} />
          </button>

          <div className="workspace-search" onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false);
          }}>
            <div className="search-field" role="search">
              <Search size={14} aria-hidden="true" />
              <input ref={searchInput} value={query} type="search" aria-label="搜索对话与记忆"
                placeholder="搜索对话与记忆…" autoComplete="off"
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
                {wikiResults.length > 0 ? <div className="group-label">Wiki 页面</div> : null}
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

          <div className="utility-actions">
            {app.model ? (
              <span className="model-badge" title="当前后台模型已锁定，暂不支持切换">
                <LockKeyhole size={12} /><span className="truncate">{app.model.label}</span>
                <span className="model-note">{app.model.note}</span>
              </span>
            ) : null}
            <button type="button" className="control utility-create" onClick={() => { app.startNewChat(); closeSearch(); }} aria-label="新对话">
              <Plus size={14} /><span>新对话</span>
            </button>
            <span className="workspace-progress font-mono-num" title="记忆版本与已入梦对话数">
              <Flag size={12} /> {version ? `v${version} · ` : ""}{dreamedCount}/{totalCount} 已入梦
            </span>
          </div>
        </header>

        <div className="context-bar">
          <div className="context-status">
            <h1 title={app.activeSession?.title} className="context-title">
              {app.centerMode === "memory" ? "个人记忆库 · Wiki" : app.activeSession?.title ?? "新对话"}
            </h1>
            <div className="context-chips">
              <button type="button" className="status-chip tone-rose" onClick={() => app.openMemory("conflicts.md")}>{stats?.conflict_count ?? 0} 处冲突修订</button>
              <button type="button" className="status-chip tone-violet" onClick={showDream}>{app.pendingCount} 场待入梦</button>
              <button type="button" className="status-chip tone-mint" onClick={() => app.openMemory()}>{stats?.fact_count ?? 0} 条事实</button>
            </div>
          </div>
          <div className="context-actions">
            <button type="button" className="control" aria-pressed={app.compareBaseline} aria-label="对比无记忆" title="对比无记忆"
              onClick={() => app.setCompareBaseline(!app.compareBaseline)}><Columns2 size={13} /><span>对比无记忆</span></button>
            <button type="button" className="control" aria-pressed={app.rightOpen} aria-label="记忆细节" title="记忆细节"
              onClick={() => app.setRightOpen(!app.rightOpen)}><PanelRight size={13} /><span>记忆细节</span></button>
            <button type="button" className="control control-dark"
              disabled={app.triggeringDream || app.dreamRunning || (!app.pendingCount && !version)}
              onClick={() => void app.triggerDream(app.pendingCount === 0)}>
              {app.pendingCount || app.dreamRunning || !version ? <Moon size={13} /> : <Sparkles size={13} />}
              {app.dreamRunning ? "做梦整理中…" : app.triggeringDream ? "正在启动…" : (app.pendingCount > 0 || !version) ? "开始做梦整理" : "深度做梦压缩"}
            </button>
          </div>
        </div>

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
              : <ChatWorkspace key={spaceKey} />}
          </div>
          <div className={`inspector-frame ${app.rightOpen ? "" : "inspector-hidden"}`}>
            {app.rightOpen ? <button type="button" className="drawer-backdrop xl:hidden" aria-label="关闭记忆细节"
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
