import { z } from "zod";
import { locatorSchema } from "@replica/shared";
import type { JobUsage, SpaceRef } from "@replica/shared";
import type { DocumentRecord, NormalizedDocument, WikiStorage } from "../db/interfaces.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";
import { anchoredSections } from "./normalizer.js";

const name = z.string().trim().min(1).max(120);
const value = z.string().trim().min(1).max(1000);
const kind = z.enum(["entity", "topic"]);
const relation = z.object({ kind, subject: name });
const revisionTarget = z.object({ previous_value: value.nullish(), previous_date: z.iso.date().nullish() });
const factSchema = relation.extend({
  predicate: name, value, locator: locatorSchema, cardinality: z.enum(["one", "many"]).default("one"),
  related: z.array(relation).max(12).default([]),
  revision: revisionTarget.extend({ explicit: z.literal(true) }).nullish(),
  expires_on: z.iso.date().nullish(),
});
const eventSchema = z.object({
  date: z.iso.date(), text: value, locator: locatorSchema, related: z.array(relation).max(12).default([]),
});
const extractionSchema = z.object({
  summary: z.string().trim().max(800),
  entities: z.array(z.object({ name, locator: locatorSchema })).max(40).default([]),
  facts: z.array(factSchema).max(64).default([]),
  conflicts: z.array(revisionTarget.extend({ kind, subject: name, predicate: name, locator: locatorSchema })).max(30).default([]),
  timeline_events: z.array(eventSchema).max(40).default([]),
});

export type ClaimAnchor = { docId: string; locator: string };
export type Fact = z.infer<typeof factSchema> & {
  extra_sources?: ClaimAnchor[];
  archived?: { reason: string; archived_at: string };
};
export type TimelineEvent = z.infer<typeof eventSchema>;
export type Relation = z.infer<typeof relation>;
export type Claim = (Fact | TimelineEvent) & ClaimAnchor & { docDate: string };
export interface Analysis {
  claims: Claim[];
}

const CHUNK_CHARS = 14_000;

function chunks(markdown: string) {
  const result: ReturnType<typeof anchoredSections>[] = [];
  let current: ReturnType<typeof anchoredSections> = [];
  let count = 0;
  for (const { locator, text } of anchoredSections(markdown)) {
    for (let start = 0; start < text.length; start += CHUNK_CHARS) {
      const part = text.slice(start, start + CHUNK_CHARS);
      if (count + part.length > CHUNK_CHARS && current.length) {
        result.push(current);
        current = [];
        count = 0;
      }
      current.push({ locator, text: part });
      count += part.length;
    }
  }
  if (current.length) result.push(current);
  return result;
}

const citation = (docId: string, locator: string) => `[src:${docId}#${locator}]`;
export const claimKey = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
export const isFact = (claim: Claim): claim is Fact & Claim => "predicate" in claim;
export const anchorKey = ({ docId, locator }: ClaimAnchor) => `${docId}#${locator}`;
export const claimAnchors = (claim: Claim): ClaimAnchor[] => [
  { docId: claim.docId, locator: claim.locator }, ...(isFact(claim) ? claim.extra_sources ?? [] : []),
];
export const claimSource = (claim: Claim) => [...new Set(claimAnchors(claim).map(({ docId, locator }) => citation(docId, locator)))].join(" ");

export class Analyzer {
  constructor(private readonly gateway: OpenAiGateway, private readonly storage: WikiStorage) {}

  async analyze(
    space: SpaceRef, purpose: string, jobId: string, doc: DocumentRecord, text: NormalizedDocument,
    vocabulary: Array<{ subject: string; predicate: string; kind: Relation["kind"] }>, usage: JobUsage,
  ): Promise<Analysis> {
    const claims: Claim[] = [];
    const note: string[] = [`# ${doc.filename.replace(/[\r\n]/g, " ")}`, "", `日期 ${doc.docDate}`, ""];
    for (const segments of chunks(text.markdown)) {
      const locators = new Set(segments.map((segment) => segment.locator));
      const schema = extractionSchema.superRefine((result, ctx) => {
        for (const key of ["entities", "facts", "conflicts", "timeline_events"] as const) {
          for (const [i, item] of result[key].entries()) {
            if (!locators.has(item.locator)) ctx.addIssue({
              code: "custom", message: "Locator must match an input segment", path: [key, i, "locator"],
            });
          }
        }
      });
      const parsed = await this.gateway.structured("fast", prompts.analyzer, {
        purpose, document: { id: doc.docId, filename: doc.filename, doc_date: doc.docDate },
        vocabulary, segments,
      }, schema, usage);
      const cited = (loc: string) => citation(doc.docId, loc);
      note.push("## 摘要", "", parsed.summary
        ? `${parsed.summary.replace(/\s+/g, " ")} ${[...locators].map(cited).join(" ")}` : "无摘要", "", "## 实体和事实", "");
      for (const entity of parsed.entities) note.push(`- ${entity.name} ${cited(entity.locator)}`);
      for (const fact of parsed.facts) {
        const revision = parsed.conflicts.find((conflict) => conflict.locator === fact.locator
          && conflict.kind === fact.kind && claimKey(conflict.subject) === claimKey(fact.subject)
          && claimKey(conflict.predicate) === claimKey(fact.predicate));
        const evidence = {
          ...fact, docId: doc.docId, docDate: doc.docDate,
          revision: fact.revision ?? (revision ? {
            explicit: true as const, previous_value: revision.previous_value, previous_date: revision.previous_date,
          } : undefined),
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
        claims.push({ ...event, docId: doc.docId, docDate: doc.docDate });
        note.push(`- ${event.date} · ${event.text} ${cited(event.locator)}`);
      }
      note.push("");
    }
    if (text.warnings.length) note.push(...text.warnings.map((warning) => `- ${warning}`));
    await this.storage.writeStagingNote(space, jobId, doc.docId, note.join("\n") + "\n");
    return { claims };
  }
}
