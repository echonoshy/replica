import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { HTTPException } from "hono/http-exception";
import { SQLiteConnection, SQLiteJobQueue, SQLiteLexicalSearch, SQLiteMetadataRepository } from "./db/sqlite-repo.js";
import type { Config } from "./config.js";
import { errorMessage, ServiceError } from "./errors.js";
import { OpenAiGateway } from "./llm/openai-gateway.js";
import type { ModelInfo } from "./llm/openai-gateway.js";
import { Analyzer } from "./pipeline/analyzer.js";
import { DreamScheduler } from "./pipeline/dreaming.js";
import { Ingestion } from "./pipeline/ingestion.js";
import { TextDocumentNormalizer } from "./pipeline/normalizer.js";
import { Organizer } from "./pipeline/organizer.js";
import { CompileWorker } from "./pipeline/worker.js";
import { Navigator } from "./retrieval/navigator.js";
import { Synthesizer } from "./retrieval/synthesizer.js";
import { adminRoutes } from "./routes/admin.js";
import { chatRoutes } from "./routes/chat.js";
import { demoRoutes } from "./routes/demo.js";
import { ingestRoutes } from "./routes/ingest.js";
import { retrieveRoutes } from "./routes/retrieve.js";
import { SQLiteChatStore } from "./chat/chat-store.js";
import { LocalFsStorage } from "./storage/local-fs-storage.js";
import { proactivePlugin } from "./plugins/proactive/index.js";

type ProactiveSettings = "PROACTIVE_ENABLED" | "PROACTIVE_POLL_SECONDS";
type ServiceConfig = Omit<Config, ProactiveSettings> & Partial<Pick<Config, ProactiveSettings>>;

export function createService(input: ServiceConfig, options: { clock?: () => number } = {}) {
  const config: Config = {
    ...input, PROACTIVE_ENABLED: input.PROACTIVE_ENABLED ?? true, PROACTIVE_POLL_SECONDS: input.PROACTIVE_POLL_SECONDS ?? 0,
  };
  const connection = new SQLiteConnection(config.DATA_DIR);
  const repo = new SQLiteMetadataRepository(connection);
  const queue = new SQLiteJobQueue(connection);
  const storage = new LocalFsStorage(config.DATA_DIR);
  const normalizer = new TextDocumentNormalizer();
  const gateway = new OpenAiGateway(config);
  const analyzer = new Analyzer(gateway, storage);
  const organizer = new Organizer(gateway);
  const proactive = config.PROACTIVE_ENABLED ? proactivePlugin(connection, repo, storage, gateway, options.clock) : undefined;
  const worker = new CompileWorker({
    onSnapshotChanged: proactive?.onSnapshotChanged, repo, queue, storage, projection: storage, analyzer, organizer, normalizer, concurrency: config.WORKER_CONCURRENCY,
  });
  const wake = () => worker.wake();
  const ingestion = new Ingestion(repo, queue, storage, storage, normalizer);
  const synthesizer = new Synthesizer(repo, storage, gateway, new Navigator(gateway, new SQLiteLexicalSearch(connection)));
  const chatStore = new SQLiteChatStore(connection.client);
  const scheduler = new DreamScheduler(repo, queue, config, wake, { chatStore, ingestion });

  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues.slice(0, 5)
          .map((issue) => `${issue.path.join(".") || result.target}: ${issue.message}`).join("; ");
        return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);
      }
    },
  });
  app.onError((error, c) => {
    if (error instanceof ServiceError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof HTTPException) return c.json({ error: { code: "INVALID_REQUEST", message: error.message } }, error.status);
    console.error("Request failed", errorMessage(error));
    return c.json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));
  app.get("/health", (c) => c.json({ status: "ok" }));
  ingestRoutes(app, repo, ingestion, wake, config.SYNC_WAIT_MS);
  retrieveRoutes(app, synthesizer);
  adminRoutes(app, repo, queue, storage, storage, wake, proactive?.onSnapshotChanged, config.SYNC_WAIT_MS);
  proactive?.mount(app);
  const model = config.LLM_STRONG_MODEL;
  const modelInfo: ModelInfo = {
    id: model,
    label: /deepseek-v4[.-]1-flash/i.test(model) ? "DeepSeek V4.1 Flash" : model,
    switchable: false,
    note: "暂不支持切换",
  };
  demoRoutes(app, repo, storage, gateway, synthesizer, modelInfo);
  chatRoutes(app, repo, queue, storage, gateway, synthesizer, ingestion, chatStore, wake, modelInfo);
  app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "Replica Memory Service", version: "2.0.0" } });
  app.get("/docs", swaggerUI({ url: "/openapi.json", title: "Replica Memory API" }));

  return {
    app,
    start: () => { worker.start(); scheduler.start(); proactive?.start(config.PROACTIVE_POLL_SECONDS); },
    async close() {
      await scheduler.stop();
      await worker.stop();
      await proactive?.close();
      connection.close();
    },
  };
}
