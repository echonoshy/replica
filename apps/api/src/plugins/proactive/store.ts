import { randomUUID } from "node:crypto";
import type { Nudge, NudgeAck, NudgesQuery, ProactivePolicy, ProactiveProfile, ProactiveKindStats, ProspectiveIntention, SpaceRef, AckReason } from "@wiki-memory/shared";
import { spaceKey } from "../../db/interfaces.js";
import type { SQLiteConnection } from "../../db/sqlite-repo.js";
import { ServiceError } from "../../errors.js";
import { intentionTimer, timer } from "./planner.js";
import type { Trigger } from "./planner.js";
import { Intentions } from "./intentions.js";
import { iso, localTime } from "./time.js";

export interface SnapshotPlan { timers: Trigger[]; documents: Set<string>; itemKeys?: Set<string> }
function matchesPlan(items: Set<string>, documents: Set<string>, keys: string[], anchors: string[]) {
  return keys.every((k) => items.has(k) || k.startsWith("digest:")) && anchors.every((a) => documents.has(a.split("#")[0]));
}

function retainDerived(t: Trigger, version: number, items: Set<string>, documents: Set<string>) {
  if (t.source_type !== "follow_up" && t.source_type !== "snooze") return false;
  const needsRecheck = t.payload.item_keys.some(k => /^(fact|conflict|intention|redline):/.test(k));
  return (!needsRecheck && t.snapshot_version === version) || matchesPlan(items, documents, t.payload.item_keys, t.payload.anchors);
}

export const defaults: ProactivePolicy = {
  enabled: true, timezone: "Asia/Shanghai", quiet_start: "22:00", quiet_end: "08:00",
  daily_digest_time: "08:30", max_daily_pushes: 3, cooldown_hours: 24,
};
type NudgeRow = Omit<Nudge, "citations" | "trigger_ids" | "proposed_actions" | "utility_score"> & {
  citations_json: string; trigger_ids_json: string; space_key: string; valid_version: number;
  proposed_actions_json: string | null; utility_score_json: string | null; keep_reminding: number;
};
function nudge(row: NudgeRow): Nudge {
  const { citations_json, trigger_ids_json, space_key, valid_version, keep_reminding, proposed_actions_json,
    utility_score_json, prepared_brief, why_now, intention_id, ack_reason, ...fields } = row;
  const actions: Nudge["proposed_actions"] = proposed_actions_json ? JSON.parse(proposed_actions_json) : [];
  return { ...fields, session_id: fields.session_id ?? null, citations: JSON.parse(citations_json), trigger_ids: JSON.parse(trigger_ids_json),
    ...(actions?.length && { proposed_actions: actions }), ...(utility_score_json && { utility_score: JSON.parse(utility_score_json) }),
    ...(prepared_brief && { prepared_brief }), ...(why_now && { why_now }), ...(intention_id && { intention_id }), ...(ack_reason && { ack_reason }) };
}

export class Store {
  readonly intentions: Intentions;
  constructor(readonly connection: SQLiteConnection) {
    this.intentions = new Intentions(connection);
    this.connection.transaction(() => {
      const migrate = (table: string, additions: Record<string, string>) => {
        const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
        for (const [name, type] of Object.entries(additions)) {
          if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        }
      };
      migrate("proactive_policies", { strict_urgent_quiet_guard: "INTEGER NOT NULL DEFAULT 0" });
      migrate("proactive_outbox", { session_id: "TEXT", prepared_brief: "TEXT", proposed_actions_json: "TEXT",
        utility_score_json: "TEXT", why_now: "TEXT", intention_id: "TEXT", ack_reason: "TEXT", keep_reminding: "INTEGER NOT NULL DEFAULT 0" });
      this.db.exec(`CREATE TABLE IF NOT EXISTS proactive_intentions (
        intention_id TEXT PRIMARY KEY, space_key TEXT NOT NULL REFERENCES spaces(id), kind TEXT NOT NULL,
        goal TEXT NOT NULL, condition_json TEXT NOT NULL, subjects_json TEXT NOT NULL, priority TEXT NOT NULL,
        status TEXT NOT NULL, evidence_anchors_json TEXT NOT NULL, source TEXT NOT NULL, snoozed_until TEXT,
        snapshot_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_proactive_intentions_space ON proactive_intentions(space_key,status,kind);
        CREATE TABLE IF NOT EXISTS proactive_deleted_intentions (
        space_key TEXT NOT NULL REFERENCES spaces(id), intention_id TEXT NOT NULL, PRIMARY KEY(space_key,intention_id));
        CREATE TABLE IF NOT EXISTS proactive_events_log (
        event_id TEXT PRIMARY KEY, space_key TEXT NOT NULL REFERENCES spaces(id), event_type TEXT NOT NULL,
        summary TEXT NOT NULL, entities_json TEXT NOT NULL, occurred_at TEXT NOT NULL, l1_match_count INTEGER NOT NULL,
        llm_called INTEGER NOT NULL, decision_summary TEXT NOT NULL, created_at TEXT NOT NULL);`);
    });
  }
  private get db() { return this.connection.client; }

  policy(key: string): ProactivePolicy {
    const row = this.db.prepare<[string], ProactivePolicy>(`SELECT enabled, timezone, quiet_start, quiet_end,
      daily_digest_time, max_daily_pushes, cooldown_hours, strict_urgent_quiet_guard FROM proactive_policies WHERE space_key=?`).get(key);
    if (!row) return { ...defaults };
    const { strict_urgent_quiet_guard, ...fields } = row;
    return { ...fields, enabled: !!row.enabled, ...(strict_urgent_quiet_guard ? { strict_urgent_quiet_guard: true } : {}) };
  }
  savePolicy(key: string, p: ProactivePolicy, now: string) {
    this.db.prepare("INSERT OR REPLACE INTO proactive_policies (space_key,enabled,timezone,quiet_start,quiet_end,daily_digest_time,max_daily_pushes,cooldown_hours,updated_at,strict_urgent_quiet_guard) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(key, Number(p.enabled), p.timezone, p.quiet_start, p.quiet_end, p.daily_digest_time, p.max_daily_pushes, p.cooldown_hours, now, Number(!!p.strict_urgent_quiet_guard));
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
      WHERE proactive_triggers.status='cancelled' OR (excluded.source_type='open_loop' AND fire_at<>excluded.fire_at) OR (proactive_triggers.status='pending' AND (snapshot_version<>excluded.snapshot_version
      OR fire_at<>excluded.fire_at OR payload_json<>excluded.payload_json))`)
      .run(t.trigger_id, key, t.source_type, t.dedup_key, t.snapshot_version, t.fire_at, JSON.stringify(t.payload), t.chain_depth, now, now);
  }
  syncIntentionTimer(ref: SpaceRef, version: number, id: string, intention: ProspectiveIntention | undefined, now: string) {
    const key = spaceKey(ref);
    const t = intention && intentionTimer(ref, version, intention);
    if (t) this.schedule(key, t, now);
    else this.db.prepare("UPDATE proactive_triggers SET status='cancelled',updated_at=? WHERE space_key=? AND dedup_key=? AND status='pending'")
      .run(now, key, "intention:" + id);
    if (!intention || ["fulfilled", "cancelled", "expired"].includes(intention.status)) {
      this.db.prepare(`UPDATE proactive_triggers SET status='cancelled',updated_at=? WHERE space_key=?
        AND status='pending' AND json_extract(payload_json,'$.intention_id')=?`).run(now, key, id);
    }
  }
  reconcile(key: string, version: number, { timers: planned, documents, itemKeys }: SnapshotPlan, now: string) {
    const keys = new Set(planned.map((t) => t.dedup_key));
    const items = new Set([...(itemKeys ?? []), ...planned.flatMap(t => t.payload.item_keys)]);
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
      if (retainDerived(t, version, items, documents)) {
        if (t.snapshot_version !== version) this.schedule(key, { ...t, snapshot_version: version }, now);
        continue;
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
    const items = new Set([...(plan?.itemKeys ?? []), ...(plan?.timers.flatMap(t => t.payload.item_keys) ?? [])]);
    const plannedKeys = new Set(plan?.timers.map(t => t.dedup_key));
    for (const t of this.pending(key, now)) {
      if (t.source_type === "daily_digest") continue;
      if (!plan) due.set(t.trigger_id, t);
      else if (retainDerived(t, version, items, plan.documents)) {
        due.set(t.trigger_id, { ...t, snapshot_version: version });
      } else if (plannedKeys.has(t.dedup_key) && this.feedback(key, t.payload.item_keys)) {
        due.set(t.trigger_id, t);
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
      FROM proactive_nudge_sources s JOIN proactive_outbox o USING(nudge_id) WHERE s.space_key=? AND s.item_key=? AND NOT (o.status='read' AND o.keep_reminding=1)`).all(key, item);
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
    type WorkingRow = Pick<Nudge, "title" | "status" | "dedup_key" | "deliver_after" | "kind" | "acked_at"> & {
      anchor: string | null;
      engaged: number;
    };
    return this.db.prepare<[string, string, string], WorkingRow>(`SELECT title, status, dedup_key, deliver_after,
      kind, acked_at, session_id IS NOT NULL AS engaged,
      json_extract(citations_json, '$[0].anchor') AS anchor FROM proactive_outbox
      WHERE space_key=? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC, rowid DESC LIMIT 40`)
      .all(key, since, now).map(({ engaged, ...row }) => ({ ...row, engaged: Boolean(engaged) }));
  }
  insert(key: string, n: Nudge, items: string[]) {
    this.db.prepare(`INSERT INTO proactive_outbox (
      nudge_id, space_key, snapshot_version, trigger_ids_json, kind, urgency, title, body, suggested_action,
      citations_json, dedup_key, status, deliver_after, created_at, acked_at, valid_version, session_id, prepared_brief, proposed_actions_json, utility_score_json, why_now, intention_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      n.nudge_id, key, n.snapshot_version, JSON.stringify(n.trigger_ids), n.kind, n.urgency, n.title, n.body,
      n.suggested_action, JSON.stringify(n.citations), n.dedup_key, n.status, n.deliver_after, n.created_at, n.acked_at,
      n.snapshot_version, n.session_id ?? null, n.prepared_brief ?? null, n.proposed_actions?.length ? JSON.stringify(n.proposed_actions) : null,
      n.utility_score ? JSON.stringify(n.utility_score) : null, n.why_now ?? null, n.intention_id ?? null,
    );
    const source = this.db.prepare("INSERT INTO proactive_nudge_sources VALUES (?,?,?)");
    for (const item of items) source.run(key, item, n.nudge_id);
  }
  getNudge(spaceKey: string, nudgeId: string, currentVersion?: number): Nudge | undefined {
    const row = this.db.prepare<[string, string], NudgeRow>(
      "SELECT * FROM proactive_outbox WHERE space_key=? AND nudge_id=?",
    ).get(spaceKey, nudgeId);
    if (row && currentVersion !== undefined && row.snapshot_version > 0 && row.valid_version !== currentVersion)
      throw new ServiceError(409, "SNAPSHOT_CHANGED", "This nudge belongs to a previous snapshot");
    return row ? nudge(row) : undefined;
  }
  linkSession(spaceKey: string, nudgeId: string, sessionId: string, ms: number): Nudge {
    return this.db.transaction(() => {
      const current = this.getNudge(spaceKey, nudgeId);
      if (!current) throw new ServiceError(404, "NUDGE_NOT_FOUND", "Nudge not found in this space");
      const now = iso(ms);
      const shouldRead = current.status === "pending" || current.status === "snoozed";
      const row = this.db.prepare<[string, Nudge["status"], string | null, string, string], NudgeRow>(
        "UPDATE proactive_outbox SET session_id=?, status=?, acked_at=? WHERE space_key=? AND nudge_id=? RETURNING *",
      ).get(sessionId, shouldRead ? "read" : current.status, shouldRead ? now : current.acked_at, spaceKey, nudgeId)!;
      if (shouldRead) this.cancelSnooze(spaceKey, nudgeId, now);
      return nudge(row);
    }).immediate();
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
  private cancelSnooze(key: string, id: string, now: string) {
    this.db.prepare("UPDATE proactive_triggers SET status='cancelled', updated_at=? WHERE space_key=? AND dedup_key=? AND status='pending'")
      .run(now, key, "snooze:" + id);
  }
  ack(id: string, action: NudgeAck, currentVersion: () => number, ms: number) {
    const key = spaceKey(action), now = iso(ms);
    return this.db.transaction(() => {
      const get = this.db.prepare<[string, string], NudgeRow>("SELECT * FROM proactive_outbox WHERE space_key=? AND nudge_id=?");
      const row = get.get(key, id);
      if (!row) throw new ServiceError(404, "NUDGE_NOT_FOUND", "Nudge not found in this space");
      if (action.action === "snooze" && Date.parse(action.snooze_until) <= ms)
        throw new ServiceError(400, "VALIDATION_ERROR", "snooze_until must be in the future");
      if (row.status === action.action) {
        const keep = Number(action.action === "read" && !!action.keep_reminding);
        if ((action.reason !== undefined && action.reason !== row.ack_reason) || row.keep_reminding !== keep) {
          this.db.prepare("UPDATE proactive_outbox SET ack_reason=coalesce(?,ack_reason),keep_reminding=? WHERE nudge_id=?")
            .run(action.reason ?? null, keep, id);
        }
        return nudge(get.get(key, id)!);
      }
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
          ...(original.intention_id && { intention_id: original.intention_id }),
        }, Math.max(0, ...parents.map((p) => p.chain_depth))), now);
      } else {
        this.cancelSnooze(key, id, now);
      }
      this.db.prepare("UPDATE proactive_outbox SET status=?, acked_at=?, ack_reason=?, keep_reminding=? WHERE nudge_id=?")
        .run(action.action === "snooze" ? "snoozed" : action.action, now, action.reason ?? null, Number(action.action === "read" && !!action.keep_reminding), id);
      return nudge(get.get(key, id)!);
    }).immediate();
  }
  profile(ref: SpaceRef, ms: number): ProactiveProfile {
    const key = spaceKey(ref), zone = this.policy(key).timezone;
    const rows = this.db.prepare<[string], Omit<ProactiveKindStats, "acceptance_rate">>(`SELECT kind,count(*) total,
      sum(status='completed') completed,sum(status='read') read,sum(status='dismissed') dismissed,sum(status='snoozed') snoozed
      FROM proactive_outbox WHERE space_key=? GROUP BY kind ORDER BY kind`).all(key);
    const by_kind = rows.map(row => ({ ...row, acceptance_rate: (row.completed + row.read) / row.total }));
    const total = rows.reduce((n, r) => n + r.total, 0);
    const accepted = rows.reduce((n, r) => n + r.completed + r.read, 0);
    const hours = new Map<number, number>();
    for (const { acked_at } of this.db.prepare<[string], { acked_at: string }>(`SELECT acked_at FROM proactive_outbox
      WHERE space_key=? AND status IN ('completed','read') AND acked_at IS NOT NULL`).iterate(key)) {
      const hour = Number(localTime(Date.parse(acked_at), zone).time.slice(0, 2));
      hours.set(hour, (hours.get(hour) ?? 0) + 1);
    }
    return { space: { namespace: ref.namespace, space_id: ref.space_id }, total_nudges: total,
      overall_acceptance_rate: total ? accepted / total : 0, by_kind,
      top_dismiss_reasons: this.db.prepare<[string], { reason: AckReason; count: number }>(`SELECT ack_reason reason,count(*) count
        FROM proactive_outbox WHERE space_key=? AND status='dismissed' AND ack_reason IS NOT NULL GROUP BY ack_reason ORDER BY count DESC,reason`).all(key),
      preferred_hours: [...hours.keys()].sort((a,b) => hours.get(b)! - hours.get(a)! || a-b),
      active_intentions_count: Number(this.db.prepare("SELECT count(*) FROM proactive_intentions WHERE space_key=? AND status='armed'").pluck().get(key)),
      updated_at: iso(ms) };
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
