import { describe, expect, it } from "vitest";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES } from "@replica/shared";
import type { Space } from "@replica/shared";
import type { Claim } from "../apps/api/src/pipeline/analyzer.js";
import { lintDraft } from "../apps/api/src/pipeline/linter.js";
import { compileWiki } from "../apps/api/src/pipeline/wiki-compiler.js";
import { readPage, renderPage } from "../apps/api/src/pipeline/wiki-markdown.js";

const now = "2026-11-23T03:00:00.000Z";
const space: Space = {
  namespace: "finance", space_id: "alpha", purpose: "为项目复盘保留文档和修订",
  current_version: 0, document_count: 0, page_count: 0, last_dreamed_at: null, incremental_since_dream: 0,
};
const fact = (id: number, subject: string, value: string, docDate = "2026-11-22"): Claim => ({
  kind: "topic", subject, predicate: "高铁座位", value, locator: "s1",
  cardinality: "one", related: [], docId: `doc_${id}`, docDate,
});

describe("canonical Wiki and publication lint", () => {
  it("renders a bounded complete index even with hundreds of Chinese subject names", () => {
    const draft = new Map<string, string>();
    const claims = Array.from({ length: 350 }, (_, id) => fact(id, `${id} ${"长期运营项目".repeat(15)}`, "靠窗"));
    const { evidence, required } = compileWiki(draft, { ...space, purpose: "记录项目".repeat(600) },
      1, claims.map((claim) => claim.docId), [], claims, now);
    const report = lintDraft(draft, evidence, required);
    expect(report.index_lines).toBeLessThanOrEqual(INDEX_MAX_LINES);
    expect(report.index_bytes).toBeLessThanOrEqual(INDEX_MAX_BYTES);
    expect(report.broken_links + report.orphan_pages).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it("rejects line/byte overflow, a broken target, and a wiki page missing from the index", () => {
    const draft = new Map<string, string>();
    const { evidence, required } = compileWiki(draft, space, 1, ["doc_1"], [], [fact(1, "差旅偏好", "靠窗")], now);
    draft.set("_index.md", `# Memory Index\n\n[不存在](topics/missing.md)\n${"过长\n".repeat(201)}${"索引".repeat(4500)}`);
    const report = lintDraft(draft, evidence, required);
    expect(report.index_lines).toBeGreaterThan(INDEX_MAX_LINES);
    expect(report.index_bytes).toBeGreaterThan(INDEX_MAX_BYTES);
    expect(report.broken_links).toBe(1);
    expect(report.orphan_pages).toBe(3);
    expect(report.issues.map(({ code }) => code)).toEqual(expect.arrayContaining(["INDEX_LIMIT", "BROKEN_LINK", "ORPHAN_PAGE"]));
  });

  it("rejects unknown raw locators and removal of the source-backed closing fact", () => {
    const draft = new Map<string, string>();
    const { evidence, required } = compileWiki(draft, space, 1, ["doc_1"], [], [fact(1, "差旅偏好", "靠窗")], now);
    const path = [...draft.keys()].find((path) => path.startsWith("topics/"))!;
    draft.set(path, renderPage({ id: path.slice(0, -3), title: "差旅偏好", updated_at: now, sources: ["doc_1"] },
      "# 差旅偏好\n\n- 靠窗 [src:doc_1#p99]\n- 不带凭证的陈述"));
    const codes = lintDraft(draft, evidence, required).issues.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining(["UNKNOWN_CITATION", "UNCITED_STATEMENT", "LOST_EVIDENCE"]));
  });

  it("retains ambiguous same-day evidence until an explicit revision resolves it", () => {
    const first = fact(1, "差旅偏好", "靠窗");
    const second = fact(2, "差旅偏好", "过道");
    const draft = new Map<string, string>();
    compileWiki(draft, space, 1, ["doc_1", "doc_2"], [], [first, second], now);
    expect(draft.get("conflicts.md")).toContain("同日冲突，待确认");
    const revision = { ...fact(3, "差旅偏好", "靠窗"), revision: { explicit: true as const, previous_value: "过道" } };
    compileWiki(draft, space, 2, ["doc_1", "doc_2", "doc_3"], [first, second], [revision], now);
    expect(draft.get("conflicts.md")).toMatch(/靠窗.*supersedes:.*过道/);
    expect([...draft].find(([path]) => path.startsWith("topics/"))?.[1]).not.toContain("过道");
  });

  it("carries a previously organized page path forward when the facts change", () => {
    const first = fact(1, "差旅偏好", "靠窗", "2026-11-21");
    const next = fact(2, "差旅偏好", "过道", "2026-11-23");
    const draft = new Map<string, string>();
    compileWiki(draft, space, 1, ["doc_1"], [], [first], now);
    const original = [...draft.keys()].find((path) => path.startsWith("topics/"))!;
    const { body, frontmatter } = readPage(draft.get(original)!);
    draft.delete(original);
    draft.set("topics/travel-guide.md", renderPage({ ...frontmatter!, id: "topics/travel-guide", title: "差旅指南" }, body));
    const { evidence, required } = compileWiki(draft, space, 2, ["doc_1", "doc_2"], [first], [next], now);
    expect(draft.get("_index.md")).toContain("[差旅指南](topics/travel-guide.md)");
    expect(draft.get("topics/travel-guide.md")).toContain("过道");
    expect(draft.get("topics/travel-guide.md")).not.toContain("靠窗");
    expect(lintDraft(draft, evidence, required).issues).toEqual([]);
  });

  it("unifies mixed subject kinds before reconciling explicit revisions and resolving related links", () => {
    const original = fact(1, "林远", "靠窗", "2026-11-21");
    const revision: Claim = {
      ...fact(2, "林远", "过道", "2026-11-23"),
      kind: "entity", revision: { explicit: true, previous_value: "靠窗" },
    };
    const project: Claim = {
      ...fact(3, "差旅新规", "发布"),
      related: [{ kind: "topic", subject: "林远" }],
    };
    const event: Claim = {
      date: "2026-12-01", text: "林远出差", locator: "t1", docId: "doc_3", docDate: "2026-11-22",
      related: [{ kind: "topic", subject: "林远" }],
    };
    const draft = new Map<string, string>();
    const { evidence, required } = compileWiki(
      draft, space, 1, ["doc_1", "doc_2", "doc_3"], [], [original, revision, project, event], now,
    );
    const userPages = [...draft].filter(([path, markdown]) => /^(entities|topics)\//.test(path) && markdown.includes("**林远 ·"));
    expect(userPages).toHaveLength(1);
    const [userPage] = userPages;
    expect(userPage[0]).toMatch(/^entities\//);
    expect(userPage[1]).toContain("过道 [src:doc_2#s1]");
    expect(userPage[1]).not.toContain("靠窗");
    expect(draft.get("conflicts.md")).toMatch(/显式修订.*过道.*supersedes:.*靠窗/);
    expect(draft.get("timeline.md")).toContain(`[林远](${userPage[0]})`);
    expect([...draft].find(([path]) => path.startsWith("topics/"))?.[1]).toContain(`[林远](../${userPage[0]})`);
    expect(lintDraft(draft, evidence, required).issues).toEqual([]);
  });

  it("preserves a subject's published folder when a new document tags it with another kind", () => {
    const original = fact(1, "林远", "靠窗", "2026-11-21");
    const revision: Claim = {
      ...fact(2, "林远", "过道", "2026-11-23"),
      kind: "entity", revision: { explicit: true, previous_value: "靠窗" },
    };
    const draft = new Map<string, string>();
    compileWiki(draft, space, 1, ["doc_1"], [], [original], now);
    const path = [...draft.keys()].find((entry) => entry.startsWith("topics/"))!;
    const { evidence, required } = compileWiki(draft, space, 2, ["doc_1", "doc_2"], [original], [revision], now);
    expect([...draft.keys()].filter((entry) => /^(entities|topics)\//.test(entry))).toEqual([path]);
    expect(draft.get(path)).toContain("过道 [src:doc_2#s1]");
    expect(draft.get(path)).not.toContain("靠窗");
    expect(draft.get("conflicts.md")).toMatch(/显式修订.*过道.*supersedes:.*靠窗/);
    expect(lintDraft(draft, evidence, required).issues).toEqual([]);
  });

});
