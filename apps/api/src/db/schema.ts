import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { DocumentExtension, JobProgress, JobStatus, JobUsage, Warning } from "@wiki-memory/shared";
import type { JobPayload, SnapshotRecord } from "./interfaces.js";

export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  spaceId: text("space_id").notNull(),
  purpose: text("purpose").notNull(),
  currentVersion: integer("current_version").notNull().default(0),
  nextVersion: integer("next_version").notNull().default(1),
  lastDreamedAt: text("last_dreamed_at"),
  incrementalSinceDream: integer("incremental_since_dream").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("spaces_identity").on(t.namespace, t.spaceId)]);

export const documents = sqliteTable("documents", {
  docId: text("doc_id").primaryKey(),
  spaceKey: text("space_key").notNull().references(() => spaces.id),
  filename: text("filename").notNull(),
  sha256: text("sha256").notNull(),
  extension: text("extension").$type<DocumentExtension>().notNull(),
  mimeType: text("mime_type").notNull(),
  docDate: text("doc_date").notNull(),
  charCount: integer("char_count").notNull().default(0),
  warnings: text("warnings_json", { mode: "json" }).$type<Warning[]>().notNull().default([]),
  firstPublishedVersion: integer("first_published_version"),
  createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("documents_hash_in_space").on(t.spaceKey, t.sha256)]);

export const jobs = sqliteTable("jobs", {
  id: text("job_id").primaryKey(),
  spaceKey: text("space_key").notNull().references(() => spaces.id),
  type: text("job_type").$type<"ingest" | "dream">().notNull(),
  status: text("status").$type<JobStatus>().notNull(),
  idempotencyKey: text("idempotency_key"),
  payload: text("payload_json", { mode: "json" }).$type<JobPayload>().notNull(),
  progress: text("progress_json", { mode: "json" }).$type<JobProgress>().notNull(),
  usage: text("usage_json", { mode: "json" }).$type<JobUsage>().notNull(),
  targetVersion: integer("target_version"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("jobs_idempotency_in_space").on(t.spaceKey, t.idempotencyKey),
  index("jobs_created_at").on(t.createdAt),
  index("jobs_space_status").on(t.spaceKey, t.status),
]);

export const snapshots = sqliteTable("snapshots", {
  spaceKey: text("space_key").notNull().references(() => spaces.id),
  version: integer("version").notNull(),
  jobId: text("job_id").notNull().unique(),
  manifest: text("manifest_json", { mode: "json" }).$type<SnapshotRecord>().notNull(),
}, (t) => [primaryKey({ columns: [t.spaceKey, t.version] })]);

export const locks = sqliteTable("space_locks", {
  spaceKey: text("space_key").primaryKey().references(() => spaces.id),
  token: text("token").notNull(),
  validUntil: integer("valid_until").notNull(),
});
