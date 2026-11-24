import { randomUUID } from "node:crypto";
import type { Nudge, NudgeAck, NudgesQuery, ProactivePolicy } from "@replica/shared";
import { spaceKey } from "../../db/interfaces.js";
import type { SQLiteConnection } from "../../db/sqlite-repo.js";
import { ServiceError } from "../../errors.js";
import { timer } from "./planner.js";
import type { Trigger } from "./planner.js";
import { iso } from "./time.js";

export interface SnapshotPlan { timers: Trigger[]; documents: Set<string> }
function matchesPlan(items: Set<string>, documents: Set<string>, keys: string[], anchors: string[]) {
  return keys.every((k) => items.has(k) || k.startsWith("digest:")) && anchors.every((a) => documents.has(a.split("#")[0]));
}

export const defaults: ProactivePolicy = {
  enabled: true, timezone: "Asia/Shanghai", quiet_start: "22:00", quiet_end: "08:00",
  daily_digest_time: "08:30", max_daily_pushes: 5, cooldown_hours: 24,
};
type NudgeRow = Omit<Nudge, "citations" | "trigger_ids"> & { citations_json: string; trigger_ids_json: string; space_key: string; valid_version: number };
function nudge({ citations_json, trigger_ids_json, space_key, valid_version, ...fields }: NudgeRow): Nudge {
  return { ...fields, citations: JSON.parse(citations_json), trigger_ids: JSON.parse(trigger_ids_json) };
}

export class Store {
  constructor(readonly connection: SQLiteConnection) {}
  private get db() { return this.connection.client; }

  policy(key: string): ProactivePolicy {
    const row = this.db.prepare<[string], ProactivePolicy>(`SELECT enabled, timezone, quiet_start, quiet_end,
      daily_digest_time, max_daily_pushes, cooldown_hours FROM proactive_policies WHERE space_key=?`).get(key);
    return row ? { ...row, enabled: !!row.enabled } : { ...defaults };
  }
  savePolicy(key: string, p: ProactivePolicy, now: string) {
    this.db.prepare("INSERT OR REPLACE INTO proactive_policies VALUES (?,?,?,?,?,?,?,?,?)")
      .run(key, Number(p.enabled), p.timezone, p.quiet_start, p.quiet_end, p.daily_digest_time, p.max_daily_pushes, p.cooldown_hours, now);
  }
  planned(key: string) {
    return this.db.prepare("SELECT snapshot_version FROM proactive_plans WHERE space_key=?").pluck().get(key);
  }
  pending(key: string, until = "9999-12-31T23:59:59.999Z") {
    type Row = Omit<Trigger, "payload"> & { payload_json: string };
    return this.db.prepare<[string, string], Row>(`SELECT trigger_id, dedup_key, source_type, snapshot_version, fire_at,
      payload_json, chain_depth FROM proactive_triggers WHERE space_key=? AND status='pending' AND fire_at<=?
      ORDER BY fire_at, trigger_id`).all(key, until).map(({ payload_json, ...row }): Trigger => ({ ...row, payload: JSON.parse(payload_json) }));
  }
  hasDue(key: string, now: string) {
    return !!this.db.prepare("SELECT 1 FROM proactive_triggers WHERE space_key=? AND status='pending' AND fire_at<=? LIMIT 1").get(key, now);
  }
  status(key: string, dedup: string) {
    return this.db.prepare("SELECT status FROM proactive_triggers WHERE space_key=? AND dedup_key=?").pluck().get(key, dedup);
  }
  mark(id: string, status: string, now: string) {
    this.db.prepare("UPDATE proactive_triggers SET status=?, updated_at=? WHERE trigger_id=? AND status='pending'").run(status, now, id);
  }
  schedule(key: string, t: Trigger, now: string) {
    this.db.prepare(`INSERT INTO proactive_triggers VALUES (?,?,?,?,?,?,'pending',?,?,?,?)
      ON CONFLICT(space_key,dedup_key) DO UPDATE SET snapshot_version=excluded.snapshot_version,
      fire_at=excluded.fire_at, status='pending', payload_json=excluded.payload_json, updated_at=excluded.updated_at
      WHERE proactive_triggers.status='cancelled' OR (proactive_triggers.status='pending' AND (snapshot_version<>excluded.snapshot_version
      OR fire_at<>excluded.fire_at OR payload_json<>excluded.payload_json))`)
      .run(t.trigger_id, key, t.source_type, t.dedup_key, t.snapshot_version, t.fire_at, JSON.stringify(t.payload), t.chain_depth, now, now);
  }
  reconcile(key: string, version: number, { timers: planned, documents }: SnapshotPlan, now: string) {
    const keys = new Set(planned.map((t) => t.dedup_key));
    const items = new Set(planned.flatMap((t) => t.payload.item_keys));
    // A future delivery can already be in the Outbox when a rollback removes its evidence.
    const open = this.db.prepare<[string, number], NudgeRow>(`SELECT * FROM proactive_outbox WHERE space_key=?
      AND valid_version<>? AND status IN ('pending','snoozed','read')`).all(key, version);
    for (const row of open) {
      const valid = matchesPlan(items, documents, this.itemKeys(row.nudge_id), nudge(row).citations.map((c) => c.anchor));
      if (valid) this.db.prepare("UPDATE proactive_outbox SET valid_version=? WHERE nudge_id=?").run(version, row.nudge_id);
      else if (row.status !== "read") this.db.prepare("UPDATE proactive_outbox SET status='expired' WHERE nudge_id=?").run(row.nudge_id);
    }
    for (const t of this.pending(key)) {
      if (t.source_type === "daily_digest") continue;
      if (t.source_type === "follow_up" || t.source_type === "snooze") {
        if (t.snapshot_version === version) continue;
        if (matchesPlan(items, documents, t.payload.item_keys, t.payload.anchors)) {
          this.schedule(key, { ...t, snapshot_version: version }, now);
          continue;
        }
      }
      if (!keys.has(t.dedup_key)) this.mark(t.trigger_id, "cancelled", now);
    }
    for (const t of planned) {
      if (!this.feedback(key, t.payload.item_keys)) this.schedule(key, t, now);
    }
    this.db.prepare("INSERT OR REPLACE INTO proactive_plans VALUES (?,?)").run(key, version);
  }
  previewDue(key: string, version: number, plan: SnapshotPlan | undefined, calendar: Trigger[], now: string) {
    const due = new Map<string, Trigger>();
    const items = new Set(plan?.timers.flatMap((t) => t.payload.item_keys));
    for (const t of this.pending(key, now)) {
      if (t.source_type === "daily_digest") continue;
      if (!plan || t.snapshot_version === version) due.set(t.trigger_id, t);
      else if (["snooze", "follow_up"].includes(t.source_type) &&
        matchesPlan(items, plan.documents, t.payload.item_keys, t.payload.anchors)) {
        due.set(t.trigger_id, { ...t, snapshot_version: version });
      }
    }
    for (const t of [...(plan?.timers ?? []), ...calendar]) {
      const status = this.status(key, t.dedup_key);
      if (t.fire_at <= now && (!status || status === "pending" || status === "cancelled") && !this.feedback(key, t.payload.item_keys))
        due.set(t.trigger_id, t);
    }
    return [...due.values()];
  }
  syncDigests(key: string, timers: Trigger[], now: string) {
    const [today, next] = timers;
    // Drop obsolete, unconsumed calendar slots. Completed days retain their receipt.
    this.db.prepare(`DELETE FROM proactive_triggers WHERE space_key=? AND source_type='daily_digest'
      AND status='pending' AND dedup_key NOT IN (?,?)`).run(key, today?.dedup_key ?? "", next?.dedup_key ?? "");
    for (const t of timers) this.schedule(key, t, now);
  }
  private itemKeys(id: string) {
    return this.db.prepare("SELECT item_key FROM proactive_nudge_sources WHERE nudge_id=?").pluck().all(id) as string[];
  }
  private history(key: string, item: string) {
    return this.db.prepare<[string, string], Pick<Nudge, "status" | "created_at" | "nudge_id">>(`SELECT o.status, o.created_at, o.nudge_id
      FROM proactive_nudge_sources s JOIN proactive_outbox o USING(nudge_id) WHERE s.space_key=? AND s.item_key=?`).all(key, item);
  }
  feedback(key: string, items: string[]) {
    return items.some((item) => this.history(key, item).some((row) => ["completed", "dismissed", "read"].includes(row.status)));
  }
  blocked(key: string, t: Trigger, ms: number, cooldown: number): string | undefined {
    for (const item of t.payload.item_keys) {
      for (const row of this.history(key, item)) {
        if (row.status === "expired") continue;
        if (["completed", "dismissed", "read"].includes(row.status)) return "feedback";
        if (row.status === "snoozed") {
          if (t.source_type !== "snooze" && this.status(key, "snooze:" + row.nudge_id) === "pending") return "snoozed";
          continue;
        }
        if (row.nudge_id !== t.payload.nudge_id && Date.parse(row.created_at) > ms - cooldown * 3_600_000) return "cooldown";
      }
    }
  }
  countDay(key: string, start: string, end: string) {
    return Number(this.db.prepare("SELECT count(*) FROM proactive_outbox WHERE space_key=? AND status<>'expired' AND deliver_after>=? AND deliver_after<?")
      .pluck().get(key, start, end));
  }
  working(key: string, since: string, now: string) {
    return this.db.prepare(`SELECT title, status, dedup_key, deliver_after,
      json_extract(citations_json, '$[0].anchor') AS anchor FROM proactive_outbox
      WHERE space_key=? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC, rowid DESC LIMIT 40`).all(key, since, now);
  }
  insert(key: string, n: Nudge, items: string[]) {
    this.db.prepare("INSERT INTO proactive_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      n.nudge_id, key, n.snapshot_version, JSON.stringify(n.trigger_ids), n.kind, n.urgency, n.title, n.body,
      n.suggested_action, JSON.stringify(n.citations), n.dedup_key, n.status, n.deliver_after, n.created_at, n.acked_at, n.snapshot_version,
    );
    const source = this.db.prepare("INSERT INTO proactive_nudge_sources VALUES (?,?,?)");
    for (const item of items) source.run(key, item, n.nudge_id);
  }
  list(q: NudgesQuery, now: string) {
    const args = [spaceKey(q), now, ...(q.status === "all" ? [] : [q.status])];
    const where = "WHERE space_key=? AND deliver_after<=?" + (q.status === "all" ? "" : " AND status=?");
    const total = Number(this.db.prepare("SELECT count(*) FROM proactive_outbox " + where).pluck().get(...args));
    const rows = this.db.prepare<unknown[], NudgeRow>("SELECT * FROM proactive_outbox " + where + " ORDER BY deliver_after DESC, rowid DESC LIMIT ?").all(...args, q.limit);
    return { space: { namespace: q.namespace, space_id: q.space_id }, nudges: rows.map(nudge), total };
  }
  watermark(key: string) {
    return Number(this.db.prepare("SELECT coalesce(max(rowid),0) FROM proactive_outbox WHERE space_key=?").pluck().get(key));
  }
  visibleSince(key: string, row: number, after: string, now: string) {
    return this.db.prepare<unknown[], NudgeRow>(`SELECT * FROM proactive_outbox WHERE space_key=? AND status='pending'
      AND deliver_after<=? AND (rowid>? OR deliver_after>?) ORDER BY deliver_after,rowid`).all(key, now, row, after).map(nudge);
  }
  nextDelivery(key: string, now: string) {
    return this.db.prepare<[string, string], string>("SELECT deliver_after FROM proactive_outbox WHERE space_key=? AND status='pending' AND deliver_after>? ORDER BY deliver_after LIMIT 1")
      .pluck().get(key, now) as string | undefined;
  }
  ack(id: string, action: NudgeAck, currentVersion: () => number, ms: number) {
    const key = spaceKey(action), now = iso(ms);
    return this.connection.transaction(() => {
      const get = this.db.prepare<[string, string], NudgeRow>("SELECT * FROM proactive_outbox WHERE space_key=? AND nudge_id=?");
      const row = get.get(key, id);
      if (!row) throw new ServiceError(404, "NUDGE_NOT_FOUND", "Nudge not found in this space");
      if (action.action === "snooze" && Date.parse(action.snooze_until) <= ms)
        throw new ServiceError(400, "VALIDATION_ERROR", "snooze_until must be in the future");
      if (row.status === action.action) return nudge(row);
      if (["completed", "dismissed", "expired"].includes(row.status))
        throw new ServiceError(409, "NUDGE_CLOSED", "This nudge is already closed");
      const snoozeKey = "snooze:" + id;
      if (action.action === "snooze") {
        const version = currentVersion();
        if (row.valid_version !== version)
          throw new ServiceError(409, "SNAPSHOT_CHANGED", "This nudge belongs to a previous snapshot");
        const prior = this.status(key, snoozeKey);
        if (prior && prior !== "pending") throw new ServiceError(409, "NUDGE_CLOSED", "This snooze has already been consumed");
        const original = nudge(row);
        const items = this.itemKeys(id);
        const parents = this.db.prepare<[string], {chain_depth: number}>(
          "SELECT chain_depth FROM proactive_triggers WHERE trigger_id IN (SELECT value FROM json_each(?))",
        ).all(row.trigger_ids_json);
        this.schedule(key, timer(action, version, "snooze", snoozeKey, Date.parse(action.snooze_until), {
          text: original.body, subjects: [], anchors: original.citations.map((c) => c.anchor), item_keys: items, nudge_id: id,
        }, Math.max(0, ...parents.map((p) => p.chain_depth))), now);
      } else {
        this.db.prepare("UPDATE proactive_triggers SET status='cancelled', updated_at=? WHERE space_key=? AND dedup_key=? AND status='pending'")
          .run(now, key, snoozeKey);
      }
      this.db.prepare("UPDATE proactive_outbox SET status=?, acked_at=? WHERE nudge_id=?")
        .run(action.action === "snooze" ? "snoozed" : action.action, now, id);
      return nudge(get.get(key, id)!);
    });
  }
  checkAvailable(key: string) {
    if (this.db.prepare("SELECT 1 FROM proactive_leases WHERE space_key=? AND valid_until>?").get(key, Date.now()))
      throw new ServiceError(409, "PROACTIVE_BUSY", "Evaluation in progress");
  }
  lease(key: string) {
    const token = randomUUID();
    const acquired = this.db.prepare(`INSERT INTO proactive_leases VALUES (?,?,?)
      ON CONFLICT(space_key) DO UPDATE SET token=excluded.token, valid_until=excluded.valid_until
      WHERE valid_until<=?`).run(key, token, Date.now() + 45_000, Date.now());
    if (!acquired.changes) throw new ServiceError(409, "PROACTIVE_BUSY", "Evaluation in progress");
    const heart = setInterval(() => {
      try {
        this.db.prepare("UPDATE proactive_leases SET valid_until=? WHERE space_key=? AND token=? AND valid_until>?")
          .run(Date.now() + 45_000, key, token, Date.now());
      } catch { /* The closing transaction checks ownership and expiry before committing. */ }
    }, 10_000).unref();
    return {
      check: () => {
        if (!this.db.prepare("SELECT 1 FROM proactive_leases WHERE space_key=? AND token=? AND valid_until>?").get(key, token, Date.now()))
          throw new ServiceError(409, "LEASE_LOST", "Evaluation lease expired");
      },
      release: () => {
        clearInterval(heart);
        this.db.prepare("DELETE FROM proactive_leases WHERE space_key=? AND token=?").run(key, token);
      },
    };
  }
}
