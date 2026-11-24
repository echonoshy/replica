import { extname } from "node:path";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import { extensions } from "@replica/shared";
import type { DocumentExtension, Warning } from "@replica/shared";
import { groupMessagesIntoTurns, locatorMarker, normalizeText } from "../chat/turns.js";
import type { NormalizedDocument } from "../db/interfaces.js";
import { ServiceError } from "../errors.js";

const mimeTypes: Record<DocumentExtension, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json",
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const paragraph = /\n[\t ]*\n+/;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const MAX_TEXT = 1_000_000;
const MAX_PDF_PAGES = 500;

export function documentType(filename: string) {
  const extension = extname(filename).slice(1).toLowerCase() as DocumentExtension;
  if (!extensions.includes(extension)) {
    throw new ServiceError(415, "UNSUPPORTED_FILE", `Unsupported file type: ${filename}`);
  }
  return { extension, mimeType: mimeTypes[extension] };
}

export interface DocumentNormalizer {
  normalize(bytes: Uint8Array, extension: DocumentExtension): Promise<NormalizedDocument>;
}

function countText(parts: string[]) {
  return parts.reduce((sum, part) => sum + (part.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
}

function anchored(parts: string[], prefix: "p" | "s" | "t", warnings: Warning[] = []): NormalizedDocument {
  const charCount = countText(parts);
  const markdown = parts.map((part, i) => `<!-- loc:${prefix}${i + 1} -->\n\n${part}`).join("\n\n");
  if (markdown.length > MAX_TEXT) {
    throw new ServiceError(422, "DOCUMENT_TOO_LONG", "Extracted document exceeds 1,000,000 characters");
  }
  return {
    markdown: markdown ? markdown + "\n" : "",
    charCount,
    warnings: warnings.length ? warnings : charCount ? [] : ["NO_EXTRACTABLE_TEXT"],
  };
}

const message = z.object({
  role: z.enum(["user", "assistant", "system", "developer", "tool"]),
  content: z.union([z.string(), z.array(z.object({ text: z.string() }))]).transform((content) =>
    typeof content === "string" ? content : content.map((part) => part.text).join("\n")),
});
const conversation = z.union([
  z.array(message),
  z.object({ messages: z.array(message) }).transform((input) => input.messages),
  z.object({ conversation: z.array(message) }).transform((input) => input.conversation),
]);

function readTurns(text: string) {
  const parsed = conversation.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new ServiceError(422, "INVALID_CONVERSATION", "JSON conversation must contain role/content messages");
  }
  return anchored(groupMessagesIntoTurns(parsed.data).map(({ text }) => text), "t");
}

export class TextDocumentNormalizer implements DocumentNormalizer {
  async normalize(bytes: Uint8Array, extension: DocumentExtension): Promise<NormalizedDocument> {
    try {
      if (extension === "pdf") {
        const document = await getDocumentProxy(new Uint8Array(bytes));
        try {
          if (document.numPages > MAX_PDF_PAGES) {
            throw new ServiceError(422, "TOO_MANY_PDF_PAGES", "A PDF may contain at most 500 pages");
          }
          const { totalPages, text } = await extractText(document, { mergePages: false });
          const pages = text.map((page) => normalizeText(page
            .replace(/([\p{L}])-\s*\n\s*(?=[\p{L}])/gu, "$1")
            .replace(/([^\n])\n(?=[^\n])/g, "$1 ")));
          return anchored(pages, "p", totalPages && countText(pages) / totalPages < 30
            ? ["SCANNED_PDF_NO_TEXT_LAYER"] : []);
        } finally {
          await document.cleanup();
        }
      }
      if (extension === "docx") {
        const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, {
          externalFileAccess: false,
          convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
        });
        const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
        turndown.remove(["img", "script", "style"]);
        return anchored(normalizeText(turndown.turndown(value)).split(paragraph).filter(Boolean), "s");
      }
      const text = normalizeText(utf8.decode(bytes));
      if (extension === "json") return readTurns(text);
      return anchored(text.split(paragraph).filter(Boolean), "s");
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(422, "NORMALIZATION_FAILED", `Could not read the ${extension.toUpperCase()} document`);
    }
  }
}

export function anchoredSections(markdown: string) {
  const matches = [...markdown.matchAll(locatorMarker)];
  return matches.map((match, index) => ({
    locator: match[1],
    text: markdown.slice(match.index! + match[0].length, matches[index + 1]?.index ?? markdown.length).trim(),
  }));
}
