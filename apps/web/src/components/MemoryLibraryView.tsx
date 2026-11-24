import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, BookOpen, CalendarClock, CheckCircle2, Code2, Compass, GitPullRequestArrow,
  History, RotateCcw, ShieldCheck, Tag, UserCircle2,
} from "lucide-react";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES } from "@replica/shared/wiki-format";
import type { FileResult, TreeResult } from "@replica/shared";
import { api, buildDocLabelMap, formatShortDate, spaceKeyOf } from "../api";
import type { ConflictItem, TimelineItem } from "../api";
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

export function MemoryLibraryView({ initialPath }: { initialPath: string }) {
  const { activeSpace, overview, setCenterMode, rightOpen, inspectSource, refreshSpaceData } = useApp();
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [tree, setTree] = useState<TreeResult | null>(null);
  const [requestedPath, setRequestedPath] = useState(initialPath);
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
    "timeline.md": "关键时间线",
    "conflicts.md": "冲突与修订审计",
  };
  const displayPageTitle = FRIENDLY_PAGE_TITLES[selectedPath] ?? tree?.titles[selectedPath] ?? currentFile?.frontmatter?.title ?? selectedPath;

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#eceef2] px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setCenterMode("chat")} className="control"><ArrowLeft size={13} /> 返回对话</button>
          {lint ? (
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
          {tree?.versions.length ? (
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
          {isHistory ? (
            <button type="button" className="status-chip tone-amber" disabled={rollingBack || loadingTree}
              onClick={() => void handleRollback()}><RotateCcw size={12} /> 回滚至 v{resolvedVersion}</button>
          ) : null}
        </div>
      </div>
      {notice ? <div role="status" className="flex items-center gap-2 bg-[#ecfdf5] px-4 py-2 text-xs text-[#047857]"><CheckCircle2 size={14} /> {notice}</div> : null}
      {error ? <div role="alert" className="bg-[#fef2f2] px-4 py-2 text-xs text-[#dc2626]">{error}</div> : null}

      {!resolvedVersion ? (
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
