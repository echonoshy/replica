import {
  contentPagePathSchema, findAnchors, INDEX_MAX_BYTES, INDEX_MAX_LINES, wikiPagePathSchema,
} from "@replica/shared";
import type { LintReport } from "@replica/shared";
import type { Root } from "mdast";
import type { WikiDraft } from "../db/interfaces.js";
import { EMPTY_CONFLICTS, EMPTY_TIMELINE } from "./wiki-compiler.js";
import type { RequiredLine } from "./wiki-compiler.js";
import { markdownAst, plainText, readPage, walk, wikiHeadingId, wikiLinkTarget } from "./wiki-markdown.js";

export function lintDraft(
  draft: WikiDraft, evidence: Set<string>, required?: RequiredLine[], indexHeader?: string,
): LintReport {
  const index = draft.get("_index.md") ?? "";
  const report: LintReport = {
    index_lines: index ? index.replace(/\r?\n$/, "").split(/\r?\n/).length : 0,
    index_bytes: Buffer.byteLength(index), broken_links: 0, orphan_pages: 0, issues: [],
  };
  const issue = (code: string, path: string, message: string) => report.issues.push({ code, path, message });
  if (!index.trim()) issue("MISSING_INDEX", "_index.md", "Write a non-empty top-level index");
  if (indexHeader && !index.startsWith(indexHeader + "\n")) {
    issue("INDEX_HEADER_REQUIRED", "_index.md", "Keep the original space purpose and snapshot statistics at the top of _index.md");
  }
  if (report.index_lines > INDEX_MAX_LINES || report.index_bytes > INDEX_MAX_BYTES) {
    issue("INDEX_LIMIT", "_index.md", `Index is ${report.index_lines} lines and ${report.index_bytes} UTF-8 bytes. Limit: 200 lines and 25,600 bytes.`);
  }
  for (const path of ["timeline.md", "conflicts.md"]) {
    if (!draft.has(path)) issue("MISSING_CORE_PAGE", path, "Keep this required Wiki page");
  }

  const activeAnchors = required
    ? new Set(required.filter(({ path }) => path !== "conflicts.md").flatMap(({ line }) => findAnchors(line).map(({ anchor }) => anchor)))
    : evidence;
  const parsed = new Map<string, { ast: Root; headings: Set<string> }>();
  const linePages = new Map<string, Set<string>>();
  for (const [path, text] of draft) {
    if (!wikiPagePathSchema.safeParse(path).success) continue;
    try {
      const { frontmatter, body } = path === "_index.md" ? { frontmatter: null, body: text } : readPage(text);
      const anchors = findAnchors(body);
      if ((body.match(/(?<!\\)\[src:/g)?.length ?? 0) !== anchors.length) issue("BAD_CITATION", path, "Use [src:doc_id#locator] for each citation");
      for (const anchor of anchors) {
        if (!evidence.has(anchor.anchor)) issue("UNKNOWN_CITATION", path, `Unknown source anchor ${anchor.anchor}`);
        else if (path !== "conflicts.md" && !activeAnchors.has(anchor.anchor)) {
          issue("INACTIVE_CITATION", path, `Keep superseded or expired evidence in the audit: ${anchor.anchor}`);
        }
      }
      if (path !== "_index.md") {
        const sources = [...new Set(anchors.map((anchor) => anchor.docId))].sort();
        if (!frontmatter || frontmatter.id !== path.slice(0, -3)
          || sources.join(",") !== [...frontmatter.sources].sort().join(",")) {
          issue("BAD_FRONTMATTER", path, "Page id and sources must match the path and inline citations");
        }
        if (!body.trim()) issue("EMPTY_PAGE", path, "Write a non-empty page");
      }
      const ast = markdownAst(body);
      const headings = new Set<string>();
      walk(ast, (node) => {
        if (node.type === "heading") headings.add(wikiHeadingId(plainText(node)));
        if (path === "_index.md") return;
        if (node.type === "code" || node.type === "html" || node.type === "image" || node.type === "imageReference") {
          issue("UNSUPPORTED_MARKUP", path, "Use sourced Markdown paragraphs or list items for knowledge");
        }
        if (node.type !== "paragraph" && node.type !== "tableCell") return;
        const text = plainText(node).trim();
        const nav = node.children.every((child) => child.type === "link" || child.type === "linkReference"
          || (child.type === "text" && /^[\s·,，、;；]*$/.test(child.value)));
        if (text && !nav && ![EMPTY_TIMELINE, EMPTY_CONFLICTS].includes(text) && !findAnchors(text).length) {
          issue("UNCITED_STATEMENT", path, `Add a source to: ${text.slice(0, 150)}`);
        }
      });
      if (!ast.children.some((node) => node.type === "heading" && node.depth === 1)) {
        issue("MISSING_TITLE", path, "Add a level-one title");
      }
      parsed.set(path, { ast, headings });
      if (path !== "_index.md") {
        for (const line of body.split(/\r?\n/)) {
          const pages = linePages.get(line.trim());
          if (pages) pages.add(path);
          else linePages.set(line.trim(), new Set([path]));
        }
      }
    } catch {
      issue("BAD_MARKDOWN", path, "Page has invalid frontmatter or Markdown");
    }
  }

  const indexed = new Set<string>();
  for (const [path, { ast }] of parsed) {
    const definitions = new Map<string, string>();
    walk(ast, (node) => { if (node.type === "definition") definitions.set(node.identifier, node.url); });
    walk(ast, (node) => {
      const url = node.type === "link" ? node.url
        : node.type === "linkReference" ? definitions.get(node.identifier) : undefined;
      if (url === undefined || /^(?:https?:\/\/|mailto:)/i.test(url)) return;
      const target = wikiLinkTarget(path, url);
      if (!target || !parsed.has(target.path) || (target.fragment && !parsed.get(target.path)!.headings.has(target.fragment))) {
        report.broken_links++;
        issue("BROKEN_LINK", path, `Link target does not exist: ${url}`);
      } else if (path === "_index.md" && contentPagePathSchema.safeParse(target.path).success) {
        indexed.add(target.path);
      }
    });
  }
  for (const path of draft.keys()) {
    if (contentPagePathSchema.safeParse(path).success && !indexed.has(path)) {
      report.orphan_pages++;
      issue("ORPHAN_PAGE", path, "Add a relative link from _index.md");
    }
  }

  for (const requirement of required ?? []) {
    const pages = linePages.get(requirement.line) ?? new Set<string>();
    const present = requirement.path ? pages.has(requirement.path)
      : [...pages].some((path) => path.startsWith(requirement.kind === "entity" ? "entities/" : "topics/"));
    if (!present) issue("LOST_EVIDENCE", requirement.path ?? "_index.md", `Keep this exact source-backed line: ${requirement.line}`);
  }
  return report;
}
