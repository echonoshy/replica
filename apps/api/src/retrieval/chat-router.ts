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
  privacy_mode: z.enum(["full", "external_safe"]).optional(),
  hot_memory: z.object({
    kind: z.enum(["remember", "forget"]),
    content: z.string().trim().min(1),
    target_hint: z.string().trim().optional(),
  }).nullish(),
});

export type RouteDecision = z.infer<typeof routeSchema>;
export type ChatRoutePlan = RouteDecision;

const externalDraft = /对外|外部邮件|发给(?:客户|合作方)|发邮件给|回复客户|公开(?:纪要|会议纪要|公告|文档)|(?:可分享|可转发)的?文档|(?:起草|草拟|代写).*(?:邮件|公告|纪要)|写.*公告|给客户.*(?:邮件|回复)|external email|client (?:email|reply)|public (?:meeting )?minutes|shareable document|(?:draft|write|prepare).*(?:announcement|email.*(?:client|partner)|reply.*client)/i;

function hotMemoryCommand(message: string): RouteDecision["hot_memory"] {
  const text = message.trim().replace(/^(?:请\s*)?(?:帮我\s*)?(?:please\s+)?/i, "");
  if (/^(?:记住|忘记)(?:了吗|了没|什么|哪些|密码怎么办)/.test(text)) return null;
  const forget = text.match(/^(?:忘掉|忘记|别再记住|别再记|不要再记住|不要再记)[\s：:，,]*([\s\S]+)/)
    ?? text.match(/^把\s*([\s\S]+?)(?:删掉|删除|作废)[吧了。！!\s]*$/)
    ?? text.match(/^forget(?:\s+that)?\s+([\s\S]+)/i);
  if (forget?.[1].trim()) {
    const content = forget[1].trim();
    return { kind: "forget", content, target_hint: content };
  }
  const remember = text.match(/^记住[\s：:，,]*([\s\S]+)/)
    ?? text.match(/^remember(?:\s+that)?[\s:]+([\s\S]+)/i);
  const content = remember?.[1].trim() || (/^(?:以后叫我\s*|(?:from now on,?\s+)?call me\s+)\S/i.test(text) ? text : "");
  return content && !/^[：:，,\s]+$/.test(content) ? { kind: "remember", content } : null;
}

const safetyHeuristic = /吃|喝|餐|饭|奶|酒|药|烧|病|过敏|禁忌|红线|健康|猫|狗|宠|预算|杠杆|投资|应急|日程|盘点|规划|生日|聚餐|医|买|约|汇报|上线|评审|出差|酒店|机票|高铁/i;
const inventoryHeuristic = /盘点|梳理|总结.*(?:日程|红线|安排|待办|禁忌)|有哪些.*(?:日程|红线|安排|重要)|最近.*聊了/i;

export class ChatRouter {
  constructor(private readonly gateway: OpenAiGateway) {}

  async route(input: {
    message: string;
    recentHistory: Array<{ role: "user" | "assistant"; content: string }>;
    hasMemory: boolean;
    today: string;
  }): Promise<ChatRoutePlan> {
    const privacy_mode = externalDraft.test(input.message) ? "external_safe" : "full";
    const hot_memory = hotMemoryCommand(input.message);
    if (!input.hasMemory) {
      return { memory_mode: "none", search_queries: [], needs_inventory: false, safety_check: false, privacy_mode, hot_memory };
    }
    const fallback: ChatRoutePlan = {
      memory_mode: "personal",
      search_queries: [input.message],
      needs_inventory: inventoryHeuristic.test(input.message),
      safety_check: safetyHeuristic.test(input.message),
      privacy_mode, hot_memory,
    };
    try {
      const compactHistory = input.recentHistory.slice(-6).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 260),
      }));
      const completion = await this.gateway.complete("fast", [
        { role: "system", content: prompts.router },
        { role: "user", content: JSON.stringify({ today: input.today, recent_history: compactHistory, message: input.message }) },
      ], zeroUsage(), { format: "json", maxTokens: 512 });
      const parsed = routeSchema.safeParse(parseJson(completion.choices[0]?.message.content));
      if (!parsed.success) return fallback;
      const plan = parsed.data;
      plan.privacy_mode = privacy_mode === "external_safe" ? privacy_mode : plan.privacy_mode ?? "full";
      plan.hot_memory = hot_memory ?? plan.hot_memory ?? null;
      if (plan.memory_mode === "personal" && !plan.search_queries.length) {
        plan.search_queries = [input.message];
      }
      if (plan.memory_mode === "personal") {
        plan.needs_inventory = plan.needs_inventory || inventoryHeuristic.test(input.message);
        plan.safety_check = plan.safety_check || safetyHeuristic.test(input.message);
      }
      return plan;
    } catch {
      return fallback;
    }
  }
}
