import { z } from "zod";
import type { JobUsage } from "@wiki-memory/shared";
import { zeroUsage } from "../db/interfaces.js";
import { errorMessage } from "../errors.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";
import { memoryTierSchema, privacyScopeSchema } from "./analyzer.js";
import type { MemoryTier, PrivacyScope } from "./analyzer.js";

export interface ClassifiableFact {
  kind: "entity" | "topic";
  subject: string;
  predicate: string;
  value: string;
  docDate?: string;
  expires_on?: string | null;
  pinned?: boolean;
  tier?: MemoryTier;
  scope?: PrivacyScope;
}

export interface ClassifyFactsOptions {
  force?: boolean;
  tier?: "fast" | "strong";
  batchSize?: number;
  throwOnError?: boolean;
}

const classificationResponseSchema = z.object({
  classifications: z.array(z.object({
    index: z.number().int().nonnegative(),
    tier: memoryTierSchema,
    scope: privacyScopeSchema,
    expires_on: z.iso.date().nullish(),
  })).default([]),
});

export async function classifyFactsWithLlm<T extends ClassifiableFact>(
  gateway: Pick<OpenAiGateway, "structured">,
  facts: T[],
  usage: JobUsage,
  options: ClassifyFactsOptions = {},
): Promise<T[]> {
  const { force = false, tier = "fast", batchSize = 35, throwOnError = false } = options;
  const targets = facts
    .map((fact, idx) => ({ fact, idx }))
    .filter(({ fact }) => force || !fact.tier || !fact.scope)
    .sort((a, b) => a.fact.subject.localeCompare(b.fact.subject) || a.idx - b.idx);
  if (!targets.length) return facts;

  const updated = [...facts];
  const step = Math.max(1, batchSize);
  for (let offset = 0; offset < targets.length; offset += step) {
    const batch = targets.slice(offset, offset + step);
    const payload = {
      facts: batch.map(({ fact }, localIdx) => ({
        index: localIdx,
        kind: fact.kind,
        subject: fact.subject,
        predicate: fact.predicate,
        value: fact.value,
        ...(fact.docDate ? { doc_date: fact.docDate } : {}),
        ...(fact.expires_on ? { expires_on: fact.expires_on } : {}),
        ...(fact.pinned ? { pinned: true } : {}),
      })),
    };
    try {
      const response = await gateway.structured(
        tier,
        prompts.factClassifier,
        payload,
        classificationResponseSchema,
        usage,
        16_384,
      );
      const byIndex = new Map(response.classifications.map((item) => [item.index, item]));
      for (const [localIdx, { fact, idx }] of batch.entries()) {
        const match = byIndex.get(localIdx);
        if (!match) continue;
        const resolvedTier: MemoryTier = fact.pinned
          ? "pinned_redline"
          : force ? match.tier : (fact.tier ?? match.tier);
        const resolvedScope: PrivacyScope = force ? match.scope : (fact.scope ?? match.scope);
        const resolvedExpires = resolvedTier === "working"
          ? (force ? (match.expires_on ?? undefined) : (fact.expires_on ?? match.expires_on ?? undefined))
          : (force ? undefined : fact.expires_on);
        const nextFact = { ...fact, tier: resolvedTier, scope: resolvedScope };
        if (resolvedExpires) nextFact.expires_on = resolvedExpires;
        else delete nextFact.expires_on;
        updated[idx] = nextFact;
      }
    } catch (error) {
      if (throwOnError) throw error;
      console.warn("LLM fact classification failed; keeping existing/default labels:", errorMessage(error));
    }
  }
  return updated;
}

export async function classifyHotMemoryWithLlm(
  gateway: Pick<OpenAiGateway, "structured"> | undefined,
  input: { kind: "remember" | "forget"; content: string; targetHint?: string | null; tier?: MemoryTier; scope?: PrivacyScope },
  usage: JobUsage = zeroUsage(),
  options: { tier?: "fast" | "strong" } = {},
): Promise<{ tier: MemoryTier; scope: PrivacyScope }> {
  const fallbackTier: MemoryTier = input.tier ?? "durable";
  const fallbackScope: PrivacyScope = input.scope ?? "general";
  if ((input.tier && input.scope) || !gateway) {
    return { tier: fallbackTier, scope: fallbackScope };
  }
  const [classified] = await classifyFactsWithLlm(
    gateway,
    [{
      kind: "topic",
      subject: input.targetHint?.trim() || (input.kind === "forget" ? "作废记忆" : "即时记忆"),
      predicate: input.kind === "forget" ? "即时忘掉" : "即时记住",
      value: input.content.trim(),
      tier: input.tier,
      scope: input.scope,
    }],
    usage,
    { tier: options.tier ?? "fast", force: false, throwOnError: false },
  );
  return {
    tier: input.tier ?? classified?.tier ?? fallbackTier,
    scope: input.scope ?? classified?.scope ?? fallbackScope,
  };
}
