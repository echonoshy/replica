import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, BookOpen, CalendarClock, CheckCircle2, Code2, Compass, GitPullRequestArrow,
  Archive, ChevronDown, History, Link2, Pencil, Pin, PinOff, Plus, RotateCcw, ShieldCheck, SlidersHorizontal, Tag, UserCircle2, X, Zap,
} from "lucide-react";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES } from "@wiki-memory/shared/wiki-format";
import type { FileResult, TreeResult } from "@wiki-memory/shared";
import { api, buildDocLabelMap, formatShortDate, spaceKeyOf } from "../api";
import type { ConflictItem, EnrichedFactView, FactControlPatch, HotMemoryRecord, MemoryControlsResponse, MemoryTier, PrivacyScope, TimelineItem } from "../api";
import { ConflictCard } from "./ConflictCard";
import { RichMarkdown } from "./RichMarkdown";
import { useApp } from "../context/AppContext";

function parseConflictsLocally(markdown: string): ConflictItem[] {
  const supersedesPattern =
    /^-\s+\*\*(.+?)\*\*\s*·\s*([^·]+?)\s*·\s*[“"](.+?)[”"]（(\d{4}-\d{2}-\d{2})）\s*\[src:([^\]]+)\]\s*·\s*supersedes:\s*[“"](.+?)[”"]（(\d{4}-\d{2}-\d{2})）\s*\[src:([^\]]+)\]/;
  return markdown
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && !l.includes("暂无冲突或修订记录"))
    .map((raw) => {
      if (raw.includes("梦境归档")) return { raw, type: "archived" as const, anchors: [], parsed: null };
      if (raw.includes("梦境纠错")) return { raw, type: "dream_correction" as const, anchors: [], parsed: null };
      const m = raw.match(supersedesPattern);
      const supersedes = raw.includes("supersedes:");
      const sameDay = raw.includes("同日冲突");
      return {
        raw,
        type: supersedes ? "superseded" as const : sameDay ? "same_day_conflict" as const : "revision" as const,
        anchors: [],
        parsed: m ? {
          label: m[1].trim(),
          rule: m[2].trim(),
          new_value: m[3].trim(),
          new_date: m[4],
          new_anchor: m[5],
          old_value: m[6].trim(),
          old_date: m[7],
          old_anchor: m[8],
        } : null,
      };
    });
}

function parseTimelineLocally(markdown: string): TimelineItem[] {
  return markdown
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && !l.includes("暂无带明确日期的事件"))
    .map((raw) => {
      const m = raw.match(/^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*·\s*(.+)$/);
      return { date: m?.[1] ?? "", text: m?.[2] ?? raw.slice(2), raw, anchors: [] };
    })
    .filter((item) => item.date);
}

export const MEMORY_CONTROLS_PATH = "#controls";

const segmentClass = "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium text-[#646a73] hover:text-[#1f2329] aria-pressed:bg-white aria-pressed:text-[#3370ff] aria-pressed:shadow-xs";

export function MemoryLibraryView({ initialPath }: { initialPath: string }) {
  const { activeSpace, overview, memoryControls, setCenterMode, rightOpen, setRightOpen, inspectSource, refreshSpaceData } = useApp();
  const [controlsOpen, setControlsOpen] = useState(initialPath === MEMORY_CONTROLS_PATH);
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [tree, setTree] = useState<TreeResult | null>(null);
  const [requestedPath, setRequestedPath] = useState(initialPath === MEMORY_CONTROLS_PATH ? "_index.md" : initialPath);
  const [file, setFile] = useState<FileResult | null>(null);
  const [rawView, setRawView] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const docLabelMap = useMemo(() => buildDocLabelMap(overview?.documents), [overview?.documents]);
  const spaceKey = activeSpace ? spaceKeyOf(activeSpace) : "";
  const currentVersion = overview?.space.current_version ?? activeSpace?.current_version;

  useEffect(() => {
    if (!activeSpace) return;
    let alive = true;
    setLoadingTree(true);
    setError(null);
    void api.getTree(activeSpace, selectedVersion)
      .then((next) => { if (alive) setTree(next); })
      .catch((err: Error) => { if (alive) setError(err.message); })
      .finally(() => { if (alive) setLoadingTree(false); });
    return () => { alive = false; };
  }, [spaceKey, currentVersion, selectedVersion]);

  const resolvedVersion = tree?.snapshot?.version;
  const files = tree?.files ?? [];
  const selectedPath = files.includes(requestedPath) ? requestedPath : "_index.md";
  const currentFile = file?.path === selectedPath && file.version === resolvedVersion ? file : null;

  useEffect(() => {
    if (!activeSpace || !resolvedVersion) return;
    let alive = true;
    setLoadingFile(true);
    setError(null);
    void api.getFile(activeSpace, selectedPath, resolvedVersion)
      .then((res) => { if (alive) setFile(res); })
      .catch((err: Error) => { if (alive) setError(err.message); })
      .finally(() => { if (alive) setLoadingFile(false); });
    return () => { alive = false; };
  }, [spaceKey, resolvedVersion, selectedPath]);

  function selectPath(path: string) {
    setRequestedPath(path);
    setRawView(false);
  }

  async function handleRollback() {
    if (!activeSpace || !resolvedVersion || rollingBack) return;
    setRollingBack(true);
    setError(null);
    try {
      await api.rollback(activeSpace, resolvedVersion);
      setSelectedVersion(undefined);
      await refreshSpaceData();
      setNotice(`已回滚至快照 v${resolvedVersion}。`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRollingBack(false);
    }
  }

  const groups = [
    { title: "总览目录", icon: Compass, tone: "tone-blue", path: "_index.md", pages: [] },
    { title: "人物与项目", icon: UserCircle2, tone: "tone-violet", pages: files.filter((p) => p.startsWith("entities/")) },
    { title: "偏好与习惯", icon: Tag, tone: "tone-mint", pages: files.filter((p) => p.startsWith("topics/")) },
    { title: "行为准则", icon: ShieldCheck, tone: "tone-mint", path: "rules.md", pages: [] },
    { title: "关键时间线", icon: CalendarClock, tone: "tone-amber", path: "timeline.md", pages: [] },
    { title: "冲突与修订审计", icon: GitPullRequestArrow, tone: "tone-rose", path: "conflicts.md", pages: [] },
  ];
  const isHistory = Boolean(resolvedVersion && resolvedVersion !== currentVersion);
  const conflicts = selectedPath === "conflicts.md" && currentFile ? parseConflictsLocally(currentFile.markdown) : [];
  const timeline = selectedPath === "timeline.md" && currentFile ? parseTimelineLocally(currentFile.markdown) : [];
  const lint = tree?.snapshot?.lint;
  const onSource = (anchor: string) => {
    if (activeSpace) inspectSource({ space: activeSpace, anchor, version: resolvedVersion });
  };

  const FRIENDLY_PAGE_TITLES: Record<string, string> = {
    "_index.md": "总览目录",
    "rules.md": "行为准则",
    "timeline.md": "关键时间线",
    "conflicts.md": "冲突与修订审计",
  };
  const displayPageTitle = FRIENDLY_PAGE_TITLES[selectedPath] ?? tree?.titles[selectedPath] ?? currentFile?.frontmatter?.title ?? selectedPath;

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ebedf0] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="记忆库视图" className="inline-flex rounded-[8px] bg-[#f5f6f7] p-1">
            <button type="button" aria-pressed={!controlsOpen} onClick={() => setControlsOpen(false)} className={segmentClass}>
              <BookOpen size={14} /> 知识百科 <span className="tabular-nums">({tree?.snapshot?.page_count ?? overview?.space.page_count ?? activeSpace?.page_count ?? 0})</span>
            </button>
            <button type="button" aria-pressed={controlsOpen} onClick={() => { setControlsOpen(true); setRightOpen(false); }} className={segmentClass}>
              <SlidersHorizontal size={14} /> 记忆管控 <span className="tabular-nums">({memoryControls?.stats.total_active ?? "…"})</span>
            </button>
          </div>
          {!controlsOpen && lint ? (
            <details className="group relative text-[11.5px]">
              <summary className="status-chip tone-mint list-none select-none">
                <ShieldCheck size={12} /> 校验通过
                <span className="font-mono-num opacity-75">· {lint.broken_links} 断链</span>
              </summary>
              <div className="card-floating absolute left-0 z-20 mt-1.5 w-64 space-y-1 p-3 text-[11.5px] text-[#4e5969] shadow-lg">
                <div className="font-medium text-[#1f2329]">快照门禁指标</div>
                <div className="font-mono-num">索引行数：{lint.index_lines} / {INDEX_MAX_LINES} 行</div>
                <div className="font-mono-num">索引体积：{(lint.index_bytes / 1024).toFixed(1)} / {INDEX_MAX_BYTES / 1024} KiB</div>
                <div className="font-mono-num">断链 / 孤岛页：{lint.broken_links} / {lint.orphan_pages}</div>
              </div>
            </details>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!controlsOpen && tree?.versions.length ? (
            <div className="flex flex-wrap items-center gap-1" aria-label="版本快照" aria-busy={loadingTree}>
              <span className="mr-0.5 inline-flex items-center gap-1 text-xs text-[#646a73]"><History size={13} /> 快照</span>
              {[...tree.versions].sort((a, b) => a.version - b.version).map((snapshot) => {
                const isCurrent = snapshot.version === currentVersion;
                return (
                  <button key={snapshot.version} type="button" aria-pressed={snapshot.version === resolvedVersion}
                    onClick={() => { setSelectedVersion(isCurrent ? undefined : snapshot.version); setRawView(false); setNotice(null); }}
                    className="control font-mono-num">
                    v{snapshot.version}{isCurrent ? <span className="font-sans text-[10px]">当前</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {!controlsOpen && isHistory ? (
            <button type="button" className="status-chip tone-amber" disabled={rollingBack || loadingTree}
              onClick={() => void handleRollback()}><RotateCcw size={12} /> 回滚至 v{resolvedVersion}</button>
          ) : null}
          <button type="button" onClick={() => setCenterMode("chat")} className="control"><ArrowLeft size={13} /> 返回对话</button>
        </div>
      </header>
      {notice ? <div role="status" className="flex items-center gap-2 bg-[#ecfdf5] px-4 py-2 text-xs text-[#047857]"><CheckCircle2 size={14} /> {notice}</div> : null}
      {!controlsOpen && error ? <div role="alert" className="bg-[#fef2f2] px-4 py-2 text-xs text-[#dc2626]">{error}</div> : null}

      {controlsOpen ? (
        <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f8fa] p-4 @3xl:p-6">
          <div className="mx-auto w-full max-w-[1200px]"><MemoryControls /></div>
        </div>
      ) : !resolvedVersion ? (
        <div className="m-4 card-tactile p-8 text-center">
          <BookOpen size={22} className="mx-auto mb-2 text-[#3370ff]" />
          <h2 className="text-sm font-semibold">{loadingTree ? "正在加载个人记忆库…" : "记忆库还是空的"}</h2>
          {!loadingTree ? <button type="button" className="control mt-3" onClick={() => setCenterMode("chat")}>去聊几句</button> : null}
        </div>
      ) : (
        <div className="wiki-layout">
          <nav className="wiki-rail" aria-label="Wiki 分类">
            {groups.map(({ title, icon: Icon, tone, path, pages }) => {
              const icon = <span className={`wiki-category-icon ${tone}`}><Icon size={11} /></span>;
              if (path) {
                return files.includes(path) ? (
                  <button key={path} type="button" className="nav-row" aria-current={selectedPath === path ? "page" : undefined}
                    onClick={() => selectPath(path)}>
                    {icon} <span className="flex-1">{title}</span>
                    {path === "conflicts.md" && !isHistory && overview?.stats.conflict_count ? (
                      <span className="status-chip tone-rose font-mono-num">{overview.stats.conflict_count}</span>
                    ) : null}
                  </button>
                ) : null;
              }
              return pages.length ? (
                <div key={title} className="py-1">
                  <div className="group-label items-center">
                    <span className="flex items-center gap-2">{icon}{title}</span><span className="font-mono-num">{pages.length}</span>
                  </div>
                  {pages.map((page) => (
                    <button key={page} type="button" className="nav-row wiki-page-row"
                      aria-current={selectedPath === page ? "page" : undefined} onClick={() => selectPath(page)}>
                      <span className={`size-1.5 shrink-0 rounded-full border ${tone}`} />
                      <span className="truncate">{tree?.titles[page] || page.split("/").at(-1)}</span>
                      {/^(topics|entities)\/hub-[^/]+\.md$/.test(page) && <span className="status-chip shrink-0 bg-[#f0f2f5] text-[#646a73]">目录</span>}
                    </button>
                  ))}
                </div>
              ) : null;
            })}
          </nav>

          <article className="wiki-article">
            <div className="mx-auto max-w-[900px] p-3 sm:p-4">
              <div className="card-tactile overflow-hidden">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eceef2] bg-[#fcfcfd] px-4 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-[#1f2329]" title={selectedPath}>{displayPageTitle}</span>
                    {isHistory ? <span className="status-chip tone-amber">历史快照 v{resolvedVersion}</span> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {conflicts.length || timeline.length ? (
                      <button type="button" className="control" onClick={() => setRawView((value) => !value)}>
                        <Code2 size={12} /> {rawView ? "可视化卡片" : "原始 Markdown"}
                      </button>
                    ) : null}
                    {currentFile?.frontmatter ? (
                      <span className="mono-meta">{formatShortDate(currentFile.frontmatter.updated_at)}</span>
                    ) : null}
                  </div>
                </header>
                <div className="p-4 sm:p-5">
                  {loadingTree || loadingFile ? (
                    <p className="py-8 text-center text-xs text-[#646a73]" role="status">读取记忆页中…</p>
                  ) : currentFile && rawView ? (
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono-num text-xs">{currentFile.markdown}</pre>
                  ) : conflicts.length ? (
                    <section className="space-y-3">
                      <h2 className="text-[17px] font-semibold">冲突与修订审计</h2>
                      {conflicts.map((item, index) => (
                        <ConflictCard key={index} item={item} docLabelMap={docLabelMap} compact={rightOpen} onSource={onSource} />
                      ))}
                    </section>
                  ) : timeline.length ? (
                    <section className="space-y-3">
                      <h2 className="text-[17px] font-semibold">关键时间线与承诺</h2>
                      <ol className="wiki-timeline">
                        {[...timeline].sort((a, b) => a.date.localeCompare(b.date)).map((item, index) => (
                          <li key={index}>
                            <time dateTime={item.date} className="status-chip tone-amber font-mono-num">{item.date}</time>
                            <RichMarkdown markdown={item.text} docLabelMap={docLabelMap} onSource={onSource} />
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : currentFile ? (
                    <RichMarkdown markdown={currentFile.markdown} currentPath={selectedPath}
                      docLabelMap={docLabelMap} onNavigate={selectPath} onSource={onSource} />
                  ) : null}
                </div>
              </div>
            </div>
          </article>
        </div>

      )}
    </div>
  );
}

const controlCard = "min-w-0 space-y-3 rounded-[10px] border border-[#ebedf0] bg-white p-4 @2xl:p-5";
const tierTones: Record<MemoryTier, string> = {
  pinned_redline: "bg-[#f8f1f2] text-[#885b67]",
  durable: "bg-[#eef3fc] text-[#526d97]",
  working: "bg-[#f8f4eb] text-[#7b6744]",
};
const tierLabels: Record<MemoryTier, string> = {
  pinned_redline: "红线永驻", durable: "长期稳定", working: "短期工作态",
};
const rulePriority = {
  redline: { label: "红线", tone: "tone-rose" },
  high: { label: "高优先级", tone: "tone-amber" },
  normal: { label: "常规", tone: "bg-[#f3f4f6] text-[#5c6370]" },
};
const scopeLabels: Record<PrivacyScope, string> = {
  private_health: "私密健康", family: "家庭", work_internal: "内部工作", work_shareable: "对外可用", general: "通用",
};
const fieldClass = "min-h-8 min-w-0 rounded-[7px] border border-[#dde0e7] bg-white px-2 text-xs focus:border-[#3370ff] focus:outline-none";
type FactFilter = "all" | MemoryTier | "archived";
const filters: [FactFilter, string][] = [
  ["all", "全部"], ["pinned_redline", tierLabels.pinned_redline], ["durable", tierLabels.durable],
  ["working", tierLabels.working], ["archived", "已遗忘归档"],
];

function useControlMutation() {
  const { refreshMemoryControls } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(write: () => Promise<unknown>, verify?: (data: MemoryControlsResponse) => void) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await write();
      const data = await refreshMemoryControls();
      if (data) verify?.(data);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, save };
}

function AliasControls({ data }: { data: MemoryControlsResponse }) {
  const { activeSpace } = useApp();
  const { busy, error, save } = useControlMutation();
  const [subject, setSubject] = useState("");
  const [alias, setAlias] = useState("");
  if (!activeSpace) return null;
  return (
    <fieldset disabled={busy} className={controlCard}>
      <h3 className="flex items-center gap-2 font-semibold"><Link2 size={14} className="text-[#6d28d9]" />实体别名</h3>
      {data.aliases.length ? (
        <div className="flex flex-wrap gap-1.5">
          {data.aliases.map((item) => (
            <span key={item.kind + ":" + item.alias} className="inline-flex max-w-full items-center gap-1 rounded-md bg-[#f5f6f7] px-2 py-1 text-[#4e5969]">
              <span className="break-all">{item.canonical_subject} ↔ {item.alias}</span>
              <button type="button" aria-label={`移除别名 ${item.alias}`} className="rounded p-1 hover:bg-white"
                onClick={() => void save(() => api.deleteEntityAlias(activeSpace, item.kind, item.alias))}><X size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}
      <form className="flex flex-wrap gap-1.5" onSubmit={async (event) => {
        event.preventDefault();
        if (await save(async () => {
          const result = await api.addEntityAlias(activeSpace, { canonical_subject: subject.trim(), alias: alias.trim() });
          if (!result.alias) throw new Error("实体名和别名需有区别。");
        })) { setSubject(""); setAlias(""); }
      }}>
        <input aria-label="实体名" placeholder="实体名" value={subject} onChange={(e) => setSubject(e.target.value)} className={`${fieldClass} flex-[1_1_65px]`} />
        <input aria-label="别名" placeholder="别名" value={alias} onChange={(e) => setAlias(e.target.value)} className={`${fieldClass} flex-[1_1_65px]`} />
        <button disabled={!subject.trim() || !alias.trim()} className="control"><Plus size={12} />添加</button>
      </form>
      {error && <p role="alert" className="text-[#b42318]">{error}</p>}
    </fieldset>
  );
}

function HotControls({ data }: { data: MemoryControlsResponse }) {
  const { activeSpace } = useApp();
  const { busy, error, save } = useControlMutation();
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<HotMemoryRecord["kind"]>("remember");
  if (!activeSpace) return null;
  return (
    <fieldset disabled={busy} className={controlCard}>
      <h3 className="flex items-center gap-2 font-semibold"><Zap size={14} className="text-[#b45309]" />即时热记忆</h3>
      {data.hot_memories.filter((item) => item.status === "active").map((item) => (
        <div key={item.id} className="flex items-start gap-2 border-b border-[#eceef2] pb-2">
          <span className={`status-chip ${item.kind === "remember" ? "tone-mint" : "tone-amber"}`}>{item.kind === "remember" ? "记住" : "忘掉"} · 生效中</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.content}</span>
          <button type="button" className="icon-button" aria-label={`撤销规则 ${item.content}`} title="撤销规则"
            onClick={() => void save(() => api.dismissHotMemory(activeSpace, item.id))}><X size={13} /></button>
        </div>
      ))}
      <form className="flex flex-wrap gap-1.5" onSubmit={async (event) => {
        event.preventDefault();
        if (await save(() => api.addHotMemory(activeSpace, { kind, content: content.trim() }))) setContent("");
      }}>
        <select className={fieldClass} aria-label="热记忆类型" value={kind} onChange={(e) => setKind(e.target.value as HotMemoryRecord["kind"])}>
          <option value="remember">记住</option><option value="forget">忘掉</option>
        </select>
        <input placeholder={kind === "remember" ? "+ 即时记住一条规则" : "要忘掉的内容"} aria-label="即时规则" value={content}
          onChange={(e) => setContent(e.target.value)} className={`${fieldClass} flex-[1_1_105px]`} />
        <button className="control" disabled={!content.trim()}>添加</button>
      </form>
      {error && <p role="alert" className="text-[#b42318]">{error}</p>}
    </fieldset>
  );
}

function FactCard({ fact }: { fact: EnrichedFactView }) {
  const { activeSpace } = useApp();
  const { busy, error, save } = useControlMutation();
  const [edit, setEdit] = useState<string | null>(null);
  if (!activeSpace) return null;
  const percent = Math.round(fact.activation_score * 100);
  const activation = { pinned: "永不衰减", fresh: `活跃 ${percent}%`, fading: `淡化中 ${percent}%`, cold: "已沉底" }[fact.decay_state];
  const update = (patch: Omit<FactControlPatch, "fact_key">) =>
    save(() => api.patchFactControl(activeSpace, { fact_key: fact.fact_key, ...patch }), (data) => {
      if (patch.restore && !data.facts.some((row) => row.fact_key === fact.fact_key)) {
        throw new Error("此事实仍由快照归档，当前版本无法恢复。");
      }
      if (patch.pinned === false && data.facts.some((row) => row.fact_key === fact.fact_key && row.pinned)) {
        throw new Error("原始快照仍将此事实标记为置顶。");
      }
    });
  return (
    <fieldset disabled={busy} aria-label={`${fact.subject} · ${fact.predicate}`} className={controlCard}>
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <h4 className="break-words font-semibold">{fact.subject} <span className="font-normal text-[#646a73]">· {fact.predicate}</span></h4>
        <span className={`status-chip ${tierTones[fact.tier]}`}>{tierLabels[fact.tier]}</span>
      </div>
      {edit === null ? <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{fact.value}</p> : (
        <form className="space-y-1.5" onSubmit={async (event) => {
          event.preventDefault();
          if (await update({ edited_value: edit.trim() })) setEdit(null);
        }}>
          <textarea autoFocus aria-label="编辑事实内容" rows={2} value={edit} onChange={(e) => setEdit(e.target.value)} className={`${fieldClass} w-full py-1.5`} />
          <div className="flex gap-1.5"><button disabled={!edit.trim()} className="control control-dark">保存</button>
            <button type="button" className="control" onClick={() => setEdit(null)}>取消</button></div>
        </form>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="隐私范围" className="rounded-md bg-[#f2f4f7] px-2 py-1 text-xs text-[#535c69] focus-visible:outline-[#3370ff]" value={fact.scope}
          onChange={(e) => void update({ scope_override: e.target.value as PrivacyScope })}>
          {Object.entries(scopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="status-chip bg-[#f3f4f6] text-[#5c6370]">{activation} · 命中 {fact.recall_count} 次</span>
        {(fact.valid_from || fact.valid_to) && <span className="status-chip bg-[#f3f4f6] text-[#5c6370]">
          生效 {fact.valid_from ?? "…"} ~ {fact.valid_to ?? "长期"}
        </span>}
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-[#eceef2] pt-2">
        {fact.archived ? <button type="button" className="control" onClick={() => void update({ restore: true })}><RotateCcw size={12} />恢复</button> : (
          <>
            <button type="button" className="control" aria-pressed={fact.pinned} onClick={() => void update({ pinned: !fact.pinned })}>
              {fact.pinned ? <PinOff size={12} /> : <Pin size={12} />}{fact.pinned ? "取消置顶" : "置顶锁定"}
            </button>
            <button type="button" className="control" disabled={edit !== null} onClick={() => setEdit(fact.value)}><Pencil size={12} />编辑</button>
            <button type="button" className="control" onClick={() => void update({ archived_reason: "手动归档" })}><Archive size={12} />归档遗忘</button>
          </>
        )}
      </div>
      {error && <p role="alert" className="text-[#b42318]">{error}</p>}
    </fieldset>
  );
}

export function MemoryControls() {
  const { activeSpace, memoryControls: data, memoryControlsError, refreshMemoryControls, inspectSource, overview } = useApp();
  const [filter, setFilter] = useState<FactFilter>("all");
  const [limit, setLimit] = useState(20);
  const [expanded, setExpanded] = useState(false);
  const docLabels = useMemo(() => buildDocLabelMap(overview?.documents), [overview?.documents]);
  const loadError = memoryControlsError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-[#b42318]">
    {memoryControlsError}<button type="button" className="control" onClick={() => void refreshMemoryControls()}>重新加载</button>
  </div>;
  if (!data || !activeSpace) return loadError || <p role="status" className="text-xs text-[#646a73]">正在读取记忆管控…</p>;
  const { stats, core_profile_card: profile } = data;
  const onSource = (anchor: string) => inspectSource({ space: activeSpace, anchor, version: data.snapshot_version });
  const long = profile.length > 240 || profile.split("\n").length > 3;
  const preview = profile.split("\n").slice(0, 2).join("\n");
  const shownProfile = long && !expanded
    ? preview.length > 240 ? preview.slice(0, 240).replace(/\[src:[^\]]*$/, "") + "…" : preview
    : profile;
  const facts = filter === "archived" ? data.archived_facts : filter === "all" ? data.facts : data.facts.filter((fact) => fact.tier === filter);
  return (
    <div className="@container space-y-4 text-[13px] text-[#1f2329]">
      {loadError}
      <section className={controlCard}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck size={15} className="text-[#3370ff]" />核心身份与永驻红线</h3>
          {data.snapshot_version > 0 && <span className="mono-meta">当前快照 v{data.snapshot_version}</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className={`status-chip ${tierTones.pinned_redline}`}>红线永驻 {stats.pinned_count}</span>
          <span className={`status-chip ${tierTones.durable}`}>长期稳定 {stats.durable_count}</span>
          <span className={`status-chip ${tierTones.working}`}>短期工作态 {stats.working_count}</span>
          <span title={`已归档 ${stats.archived_count} 条，另有 ${stats.cold_count} 条活跃事实已沉底`} className="status-chip bg-[#f0f2f5]">冷归档 {stats.archived_count}</span>
        </div>
        {profile ? <div className="break-words">
          <RichMarkdown markdown={shownProfile} docLabelMap={docLabels} onSource={onSource} />
        </div> : <p className="text-[#646a73]">暂无核心身份或红线记录。</p>}
        {long && <button type="button" aria-expanded={expanded} className="inline-flex items-center gap-1 text-[#245bdb]" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起" : "展开全部"}<ChevronDown size={12} className={expanded ? "rotate-180" : ""} />
        </button>}
      </section>
      {data.rules?.length ? (
        <section className={controlCard}>
          <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck size={15} className="text-[#047857]" />行为准则 / 程序性记忆</h3>
          <ul className="divide-y divide-[#eceef2]">
            {data.rules.map((rule) => (
              <li key={rule.rule_id} className="space-y-1.5 break-words py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-[#646a73]">{rule.trigger_context}</span>
                  <span className={`status-chip ${rulePriority[rule.priority].tone}`}>{rulePriority[rule.priority].label}</span>
                  <span className="status-chip bg-[#f3f4f6] text-[#5c6370]">{scopeLabels[rule.scope]}</span>
                </div>
                <p className="font-medium leading-relaxed">{rule.instruction}</p>
                {rule.rationale && <p className="text-xs leading-relaxed text-[#646a73]">{rule.rationale}</p>}
                <RichMarkdown markdown={`[src:${rule.doc_id}#${rule.locator}]`} docLabelMap={docLabels} onSource={onSource} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="grid items-start gap-3 @2xl:grid-cols-2"><AliasControls data={data} /><HotControls data={data} /></div>
      <section className="space-y-2">
        <h3 className="flex items-center gap-2 pt-1 font-semibold"><SlidersHorizontal size={14} className="text-[#3370ff]" />事实管控</h3>
        <div role="group" className="inline-flex max-w-full flex-wrap gap-1 rounded-[8px] bg-[#f5f6f7] p-1" aria-label="事实筛选">
          {filters.map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} className={segmentClass}
            onClick={() => { setFilter(value); setLimit(20); }}>{label}</button>)}
        </div>
        <div className="grid items-start gap-3 @3xl:grid-cols-2">
          {facts.slice(0, limit).map((fact) => <FactCard key={fact.fact_key + ":" + fact.doc_id + "#" + fact.locator} fact={fact} />)}
        </div>
        {!facts.length && <p className="rounded-lg border border-dashed border-[#dde0e7] p-4 text-center text-[#646a73]">此分类暂无事实。</p>}
        {facts.length > limit && <button type="button" className="control" onClick={() => setLimit(limit + 20)}>显示更多（剩余 {facts.length - limit} 条）</button>}
      </section>
    </div>
  );
}

