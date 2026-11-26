import { createHash } from "node:crypto";
import { findAnchors } from "@wiki-memory/shared";
import type { ProactivePolicy, ProspectiveIntention, SpaceRef } from "@wiki-memory/shared";
import { spaceKey } from "../../db/interfaces.js";
import { indexText } from "../../db/tokenize.js";
import { inferFactTier } from "../../memory/memory-state.js";
import { anchorKey, claimKey, claimSource } from "../../pipeline/analyzer.js";
import type { Claim } from "../../pipeline/analyzer.js";
import { claimIdentity, reconcile } from "../../pipeline/wiki-compiler.js";
import { inline } from "../../pipeline/wiki-markdown.js";
import type { MemoryKernelPort } from "./kernel.js";
import { DAY, iso, localTime, shiftDay, wallTime } from "./time.js";

export type SourceType = "memory_event" | "expiring_fact" | "conflict" | "daily_digest" | "follow_up" | "snooze" | "open_loop" | "event_trigger";
export interface Payload {
  text: string;
  anchors: string[];
  subjects: string[];
  item_keys: string[];
  nudge_id?: string;
  valid_until?: string;
  occurs_on?: string;
  intention_id?: string;
  redline?: boolean;
  risk_watch?: boolean;
}
export interface Trigger {
  trigger_id: string;
  dedup_key: string;
  source_type: SourceType;
  snapshot_version: number;
  fire_at: string;
  payload: Payload;
  chain_depth: number;
}
export const hash = (parts: unknown) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export function timer(ref: SpaceRef, version: number, type: SourceType, key: string, at: number, payload: Payload, depth = 0): Trigger {
  return {
    trigger_id: "tr_" + hash([spaceKey(ref), key]), source_type: type, dedup_key: key, snapshot_version: version,
    fire_at: iso(at), payload, chain_depth: depth,
  };
}

export function digests(ref: SpaceRef, version: number, policy: ProactivePolicy, ms: number) {
  if (!version || !policy.enabled || !policy.daily_digest_time) return [];
  const time = policy.daily_digest_time;
  const today = localTime(ms, policy.timezone).date;
  return [today, shiftDay(today, 1)].map((day) => {
    const key = "digest:" + day;
    return timer(ref, version, "daily_digest", key, wallTime(day, time, policy.timezone), {
      text: day + " daily digest", subjects: [], anchors: [], item_keys: [key],
    });
  });
}

export function intentionTimer(ref: SpaceRef, version: number, i: ProspectiveIntention) {
  if (i.status !== "armed") return;
  const c = i.condition;
  const due = c.fire_at ? Date.parse(c.fire_at) : i.kind === "open_loop" && c.stale_after_days
    ? Date.parse(i.created_at) + c.stale_after_days * DAY : undefined;
  if (due === undefined) return;
  const at = Math.max(due, c.not_before ? Date.parse(c.not_before) : due);
  const key = "intention:" + i.intention_id;
  return timer(ref, version, "open_loop", key, at, {
    intention_id: i.intention_id, text: i.goal, anchors: i.evidence_anchors, subjects: i.subjects,
    item_keys: [key], occurs_on: iso(due), valid_until: c.deadline ? iso(Date.parse(c.deadline)) : undefined,
    redline: i.priority === "redline", risk_watch: i.kind === "risk_watch",
  });
}

// Recall counts change during interactive searches but do not alter trigger evidence.
export function controlState(port: MemoryKernelPort, ref: SpaceRef) {
  const controls = [...(port.telemetry?.(ref)?.values() ?? [])]
    .filter(t => t.pinned || t.tier_override || t.edited_value !== null || t.archived_reason)
    .map(t => [t.fact_key, t.pinned, t.tier_override, t.edited_value, t.archived_reason]);
  return JSON.stringify([controls, [...(port.aliases?.(ref) ?? [])]]);
}

export async function activeLedger(port: MemoryKernelPort, ref: SpaceRef, version: number, day: string) {
  const claims: Claim[] = version ? JSON.parse(await port.file(ref, version, "_claims.json")) : [];
  return reconcile(claims, day, { aliases: port.aliases?.(ref), telemetry: port.telemetry?.(ref) });
}

export async function snapshotTimers(port: MemoryKernelPort, ref: SpaceRef, version: number, policy: ProactivePolicy, ms: number,
  ledger?: Awaited<ReturnType<typeof activeLedger>>) {
  if (!version) return [];
  const { current, events, audit } = ledger ?? await activeLedger(port, ref, version, localTime(ms, policy.timezone).date);
  const result: Trigger[] = [];
  const dedupedEvents: Array<typeof events[number] & { mergedAnchors: string[] }> = [];
  for (const ev of events) {
    if (ev.status === "cancelled" || ev.status === "completed") continue;
    const anchor = `${ev.docId}#${ev.locator}`;
    const evTokens = new Set((indexText(ev.text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => [...t].length > 1));
    const evSubjects = new Set(ev.related.map((r) => claimKey(r.subject)));
    const existing = dedupedEvents.find((other) => {
      if (other.date !== ev.date) return false;
      if (ev.event_key && other.event_key && claimKey(ev.event_key) === claimKey(other.event_key)) return true;
      // Only fuzzy-merge across distinct documents (restatements in separate chats/docs),
      // preserving distinct numbered items enumerated within the same source document.
      if (other.docId === ev.docId) return false;
      const otherTokens = new Set((indexText(other.text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => [...t].length > 1));
      let overlap = 0;
      for (const token of evTokens) if (otherTokens.has(token)) overlap++;
      const ratio = overlap / Math.max(1, Math.min(evTokens.size, otherTokens.size));
      const sharesSubject = other.related.some((r) => evSubjects.has(claimKey(r.subject)));
      return ratio >= 0.5 || (sharesSubject && ratio >= 0.4);
    });
    if (existing) {
      if (!existing.mergedAnchors.includes(anchor)) existing.mergedAnchors.push(anchor);
      if (ev.docDate >= existing.docDate && ev.text.length > existing.text.length) existing.text = ev.text;
    } else {
      dedupedEvents.push({ ...ev, mergedAnchors: [anchor] });
    }
  }

  for (const claim of [...dedupedEvents, ...current]) {
    const fact = "predicate" in claim;
    const day = fact ? claim.expires_on : claim.date;
    if (!day) continue;
    const at = wallTime(day, "08:30", policy.timezone);
    if (at < ms - DAY) continue;
    const identity = fact ? claimIdentity(claim) : (claim.event_key ? claimKey(claim.event_key) : claim.text);
    const key = (fact ? "fact:" : "event:") + hash([identity, day]);
    const payload: Payload = {
      text: fact ? [claim.subject, claim.predicate, claim.value, day].join(" · ") : day + " " + claim.text,
      subjects: [...(fact ? [claim.subject] : []), ...claim.related.map((r) => r.subject)],
      anchors: fact ? [claim.docId + "#" + claim.locator] : claim.mergedAnchors,
      item_keys: [key], occurs_on: day, redline: fact && (claim.tier ?? inferFactTier(claim)) === "pinned_redline", valid_until: iso(at + DAY),
    };
    result.push(timer(ref, version, fact ? "expiring_fact" : "memory_event", key + ":eve",
      wallTime(shiftDay(day, -1), "09:00", policy.timezone), payload));
    if (!fact) result.push(timer(ref, version, "memory_event", key + ":day", at, payload));
  }
  // conflicts.md retains audit history. Only the currently competing values need a decision.
  const groups = Map.groupBy(current, (fact) => inline(fact.subject) + " · " + inline(fact.predicate));
  for (const line of audit) {
    const match = /^- \*\*(.*?)\*\* · 同日冲突，待确认/.exec(line);
    if (!match) continue;
    const anchors = findAnchors(line).map((a) => a.anchor);
    const active = groups.get(match[1])?.filter((fact) => anchors.includes(fact.docId + "#" + fact.locator));
    if (!active || new Set(active.map((f) => f.value)).size < 2) continue;
    const activeAnchors = active.map(anchorKey).sort();
    const key = "conflict:" + hash([match[1], activeAnchors]);
    result.push(timer(ref, version, "conflict", key, ms, {
      text: `- **${match[1]}** · 同日冲突，待确认 · ` + active.map(f => `${inline(f.value)} ${claimSource(f)}`).join(" / "),
      anchors: activeAnchors, subjects: [active[0].subject], item_keys: [key],
    }));
  }
  return result;
}
