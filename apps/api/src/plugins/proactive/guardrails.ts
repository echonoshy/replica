import { randomUUID } from "node:crypto";
import type { Nudge, ProactivePolicy, SpaceRef } from "@replica/shared";
import { spaceKey } from "../../db/interfaces.js";
import type { Decision, VerifiedNudge } from "./decider.js";
import { hash, timer } from "./planner.js";
import type { Trigger } from "./planner.js";
import type { Store } from "./store.js";
import { iso, localTime, quietUntil, shiftDay, wallTime } from "./time.js";

export interface EvaluationWindow {
  ref: SpaceRef;
  version: number;
  policy: ProactivePolicy;
  ms: number;
}

function countDay(store: Store, window: EvaluationWindow, day: string) {
  const zone = window.policy.timezone;
  return store.countDay(spaceKey(window.ref), iso(wallTime(day, "00:00", zone)), iso(wallTime(shiftDay(day, 1), "00:00", zone)));
}

export function hasDeliveryBudget(store: Store, window: EvaluationWindow) {
  const { policy, ms } = window;
  const possibleDays = new Set([ms, quietUntil(ms, policy)].map((at) => localTime(at, policy.timezone).date));
  return [...possibleDays].some((day) => countDay(store, window, day) < policy.max_daily_pushes);
}

export function eligible(store: Store, window: EvaluationWindow, triggers: Trigger[], reasons: Set<string>) {
  const { ref, policy, ms } = window;
  return triggers.filter((t) => {
    const stale = t.payload.valid_until && t.payload.valid_until < iso(ms);
    const reason = stale ? "stale" : store.blocked(spaceKey(ref), t, ms, policy.cooldown_hours);
    if (reason) reasons.add(reason);
    return !reason;
  });
}

export function deliveries(store: Store, window: EvaluationWindow, parents: Map<string, Trigger>,
  decision: Decision, drafts: VerifiedNudge[], agenda: Trigger[], reasons: Set<string>) {
  const { ref, version, policy, ms } = window;
  const accepted: Array<{ nudge: Nudge; items: string[] }> = [];
  const used = new Set<string>();
  const daily = new Map<string, number>();
  for (const draft of drafts) {
    const ids = [...new Set(draft.trigger_ids)];
    if (!ids.every((id) => parents.has(id))) { reasons.add("invalid_trigger"); continue; }
    if (!draft.citations.length) { reasons.add("no_valid_citation"); continue; }
    const anchors = new Set(draft.citations.map((c) => c.anchor));
    const citedAgenda = agenda.filter((t) => t.payload.anchors.some((a) => anchors.has(a)));
    const blocked = citedAgenda.map((t) => store.blocked(spaceKey(ref), t, ms, policy.cooldown_hours)).find(Boolean);
    if (blocked) { reasons.add(blocked); continue; }
    const sources = [...ids.map((id) => parents.get(id)!), ...citedAgenda];
    const items = [...new Set(sources.flatMap((t) => t.payload.item_keys))].sort();
    if (items.some((item) => used.has(item))) { reasons.add("duplicate"); continue; }

    const at = draft.urgency === "urgent" ? ms : quietUntil(ms, policy);
    const day = localTime(at, policy.timezone).date;
    const count = daily.get(day) ?? countDay(store, window, day);
    if (count >= policy.max_daily_pushes) { reasons.add("daily_limit"); continue; }
    daily.set(day, count + 1);
    items.forEach((item) => used.add(item));
    accepted.push({ items, nudge: {
      ...draft, kind: decision.decision === "digest" ? "digest" : draft.kind,
      suggested_action: draft.suggested_action ?? null, trigger_ids: ids,
      nudge_id: "nudge_" + randomUUID(), dedup_key: items.length === 1 ? items[0] : hash(items),
      snapshot_version: version, status: "pending", deliver_after: iso(at), created_at: iso(ms), acked_at: null,
    } });
  }
  return accepted;
}

export function followUps(window: EvaluationWindow, parents: Map<string, Trigger>, decision: Decision, reasons: Set<string>) {
  const accepted: Trigger[] = [];
  for (const follow of decision.follow_ups) {
    const parent = parents.get(follow.parent_trigger_id);
    if (!parent) { reasons.add("invalid_parent"); continue; }
    if (parent.chain_depth >= 2) { reasons.add("chain_depth"); continue; }
    const at = Date.parse(follow.fire_at);
    if (at < window.ms + 15 * 60_000) { reasons.add("follow_up_too_soon"); continue; }
    accepted.push(timer(window.ref, window.version, "follow_up", "follow:" + parent.trigger_id,
      at, { ...parent.payload, text: follow.text }, parent.chain_depth + 1));
  }
  return accepted;
}
