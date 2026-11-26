import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { JobUsage } from "@wiki-memory/shared";
import type { Config } from "../config.js";
import { ServiceError } from "../errors.js";

type Tier = "fast" | "strong";
type Endpoint = { client: OpenAI | null; model: string; disableThinking: boolean };
type PreferredFormat = "json" | "tools";

export interface ModelInfo {
  id: string;
  label: string;
  switchable: false;
  note: string;
}

export class OpenAiGateway {
  private readonly endpoints: Record<Tier, Endpoint>;
  private readonly embeddings?: Endpoint;
  private readonly waiters: Array<() => void> = [];
  private readonly unsupported = new Set<string>();
  private active = 0;

  constructor(private readonly config: Config) {
    const createEndpoint = (baseURL: string, apiKey: string | undefined, model: string): Endpoint => {
      const url = new URL(baseURL);
      const disableThinking = url.origin === "https://ark.cn-beijing.volces.com"
        && url.pathname.replace(/\/$/, "") === "/api/plan/v3"
        && /^(?:doubao-seed-2[.-]1-|deepseek-v4[.-]1-flash)/.test(model);
      return {
        client: apiKey ? new OpenAI({ baseURL, apiKey, timeout: config.LLM_TIMEOUT_MS, maxRetries: 2 }) : null,
        model,
        disableThinking,
      };
    };
    const sameUrl = !config.LLM_STRONG_BASE_URL || config.LLM_STRONG_BASE_URL === config.LLM_BASE_URL;
    this.endpoints = {
      fast: createEndpoint(config.LLM_BASE_URL, config.LLM_API_KEY, config.LLM_FAST_MODEL),
      strong: createEndpoint(config.LLM_STRONG_BASE_URL || config.LLM_BASE_URL,
        config.LLM_STRONG_API_KEY || (sameUrl ? config.LLM_API_KEY : undefined), config.LLM_STRONG_MODEL),
    };
    if (config.LLM_EMBEDDING_MODEL) {
      const sameEmbeddingUrl = !config.LLM_EMBEDDING_BASE_URL || config.LLM_EMBEDDING_BASE_URL === config.LLM_BASE_URL;
      this.embeddings = createEndpoint(config.LLM_EMBEDDING_BASE_URL ?? config.LLM_BASE_URL,
        config.LLM_EMBEDDING_API_KEY ?? (sameEmbeddingUrl ? config.LLM_API_KEY : undefined), config.LLM_EMBEDDING_MODEL);
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.config.LLM_MAX_CONCURRENCY) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  hasEmbeddings(): boolean {
    return Boolean(this.embeddings?.client) && !this.unsupported.has("embeddings");
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    const endpoint = this.embeddings;
    if (!endpoint?.client || !this.hasEmbeddings() || !texts.length) return null;
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 32) {
      const input = texts.slice(offset, offset + 32);
      await this.acquire();
      try {
        if (this.unsupported.has("embeddings")) return null;
        const { data } = await endpoint.client.embeddings.create({ model: endpoint.model, input, encoding_format: "float" });
        if (data.length !== input.length) return null;
        const ordered = data.sort((a, b) => a.index - b.index);
        for (const [index, { embedding, index: inputIndex }] of ordered.entries()) {
          if (inputIndex !== index || !Array.isArray(embedding) || !embedding.every(Number.isFinite)
            || (vectors.length && embedding.length !== vectors[0].length)) return null;
          const norm = Math.hypot(...embedding);
          if (!norm || !Number.isFinite(norm)) return null;
          vectors.push(embedding.map((value) => value / norm));
        }
      } catch (error) {
        if (error instanceof OpenAI.APIError && (error.status === 404 || error.status === 501
          || (error.status === 400 && /unsupported|not supported|does not support|not implemented|unknown model|model not found/i.test(error.message)))) {
          this.unsupported.add("embeddings");
        }
        return null;
      } finally {
        this.release();
      }
    }
    return vectors;
  }

  async complete(
    tier: Tier, messages: ChatCompletionMessageParam[], usage: JobUsage,
    options: { format?: PreferredFormat; tools?: ChatCompletionTool[]; maxTokens?: number } = {},
  ): Promise<ChatCompletion> {
    const { client, model, disableThinking } = this.endpoints[tier];
    if (!client) {
      throw new ServiceError(503, "LLM_NOT_CONFIGURED", `Configure the ${tier} model's API key in .env`);
    }
    await this.acquire();

    const capability = `${tier}:${options.format}`;
    const desired = options.format && !this.unsupported.has(capability) ? options.format : undefined;
    const send = async (format: PreferredFormat | undefined) => {
      usage.llm_calls++;
      const response = await client.chat.completions.create({
        model, messages, stream: false, max_tokens: options.maxTokens ?? 12_288,
        ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
        ...(format === "json" ? { response_format: { type: "json_object" } } : {}),
        ...(format === "tools" ? { tools: options.tools, tool_choice: "auto" } : {}),
      });
      usage.prompt_tokens += response.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += response.usage?.completion_tokens ?? 0;
      usage.total_tokens += response.usage?.total_tokens
        ?? (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0);
      return response;
    };
    try {
      try {
        return await send(desired);
      } catch (error) {
        if (desired && error instanceof OpenAI.APIError && (error.status === 400 || error.status === 422)
          && /response_format|json.object|tools?|function.call/i.test(error.message)) {
          this.unsupported.add(capability);
          return await send(undefined);
        }
        throw error;
      }
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      throw new ServiceError(502, "LLM_GATEWAY_ERROR",
        `The ${tier} model gateway request failed${status ? ` (HTTP ${status})` : ""}`);
    } finally {
      this.release();
    }
  }

  async stream(
    tier: Tier,
    messages: ChatCompletionMessageParam[],
    usage: JobUsage,
    onDelta: (chunk: string) => void,
    options: { maxTokens?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const { client, model, disableThinking } = this.endpoints[tier];
    if (!client) {
      throw new ServiceError(503, "LLM_NOT_CONFIGURED", `Configure the ${tier} model's API key in .env`);
    }
    await this.acquire();

    const usageCap = `${tier}:stream_usage`;
    const includeUsage = !this.unsupported.has(usageCap);
    const runStream = async (withUsage: boolean) => {
      usage.llm_calls++;
      let fullText = "";
      const response = await client.chat.completions.create({
        model,
        messages,
        stream: true,
        max_tokens: options.maxTokens ?? 12_288,
        ...(withUsage ? { stream_options: { include_usage: true } } : {}),
        ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
      }, { signal: options.signal });

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
        if (chunk.usage) {
          usage.prompt_tokens += chunk.usage.prompt_tokens ?? 0;
          usage.completion_tokens += chunk.usage.completion_tokens ?? 0;
          usage.total_tokens += chunk.usage.total_tokens
            ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0);
        }
      }
      return fullText.trim();
    };

    try {
      try {
        return await runStream(includeUsage);
      } catch (error) {
        if (includeUsage && error instanceof OpenAI.APIError && (error.status === 400 || error.status === 422)
          && /stream_options|include_usage/i.test(error.message)) {
          this.unsupported.add(usageCap);
          return await runStream(false);
        }
        throw error;
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      throw new ServiceError(502, "LLM_GATEWAY_ERROR",
        `The ${tier} model gateway request failed${status ? ` (HTTP ${status})` : ""}`);
    } finally {
      this.release();
    }
  }

  async structured<T>(
    tier: Tier, system: string, data: unknown, schema: z.ZodType<T>,
    usage: JobUsage, maxTokens = 12_288,
  ): Promise<T> {
    let feedback = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const completion = await this.complete(tier, [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ ...data as object, ...(feedback ? { validation_feedback: feedback } : {}) }) },
      ], usage, { format: "json", maxTokens });
      try {
        const result = schema.safeParse(parseJson(completion.choices[0]?.message.content));
        if (result.success) return result.data;
        feedback = result.error.issues.slice(0, 6).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      } catch {
        feedback = "Return one valid JSON object without text outside it.";
      }
    }
    throw new ServiceError(502, "LLM_INVALID_OUTPUT", `The ${tier} model returned invalid structured output: ${feedback}`);
  }
}

export function parseJson(text?: string | null): unknown {
  return JSON.parse((text ?? "").trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```$/, ""));
}
