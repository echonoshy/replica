import { z } from "zod";
import {
  identifierSchema, docIdSchema, jobIdSchema, locatorSchema, wikiPagePathSchema,
  anchorSchema, frontmatterSchema, snapshotSchema,
} from "./wiki-types.js";
import { UPLOAD_MAX_ITEMS } from "./wiki-format.js";

export const spaceRefSchema = z.object({ namespace: identifierSchema, space_id: identifierSchema });
export const purposeSchema = z.string().trim().min(1).max(4000);
export const filenameSchema = z.string().trim().min(1).max(255).regex(/^[^/\\\u0000-\u001f\u007f]+$/);
export const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const warningSchema = z.enum(["SCANNED_PDF_NO_TEXT_LAYER", "NO_EXTRACTABLE_TEXT"]);
export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export const docDateSchema = z.iso.date();
const ingestBaseSchema = spaceRefSchema.extend({
  purpose: purposeSchema.optional(),
  mode: z.enum(["async", "sync"]).default("async"),
  idempotency_key: z.string().trim().min(1).max(180).optional(),
});
export const ingestSchema = ingestBaseSchema.extend({
  items: z.array(z.object({
    filename: filenameSchema,
    doc_date: docDateSchema.optional(),
    content: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
  })).min(1).max(UPLOAD_MAX_ITEMS),
});
export const multipartFieldsSchema = ingestBaseSchema.extend({
  doc_dates: z.string().max(10_000).optional(),
});
export const forgetSchema = spaceRefSchema.extend({
  doc_ids: z.array(docIdSchema).min(1).max(50),
  mode: z.enum(["async", "sync"]).default("async"),
  idempotency_key: z.string().trim().min(1).max(180).optional(),
});
export const acceptedDocumentSchema = z.object({
  doc_id: docIdSchema,
  filename: filenameSchema,
  dedup_status: z.enum(["new", "duplicate"]),
  warnings: z.array(warningSchema),
  replaces_doc_id: docIdSchema.optional(),
  analyze_from_turn: z.number().int().positive().optional(),
});
export const jobStatusSchema = z.enum(["queued", "normalizing", "extracting", "organizing", "linting", "published", "failed"]);
export const jobUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  llm_calls: z.number().int().nonnegative(),
  latency_ms: z.number().int().nonnegative(),
});
export const jobProgressSchema = z.object({ completed: z.number().int(), total: z.number().int() });
export const ingestResultSchema = spaceRefSchema.extend({
  job_id: jobIdSchema,
  status: jobStatusSchema,
  accepted_docs: z.array(acceptedDocumentSchema),
  base_snapshot_version: z.number().int().nonnegative(),
  target_version: z.number().int().nonnegative().nullable().optional(),
  error_message: z.string().nullable().optional(),
});
export const jobResultSchema = ingestResultSchema.extend({
  job_type: z.enum(["ingest", "dream"]),
  progress: jobProgressSchema,
  usage: jobUsageSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export const retrieveSchema = spaceRefSchema.extend({
  query: z.string().trim().min(1).max(4000),
  return_mode: z.enum(["context", "answer", "both"]).default("context"),
  max_tokens: z.number().int().min(128).max(12_000).default(3000),
  include_index: z.boolean().default(true),
  verify_raw_sources: z.boolean().default(false),
  snapshot_version: versionSchema.nullish(),
});
export const citationSchema = z.object({
  anchor: anchorSchema,
  doc_id: docIdSchema,
  filename: filenameSchema,
  doc_date: docDateSchema,
  raw_excerpt: z.string().nullable(),
});
export const contextSchema = z.object({
  page_id: wikiPagePathSchema,
  title: z.string(),
  relevance_reason: z.string(),
  content: z.string(),
  citations: z.array(citationSchema),
});
export const retrieveResultSchema = z.object({
  snapshot_version: z.number().int().nonnegative(),
  index_excerpt: z.string().nullable(),
  contexts: z.array(contextSchema),
  answer: z.string().nullable(),
  citations: z.array(citationSchema),
  usage: z.object({
    selected_pages: z.number().int(),
    returned_tokens: z.number().int(),
    latency_ms: z.number().int(),
  }),
});
export const createSpaceSchema = spaceRefSchema.extend({ purpose: purposeSchema });
export const spaceResultSchema = createSpaceSchema.extend({
  current_version: z.number().int().nonnegative(),
  document_count: z.number().int(),
  page_count: z.number().int(),
  last_dreamed_at: z.iso.datetime().nullable(),
  incremental_since_dream: z.number().int(),
});
export const spacesResultSchema = z.object({ spaces: z.array(spaceResultSchema) });
export const treeResultSchema = z.object({
  space: spaceResultSchema,
  snapshot: snapshotSchema.nullable(),
  versions: z.array(snapshotSchema),
  files: z.array(wikiPagePathSchema),
  titles: z.record(z.string(), z.string()),
});
export const fileResultSchema = z.object({
  path: wikiPagePathSchema,
  version: versionSchema,
  frontmatter: frontmatterSchema.nullable(),
  markdown: z.string(),
});
export const sourceQuerySchema = z.object({ doc_id: docIdSchema, locator: locatorSchema });
export const sourceResultSchema = citationSchema.extend({
  locator: locatorSchema,
  previous: z.string().nullable(),
  next: z.string().nullable(),
});

export type SpaceRef = z.infer<typeof spaceRefSchema>;
export type Space = z.infer<typeof spaceResultSchema>;
export type Warning = z.infer<typeof warningSchema>;
export type AcceptedDocument = z.infer<typeof acceptedDocumentSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobUsage = z.infer<typeof jobUsageSchema>;
export type JobProgress = z.infer<typeof jobProgressSchema>;
export type JobResult = z.infer<typeof jobResultSchema>;
export type RetrieveInput = z.infer<typeof retrieveSchema>;
export type RetrieveResult = z.infer<typeof retrieveResultSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type WikiContext = z.infer<typeof contextSchema>;
export type TreeResult = z.infer<typeof treeResultSchema>;
export type FileResult = z.infer<typeof fileResultSchema>;
export type SourceResult = z.infer<typeof sourceResultSchema>;
