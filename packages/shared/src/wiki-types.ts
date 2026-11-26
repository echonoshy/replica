import { z } from "zod";
import { CONTENT_PAGE_PATH } from "./wiki-format.js";

export const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const docIdSchema = z.string().regex(/^doc_[a-zA-Z0-9_-]{1,80}$/);
export const jobIdSchema = z.string().regex(/^job_[a-zA-Z0-9_-]{1,80}$/);
export const locatorSchema = z.string().regex(/^[pst][1-9][0-9]*$/);
export const anchorSchema = z.string().regex(/^doc_[a-zA-Z0-9_-]{1,80}#[pst][1-9][0-9]*$/);
export const contentPagePathSchema = z.string().regex(CONTENT_PAGE_PATH);
export const wikiPagePathSchema = z.union([z.literal("_index.md"), contentPagePathSchema]);
export const memoryTierSchema = z.enum(["pinned_redline", "durable", "working"]);
export const privacyScopeSchema = z.enum(["private_health", "family", "work_internal", "work_shareable", "general"]);
export const proceduralRulePrioritySchema = z.enum(["redline", "high", "normal"]);
export const proceduralRuleSchema = z.object({
  rule_id: z.string(),
  trigger_context: z.string().trim().min(1).max(300),
  instruction: z.string().trim().min(1).max(1000),
  rationale: z.string().trim().max(500).nullish(),
  scope: privacyScopeSchema.default("general"),
  priority: proceduralRulePrioritySchema.default("normal"),
  doc_id: docIdSchema,
  locator: locatorSchema,
  doc_date: z.iso.date(),
  archived: z.boolean().default(false),
  archived_reason: z.string().nullish(),
});
export const hotMemorySummarySchema = z.object({
  id: z.string(),
  kind: z.enum(["remember", "forget"]),
  content: z.string(),
  target_hint: z.string().nullable(),
  tier: memoryTierSchema,
  scope: privacyScopeSchema,
  status: z.enum(["active", "consumed", "dismissed"]),
  created_at: z.string(),
});
export const conversationHitSummarySchema = z.object({
  session_id: z.string(),
  session_title: z.string(),
  session_date: z.iso.date(),
  session_status: z.enum(["pending", "dreaming", "dreamed"]),
  dreamed_doc_id: z.string().nullable(),
  turn_locator: z.string(),
  excerpt: z.string(),
  matched_terms: z.array(z.string()),
  score: z.number(),
});
export const lintReportSchema = z.object({
  index_lines: z.number().int(),
  index_bytes: z.number().int(),
  broken_links: z.number().int(),
  orphan_pages: z.number().int(),
  issues: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })),
});
export const frontmatterSchema = z.strictObject({
  id: z.string(),
  title: z.string().trim().min(1).max(180),
  updated_at: z.iso.datetime(),
  sources: z.array(docIdSchema),
});
export const snapshotSchema = z.object({
  version: z.number().int().positive(),
  created_at: z.iso.datetime(),
  job_id: jobIdSchema,
  document_count: z.number().int(),
  page_count: z.number().int(),
  lint: lintReportSchema,
});
export type LintReport = z.infer<typeof lintReportSchema>;
export type Frontmatter = z.infer<typeof frontmatterSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type MemoryTier = z.infer<typeof memoryTierSchema>;
export type PrivacyScope = z.infer<typeof privacyScopeSchema>;
export type ProceduralRulePriority = z.infer<typeof proceduralRulePrioritySchema>;
export type ProceduralRule = z.infer<typeof proceduralRuleSchema>;
export type HotMemorySummary = z.infer<typeof hotMemorySummarySchema>;
export type ConversationHitSummary = z.infer<typeof conversationHitSummarySchema>;
