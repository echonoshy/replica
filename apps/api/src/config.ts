import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const blank = (value: unknown) => value === "" ? undefined : value;
const optionalText = z.preprocess(blank, z.string().optional());
const gatewayUrl = z.url({ protocol: /^https?$/ });
const positive = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

const schema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: positive(8787, 65535),
  DATA_DIR: optionalText.transform((path) => resolve(workspace, path ?? "data")),
  LLM_BASE_URL: gatewayUrl.default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  LLM_API_KEY: optionalText,
  LLM_FAST_MODEL: z.string().min(1).default("qwen-plus"),
  LLM_STRONG_MODEL: z.string().min(1).default("qwen-max"),
  LLM_STRONG_BASE_URL: z.preprocess(blank, gatewayUrl.optional()),
  LLM_STRONG_API_KEY: optionalText,
  LLM_EMBEDDING_MODEL: optionalText,
  LLM_EMBEDDING_BASE_URL: z.preprocess(blank, gatewayUrl.optional()),
  LLM_EMBEDDING_API_KEY: optionalText,
  LLM_MAX_CONCURRENCY: positive(6, 32),
  LLM_TIMEOUT_MS: positive(120_000, 600_000),
  WORKER_CONCURRENCY: positive(2, 12),
  SYNC_WAIT_MS: positive(180_000, 900_000),
  PROACTIVE_ENABLED: z.preprocess(
    (value) => typeof value === "string" ? (value.trim() === "" ? undefined : value.trim().toLowerCase()) : value,
    z.enum(["true", "1", "false", "0"]).default("true"),
  ).transform((value) => value === "true" || value === "1"),
  PROACTIVE_POLL_SECONDS: z.coerce.number().int().min(0).max(86400).default(0),
  DREAM_POLL_MINUTES: z.coerce.number().int().min(0).max(1440).default(0),
  DREAM_MIN_INCREMENTAL: positive(5, 10_000),
  DREAM_MAX_AGE_HOURS: positive(24, 8760),
});

export function readConfig(env?: NodeJS.ProcessEnv) {
  if (env) return schema.parse(env);
  loadDotenv({ path: resolve(workspace, ".env"), quiet: true });
  return schema.parse(process.env);
}

export type Config = ReturnType<typeof readConfig>;
