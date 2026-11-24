import { createHash } from "node:crypto";
import { findAnchors } from "@replica/shared";
import type { ProactivePolicy, SpaceRef } from "@replica/shared";
import { spaceKey } from "../../db/interfaces.js";
import type { Claim } from "../../pipeline/analyzer.js";
import { claimIdentity, reconcile } from "../../pipeline/wiki-compiler.js";
import { inline } from "../../pipeline/wiki-markdown.js";
import type { MemoryKernelPort } from "./kernel.js";
import { DAY, iso, localTime, shiftDay, wallTime } from "./time.js";

export type SourceType = "memory_event" | "expiring_fact" | "conflict" | "daily_digest" | "follow_up" | "snooze";
export interface Payload {
  text: string;
  anchors: string[];
  subjects: string[];
  item_keys: string[];
  nudge_id?: string;
  valid_until?: string;
  occurs_on?: string;
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

export async function snapshotTimers(port: MemoryKernelPort, ref: SpaceRef, version: number, policy: ProactivePolicy, ms: number) {
  if (!version) return [];
  const [raw, conflicts] = await Promise.all([
    port.file(ref, version, "_claims.json"), port.file(ref, version, "conflicts.md"),
  ]);
  const claims: Claim[] = JSON.parse(raw);
  const { current, events } = reconcile(claims, localTime(ms, policy.timezone).date);
  const result: Trigger[] = [];
  for (const claim of [...events, ...current]) {
    const fact = "predicate" in claim;
    const day = fact ? claim.expires_on : claim.date;
    if (!day) continue;
    const at = wallTime(day, "08:30", policy.timezone);
    if (at < ms - DAY) continue;
    const key = (fact ? "fact:" : "event:") + hash([fact ? claimIdentity(claim) : claim.text, day]);
    const payload: Payload = {
      text: fact ? [claim.subject, claim.predicate, claim.value, day].join(" · ") : day + " " + claim.text,
      subjects: [...(fact ? [claim.subject] : []), ...claim.related.map((r) => r.subject)],
      anchors: [claim.docId + "#" + claim.locator], item_keys: [key], occurs_on: day, valid_until: iso(at + DAY),
    };
    result.push(timer(ref, version, fact ? "expiring_fact" : "memory_event", key + ":eve",
      wallTime(shiftDay(day, -1), "09:00", policy.timezone), payload));
    if (!fact) result.push(timer(ref, version, "memory_event", key + ":day", at, payload));
  }
  // conflicts.md retains audit history. Only the currently competing values need a decision.
  const groups = Map.groupBy(current, (fact) => inline(fact.subject) + " · " + inline(fact.predicate));
  for (const line of conflicts.split("\n")) {
    const match = /^- \*\*(.*?)\*\* · 同日冲突，待确认/.exec(line);
    if (!match) continue;
    const anchors = findAnchors(line).map((a) => a.anchor);
    const active = groups.get(match[1])?.filter((fact) => anchors.includes(fact.docId + "#" + fact.locator));
    if (!active || new Set(active.map((f) => f.value)).size < 2) continue;
    const key = "conflict:" + hash([match[1], anchors.slice().sort()]);
    result.push(timer(ref, version, "conflict", key, ms, {
      text: line, anchors, subjects: [active[0].subject], item_keys: [key],
    }));
  }
  return result;
}
