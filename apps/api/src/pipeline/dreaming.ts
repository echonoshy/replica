import { randomUUID } from "node:crypto";
import type { Space } from "@wiki-memory/shared";
import type { Config } from "../config.js";
import { digestPendingChatSessions } from "../chat/dream-chats.js";
import type { ChatDreamDependencies } from "../chat/dream-chats.js";
import type { JobQueue, MetadataRepository } from "../db/interfaces.js";
import { spaceKey } from "../db/interfaces.js";

export function enqueueDream(queue: Pick<JobQueue, "enqueue">, space: Space, mode?: "consolidate" | "full") {
  return queue.enqueue({
    id: `job_${randomUUID().replaceAll("-", "")}`, type: "dream", spaceKey: spaceKey(space),
    idempotencyKey: null, payload: { docs: [], baseVersion: space.current_version, ...(mode ? { dream_mode: mode } : {}) },
  });
}

export class DreamScheduler {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly repo: Pick<MetadataRepository, "listSpaces" | "getSnapshot"> & Partial<Pick<MetadataRepository, "getJob">>,
    private readonly queue: Pick<JobQueue, "enqueue">,
    private readonly config: Config, private readonly wake: () => void,
    private readonly chatDeps?: Pick<ChatDreamDependencies, "chatStore" | "ingestion"> & { idleMs?: number },
  ) {}

  start() {
    if (!this.config.DREAM_POLL_MINUTES || this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.schedule().catch((error: unknown) => {
        console.error("Dream scheduling failed", error instanceof Error ? error.message : "");
      }).finally(() => { this.running = undefined; });
    };
    this.timer = setInterval(tick, this.config.DREAM_POLL_MINUTES * 60_000);
    this.timer.unref();
  }

  private async schedule() {
    const now = Date.now();
    const cutoff = now - this.config.DREAM_MAX_AGE_HOURS * 3_600_000;
    const spaces = await this.repo.listSpaces();
    for (const space of spaces) {
      if (this.chatDeps) {
        const idleCutoff = now - (this.chatDeps.idleMs ?? 60_000);
        const result = await digestPendingChatSessions(space, {
          ...this.chatDeps, getJob: (id) => this.repo.getJob?.(id) ?? Promise.resolve(undefined), wake: this.wake,
        }, (pending) => {
          const eligible = pending.filter((session) => Date.parse(session.updated_at) <= idleCutoff);
          return eligible.length >= this.config.DREAM_MIN_INCREMENTAL
            || eligible.some((session) => Date.parse(session.updated_at) <= cutoff) ? eligible : [];
        });
        if (result?.submitted) continue;
      }
      if (!space.current_version || !space.incremental_since_dream) continue;
      const snapshot = await this.repo.getSnapshot(spaceKey(space), space.current_version);
      const reference = space.last_dreamed_at ?? snapshot?.created_at;
      if (space.incremental_since_dream >= this.config.DREAM_MIN_INCREMENTAL || (reference && Date.parse(reference) <= cutoff)) {
        await enqueueDream(this.queue, space);
        this.wake();
      }
    }
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
