CREATE TABLE proactive_policies (
  space_key TEXT PRIMARY KEY REFERENCES spaces(id),
  enabled INTEGER NOT NULL, timezone TEXT NOT NULL, quiet_start TEXT NOT NULL, quiet_end TEXT NOT NULL,
  daily_digest_time TEXT, max_daily_pushes INTEGER NOT NULL, cooldown_hours REAL NOT NULL, updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE proactive_triggers (
  trigger_id TEXT PRIMARY KEY, space_key TEXT NOT NULL REFERENCES spaces(id),
  source_type TEXT NOT NULL, dedup_key TEXT NOT NULL, snapshot_version INTEGER NOT NULL,
  fire_at TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
  chain_depth INTEGER NOT NULL CHECK (chain_depth BETWEEN 0 AND 2),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(space_key, dedup_key)
);
--> statement-breakpoint
CREATE INDEX proactive_due ON proactive_triggers(space_key, status, fire_at);
--> statement-breakpoint
CREATE TABLE proactive_outbox (
  nudge_id TEXT PRIMARY KEY, space_key TEXT NOT NULL REFERENCES spaces(id), snapshot_version INTEGER NOT NULL,
  trigger_ids_json TEXT NOT NULL, kind TEXT NOT NULL, urgency TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  suggested_action TEXT, citations_json TEXT NOT NULL, dedup_key TEXT NOT NULL, status TEXT NOT NULL,
  deliver_after TEXT NOT NULL, created_at TEXT NOT NULL, acked_at TEXT, valid_version INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX proactive_delivery ON proactive_outbox(space_key, deliver_after);
--> statement-breakpoint
CREATE INDEX proactive_history ON proactive_outbox(space_key, created_at);
--> statement-breakpoint
CREATE TABLE proactive_nudge_sources (
  space_key TEXT NOT NULL, item_key TEXT NOT NULL, nudge_id TEXT NOT NULL REFERENCES proactive_outbox(nudge_id),
  PRIMARY KEY(space_key, item_key, nudge_id)
);
--> statement-breakpoint
CREATE TABLE proactive_leases (
  space_key TEXT PRIMARY KEY REFERENCES spaces(id), token TEXT NOT NULL, valid_until INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE proactive_plans (
  space_key TEXT PRIMARY KEY REFERENCES spaces(id), snapshot_version INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX proactive_sources_by_nudge ON proactive_nudge_sources(nudge_id);
