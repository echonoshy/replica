import { posix } from "node:path";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import { parse } from "yaml";
import type { Nodes, Root } from "mdast";
import { frontmatterSchema } from "@replica/shared";
import type { Frontmatter } from "@replica/shared";

const parser = unified().use(remarkParse).use(remarkGfm);
const frontmatterBlock = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function readPage(markdown: string) {
  const match = markdown.match(frontmatterBlock);
  const body = match ? markdown.slice(match[0].length).trim() : markdown.trim();
  const frontmatter = match ? frontmatterSchema.parse(parse(match[1], { schema: "core", maxAliasCount: 0 })) : null;
  return { frontmatter, body };
}

export function renderPage(frontmatter: Frontmatter, body: string) {
  const header = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  return `---\n${header}\n---\n\n${body.trim()}\n`;
}

export function markdownAst(text: string): Root {
  return parser.parse(text);
}

export function walk(node: Nodes, visit: (part: Nodes) => void) {
  visit(node);
  if ("children" in node) for (const child of node.children) walk(child, visit);
}

export function plainText(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(plainText).join("");
  return "";
}

export function relativeWikiLink(from: string, to: string) {
  return posix.relative(posix.dirname(from), to);
}

export function wikiLinkTarget(from: string, url: string) {
  try {
    const [part, fragment] = url.split("#");
    const decoded = decodeURIComponent(part);
    if (/^[a-z]+:|^\/|[\\?]/i.test(decoded)) return null;
    return {
      path: decoded ? posix.normalize(posix.join(posix.dirname(from), decoded)) : from,
      fragment: fragment ? decodeURIComponent(fragment) : null,
    };
  } catch {
    return null;
  }
}

export const wikiHeadingId = (name: string) =>
  name.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s+/g, "-");

export function inline(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/[\\\[\]<>*_\x60|]/g, "\\$&");
}

export function clipBytes(value: string, limit: number) {
  if (Buffer.byteLength(value) <= limit) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit - 3) break;
    output += character;
  }
  return output.trimEnd() + "…";
}
