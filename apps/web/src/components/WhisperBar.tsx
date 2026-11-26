import { useId, useState } from "react";
import { X } from "lucide-react";
import type { Nudge } from "../api";
import { useApp } from "../context/AppContext";
import { NudgeContent, nudgeKinds } from "./NudgeContent";

function WhisperPreview({ nudge, more }: { nudge: Nudge; more: number }) {
  const { openInbox, tuckWhisper } = useApp();
  const [expanded, setExpanded] = useState(false);
  const previewId = useId();
  const { icon: Icon, label, tone } = nudgeKinds[nudge.kind];

  return (
    <div className="shrink-0 px-4 pt-3 sm:px-6">
      <section className="mx-auto w-full max-w-[780px]" aria-label="轻提醒预览">
        <div className={`whisper-line ${nudge.urgency === "urgent" ? "nudge-tone-urgent" : tone}`}>
          <Icon size={14} className="shrink-0" aria-hidden="true" />
          <span className="shrink-0 font-medium">{label}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--ink-primary)]" title={nudge.title}>{nudge.title}</span>
          {more > 0 ? (
            <button type="button" className="whisper-more font-mono-num" onClick={openInbox} aria-label={`在轻提醒中查看另外 ${more} 条提醒`}>
              +{more}
            </button>
          ) : null}
          <button type="button" className="whisper-toggle" aria-expanded={expanded} aria-controls={expanded ? previewId : undefined}
            onClick={() => setExpanded((open) => !open)}>{expanded ? "收起" : "查看"}</button>
          <button type="button" className="icon-button" aria-label="先收起到轻提醒" title="先收起到轻提醒"
            onClick={() => tuckWhisper(nudge.nudge_id)}><X size={14} aria-hidden="true" /></button>
        </div>
        {expanded ? (
          <div id={previewId} className="card-tactile mt-1.5 max-h-[min(46dvh,29rem)] overflow-y-auto p-3 sm:p-4">
            <h2 className="mb-2 text-sm font-semibold [overflow-wrap:anywhere]">{nudge.title}</h2>
            <NudgeContent nudge={nudge} />
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function WhisperBar() {
  const { activeSession, activeSessionId, pendingNudges, proactiveAvailable, proactivePolicy, tuckedNudgeIds } = useApp();
  if (!proactiveAvailable || proactivePolicy?.enabled === false) return null;
  const visible = pendingNudges.filter((nudge) => !tuckedNudgeIds.includes(nudge.nudge_id));
  const topNudge = visible[0];
  if (!topNudge) return null;
  if (activeSessionId && (topNudge.urgency !== "urgent" || activeSession?.source_nudge_id === topNudge.nudge_id)) return null;
  return <WhisperPreview key={topNudge.nudge_id} nudge={topNudge} more={visible.length - 1} />;
}

