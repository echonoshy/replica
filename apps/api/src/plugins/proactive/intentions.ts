import { randomUUID } from "node:crypto";
import type {
  CreateIntentionInput, IntentionsQuery, ProspectiveIntention, SpaceRef, UpdateIntentionInput,
} from "@wiki-memory/shared";
import type { SQLiteConnection } from "../../db/sqlite-repo.js";
import { spaceKey } from "../../db/interfaces.js";
import { ServiceError } from "../../errors.js";
import { anchorKey, claimAnchors } from "../../pipeline/analyzer.js";
import type { IntentionClaim } from "../../pipeline/analyzer.js";
import { iso, wallTime } from "./time.js";

type Intention = ProspectiveIntention;
type Row = Omit<Intention, "condition" | "subjects" | "evidence_anchors"> & {
  condition_json: string; subjects_json: string; evidence_anchors_json: string; snapshot_version: number | null;
};

function decode({ condition_json, subjects_json, evidence_anchors_json, snapshot_version, ...fields }: Row): Intention {
  return { ...fields, condition: JSON.parse(condition_json), subjects: JSON.parse(subjects_json),
    evidence_anchors: JSON.parse(evidence_anchors_json) };
}

function instant(value: string | null | undefined, zone: string, end = false) {
  if (!value) return undefined;
  if (!Number.isFinite(Date.parse(value))) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return iso(wallTime(value, end ? "23:59" : "00:00", zone));
  return iso(Date.parse(value));
}

export class Intentions {
  constructor(private readonly connection: SQLiteConnection) {}
  private get db() { return this.connection.client; }

  get(key: string, id: string) {
    const row = this.db.prepare<[string, string], Row>(
      "SELECT * FROM proactive_intentions WHERE space_key=? AND intention_id=?").get(key, id);
    return row && decode(row);
  }
  armed(key: string) {
    return this.db.prepare<[string], Row>("SELECT * FROM proactive_intentions WHERE space_key=? AND status='armed' ORDER BY intention_id")
      .all(key).map(decode);
  }
  scoutFindings(key: string) {
    return this.db.prepare<[string], Pick<Row, "goal" | "evidence_anchors_json">>(
      "SELECT goal,evidence_anchors_json FROM proactive_intentions WHERE space_key=? AND source='scout'"
    ).all(key).map(row => ({ goal: row.goal, evidence_anchors: JSON.parse(row.evidence_anchors_json) as string[] }));
  }
  list(q: IntentionsQuery) {
    const filters = ["space_key=?"];
    const args = [spaceKey(q)];
    if (q.status !== "all") { filters.push("status=?"); args.push(q.status); }
    if (q.kind !== "all") { filters.push("kind=?"); args.push(q.kind); }
    const clause = " FROM proactive_intentions WHERE " + filters.join(" AND ");
    return {
      space: { namespace: q.namespace, space_id: q.space_id },
      total: Number(this.db.prepare("SELECT count(*)" + clause).pluck().get(...args)),
      intentions: this.db.prepare<unknown[], Row>("SELECT *" + clause + " ORDER BY updated_at DESC,intention_id LIMIT ?")
        .all(...args, q.limit).map(decode),
    };
  }

  private insert(i: Intention, version: number | null) {
    this.db.prepare(`INSERT INTO proactive_intentions (intention_id,space_key,kind,goal,condition_json,subjects_json,
      priority,status,evidence_anchors_json,source,snoozed_until,snapshot_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(i.intention_id, i.space_key, i.kind, i.goal, JSON.stringify(i.condition),
        JSON.stringify(i.subjects), i.priority, i.status, JSON.stringify(i.evidence_anchors), i.source, i.snoozed_until,
        version, i.created_at, i.updated_at);
    return i;
  }

  create(input: CreateIntentionInput, now: string, version: number) {
    const { namespace, space_id, ...fields } = input;
    return this.insert({ ...fields, space_key: spaceKey(input), intention_id: "intention_" + randomUUID(),
      created_at: now, updated_at: now, status: "armed", snoozed_until: null }, input.source === "scout" ? version : null);
  }
  update(id: string, input: UpdateIntentionInput, now: string) {
    const key = spaceKey(input);
    const prior = this.get(key, id);
    if (!prior) throw new ServiceError(404, "INTENTION_NOT_FOUND", "Intention not found in this space");
    const next = { ...prior, ...input };
    // Multiple edits can share a clock tick. Keep updated_at usable as a revision.
    const updatedAt = iso(Math.max(Date.parse(now), Date.parse(prior.updated_at) + 1));
    this.db.prepare(`UPDATE proactive_intentions SET goal=?,condition_json=?,priority=?,status=?,snoozed_until=?,updated_at=?,
      snapshot_version=CASE WHEN source='memory' AND ? THEN NULL ELSE snapshot_version END
      WHERE space_key=? AND intention_id=?`).run(next.goal, JSON.stringify(next.condition), next.priority, next.status,
        next.snoozed_until, updatedAt, Number(input.status !== undefined), key, id);
    return this.get(key, id)!;
  }
  delete(key: string, id: string) {
    // A published claim can be planned more than once. Keep a private deletion
    // receipt for extracted claims so that replanning cannot undo a user's delete.
    if (this.get(key, id)?.source === "memory") {
      this.db.prepare("INSERT OR IGNORE INTO proactive_deleted_intentions(space_key,intention_id) VALUES (?,?)").run(key, id);
    }
    return !!this.db.prepare("DELETE FROM proactive_intentions WHERE space_key=? AND intention_id=?").run(key, id).changes;
  }

  // Calculate the same projection for previews and commits. Existing rows retain user edits and status.
  project(ref: SpaceRef, claims: IntentionClaim[], documents: Set<string>, zone: string, version: number, now: string, persist: boolean) {
    const key = spaceKey(ref);
    const armed = new Map(this.armed(key).map(i => [i.intention_id, i]));
    const deleted = new Set(this.db.prepare("SELECT intention_id FROM proactive_deleted_intentions WHERE space_key=?").pluck().all(key));
    const saved = new Map(this.db.prepare<[string], Row>(
      "SELECT * FROM proactive_intentions WHERE space_key=? AND source='memory'").all(key).map(r => [r.intention_id, r]));
    const present = new Set<string>();
    for (const c of claims) {
      const evidence = claimAnchors(c).filter(a => documents.has(a.docId)).map(anchorKey);
      if (!evidence.length) continue;
      const id = c.intention_id;
      present.add(id);
      const prior = saved.get(id);
      if (deleted.has(id)) continue;
      if (prior) {
        // Only revive automatic expiry. A manual transition clears snapshot_version.
        const restored = prior.status === "expired" && prior.snapshot_version !== null;
        const changed = prior.evidence_anchors_json !== JSON.stringify(evidence);
        if (restored || changed) {
          const status = restored ? "armed" : prior.status;
          if (persist) this.db.prepare(`UPDATE proactive_intentions SET evidence_anchors_json=?,snapshot_version=?,updated_at=?,status=?
            WHERE space_key=? AND intention_id=?`).run(JSON.stringify(evidence), prior.snapshot_version === null ? null : version, now, status, key, id);
          if (status === "armed") armed.set(id, { ...decode({ ...prior, status }), evidence_anchors: evidence, updated_at: now });
        }
        continue;
      }
      const i: Intention = { intention_id: id, space_key: key, kind: c.intention_kind, goal: c.goal,
        priority: c.priority ?? "normal", subjects: c.subjects, evidence_anchors: evidence, source: "memory",
        condition: { cue_text: c.cue_text, match_event_types: c.match_event_types, fire_at: instant(c.fire_at, zone),
          stale_after_days: c.stale_after_days, deadline: instant(c.deadline, zone, true), rrule: c.rrule },
        status: "armed", snoozed_until: null, created_at: instant(c.docDate, zone) ?? now, updated_at: now };
      if (persist) this.insert(i, version);
      armed.set(id, i);
    }
    for (const [id, i] of armed) if (i.source === "memory" && !present.has(id)) armed.delete(id);
    if (persist) this.db.prepare(`UPDATE proactive_intentions SET status='expired',snapshot_version=?,updated_at=?
      WHERE space_key=? AND source='memory' AND status IN ('armed','snoozed','triggered')
      AND intention_id NOT IN (SELECT value FROM json_each(?))`).run(version, now, key, JSON.stringify([...present]));
    const scouts = this.db.prepare<[string], Pick<Row, "intention_id" | "evidence_anchors_json">>(
      `SELECT intention_id,evidence_anchors_json FROM proactive_intentions
       WHERE space_key=? AND source='scout' AND status IN ('armed','snoozed','triggered')`
    ).all(key);
    for (const row of scouts) {
      const anchors: string[] = JSON.parse(row.evidence_anchors_json);
      if (anchors.every(anchor => documents.has(anchor.split("#")[0]))) continue;
      armed.delete(row.intention_id);
      if (persist) this.db.prepare("UPDATE proactive_intentions SET status='expired',updated_at=? WHERE space_key=? AND intention_id=?")
        .run(now, key, row.intention_id);
    }
    return [...armed.values()];
  }
}
