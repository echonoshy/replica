// Run from the repository root with:
// pnpm --filter @replica/api exec tsx scripts/seed-realistic-spaces.ts
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import Database from "better-sqlite3";
import type { JobResult, Space } from "@replica/shared";
import { SQLiteChatStore } from "../src/chat/chat-store.js";
import { datasets, type Chat, type Dataset } from "./realistic-datasets.js";
import type { DreamTriggerResponse, SessionsListResponse, SpaceOverviewResponse } from "../../web/src/api.js";

export const origin = "http://127.0.0.1:8787";
const dataDir = fileURLToPath(new URL("../../../data/", import.meta.url));
export const stem = (s: Dataset, area: string) => `/v1/${area}/spaces/${s.namespace}/${s.space_id}`;
export const sessionId = (s: Dataset, c: Chat) => `seed_${s.space_id}_${c.date.replaceAll("-", "")}`;
export const expectedVersions = (s: Dataset) => s.batches.length + Number(!!s.followUp) + 1;
export async function http<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const request = () => fetch(origin + path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try { response = await request(); break; }
    catch (error) {
      // Only reads are safe to replay after a lost response to an enqueuing POST.
      if (method !== "GET" || attempt >= 5) throw error;
      await delay(2000);
    }
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} HTTP ${response.status}: ${raw.slice(0, 2000)}`);
  return JSON.parse(raw) as T;
}
export const sessions = (s: Dataset) => http<SessionsListResponse>(stem(s, "chat") + "/sessions");
export const overview = (s: Dataset, version?: number) =>
  http<SpaceOverviewResponse>(stem(s, "demo") + "/overview" + (version ? `?version=${version}` : ""));

function checkDataset(s: Dataset) {
  const chats = [...s.batches.flat(), ...s.pending];
  assert.deepEqual(s.batches.map(b => b.length), [3, 3, 3, 3, 2]);
  assert.equal(s.pending.length, 2);
  assert.equal(new Set(chats.map(c => sessionId(s, c))).size, chats.length);
  assert.deepEqual(chats.map(c => c.date), chats.map(c => c.date).sort());
  for (const c of chats) {
    const extra = s.followUp?.title === c.title ? s.followUp : undefined;
    for (const withExtra of extra ? [false, true] : [false]) {
      const lines = withExtra ? [...c.messages, ...extra!.messages] : c.messages;
      const noise = new Set([...c.noiseMessages, ...(withExtra ? extra!.noiseMessages.map(n => n + c.messages.length) : [])]);
      assert(lines.length >= 14 && lines.length <= 24, `Unexpected message count ${lines.length} in ${c.title}`);
      assert([...noise].every(n => n >= 0 && n < lines.length));
      assert(noise.size / lines.length >= 0.45 && noise.size / lines.length <= 0.55);
      lines.forEach((m, i) => { assert.equal(m.role, i % 2 ? "assistant" : "user"); assert(m.content.trim()); });
    }
  }
}

// Insert an entire batch in one transaction, including its FTS rows. The HTTP
// worker cannot observe an incomplete conversation or an incomplete batch.
function insertChats(db: Database.Database, store: SQLiteChatStore, s: Dataset, chats: Chat[], delta = false) {
  db.transaction(() => {
    for (const c of chats) {
      const id = sessionId(s, c);
      const key = `${s.namespace}:${s.space_id}`;
      const lines = delta ? [...c.messages, ...s.followUp!.messages] : c.messages;
      const stamp = (i: number) => {
        const follow = i >= c.messages.length;
        const base = Date.parse(`${follow ? s.followUp!.date : c.date}T15:00:00+08:00`);
        return new Date(base + i * 90_000).toISOString();
      };
      let session = store.getSession(id);
      if (!session) {
        assert(!delta, "Missing original session for delta");
        session = store.createSession({ sessionId: id, spaceKey: key, sessionDate: c.date, title: c.title, createdAt: stamp(0) });
      }
      assert.equal(session.space_key, key);
      assert.equal(session.session_date, c.date);
      assert.equal(session.title, c.title);
      const existing = store.getMessages(id).map(({ role, content }) => ({ role, content }));
      assert.deepEqual(existing, lines.slice(0, existing.length), `Seed content differs in ${id}`);
      if (existing.length === lines.length) continue;
      if (delta) {
        assert.equal(existing.length, c.messages.length);
        assert.equal(session.status, "dreamed");
      } else assert.equal(session.status, "pending");
      for (let i = existing.length; i < lines.length; i++) {
        store.appendMessage({ sessionId: id, ...lines[i], createdAt: stamp(i) });
      }
    }
  }).immediate();
}

async function waitForJob(job: JobResult) {
  let last = "";
  while (true) {
    const status = `${job.status} ${job.progress.completed}/${job.progress.total}`;
    if (status !== last) console.log(`[${job.space_id} ${job.job_id}] ${status}`);
    last = status;
    if (job.status === "published" || job.status === "failed") return job;
    await delay(2500);
    job = await http<JobResult>(`/v1/memories/jobs/${job.job_id}`);
  }
}
async function seedSpace(db: Database.Database, store: SQLiteChatStore, s: Dataset) {
  const { namespace, space_id, purpose } = s;
  await http<Space>("/v1/admin/spaces", { namespace, space_id, purpose });
  const known = new Set([...s.batches.flat(), ...s.pending].map(c => sessionId(s, c)));
  const final = expectedVersions(s);
  for (;;) {
    await sessions(s); // reconcile sessions whose live worker published or failed
    const state = await overview(s);
    const listing = await sessions(s);
    const v = state.space.current_version;
    // The service reserves a version before final lint. A failed reservation
    // can leave a gap. Batch position follows actual publications.
    const published = state.snapshots.length;
    assert(listing.sessions.every(row => known.has(row.session_id)), `Unexpected session in ${space_id}`);
    assert(published <= final && listing.space.current_version === v, `Unexpected snapshot in ${space_id}`);
    const history = s.batches.slice(0, published).flat();
    assert.equal(state.active_snapshot?.document_count ?? 0, history.length, `Unexpected documents at v${v}`);
    for (const c of history) {
      const row = listing.sessions.find(r => r.session_id === sessionId(s, c));
      assert(row && row.dreamed_version !== null, `Missing dreamed chat ${c.title}`);
    }
    if (published === final) {
      insertChats(db, store, s, s.pending);
      const done = await sessions(s);
      assert.equal(done.sessions.length, s.batches.flat().length + s.pending.length);
      assert.deepEqual(done.sessions.filter(r => r.status === "pending").map(r => r.session_id).sort(),
        s.pending.map(c => sessionId(s, c)).sort());
      console.log(`[${space_id}] v${v} complete, two pending chats`);
      return;
    }
    const deep = published + 1 === final;
    const delta = !deep && published === s.batches.length;
    const chats = deep ? [] : delta ? [history.find(c => c.title === s.followUp!.title)!] : s.batches[published];
    const ids = chats.map(c => sessionId(s, c)).sort();
    const prior = state.jobs.filter(j => j.base_snapshot_version === v && j.job_type === (deep ? "dream" : "ingest"));
    let job = prior.find(j => j.status !== "failed" && j.status !== "published");
    if (!job) {
      const failures = prior.filter(j => j.status === "failed");
      for (const f of failures) console.error(`[${space_id} v${v + 1}] ${f.job_id} failed: ${f.error_message}`);
      if (failures.length >= 2) throw new Error(`${space_id} v${v + 1} failed twice: ${failures[0].error_message}`);
      if (failures.length) console.error(`[${space_id}] retrying v${v + 1} once`);
      insertChats(db, store, s, chats, delta);
      const ready = await sessions(s);
      assert.deepEqual(ready.sessions.filter(r => r.status !== "dreamed").map(r => r.session_id).sort(), ids,
        `Refusing to digest an unexpected queue for ${space_id}`);
      const result = await http<DreamTriggerResponse>(stem(s, "chat") + "/dream", { force_consolidate: deep });
      assert.equal(result.mode, deep ? "consolidate_wiki" : "digest_pending");
      assert.deepEqual(result.digested_sessions.map(r => r.session_id).sort(), ids);
      job = result.job;
    }
    const settled = await waitForJob(job);
    if (settled.status === "published") {
      assert(settled.target_version && settled.target_version > v);
      if (settled.target_version !== v + 1) console.warn(`[${space_id}] Live worker skipped a reserved version: v${v} → v${settled.target_version}`);
    }
  }
}
// --reset-new resets all three fixtures. --reset-new=namespace:id limits
// recovery to a named fixture. No arbitrary IDs or filesystem paths are accepted.
const resetKeys = ["engineering:atlas_platform", "sales:enterprise_q4", "personal:zhou_ran"];
function resetFixture(db: Database.Database, s: Dataset) {
  const key = `${s.namespace}:${s.space_id}`;
  assert(resetKeys.includes(key));
  db.transaction(() => {
    assert(!db.prepare("SELECT 1 FROM jobs WHERE space_key=? AND status NOT IN ('published','failed')").get(key), "Space has an active job");
    assert(!db.prepare("SELECT 1 FROM space_locks WHERE space_key=? AND valid_until>?").get(key, Date.now()), "Space has a live lease");
    // The live API has no reset operation. This opt-in cleanup is scoped
    // identically to the repository's demo reset, including both FTS indexes.
    for (const table of ["proactive_nudge_sources", "proactive_outbox", "proactive_triggers",
      "proactive_leases", "proactive_plans", "proactive_policies", "chat_turns_fts", "chat_sessions",
      "wiki_fts", "snapshots", "jobs", "documents", "space_locks"]) {
      db.prepare(`DELETE FROM ${table} WHERE space_key=?`).run(key);
    }
    db.prepare("DELETE FROM spaces WHERE id=?").run(key);
  }).immediate();
  rmSync(join(dataDir, "spaces", s.namespace, s.space_id), { recursive: true, force: true });
  console.log(`Reset fixture ${key}`);
}
async function main() {
  const resets = new Set(process.argv.slice(2).flatMap(flag => {
    if (flag === "--reset-new") return resetKeys;
    const key = flag.slice("--reset-new=".length);
    assert(flag.startsWith("--reset-new=") && resetKeys.includes(key), "Unrecognized fixture reset option");
    return [key];
  }));
  datasets.forEach(checkDataset);
  const lock = createServer(); // OS releases this local runner lock even on an interrupted run.
  await new Promise<void>((resolve, reject) => lock.once("error", reject).listen(0xA57A, "127.0.0.1", resolve));
  try {
    await http("/health");
    const db = new Database(join(dataDir, "wiki_memory.db"), { fileMustExist: true });
    try {
      db.pragma("foreign_keys = ON");
      for (const s of datasets) if (resets.has(`${s.namespace}:${s.space_id}`)) resetFixture(db, s);
      // The store constructor backfills missing FTS rows. Require an already
      // initialized live store so opening it cannot reindex pre-existing chats.
      const missing = db.prepare(`SELECT 1 FROM chat_sessions s WHERE EXISTS
        (SELECT 1 FROM chat_messages m WHERE m.session_id=s.session_id)
        AND s.session_id NOT IN (SELECT session_id FROM chat_turns_fts) LIMIT 1`).get();
      assert(!missing, "Live chat index needs maintenance before seeding");
      const store = new SQLiteChatStore(db);
      const results = await Promise.allSettled(datasets.map(s => seedSpace(db, store, s)));
      const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, "Live seeding incomplete");
    } finally { db.close(); }
    const { verify } = await import("./verify-realistic-spaces.js");
    await verify();
  } finally { lock.close(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
