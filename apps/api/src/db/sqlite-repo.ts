import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { JobStatus, JobUsage, Space, SpaceRef } from "@wiki-memory/shared";
import { ServiceError } from "../errors.js";
import { spaceKey, zeroUsage } from "./interfaces.js";
import type {
  ClaimedJob, DocumentRecord, Job, JobQueue, LexicalSearchProvider, MetadataRepository,
  NewJob, NormalizedDocument, SpaceLease,
} from "./interfaces.js";
import { documents, jobs, locks, snapshots, spaces } from "./schema.js";
import { indexText, queryTerms } from "./tokenize.js";

const LEASE_MS = 45_000;
const terminal: JobStatus[] = ["published", "failed"];
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export class SQLiteConnection {
  readonly client: Database.Database;
  readonly db: ReturnType<typeof drizzle>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.client = new Database(join(dataDir, "wiki_memory.db"));
    this.client.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    this.db = drizzle(this.client);
    this.transaction(() => {
      this.client.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL)");
      const applied = this.client.prepare("SELECT hash FROM _migrations WHERE id = ?");
      const insert = this.client.prepare("INSERT INTO _migrations (id, hash) VALUES (?, ?)");
      for (const migration of readMigrationFiles({ migrationsFolder })) {
        const row = applied.get(migration.folderMillis);
        if (row) {
          if ((row as { hash: string }).hash !== migration.hash) throw new Error("An applied migration was edited");
          continue;
        }
        for (const statement of migration.sql) this.client.exec(statement);
        insert.run(migration.folderMillis, migration.hash);
      }
    });
  }

  transaction<T>(operation: () => T): T {
    this.client.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.client.exec("COMMIT");
      return value;
    } catch (error) {
      this.client.exec("ROLLBACK");
      throw error;
    }
  }

  requireLease(lease: SpaceLease) {
    const lock = this.db.select().from(locks).where(and(
      eq(locks.spaceKey, lease.spaceKey), eq(locks.token, lease.token), gt(locks.validUntil, Date.now()),
    )).get();
    if (!lock) throw new ServiceError(409, "SPACE_LEASE_LOST", "The compiler no longer holds the space write lock");
  }

  close() {
    this.client.close();
  }
}

export class SQLiteMetadataRepository implements MetadataRepository {
  constructor(private readonly connection: SQLiteConnection) {}
  private get db() { return this.connection.db; }

  private asSpace(row: typeof spaces.$inferSelect): Space {
    const current = row.currentVersion ? this.db.select({ manifest: snapshots.manifest }).from(snapshots)
      .where(and(eq(snapshots.spaceKey, row.id), eq(snapshots.version, row.currentVersion))).get()?.manifest : undefined;
    return {
      namespace: row.namespace, space_id: row.spaceId, purpose: row.purpose,
      current_version: row.currentVersion, document_count: current?.document_count ?? 0,
      page_count: current?.page_count ?? 0, last_dreamed_at: row.lastDreamedAt,
      incremental_since_dream: row.incrementalSinceDream,
    };
  }

  async findSpace(ref: SpaceRef) { return this.findSpaceByKey(spaceKey(ref)); }

  async findSpaceByKey(key: string) {
    const row = this.db.select().from(spaces).where(eq(spaces.id, key)).get();
    return row ? this.asSpace(row) : undefined;
  }

  async listSpaces() {
    return this.db.select().from(spaces).orderBy(spaces.namespace, spaces.spaceId).all().map((row) => this.asSpace(row));
  }

  async ensureSpace(ref: SpaceRef, purpose: string) {
    const now = new Date().toISOString();
    const key = spaceKey(ref);
    this.db.insert(spaces).values({
      id: key, namespace: ref.namespace, spaceId: ref.space_id, purpose, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run();
    return this.asSpace(this.db.select().from(spaces).where(eq(spaces.id, key)).get()!);
  }

  async updatePurpose(ref: SpaceRef, purpose: string) {
    const row = this.db.update(spaces).set({ purpose, updatedAt: new Date().toISOString() })
      .where(eq(spaces.id, spaceKey(ref))).returning().get();
    if (!row) throw new ServiceError(404, "SPACE_NOT_FOUND", "Memory space not found");
    return this.asSpace(row);
  }

  async findDocument(key: string, docId: string) {
    return this.db.select().from(documents).where(and(eq(documents.spaceKey, key), eq(documents.docId, docId))).get();
  }

  async findDocumentByHash(key: string, sha256: string) {
    return this.db.select().from(documents).where(and(eq(documents.spaceKey, key), eq(documents.sha256, sha256))).get();
  }

  async listDocuments(key: string) {
    return this.db.select().from(documents).where(eq(documents.spaceKey, key))
      .orderBy(desc(documents.docDate), desc(documents.createdAt)).all();
  }

  async registerDocument(doc: DocumentRecord) {
    const inserted = this.db.insert(documents).values(doc).onConflictDoNothing().returning().get();
    const saved = inserted ?? await this.findDocumentByHash(doc.spaceKey, doc.sha256);
    if (!saved) throw new Error("Could not register document");
    return { doc: saved, inserted: !!inserted };
  }

  async recordNormalization(docId: string, result: NormalizedDocument) {
    this.db.update(documents).set({ charCount: result.charCount, warnings: result.warnings })
      .where(eq(documents.docId, docId)).run();
  }

  async getJob(id: string) { return this.db.select().from(jobs).where(eq(jobs.id, id)).get(); }

  async listJobs(key: string, limit = 25) {
    return this.db.select().from(jobs).where(eq(jobs.spaceKey, key))
      .orderBy(desc(jobs.createdAt)).limit(limit).all();
  }

  async findIdempotentJob(key: string, idempotencyKey: string) {
    return this.db.select().from(jobs).where(and(eq(jobs.spaceKey, key), eq(jobs.idempotencyKey, idempotencyKey))).get();
  }

  async getSnapshot(key: string, version: number) {
    return this.db.select().from(snapshots).where(and(eq(snapshots.spaceKey, key), eq(snapshots.version, version))).get()?.manifest;
  }

  async listSnapshots(key: string) {
    return this.db.select({ manifest: snapshots.manifest }).from(snapshots)
      .where(eq(snapshots.spaceKey, key)).orderBy(desc(snapshots.version)).all().map((row) => row.manifest);
  }

  async findPublication(jobId: string) {
    return this.db.select().from(snapshots).where(eq(snapshots.jobId, jobId)).get()?.manifest;
  }

  async reserveVersion(lease: SpaceLease) {
    return this.connection.transaction(() => {
      this.connection.requireLease(lease);
      const next = this.db.update(spaces).set({ nextVersion: sql`${spaces.nextVersion} + 1` })
        .where(eq(spaces.id, lease.spaceKey)).returning({ next: spaces.nextVersion }).get()!;
      return next.next - 1;
    });
  }

  async publish({ lease, expectedVersion, snapshot, pages, addedDocuments, dreaming }: Parameters<MetadataRepository["publish"]>[0]) {
    this.connection.transaction(() => {
      this.connection.requireLease(lease);
      const key = lease.spaceKey;
      const updated = this.db.update(spaces).set({
        currentVersion: snapshot.version,
        incrementalSinceDream: dreaming ? 0 : sql`${spaces.incrementalSinceDream} + 1`,
        ...(dreaming ? { lastDreamedAt: snapshot.created_at } : {}),
        updatedAt: snapshot.created_at,
      }).where(and(eq(spaces.id, key), eq(spaces.currentVersion, expectedVersion))).run();
      if (!updated.changes) throw new ServiceError(409, "SNAPSHOT_MOVED", "The current snapshot changed during compilation");
      this.db.insert(snapshots).values({ spaceKey: key, version: snapshot.version, jobId: snapshot.job_id, manifest: snapshot }).run();
      if (addedDocuments.length) {
        this.db.update(documents).set({ firstPublishedVersion: snapshot.version }).where(and(
          eq(documents.spaceKey, key), inArray(documents.docId, addedDocuments), isNull(documents.firstPublishedVersion),
        )).run();
      }
      const insert = this.connection.client.prepare(
        "INSERT INTO wiki_fts (space_key, version, page_id, title, content) VALUES (?, ?, ?, ?, ?)",
      );
      for (const page of pages) insert.run(key, snapshot.version, page.path, indexText(page.title), indexText(page.content));
    });
  }

  async rollback(lease: SpaceLease, version: number) {
    return this.connection.transaction(() => {
      this.connection.requireLease(lease);
      const target = this.db.select().from(snapshots)
        .where(and(eq(snapshots.spaceKey, lease.spaceKey), eq(snapshots.version, version))).get();
      if (!target) throw new ServiceError(404, "SNAPSHOT_NOT_FOUND", "Snapshot version not found");
      const row = this.db.update(spaces).set({
        currentVersion: version, incrementalSinceDream: 0, updatedAt: new Date().toISOString(),
      }).where(eq(spaces.id, lease.spaceKey)).returning().get()!;
      return this.asSpace(row);
    });
  }
}

export class SQLiteLexicalSearch implements LexicalSearchProvider {
  constructor(private readonly connection: SQLiteConnection) {}

  async search(key: string, version: number, query: string, limit: number, includeAudit: boolean) {
    const terms = queryTerms(query).filter((term) => [...term].length > 1 || /[a-z0-9]/i.test(term));
    if (!terms.length) return [];
    const expression = terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" OR ");
    const rows = this.connection.client.prepare(`
      SELECT page_id, title, content FROM wiki_fts
      WHERE wiki_fts MATCH ? AND space_key = ? AND version = ?
      AND (? = 1 OR page_id <> 'conflicts.md')
      ORDER BY bm25(wiki_fts, 0, 0, 0, 4, 1), page_id
      LIMIT ?
    `).all(expression, key, version, Number(includeAudit), Math.max(limit * 3, 12)) as Array<{
      page_id: string; title: string; content: string;
    }>;
    const minMatches = terms.length >= 4 ? 2 : 1;
    const filtered: string[] = [];
    for (const row of rows) {
      const titleTokens = new Set(row.title.match(/[\p{L}\p{N}]+/gu) ?? []);
      const bodyTokens = new Set(row.content.match(/[\p{L}\p{N}]+/gu) ?? []);
      const matched = terms.filter((term) => titleTokens.has(term) || bodyTokens.has(term));
      const strongTitleOrAscii = matched.some((term) =>
        (titleTokens.has(term) && (/[a-z0-9]/i.test(term) || matched.filter((t) => titleTokens.has(t)).length >= 2))
        || (/^[a-z0-9]{3,}$/i.test(term)));
      if (matched.length >= minMatches || strongTitleOrAscii) {
        filtered.push(row.page_id);
        if (filtered.length >= limit) break;
      }
    }
    return filtered;
  }
}

export class SQLiteJobQueue implements JobQueue {
  constructor(private readonly connection: SQLiteConnection) {}
  private get db() { return this.connection.db; }

  async enqueue(job: NewJob, onEnqueued?: (job: Job) => void) {
    return this.connection.transaction(() => {
      if (job.idempotencyKey) {
        const existing = this.db.select().from(jobs).where(and(
          eq(jobs.spaceKey, job.spaceKey), eq(jobs.idempotencyKey, job.idempotencyKey),
        )).get();
        if (existing) {
          if (existing.type !== job.type || existing.payload.fingerprint !== job.payload.fingerprint) {
            throw new ServiceError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different request");
          }
          return existing;
        }
      }
      if (job.type === "dream") {
        const existing = this.db.select().from(jobs).where(and(
          eq(jobs.spaceKey, job.spaceKey), eq(jobs.type, "dream"), notInArray(jobs.status, terminal),
        )).get();
        if (existing) return existing;
      }
      const now = new Date().toISOString();
      const queued = this.db.insert(jobs).values({
        ...job, status: "queued", progress: { completed: 0, total: job.payload.docs.length },
        usage: zeroUsage(), createdAt: now, updatedAt: now,
      }).returning().get()!;
      onEnqueued?.(queued);
      return queued;
    });
  }

  async claimNext(workerId: string) {
    return this.connection.transaction(() => {
      const now = Date.now();
      const job = this.db.select().from(jobs).where(and(notInArray(jobs.status, terminal), sql`
        NOT EXISTS (
          SELECT 1 FROM space_locks
          WHERE space_locks.space_key = ${jobs.spaceKey} AND space_locks.valid_until > ${now}
        )
      `)).orderBy(jobs.createdAt, sql`jobs.rowid`).limit(1).get();
      if (!job) return undefined;
      const lease = this.lock(job.spaceKey, `${workerId}:${randomUUID()}`, now);
      const claimed = this.db.update(jobs).set({ status: "normalizing", updatedAt: new Date(now).toISOString() })
        .where(eq(jobs.id, job.id)).returning().get()!;
      return { job: claimed, lease };
    });
  }

  private lock(key: string, token: string, now: number): SpaceLease {
    this.db.insert(locks).values({ spaceKey: key, token, validUntil: now + LEASE_MS })
      .onConflictDoUpdate({ target: locks.spaceKey, set: { token, validUntil: now + LEASE_MS } }).run();
    return {
      spaceKey: key, token,
      release: async () => {
        this.db.delete(locks).where(and(eq(locks.spaceKey, key), eq(locks.token, token))).run();
      },
    };
  }

  async acquireSpaceLock(key: string) {
    return this.connection.transaction(() => {
      const now = Date.now();
      const active = this.db.select().from(locks).where(and(eq(locks.spaceKey, key), gt(locks.validUntil, now))).get();
      return active ? undefined : this.lock(key, randomUUID(), now);
    });
  }

  async heartbeat(lease: SpaceLease, update?: Parameters<JobQueue["heartbeat"]>[1]) {
    this.connection.transaction(() => {
      this.connection.requireLease(lease);
      const now = Date.now();
      this.db.update(locks).set({ validUntil: now + LEASE_MS }).where(eq(locks.spaceKey, lease.spaceKey)).run();
      if (update) {
        const { id, ...fields } = update;
        this.db.update(jobs).set({ ...fields, updatedAt: new Date(now).toISOString() })
          .where(and(eq(jobs.id, id), eq(jobs.spaceKey, lease.spaceKey))).run();
      }
    });
  }

  private settle({ job, lease }: ClaimedJob, fields: Partial<Job>) {
    this.connection.transaction(() => {
      this.connection.requireLease(lease);
      this.db.update(jobs).set({ ...fields, updatedAt: new Date().toISOString() }).where(eq(jobs.id, job.id)).run();
      this.db.delete(locks).where(and(eq(locks.spaceKey, lease.spaceKey), eq(locks.token, lease.token))).run();
    });
  }

  async complete(claim: ClaimedJob, version: number, usage: JobUsage) {
    const progress = this.db.select({ progress: jobs.progress }).from(jobs).where(eq(jobs.id, claim.job.id)).get()!.progress;
    this.settle(claim, { status: "published", targetVersion: version, usage, progress: { ...progress, completed: progress.total } });
  }

  async fail(claim: ClaimedJob, message: string, usage: JobUsage) {
    this.settle(claim, { status: "failed", errorMessage: message, usage });
  }
}
