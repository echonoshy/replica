import { Archive, ArrowRight, GitPullRequestArrow } from "lucide-react";
import type { ConflictItem } from "../api";
import { RichMarkdown } from "./RichMarkdown";

export function ConflictCard({
  item,
  docLabelMap,
  onSource,
  compact = false,
}: {
  item: ConflictItem;
  docLabelMap?: Record<string, string>;
  onSource: (anchor: string) => void;
  compact?: boolean;
}) {
  const p = item.parsed;
  const archived = item.type === "archived";
  if (archived || !p) {
    const Icon = archived ? Archive : GitPullRequestArrow;
    return (
      <div className={archived ? "card-tactile p-4" : "rounded-[10px] border border-[#fee2e2] bg-white p-4"}>
        <div className={`status-chip mb-2 ${archived ? "tone-mint" : "tone-rose"}`}>
          <Icon size={12} aria-hidden="true" />
          {archived ? "梦境归档 · 已完成下架"
            : item.type === "same_day_conflict" ? "同日冲突 · 保留双方证据" : "冲突与修订记录"}
        </div>
        <RichMarkdown
          markdown={item.raw.replace(/^-\s+/, "")}
          docLabelMap={docLabelMap}
          onSource={onSource}
        />
      </div>
    );
  }

  const isExplicit = p.rule.includes("显式");

  return (
    <div className="card-tactile overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f0f2f5] bg-[#fcfcfd] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <GitPullRequestArrow size={14} className="text-[#dc2626]" />
          <span className="text-[13px] font-semibold text-[#1f2329]">{p.label}</span>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-[10.5px] font-medium ${
          isExplicit
            ? "border border-[#fee2e2] bg-[#fef2f2] text-[#dc2626]"
            : "bg-[#f0f2f5] text-[#646a73]"
        }`}>
          {p.rule} · 新旧替换
        </span>
      </div>

      <div className={`grid items-stretch gap-2.5 p-3.5 ${compact ? "grid-cols-1" : "md:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] md:p-4"}`}>
        {/* Old / Superseded Memory */}
        <div className="flex flex-col justify-between bg-hatch-muted rounded-[8px] border border-[#eceef2] bg-[#f7f8f9] p-3">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2 flex-wrap text-[11px]">
              <span className="font-medium text-[#8f959e]">旧记忆（已归档）</span>
              <span className="font-mono-num text-[#a0a6b1]">{p.old_date}</span>
            </div>
            <p className="text-[13px] leading-relaxed text-[#646a73] line-through decoration-[#c2c7d0]">
              {p.old_value}
            </p>
          </div>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => onSource(p.old_anchor)}
              className="inline-flex items-center gap-1 rounded-[6px] border border-[#e2e5ec] bg-white px-2.5 py-0.5 font-mono-num text-[11px] text-[#646a73] transition-colors hover:border-[#3370ff] hover:text-[#245bdb]"
            >
              ↗ 原话 #{p.old_anchor.split("#")[1]}
            </button>
          </div>
        </div>

        {/* Arrow */}
        <div className="flex items-center justify-center">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full bg-[#fef2f2] text-[#dc2626] ${compact ? "rotate-90" : "rotate-90 md:rotate-0"}`}>
            <ArrowRight size={13} />
          </span>
        </div>

        {/* New / Active Memory */}
        <div className="flex flex-col justify-between rounded-[10px] border border-[#d1fae5] bg-[#ecfdf5] p-3">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2 flex-wrap text-[11px]">
              <span className="font-medium text-[#047857]">最新生效</span>
              <span className="font-mono-num text-[#0f9d6e]">{p.new_date}</span>
            </div>
            <p className="text-[13px] font-medium leading-relaxed text-[#142d23]">
              {p.new_value}
            </p>
          </div>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => onSource(p.new_anchor)}
              className="source-pill"
            >
              ↗ 原话 #{p.new_anchor.split("#")[1]}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
