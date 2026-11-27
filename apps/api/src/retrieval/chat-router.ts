import { z } from "zod";
import { zeroUsage } from "../db/interfaces.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { parseJson } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";

const routeSchema = z.object({
  memory_mode: z.enum(["none", "personal"]),
  search_queries: z.array(z.string().trim().min(1).max(300)).max(4).default([]),
  needs_inventory: z.boolean().default(false),
  safety_check: z.boolean().default(false),
  needs_audit_history: z.boolean().default(false),
  privacy_mode: z.enum(["full", "external_safe"]).optional(),
  hot_memory: z.object({
    kind: z.enum(["remember", "forget"]),
    content: z.string().trim().min(1),
    target_hint: z.string().trim().optional(),
  }).nullish(),
});

export type RouteDecision = z.infer<typeof routeSchema>;
export type ChatRoutePlan = RouteDecision;

export class ChatRouter {
  constructor(private readonly gateway: OpenAiGateway) {}

  async route(input: {
    message: string;
    recentHistory: Array<{ role: "user" | "assistant"; content: string }>;
    hasMemory: boolean;
    today: string;
  }): Promise<ChatRoutePlan> {
    const fallback: ChatRoutePlan = {
      memory_mode: input.hasMemory ? "personal" : "none",
      search_queries: input.hasMemory ? [input.message] : [],
      needs_inventory: false,
      safety_check: false,
      needs_audit_history: false,
      privacy_mode: "full",
      hot_memory: null,
    };
    try {
      const compactHistory = input.recentHistory.slice(-6).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 260),
      }));
      const completion = await this.gateway.complete("fast", [
        { role: "system", content: prompts.router },
        { role: "user", content: JSON.stringify({ today: input.today, recent_history: compactHistory, message: input.message }) },
      ], zeroUsage(), { format: "json", maxTokens: 2048 });
      const parsed = routeSchema.safeParse(parseJson(completion.choices[0]?.message.content));
      if (!parsed.success) return fallback;
      const plan: ChatRoutePlan = {
        ...parsed.data,
        privacy_mode: parsed.data.privacy_mode ?? "full",
        hot_memory: parsed.data.hot_memory ?? null,
      };
      if (!input.hasMemory) {
        return {
          memory_mode: "none",
          search_queries: [],
          needs_inventory: false,
          safety_check: false,
          needs_audit_history: false,
          privacy_mode: plan.privacy_mode,
          hot_memory: plan.hot_memory,
        };
      }
      if (plan.memory_mode === "personal" && !plan.search_queries.length) {
        plan.search_queries = [input.message];
      }
      return plan;
    } catch {
      return fallback;
    }
  }
}
