import { z } from "zod";
import { CONTENT_PAGE_PATH } from "./wiki-format.js";

export const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const docIdSchema = z.string().regex(/^doc_[a-zA-Z0-9_-]{1,80}$/);
export const jobIdSchema = z.string().regex(/^job_[a-zA-Z0-9_-]{1,80}$/);
export const locatorSchema = z.string().regex(/^[pst][1-9][0-9]*$/);
export const anchorSchema = z.string().regex(/^doc_[a-zA-Z0-9_-]{1,80}#[pst][1-9][0-9]*$/);
export const contentPagePathSchema = z.string().regex(CONTENT_PAGE_PATH);
export const wikiPagePathSchema = z.union([z.literal("_index.md"), contentPagePathSchema]);
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
