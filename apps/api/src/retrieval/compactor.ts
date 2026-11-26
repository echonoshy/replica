import { compactResultSchema } from "@wiki-memory/shared";
import type { CompactMessage, CompactRequest, CompactResult } from "@wiki-memory/shared";
import { spaceKey, zeroUsage } from "../db/interfaces.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";
import type { SQLiteMemoryStateStore } from "../memory/memory-state.js";
import { countTokens, truncateTokens } from "./token-budget.js";

const extraction = compactResultSchema.pick({
  summary: true, active_goals: true, confirmed_constraints: true, recent_decisions: true,
  open_questions: true, extracted_hot_memories: true,
});
type Extraction = Pick<CompactResult, keyof typeof extraction.shape>;
const empty = (): Extraction => ({
  summary: "", active_goals: [], confirmed_constraints: [], recent_decisions: [], open_questions: [], extracted_hot_memories: [],
});
const turnText = (m: CompactMessage) => m.role + ": " + m.content + "\n";

function fallback(older: CompactMessage[], budget: number): Extraction {
  const result = empty();
  // Sample the entire interval so that both opening goals and later decisions can survive.
  const slots = Math.min(older.length, Math.max(1, Math.floor(budget / 32)));
  const lines = Array.from({ length: slots }, (_, i) => {
    const index = slots === 1 ? 0 : Math.round(i * (older.length - 1) / (slots - 1));
    return truncateTokens(turnText(older[index]), Math.floor(budget / slots));
  });
  result.summary = lines.join("\n");
  for (const { role, content } of older) {
    if (role !== "user") continue;
    const match = content.trim().match(/^(?:请|please\s+)?(记住|记下|忘记|忘掉|remember\b|forget\b)[：:,，\s]*(.{1,2000})$/iu);
    if (match) result.extracted_hot_memories.push({
      kind: /^(忘|forget)/i.test(match[1]) ? "forget" : "remember", content: match[2].trim(),
    });
  }
  return result;
}

export class SessionCompactor {
  constructor(private readonly gateway: OpenAiGateway, private readonly memoryState?: SQLiteMemoryStateStore) {}

  async compact(input: CompactRequest): Promise<CompactResult> {
    const { messages, max_tokens: limit } = input;
    const original_tokens = countTokens(JSON.stringify(messages));
    const desired = Math.max(0, messages.length - input.keep_recent_turns * 2);
    const result: CompactResult = {
      ...empty(), kept_recent_messages: [], persisted_hot_ids: [], original_tokens, compacted_tokens: 0,
    };
    if (!desired && original_tokens <= limit) {
      return { ...result, kept_recent_messages: messages, compacted_tokens: original_tokens };
    }

    let start = messages.length;
    const recentLimit = Math.floor(limit * 0.7);
    let recentCost = 0;
    while (start > desired) {
      const cost = countTokens(JSON.stringify(messages[start - 1])) + 1;
      if (recentCost + cost > recentLimit) break;
      recentCost += cost;
      start--;
    }
    const older = messages.slice(0, start);
    result.kept_recent_messages = messages.slice(start);
    const context = { ...empty(), kept_recent_messages: result.kept_recent_messages };
    const budget = limit - countTokens(JSON.stringify(context));
    let extracted: Extraction;
    try {
      // Bound the model input too. A single pasted document can be much larger than the output budget.
      const perMessage = Math.max(16, Math.floor(24000 / older.length));
      extracted = extraction.parse(await this.gateway.structured("fast", prompts.compactor, {
        messages: older.map(({ role, content }) => ({ role, content: truncateTokens(content, perMessage) })),
        max_tokens: budget,
      }, extraction, zeroUsage(), budget));
      if (!extracted.summary.trim()) throw new Error("Empty conversation summary");
    } catch {
      extracted = fallback(older, budget);
    }

    let remaining = budget;
    const take = (s: string, cap = remaining) => {
      const available = Math.min(remaining, cap);
      let text = truncateTokens(s.trim(), available);
      // Count JSON escaping and separators as part of the reusable context.
      while (text) {
        const cost = countTokens(JSON.stringify(text)) + 1;
        if (cost <= available) {
          remaining -= cost;
          break;
        }
        text = truncateTokens(text, Math.floor(countTokens(text) * available / (cost + 1)));
      }
      return text;
    };
    const seen = new Set<string>();
    // Keep memory instructions whole. Truncation can reverse their meaning.
    for (const hot of extracted.extracted_hot_memories) {
      const content = hot.content.trim();
      const id = hot.kind + ":" + content;
      const cost = countTokens(JSON.stringify({ kind: hot.kind, content })) + 1;
      if (!content || content.length > 2000 || seen.has(id) || cost > remaining - Math.ceil(budget / 2)) continue;
      if (!older.some((m) => m.role === "user" && m.content.includes(content))) continue;
      result.extracted_hot_memories.push({ kind: hot.kind, content });
      remaining -= cost;
      seen.add(id);
    }
    const fields = ["active_goals", "confirmed_constraints", "recent_decisions", "open_questions"] as const;
    result.summary = take(extracted.summary, fields.some((f) => extracted[f].length) ? Math.ceil(remaining / 2) : remaining);
    for (const field of fields) {
      for (const item of extracted[field]) {
        const text = take(item);
        if (text) result[field].push(text);
      }
    }
    result.compacted_tokens = countTokens(JSON.stringify({
      ...extraction.parse(result), kept_recent_messages: result.kept_recent_messages,
    }));
    if (input.persist_hot_memories && this.memoryState) {
      for (const hot of result.extracted_hot_memories) {
        const saved = this.memoryState.addHotMemory({ spaceKey: spaceKey(input), sessionId: input.session_id, ...hot });
        result.persisted_hot_ids.push(saved.id);
      }
    }
    return result;
  }
}
