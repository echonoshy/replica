import { encode, decode } from "gpt-tokenizer/encoding/o200k_base";
import { findAnchors } from "@wiki-memory/shared";
import { indexText, queryTerms } from "../db/tokenize.js";

const encoderOptions = { disallowedSpecial: new Set<string>() };
const structuredRedlineMarker = /\[redline\]|\bpinned_redline\b/i;
const fallbackSafetyMarker = /过敏|急诊|医嘱|禁忌|红线|绝对不能|严禁|不耐受|过敏原|allergy|medical|emergency|prohibit|redline/i;

export const countTokens = (text: string | null | undefined) => text ? encode(text, encoderOptions).length : 0;

export function truncateTokens(text: string, limit: number) {
  if (limit <= 0) return "";
  const tokens = encode(text, encoderOptions);
  if (tokens.length <= limit) return text;
  return decode(tokens.slice(0, limit)).replace(/\uFFFD$/, "").trimEnd();
}

export function trimIndex(markdown: string, limit: number) {
  if (countTokens(markdown) <= limit) return markdown;
  const clipped = truncateTokens(markdown, limit);
  const lastLine = clipped.lastIndexOf("\n");
  return lastLine > 0 ? clipped.slice(0, lastLine).trimEnd() : clipped;
}

export function relevantMarkdown(
  markdown: string,
  query: string | string[],
  limit: number,
  boostSafety = false,
  redlineAnchors?: Set<string>,
) {
  if (countTokens(markdown) <= limit) return markdown;
  const queryList = Array.isArray(query) ? query : [query];
  const terms = [...new Set(queryList.flatMap((q) => queryTerms(q)))];
  const lines = markdown.split("\n").map((line, index) => {
    const words = new Set(indexText(line).match(/[\p{L}\p{N}]+/gu) ?? []);
    const lexicalScore = terms.reduce((sum, word) => sum + Number(words.has(word)), 0);
    const citations = findAnchors(line);
    const isRedline = boostSafety && (
      redlineAnchors !== undefined
        ? structuredRedlineMarker.test(line) || citations.some((c) => redlineAnchors.has(c.anchor))
        : structuredRedlineMarker.test(line) || fallbackSafetyMarker.test(line)
    );
    const safetyBonus = isRedline ? 1.5 : 0;
    return { line, index, score: lexicalScore + safetyBonus, citations };
  }).filter(({ citations }) => citations.length);
  lines.sort((a, b) => b.score - a.score || a.index - b.index);
  const kept = new Map<number, string>();
  let remaining = limit;
  for (const { line, index, citations } of lines) {
    const tokens = countTokens(line + "\n");
    if (tokens <= remaining) {
      kept.set(index, line);
      remaining -= tokens;
      continue;
    }
    if (kept.size) continue;
    const tags = [...new Set(citations.map(({ anchor }) => `[src:${anchor}]`))].join(" ");
    const proseBudget = remaining - countTokens(tags) - 5;
    if (proseBudget < 10) continue;
    const prose = truncateTokens(line.replace(/\[src:[^\]]+\]/g, "").replace(/\*\*/g, ""), proseBudget);
    const excerpt = `${prose}… ${tags}`;
    if (countTokens(excerpt + "\n") <= remaining) {
      kept.set(index, excerpt);
      remaining -= countTokens(excerpt + "\n");
    }
  }
  const output = [...kept].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n");
  return countTokens(output) <= limit ? output : "";
}
