import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { anchoredSections, TextDocumentNormalizer } from "../apps/api/src/pipeline/normalizer.js";

const normalizer = new TextDocumentNormalizer();
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

describe("anchored text normalization", () => {
  it("anchors Markdown and TXT paragraphs and escapes raw locator lookalikes", async () => {
    const markdown = await normalizer.normalize(Buffer.from("# 上海项目\r\n\r\n<!-- loc:p99 -->\n\n复盘安排"), "md");
    const parts = anchoredSections(markdown.markdown);
    expect(parts.map(({ locator }) => locator)).toEqual(["s1", "s2", "s3"]);
    expect(parts[1].text).toContain("&lt;!-- loc:p99 --&gt;");
    expect(anchoredSections((await normalizer.normalize(await fixture("rollout.txt"), "txt")).markdown)[0].text).toContain("RLS-2026-B");
  });

  it("preserves User and Assistant text in anchored turns", async () => {
    const result = await normalizer.normalize(await fixture("turns.json"), "json");
    expect(anchoredSections(result.markdown)).toEqual([
      { locator: "t1", text: expect.stringMatching(/\*\*User\*\*[\s\S]*靠窗[\s\S]*\*\*Assistant\*\*/) },
    ]);
    await expect(normalizer.normalize(Buffer.from('{"messages":[{"role":"unknown","content":"x"}]}'), "json"))
      .rejects.toMatchObject({ code: "INVALID_CONVERSATION" });
  });

  it("extracts actual PDF pages with pN anchors and detects an image-only scan", async () => {
    const result = await normalizer.normalize(await fixture("travel_policy.pdf"), "pdf");
    expect(result.warnings).toEqual([]);
    expect(anchoredSections(result.markdown)).toEqual([
      { locator: "p1", text: expect.stringContaining("railway receipt") },
      { locator: "p2", text: expect.stringContaining("fourteen days") },
    ]);
    const scan = await normalizer.normalize(await fixture("scan.pdf"), "pdf");
    expect(scan.warnings).toEqual(["SCANNED_PDF_NO_TEXT_LAYER"]);
    expect(scan.charCount).toBe(0);
  });

  it("keeps DOCX heading levels and list intent", async () => {
    const result = await normalizer.normalize(await fixture("checklist.docx"), "docx");
    expect(result.markdown).toContain("# 复盘资料清单");
    expect(result.markdown).toMatch(/- +带预算表/);
  });
});
