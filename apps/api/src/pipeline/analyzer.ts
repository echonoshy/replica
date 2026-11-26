import { createHash } from "node:crypto";
import { z } from "zod";
import { locatorSchema } from "@wiki-memory/shared";
import type { JobUsage, SpaceRef } from "@wiki-memory/shared";
import { splitTurnBySpeaker, stripCitationTags } from "../chat/turns.js";
import type { DocumentRecord, NormalizedDocument, WikiStorage } from "../db/interfaces.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";
import { anchoredSections } from "./normalizer.js";

const name = z.string().trim().min(1).max(120);
const value = z.string().trim().min(1).max(1000);
const kind = z.enum(["entity", "topic"]);
export const memoryTierSchema = z.enum(["pinned_redline", "durable", "working"]);
export type MemoryTier = z.infer<typeof memoryTierSchema>;
export const privacyScopeSchema = z.enum(["private_health", "family", "work_internal", "work_shareable", "general"]);
export type PrivacyScope = z.infer<typeof privacyScopeSchema>;
const relation = z.object({ kind, subject: name });
const revisionTarget = z.object({ previous_value: value.nullish(), previous_date: z.iso.date().nullish() });
const factSchema = relation.extend({
  predicate: name, value, locator: locatorSchema, cardinality: z.enum(["one", "many"]).default("one"),
  related: z.array(relation).max(12).default([]),
  revision: revisionTarget.extend({ explicit: z.literal(true) }).nullish(),
  expires_on: z.iso.date().nullish(),
  valid_from: z.iso.date().nullish(),
  valid_to: z.iso.date().nullish(),
  tier: memoryTierSchema.optional(),
  scope: privacyScopeSchema.optional(),
});
const eventSchema = z.object({
  date: z.iso.date(), text: value, locator: locatorSchema, related: z.array(relation).max(12).default([]),
  event_key: name.nullish(),
  status: z.enum(["planned", "rescheduled", "cancelled", "completed"]).optional(),
  previous_date: z.iso.date().nullish(),
});
export const proceduralRuleInputSchema = z.object({
  trigger_context: name, instruction: value, rationale: z.string().trim().max(500).nullish(),
  locator: locatorSchema, scope: privacyScopeSchema.optional(),
  priority: z.enum(["redline", "high", "normal"]).optional(),
});
export const intentionInputSchema = z.object({
  kind: z.enum(["time_based", "event_based", "open_loop", "recurring", "risk_watch"]),
  goal: value,
  cue_text: z.string().trim().min(1).max(600).optional(),
  match_event_types: z.array(z.enum(["email_received", "calendar_changed", "chat_turn", "location_changed", "topic_entered", "app_signal", "custom"])).max(10).optional(),
  fire_at: z.string().trim().max(40).nullish(),
  rrule: z.string().trim().max(200).nullish(),
  stale_after_days: z.number().int().min(1).max(365).nullish(),
  deadline: z.iso.date().nullish(),
  priority: z.enum(["redline", "high", "normal", "low"]).optional(),
  subjects: z.array(name).max(10).default([]),
  locator: locatorSchema,
});
const extractionSchema = z.object({
  summary: z.string().trim().max(2000),
  entities: z.array(z.object({
    name,
    locator: locatorSchema,
    aliases: z.array(name).max(12).optional(),
  })).max(100).default([]),
  facts: z.array(factSchema).max(150).default([]),
  procedural_rules: z.array(proceduralRuleInputSchema).max(40).default([]),
  intentions: z.array(intentionInputSchema).default([]),
  conflicts: z.array(revisionTarget.extend({ kind, subject: name, predicate: name, locator: locatorSchema })).max(60).default([]),
  timeline_events: z.array(eventSchema).max(100).default([]),
});

export type ClaimAnchor = { docId: string; locator: string };
type FactCorrection = {
  old_value: string; new_value: string; reason: string; corrected_at: string;
  subject: string; predicate: string; sources: ClaimAnchor[];
};
export type AtomicFact = z.infer<typeof factSchema> & ClaimAnchor & { docDate: string; corrections?: FactCorrection[] };
export type Fact = z.infer<typeof factSchema> & {
  previous_fact_keys?: string[];
  extra_sources?: ClaimAnchor[];
  archived?: { reason: string; archived_at: string };
  merged_from?: AtomicFact[];
  pinned?: boolean;
  corrections?: FactCorrection[];
};
export type TimelineEvent = z.infer<typeof eventSchema> & {
  archived?: { reason: string; archived_at: string };
};
export type Relation = z.infer<typeof relation>;
export interface ProceduralRuleClaim {
  kind: "rule";
  rule_id: string;
  trigger_context: string;
  instruction: string;
  rationale?: string | null;
  scope?: PrivacyScope;
  priority?: "redline" | "high" | "normal";
  docId: string;
  locator: string;
  docDate: string;
  archived?: { reason: string; archived_at: string };
  extra_sources?: ClaimAnchor[];
}
export interface IntentionClaim extends Omit<z.infer<typeof intentionInputSchema>, "kind">, ClaimAnchor {
  kind: "intention";
  intention_kind: z.infer<typeof intentionInputSchema>["kind"];
  intention_id: string;
  docDate: string;
  archived?: { reason: string; archived_at: string };
  extra_sources?: ClaimAnchor[];
}
export type Claim = ((Fact | TimelineEvent) & ClaimAnchor & { docDate: string }) | ProceduralRuleClaim | (IntentionClaim & { date?: never });
export const isIntention = (claim: Claim | IntentionClaim): claim is IntentionClaim =>
  "kind" in claim && claim.kind === "intention";
export const isRule = (claim: Claim): claim is ProceduralRuleClaim => "kind" in claim && claim.kind === "rule";
export const ruleId = (trigger: string, instruction: string) =>
  "rule_" + createHash("sha256").update(trigger + instruction).digest("hex").slice(0, 16);
export interface EntityAliasCandidate {
  canonical: string;
  aliases: string[];
  locator: string;
}
export interface Analysis {
  claims: Claim[];
  intentions?: IntentionClaim[];
  entityAliases?: EntityAliasCandidate[];
}

const CHUNK_CHARS = 28_000;
const safetyCardinalityPattern = /过敏|急诊|医嘱|禁忌|红线|合规|严禁|禁止|不得|不许|绝对不能|不能碰|不耐受|等保|出境|公有云|allergy|medical|emergency|compliance|prohibit|redline|forbidden/i;

type ChunkSegment = {
  locator: string;
  text: string;
  date?: string;
  user_text?: string;
  assistant_context?: string;
};

function chunks(markdown: string) {
  const result: ChunkSegment[][] = [];
  let current: ChunkSegment[] = [];
  let count = 0;
  for (const { locator, text, date } of anchoredSections(markdown)) {
    const isChatTurn = locator.startsWith("t");
    const split = isChatTurn ? splitTurnBySpeaker(text) : null;
    if (isChatTurn && !split!.userText.trim()) continue;
    const cleanedAssistant = split?.assistantText ? stripCitationTags(split.assistantText) : "";
    const sourceText = split?.userText ?? text;
    for (let start = 0; start < sourceText.length; start += CHUNK_CHARS) {
      const part = sourceText.slice(start, start + CHUNK_CHARS);
      if (count + part.length > CHUNK_CHARS && current.length) {
        result.push(current);
        current = [];
        count = 0;
      }
      if (isChatTurn) {
        current.push({
          locator,
          text: part,
          ...(date ? { date } : {}),
          user_text: part,
          ...(cleanedAssistant ? { assistant_context: cleanedAssistant.slice(0, 6000) } : {}),
        });
      } else {
        current.push({ locator, text: part, ...(date ? { date } : {}) });
      }
      count += part.length;
    }
  }
  if (current.length) result.push(current);
  return result;
}

function normalizeEventDate(eventDate: string, refDate: string, segmentText: string) {
  const eventYear = Number(eventDate.slice(0, 4));
  const refYear = Number(refDate.slice(0, 4));
  // Guard against LLM defaulting month-day mentions (e.g. "10月22日" / "12月15日")
  // to an earlier year like 2025 when the document itself is in 2026 and never mentions 2025.
  if (eventYear === refYear - 1 && !segmentText.includes(String(eventYear))) {
    return `${refYear}${eventDate.slice(4)}`;
  }
  return eventDate;
}

const citation = (docId: string, locator: string) => `[src:${docId}#${locator}]`;
export const claimKey = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
export const isFact = (claim: Claim): claim is Fact & ClaimAnchor & { docDate: string } => "predicate" in claim;
export const anchorKey = ({ docId, locator }: ClaimAnchor) => `${docId}#${locator}`;
export const claimAnchors = (claim: Claim | IntentionClaim): ClaimAnchor[] => [
  { docId: claim.docId, locator: claim.locator }, ...("extra_sources" in claim ? claim.extra_sources ?? [] : []),
];
export const claimSource = (claim: Claim) => [...new Set(claimAnchors(claim).map(({ docId, locator }) => citation(docId, locator)))].join(" ");

export class Analyzer {
  constructor(private readonly gateway: OpenAiGateway, private readonly storage: WikiStorage) {}

  async analyze(
    space: SpaceRef, purpose: string, jobId: string, doc: DocumentRecord, text: NormalizedDocument,
    vocabulary: Array<{ subject: string; predicate: string; kind: Relation["kind"] }>, usage: JobUsage,
    existingAliases: Array<{ canonical: string; aliases: string[] }> = [],
  ): Promise<Analysis> {
    const claims: Claim[] = [];
    const intentions: IntentionClaim[] = [];
    const entityAliases: EntityAliasCandidate[] = [];
    const note: string[] = [`# ${doc.filename.replace(/[\r\n]/g, " ")}`, "", `日期 ${doc.docDate}`, ""];
    for (const segments of chunks(text.markdown)) {
      const locators = new Set(segments.map((segment) => segment.locator));
      const segmentByLocator = new Map(segments.map((segment) => [segment.locator, segment]));
      const schema = extractionSchema.superRefine((result, ctx) => {
        for (const key of ["entities", "facts", "conflicts", "timeline_events", "procedural_rules", "intentions"] as const) {
          for (const [i, item] of result[key].entries()) {
            if (!locators.has(item.locator)) ctx.addIssue({
              code: "custom", message: "Locator must match an input segment", path: [key, i, "locator"],
            });
          }
        }
      });
      const promptSegments = segments.map((segment) => (
        segment.user_text !== undefined
          ? {
            locator: segment.locator,
            date: segment.date ?? doc.docDate,
            text: segment.user_text,
            user_text: segment.user_text,
            ...(segment.assistant_context ? { assistant_context: segment.assistant_context } : {}),
          }
          : { locator: segment.locator, date: segment.date ?? doc.docDate, text: segment.text }
      ));
      const parsed = await this.gateway.structured("fast", prompts.analyzer, {
        purpose, document: { id: doc.docId, filename: doc.filename, doc_date: doc.docDate },
        vocabulary, ...(existingAliases.length ? { aliases: existingAliases } : {}), segments: promptSegments,
      }, schema, usage);
      const cited = (loc: string) => citation(doc.docId, loc);
      note.push("## 摘要", "", parsed.summary
        ? `${parsed.summary.replace(/\s+/g, " ")} ${[...locators].map(cited).join(" ")}` : "无摘要", "", "## 实体和事实", "");
      for (const entity of parsed.entities) {
        note.push(`- ${entity.name}${entity.aliases?.length ? `（别名：${entity.aliases.join("、")}）` : ""} ${cited(entity.locator)}`);
        if (entity.aliases?.length) {
          entityAliases.push({ canonical: entity.name, aliases: entity.aliases, locator: entity.locator });
        }
      }
      for (const fact of parsed.facts) {
        const seg = segmentByLocator.get(fact.locator);
        const turnDate = seg?.date ?? doc.docDate;
        const revision = parsed.conflicts.find((conflict) => conflict.locator === fact.locator
          && conflict.kind === fact.kind && claimKey(conflict.subject) === claimKey(fact.subject)
          && claimKey(conflict.predicate) === claimKey(fact.predicate));
        const resolvedRevision = fact.revision ?? (revision ? {
          explicit: true as const, previous_value: revision.previous_value, previous_date: revision.previous_date,
        } : undefined);
        const cardinality = !resolvedRevision?.explicit
          && safetyCardinalityPattern.test(`${fact.predicate} ${fact.value}`)
          ? "many"
          : fact.cardinality;
        const evidence = {
          ...fact, cardinality, docId: doc.docId, docDate: turnDate,
          revision: resolvedRevision,
        };
        claims.push(evidence);
        note.push(`- ${fact.subject} · ${fact.predicate}：${fact.value} ${cited(fact.locator)}`);
      }
      note.push("", "## 修订线索", "");
      for (const conflict of parsed.conflicts) {
        note.push(`- ${conflict.subject} · ${conflict.predicate} ${conflict.previous_value ?? ""} ${cited(conflict.locator)}`);
      }
      note.push("", "## 时间线", "");
      for (const event of parsed.timeline_events) {
        const seg = segmentByLocator.get(event.locator);
        const turnDate = seg?.date ?? doc.docDate;
        const segText = seg?.user_text ?? seg?.text ?? "";
        const fixedDate = normalizeEventDate(event.date, turnDate, segText);
        const fixedPrevDate = event.previous_date ? normalizeEventDate(event.previous_date, turnDate, segText) : undefined;
        claims.push({
          ...event, date: fixedDate, ...(fixedPrevDate ? { previous_date: fixedPrevDate } : {}),
          docId: doc.docId, docDate: turnDate,
        });
        note.push(`- ${fixedDate} · ${event.text} ${cited(event.locator)}`);
      }
      for (const rule of parsed.procedural_rules) {
        claims.push({
          ...rule, kind: "rule", rule_id: ruleId(rule.trigger_context, rule.instruction),
          docId: doc.docId, docDate: segmentByLocator.get(rule.locator)?.date ?? doc.docDate,
        });
      }
      for (const { kind: intention_kind, ...input } of parsed.intentions) {
        const identity = [doc.docId, input.locator, intention_kind, claimKey(input.goal), input.cue_text, input.fire_at, input.rrule];
        intentions.push({
          ...input, kind: "intention", intention_kind,
          intention_id: "intention_" + createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16),
          docId: doc.docId, docDate: segmentByLocator.get(input.locator)?.date ?? doc.docDate,
        });
      }
      note.push("");
    }
    const rules = claims.filter(isRule);
    if (rules.length) {
      note.push("## 行为准则", "", ...rules.map((rule) => `- ${rule.trigger_context} · ${rule.instruction} ${claimSource(rule)}`), "");
    }
    if (text.warnings.length) note.push(...text.warnings.map((warning) => `- ${warning}`));
    await this.storage.writeStagingNote(space, jobId, doc.docId, note.join("\n") + "\n");
    return { claims, entityAliases, ...(intentions.length ? { intentions } : {}) };
  }
}
