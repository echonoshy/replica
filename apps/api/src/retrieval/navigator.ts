import { z } from "zod";
import { contentPagePathSchema } from "@replica/shared";
import type { RetrieveInput } from "@replica/shared";
import { spaceKey, zeroUsage } from "../db/interfaces.js";
import type { LexicalSearchProvider } from "../db/interfaces.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";

const selection = z.object({
  selected_pages: z.array(z.object({
    path: contentPagePathSchema,
    reason: z.string().trim().min(1).max(400),
  })).max(8),
});
const auditQuestion = /历史|旧值|原来|修订|冲突|覆盖|替换|变更记录|此前|以前|supersed|conflict|revision|previous|history/i;

export class Navigator {
  constructor(private readonly gateway: OpenAiGateway, private readonly lexical: LexicalSearchProvider) {}

  async select(input: RetrieveInput, version: number, index: string, paths: string[]) {
    const includeAudit = auditQuestion.test(input.query);
    const valid = new Set(paths.filter((path) => path !== "_index.md" && (path !== "conflicts.md" || includeAudit)));
    if (!valid.size) return [];
    const [model, lexical] = await Promise.all([
      this.gateway.structured("fast", prompts.navigator, { query: input.query, index },
        selection, zeroUsage(), 1200).catch(() => ({ selected_pages: [] })),
      this.lexical.search(spaceKey(input), version, input.query, 5, includeAudit),
    ]);
    const matches = new Map<string, string>();
    for (const { path, reason } of model.selected_pages) if (valid.has(path)) matches.set(path, reason);
    for (const path of lexical) if (valid.has(path) && !matches.has(path)) matches.set(path, "FTS5 关键词匹配");
    return [...matches].map(([path, reason]) => ({ path, reason }));
  }
}
