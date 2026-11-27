import { randomUUID } from "node:crypto";
import type { Nudge, ProactivePolicy, SpaceRef } from "@wiki-memory/shared";
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
    if (draft.utility_score && draft.utility_score.net_utility < 0 && draft.urgency !== "urgent") { reasons.add("negative_utility"); continue; }
    const ids = [...new Set(draft.trigger_ids)];
    if (!ids.every((id) => parents.has(id))) { reasons.add("invalid_trigger"); continue; }
    const triggers = ids.map(id => parents.get(id)!);
    const userAuthored = triggers.length > 0 && triggers.every(t => t.payload.user_authored);
    if (!draft.citations.length && (!userAuthored || draft.ungrounded_citations)) { reasons.add("no_valid_citation"); continue; }
    const anchors = new Set(draft.citations.map((c) => c.anchor));
    const citedAgenda = agenda.filter((t) => t.payload.anchors.some((a) => anchors.has(a)));
    const blocked = citedAgenda.map((t) => store.blocked(spaceKey(ref), t, ms, policy.cooldown_hours)).find(Boolean);
    if (blocked) { reasons.add(blocked); continue; }
    const sources = [...triggers, ...citedAgenda];
    const items = [...new Set(sources.flatMap((t) => t.payload.item_keys))].sort();
    if (items.some((item) => used.has(item))) { reasons.add("duplicate"); continue; }

    const quietEnd = quietUntil(ms, policy);
    let urgency = draft.urgency;
    if (urgency === "urgent" && policy.strict_urgent_quiet_guard && quietEnd > ms) {
      const backed = triggers.some(({ source_type, payload: p }) => {
        if (p.redline || p.risk_watch || source_type === "conflict") return true;
        if (!p.occurs_on) return false;
        const at = p.occurs_on.length === 10 ? wallTime(p.occurs_on, "08:30", policy.timezone) : Date.parse(p.occurs_on);
        return Math.abs(at - ms) <= 2 * 3_600_000;
      });
      if (!backed) urgency = "normal";
    }
    const at = urgency === "urgent" ? ms : quietEnd;
    const day = localTime(at, policy.timezone).date;
    const count = daily.get(day) ?? countDay(store, window, day);
    if (count >= policy.max_daily_pushes) { reasons.add("daily_limit"); continue; }
    daily.set(day, count + 1);
    items.forEach((item) => used.add(item));
    const { intention_id: requestedId, ungrounded_citations: _ungrounded, ...content } = draft;
    const intentionId = requestedId ?? triggers[0]?.payload.intention_id;
    const linked = intentionId && triggers.some(t => t.payload.intention_id === intentionId);
    accepted.push({ items, nudge: {
      ...content, urgency, ...(linked && { intention_id: intentionId }),
      kind: decision.decision === "digest" ? "digest" : draft.kind,
      suggested_action: draft.suggested_action ?? null, trigger_ids: ids,
      nudge_id: "nudge_" + randomUUID(), dedup_key: items.length === 1 ? items[0] : hash(items),
      snapshot_version: version, status: "pending", deliver_after: iso(at), created_at: iso(ms), acked_at: null, session_id: null,
    } });
  }
  return accepted;
}

export function followUps(window: EvaluationWindow, parents: Map<string, Trigger>, decision: Decision, reasons: Set<string>) {
  const accepted: Trigger[] = [];
  const closed = new Set(decision.intention_updates.filter(i => ["fulfilled", "cancelled", "expired"].includes(i.status))
    .map(i => i.intention_id));
  for (const follow of decision.follow_ups) {
    const parent = parents.get(follow.parent_trigger_id);
    if (!parent) { reasons.add("invalid_parent"); continue; }
    if (parent.payload.intention_id && closed.has(parent.payload.intention_id)) { reasons.add("intention_closed"); continue; }
    if (parent.chain_depth >= 2) { reasons.add("chain_depth"); continue; }
    const at = Date.parse(follow.fire_at);
    if (at < window.ms + 15 * 60_000) { reasons.add("follow_up_too_soon"); continue; }
    accepted.push(timer(window.ref, window.version, "follow_up", "follow:" + parent.trigger_id,
      at, { ...parent.payload, text: follow.text }, parent.chain_depth + 1));
  }
  return accepted;
}
