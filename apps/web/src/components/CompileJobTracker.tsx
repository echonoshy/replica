import { useEffect, useEffectEvent, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Clock3, Loader2, Sparkles, XCircle } from "lucide-react";
import type { JobResult } from "@replica/shared";
import { api, formatNumber } from "../api";

const STAGES = [
  { id: "queued", label: "任务入队", desc: "SHA-256 去重与排程" },
  { id: "normalizing", label: "锚点切分", desc: "生成 #t / #s 锚点" },
  { id: "extracting", label: "并行抽取", desc: "快模型抽事实与冲突" },
  { id: "organizing", label: "记忆整理", desc: "冲突裁决与单写者编排" },
  { id: "linting", label: "门禁校验", desc: "校验索引/断链/出处" },
  { id: "published", label: "原子发布", desc: "切换快照与 FTS5 索引" },
] as const;

export function CompileJobTracker({
  jobId,
  onSettled,
  compact = false,
}: {
  jobId: string | null;
  onSettled?: (job: JobResult) => void;
  compact?: boolean;
}) {
  const [job, setJob] = useState<JobResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastActiveIdx, setLastActiveIdx] = useState(0);

  const notifySettled = useEffectEvent((result: JobResult) => onSettled?.(result));

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const next = await api.getJob(jobId!);
        if (cancelled) return;
        setJob(next);
        setError(null);
        if (next.status !== "failed") {
          const idx = STAGES.findIndex((s) => s.id === next.status);
          if (idx >= 0) setLastActiveIdx(idx);
        }
        if (next.status === "published" || next.status === "failed") {
          notifySettled(next);
        } else {
          timer = setTimeout(poll, 700);
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        timer = setTimeout(poll, 1800);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  if (!jobId) return null;
  if (!job) return <p role="status" className="card-tactile px-3 py-2 text-xs text-[#646a73]">{error ?? "正在获取整理进度…"}</p>;

  const currentIdx = job.status === "failed"
    ? lastActiveIdx
    : STAGES.findIndex((s) => s.id === job.status);
  const isDone = job.status === "published";
  const isFailed = job.status === "failed";

  return (
    <div className={`rounded-[10px] border ${
      isFailed
        ? "border-[#fee2e2] bg-[#fef2f2]/80"
        : isDone
          ? "border-[#d1fae5] bg-[#ecfdf5]"
          : "border-[#ede9fe] bg-[#f5f3ff]"
    } ${compact ? "p-3.5" : "p-5"}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isDone ? (
            <CheckCircle2 size={16} className="text-[#0f9d6e]" />
          ) : isFailed ? (
            <XCircle size={16} className="text-[#dc2626]" />
          ) : (
            <Loader2 size={16} className="animate-spin text-[#6b5ce7]" />
          )}
          <span className="text-xs font-semibold text-[#1f2329]">
            {job.job_type === "dream" ? "深度做梦压缩整理" : "离线做梦整理管线"}
          </span>
          {isDone && job.target_version ? (
            <span className="rounded-full bg-[#0f9d6e] px-2 py-0.5 font-mono-num text-[10.5px] font-medium text-white">
              已发布 v{job.target_version}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 font-mono-num text-[11px] text-[#646a73]">
          <span>{job.usage.llm_calls} 次调用</span>
          <span>·</span>
          <span>{formatNumber(job.usage.total_tokens)} tok</span>
          <span>·</span>
          <span>{(job.usage.latency_ms / 1000).toFixed(1)}s</span>
        </div>
      </div>

      <div className={`grid gap-1.5 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"}`}>
        {STAGES.map((stage, idx) => {
          const completed = idx < currentIdx || (idx === currentIdx && isDone);
          const active = idx === currentIdx && !isDone && !isFailed;
          const failedHere = idx === currentIdx && isFailed;
          return (
            <div
              key={stage.id}
              className={`rounded-[8px] border px-2.5 py-2 transition-all ${
                completed
                  ? "border-[#d1fae5] bg-white text-[#047857]"
                  : failedHere
                    ? "border-[#fee2e2] bg-white text-[#dc2626]"
                    : active
                      ? "border-[#6b5ce7] bg-white text-[#6d28d9] ring-2 ring-[#6b5ce7]/15"
                      : "border-transparent bg-white/55 text-[#9ea4ae]"
              }`}
            >
              <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9.5px] ${
                  completed
                    ? "bg-[#0f9d6e] text-white"
                    : failedHere
                      ? "bg-[#dc2626] text-white"
                      : active
                        ? "bg-[#f5f3ff] text-[#6b5ce7]"
                        : "bg-[#eff1f5] text-[#8f959e]"
                }`}>
                  {completed ? <Check size={10} /> : active ? <Clock3 size={10} /> : idx + 1}
                </span>
                <span className="truncate">{stage.label}</span>
              </div>
              {!compact ? (
                <p className="mt-1 truncate text-[10.5px] opacity-80">{stage.desc}</p>
              ) : null}
            </div>
          );
        })}
      </div>

      {error ? <p className="mt-2.5 text-xs text-[#dc2626]">{error}</p> : null}
      {job.error_message ? (
        <div className="mt-2.5 flex items-start gap-2 rounded-[8px] bg-white px-3 py-2 text-xs text-[#dc2626]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{job.error_message}</span>
        </div>
      ) : null}
      {isDone && job.usage.llm_calls === 0 ? (
        <div className="mt-2.5 flex items-center gap-1.5 text-xs text-[#047857]">
          <Sparkles size={13} />
          <span>语料已去重（SHA-256 命中），零模型调用复用当前快照。</span>
        </div>
      ) : null}
    </div>
  );
}
