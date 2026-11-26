import { dirname, join } from "node:path";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { SQLiteConnection } from "../../db/sqlite-repo.js";
import { spaceKey } from "../../db/interfaces.js";
import type { MetadataRepository, WikiStorage } from "../../db/interfaces.js";
import { errorMessage } from "../../errors.js";
import type { OpenAiGateway } from "../../llm/openai-gateway.js";
import { EvaluationGate } from "./evaluation-gate.js";
import { Engine } from "./engine.js";
import type { Synthesizer } from "../../retrieval/synthesizer.js";
import type { ServiceMemoryState } from "./kernel.js";
import { memoryKernelPort } from "./kernel.js";
import { proactiveRoutes } from "./routes.js";
import type { NudgeChatStore } from "./routes.js";
import { Store } from "./store.js";
import { NudgeStreams } from "./stream.js";

export function proactivePlugin(connection: SQLiteConnection, repo: MetadataRepository, storage: WikiStorage,
  gateway: OpenAiGateway, chatStore: NudgeChatStore, clock = Date.now, synthesizer?: Synthesizer, memoryState?: ServiceMemoryState) {
  const kernel = memoryKernelPort(connection, repo, storage, synthesizer, memoryState);
  const store = new Store(connection);
  const streams = new NudgeStreams(store, clock);
  const gate = new EvaluationGate(join(dirname(connection.client.name), "proactive-locks"));
  for (const ref of kernel.port.spaces()) gate.prepare(spaceKey(ref));
  const engine = new Engine(kernel.port, store, gateway, gate, clock, (key) => streams.notify(key));
  const unsubscribe = kernel.port.subscribe(async (ref, version) => {
    try {
      await engine.plan(ref, version);
      engine.wake();
    }
    catch (error) {
      // The publication is durable. evaluate() retries any missing plan before consuming triggers.
      console.error("Could not plan proactive timers", ref.namespace, ref.space_id, version, errorMessage(error));
    }
  });
  return {
    onSnapshotChanged: kernel.onSnapshotChanged,
    mount: (app: OpenAPIHono) => proactiveRoutes(app, engine, streams, chatStore, gateway),
    start: (seconds: number) => engine.start(seconds),
    async close() { unsubscribe(); streams.close(); await engine.stop(); },
  };
}
