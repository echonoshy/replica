import { rm } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readConfig } from "../src/config.js";
import { createService } from "../src/service.js";
import { SQLiteChatStore } from "../src/chat/chat-store.js";
import {
  MY_BLANK_SPACE,
  PENDING_DEMO_CHATS,
  PERSONAL_DEMO_DAYS,
  PERSONAL_DEMO_SPACE,
} from "../src/demo/scenarios.js";

async function resetPersonalDemo(dataDir: string) {
  const key = `${PERSONAL_DEMO_SPACE.namespace}:${PERSONAL_DEMO_SPACE.space_id}`;
  const db = new Database(join(dataDir, "wiki_memory.db"));
  try {
    db.pragma("foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM proactive_nudge_sources WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM proactive_outbox WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM proactive_triggers WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM proactive_leases WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM proactive_plans WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM proactive_policies WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM chat_sessions WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM wiki_fts WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM snapshots WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM jobs WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM documents WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM space_locks WHERE space_key = ?").run(key);
    db.prepare("DELETE FROM spaces WHERE id = ?").run(key);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }
  await rm(join(dataDir, "spaces", PERSONAL_DEMO_SPACE.namespace, PERSONAL_DEMO_SPACE.space_id), {
    recursive: true,
    force: true,
  });
  console.log(`Reset existing ${key} data.`);
}

async function waitForJob(
  request: (path: string) => Response | Promise<Response>,
  jobId: string,
  label: string,
) {
  let lastStatus = "";
  while (true) {
    const res = await request(`/v1/memories/jobs/${jobId}`);
    const job = await res.json();
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      console.log(`  [${label}] status=${job.status} llm_calls=${job.usage?.llm_calls ?? 0} latency=${((job.usage?.latency_ms ?? 0) / 1000).toFixed(1)}s`);
    }
    if (job.status === "published" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const config = readConfig();
  const service = createService(config);
  try {
    if (process.argv.includes("--reset")) {
      await resetPersonalDemo(config.DATA_DIR);
    }
    service.start();
    // 1. Ensure blank personal space ("我的个人空间") exists
    await service.app.request("/v1/admin/spaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: MY_BLANK_SPACE.namespace,
        space_id: MY_BLANK_SPACE.space_id,
        purpose: MY_BLANK_SPACE.purpose,
      }),
    });

    // Compile each historical conversation before submitting the next snapshot.
    console.log(`Seeding ${PERSONAL_DEMO_SPACE.namespace}/${PERSONAL_DEMO_SPACE.space_id} ...`);
    for (const day of PERSONAL_DEMO_DAYS) {
      console.log(`→ Ensuring ${day.label} (${day.doc_date} · ${day.filename})...`);
      const idempotencyKey = `seed-lin-yuan-${day.id}`;
      const submit = async (key: string) => {
        const res = await service.app.request("/v1/memories/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            namespace: PERSONAL_DEMO_SPACE.namespace,
            space_id: PERSONAL_DEMO_SPACE.space_id,
            purpose: PERSONAL_DEMO_SPACE.purpose,
            mode: "async",
            idempotency_key: key,
            items: [{ filename: day.filename, doc_date: day.doc_date, content: { messages: day.messages } }],
          }),
        });
        const data = await res.json();
        if (res.status === 409 && data.error?.code === "IDEMPOTENCY_CONFLICT") {
          throw new Error("The existing 林远 demo uses an older dataset. Use a fresh DATA_DIR or explicitly rerun with --reset to replace it.");
        }
        if (!res.ok) throw new Error(`${day.label} failed (${res.status}): ${JSON.stringify(data)}`);
        return waitForJob((path) => service.app.request(path), data.job_id, day.label);
      };
      let settled = await submit(idempotencyKey);
      if (settled.status === "failed") {
        console.log(`  ↻ Retrying ${day.label}...`);
        settled = await submit(`${idempotencyKey}-retry-${Date.now()}`);
      }
      if (settled.status === "failed") {
        throw new Error(`${day.label} compile failed: ${settled.error_message}`);
      }
    }

    // Mirror published historical sources in chat, then add the uncompiled pending queue.
    const overviewRes = await service.app.request(
      `/v1/demo/spaces/${PERSONAL_DEMO_SPACE.namespace}/${PERSONAL_DEMO_SPACE.space_id}/overview`,
    );
    if (!overviewRes.ok) throw new Error(`Could not read seeded overview (${overviewRes.status})`);
    const overview = await overviewRes.json();
    const docByFilename = new Map<string, { doc_id: string; first_published_version: number | null }>(
      (overview.documents ?? []).map((d: { filename: string; doc_id: string; first_published_version: number | null }) => [d.filename, d]),
    );
    const snapByVersion = new Map<number, { job_id: string }>(
      (overview.snapshots ?? []).map((s: { version: number; job_id: string }) => [s.version, s]),
    );

    const db = new Database(join(config.DATA_DIR, "wiki_memory.db"));
    try {
      const chatStore = new SQLiteChatStore(db);
      const linKey = `${PERSONAL_DEMO_SPACE.namespace}:${PERSONAL_DEMO_SPACE.space_id}`;

      const insertSession = (
        input: Parameters<SQLiteChatStore["createSession"]>[0],
        messages: (typeof PERSONAL_DEMO_DAYS)[number]["messages"],
      ) => {
        const session = chatStore.createSession(input);
        const baseTime = Date.parse(session.created_at);
        messages.forEach((message, index) => {
          chatStore.appendMessage({
            ...message,
            sessionId: session.session_id,
            createdAt: new Date(baseTime + (index + 1) * 5000).toISOString(),
            preserveStatus: true,
          });
        });
      };

      db.transaction(() => {
        for (const day of PERSONAL_DEMO_DAYS) {
          const sessionId = `chat_lin_${day.id}`;
          if (chatStore.getSession(sessionId)) continue;
          const doc = docByFilename.get(day.filename);
          const version = doc?.first_published_version;
          const jobId = version ? snapByVersion.get(version)?.job_id : undefined;
          if (!doc || !version || !jobId) {
            throw new Error(`Missing published snapshot for ${day.filename}`);
          }
          insertSession({
            sessionId,
            spaceKey: linKey,
            title: day.title,
            sessionDate: day.doc_date,
            status: "dreamed",
            dreamedDocId: doc.doc_id,
            dreamedVersion: version,
            dreamedJobId: jobId,
            dreamedMessageCount: day.messages.length,
            createdAt: `${day.doc_date}T01:30:00.000Z`,
          }, day.messages);
        }

        PENDING_DEMO_CHATS.forEach((chat, index) => {
          if (chatStore.getSession(chat.session_id)) return;
          insertSession({
            sessionId: chat.session_id,
            spaceKey: linKey,
            title: chat.title,
            sessionDate: chat.doc_date,
            status: "pending",
            createdAt: `${chat.doc_date}T07:${30 + index * 15}:00.000Z`,
          }, chat.messages);
        });
      })();
      console.log(`Synced ${chatStore.listSessions(linKey).length} chat sessions for ${linKey}.`);
    } finally {
      db.close();
    }

    console.log("\n=== Seeded Personal Memory Summary ===");
    console.log(
      `Space: ${overview.space.namespace}/${overview.space.space_id} | Version: v${overview.space.current_version} | Docs: ${overview.space.document_count} | Pages: ${overview.space.page_count}`,
    );
    console.log(
      `Facts: ${overview.stats.fact_count} | Events: ${overview.stats.event_count} | Conflicts/Supersedes: ${overview.stats.conflict_count}`,
    );
  } finally {
    await service.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
