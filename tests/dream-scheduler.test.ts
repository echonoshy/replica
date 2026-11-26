import { expect, it, vi } from "vitest";
import type { Space } from "@wiki-memory/shared";
import { readConfig } from "../apps/api/src/config.js";
import type { Job, NewJob } from "../apps/api/src/db/interfaces.js";
import { zeroUsage } from "../apps/api/src/db/interfaces.js";
import { DreamScheduler } from "../apps/api/src/pipeline/dreaming.js";

it("enqueues only published spaces that meet the Dreaming threshold", async () => {
  vi.useFakeTimers();
  const namespace = "finance";
  const candidate: Space = {
    namespace, space_id: "alpha", purpose: "复盘", current_version: 3, incremental_since_dream: 2,
    last_dreamed_at: null, document_count: 4, page_count: 5,
  };
  const getSnapshot = vi.fn(async () => undefined);
  const enqueue = vi.fn(async (job: NewJob): Promise<Job> => ({
    ...job, status: "queued", progress: { completed: 0, total: 0 }, usage: zeroUsage(),
    targetVersion: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  const wake = vi.fn();
  const scheduler = new DreamScheduler({
    listSpaces: async () => [candidate, { ...candidate, space_id: "beta", current_version: 0 }],
    getSnapshot,
  }, { enqueue }, readConfig({ DREAM_POLL_MINUTES: "1", DREAM_MIN_INCREMENTAL: "2" }), wake);
  try {
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "dream", spaceKey: "finance:alpha", payload: { baseVersion: 3, docs: [] },
    }));
    expect(wake).toHaveBeenCalledTimes(1);
  } finally {
    await scheduler.stop();
    vi.useRealTimers();
  }
});
