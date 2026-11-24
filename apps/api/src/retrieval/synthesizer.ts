import { z } from "zod";
import { findAnchors } from "@replica/shared";
import type { Citation, RetrieveInput, RetrieveResult, SourceResult, SpaceRef, WikiContext } from "@replica/shared";
import type { DocumentRecord, MetadataRepository, WikiStorage } from "../db/interfaces.js";
import { spaceKey, zeroUsage } from "../db/interfaces.js";
import { ServiceError } from "../errors.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";
import { anchoredSections } from "../pipeline/normalizer.js";
import { clipBytes, markdownAst, plainText, readPage, walk } from "../pipeline/wiki-markdown.js";
import type { Navigator } from "./navigator.js";
import { countTokens, relevantMarkdown, trimIndex, truncateTokens } from "./token-budget.js";

const noEvidence = (query: string) => /\p{Script=Han}/u.test(query)
  ? "当前快照没有足够的相关证据。" : "The snapshot does not contain enough relevant evidence.";

const framingLeadIn = /^(?:(?:具体|分项|分别)?(?:说明|回答|答复|情况|要点|总结)(?:如下)?|以下(?:是|为)?(?:具体)?(?:回答|说明|要点)|(?:here (?:is|are) (?:the |a )?)?(?:summary|answers?|details|key points))\s*[:：]$/i;
const evidenceGap = /未提及|未找到|没有.*(?:信息|记录|资料|数据|证据)|暂无.*(?:信息|记录|资料|证据)|无相关|无法确认|无法确定|not mentioned|no (?:relevant )?(?:evidence|information|record)|not found in|cannot (?:confirm|determine)|(?:passages|sources|records) do not (?:mention|cover|specify)/i;

function needsCitation(text: string) {
  if (!text) return false;
  const body = text.replace(/^(?:关于|针对|就)[^，,。！？:：\n]{1,24}[，,]\s*/u, "");
  if ([...text].length <= 40 && framingLeadIn.test(body)) return false;
  // A disclaimer cannot exempt a separate assertion in the same paragraph.
  const statement = body.replace(/^(?:根据(?:现有|当前|所提供的?)?(?:资料|材料|记录)|(?:in|according to) the (?:supplied|available|provided) passages)[，,]\s*/i, "");
  const clauses = statement.split(/[。！？.!?；;，,\n]+|但(?:是)?|不过|\b(?:but|however)\b/i)
    .map((part) => part.trim()).filter(Boolean);
  return !clauses.length || clauses.some((part) => !evidenceGap.test(part));
}

export async function requireSpace(repo: MetadataRepository, ref: SpaceRef) {
  const space = await repo.findSpace(ref);
  if (!space) throw new ServiceError(404, "SPACE_NOT_FOUND", "Memory space not found");
  return space;
}

export async function snapshotFor(repo: MetadataRepository, ref: SpaceRef, requested?: number | null) {
  const space = await requireSpace(repo, ref);
  const version = requested ?? space.current_version;
  const snapshot = version ? await repo.getSnapshot(spaceKey(ref), version) : null;
  if (version && !snapshot) throw new ServiceError(404, "SNAPSHOT_NOT_FOUND", "Snapshot version not found");
  return { space, snapshot };
}

export class SourceReader {
  private readonly docs = new Map<string, Promise<DocumentRecord | undefined>>();
  private readonly sections = new Map<string, Promise<ReturnType<typeof anchoredSections>>>();

  constructor(private readonly repo: MetadataRepository, private readonly storage: WikiStorage, private readonly ref: SpaceRef) {}

  private document(id: string) {
    const cached = this.docs.get(id) ?? this.repo.findDocument(spaceKey(this.ref), id);
    this.docs.set(id, cached);
    return cached;
  }

  private blocks(doc: DocumentRecord) {
    const cached = this.sections.get(doc.docId) ?? this.storage.readNormalized(this.ref, doc).then((result) =>
      result ? anchoredSections(result.markdown) : []);
    this.sections.set(doc.docId, cached);
    return cached;
  }

  async lookup(docId: string, locator: string): Promise<SourceResult> {
    const doc = await this.document(docId);
    if (!doc) throw new ServiceError(404, "SOURCE_NOT_FOUND", "Source document not found in this space");
    const sections = await this.blocks(doc);
    const index = sections.findIndex((section) => section.locator === locator);
    if (index < 0) throw new ServiceError(404, "SOURCE_NOT_FOUND", "Source locator not found");
    return {
      anchor: `${docId}#${locator}`, doc_id: docId, filename: doc.filename, doc_date: doc.docDate, locator,
      raw_excerpt: clipBytes(sections[index].text, 24_000),
      previous: index > 0 ? clipBytes(sections[index - 1].text, 800) : null,
      next: sections[index + 1] ? clipBytes(sections[index + 1].text, 800) : null,
    };
  }

  async citations(text: string, rawBudget: { remaining: number } | null) {
    const anchors = new Map(findAnchors(text).map((anchor) => [anchor.anchor, anchor]));
    const citations: Citation[] = [];
    for (const { anchor, docId, locator } of anchors.values()) {
      const doc = await this.document(docId);
      if (!doc) throw new ServiceError(500, "SOURCE_MISSING", "A published citation has no source document");
      let raw: string | null = null;
      if (rawBudget && rawBudget.remaining > 0) {
        const excerpt = (await this.lookup(docId, locator)).raw_excerpt;
        if (excerpt) {
          const fairBudget = Math.ceil(rawBudget.remaining / (anchors.size - citations.length));
          raw = truncateTokens(excerpt, Math.min(360, fairBudget)) || null;
          rawBudget.remaining -= countTokens(raw);
        }
      }
      citations.push({ anchor, doc_id: docId, filename: doc.filename, doc_date: doc.docDate, raw_excerpt: raw });
    }
    return citations;
  }
}

export class Synthesizer {
  constructor(
    private readonly repo: MetadataRepository, private readonly storage: WikiStorage,
    private readonly gateway: OpenAiGateway, private readonly navigator: Navigator,
  ) {}

  async retrieve(input: RetrieveInput): Promise<RetrieveResult> {
    const started = Date.now();
    const { snapshot } = await snapshotFor(this.repo, input, input.snapshot_version);
    const empty = !snapshot;
    const answerRequested = input.return_mode !== "context";
    const contextsRequested = input.return_mode !== "answer";
    if (empty) {
      const answer = answerRequested ? noEvidence(input.query) : null;
      return {
        snapshot_version: 0, index_excerpt: null, contexts: [], answer, citations: [],
        usage: { selected_pages: 0, returned_tokens: countTokens(answer), latency_ms: Date.now() - started },
      };
    }
    const version = snapshot.version;
    const [index, paths] = await Promise.all([
      this.storage.readSnapshotFile(input, version, "_index.md"), this.storage.listSnapshotFiles(input, version),
    ]);
    const selection = await this.navigator.select(input, version, index, paths);
    const pages = await Promise.all(selection.map(async ({ path, reason }) => ({
      path, reason, ...readPage(await this.storage.readSnapshotFile(input, version, path)),
    })));
    const indexExcerpt = input.include_index ? trimIndex(index, Math.floor(input.max_tokens / 5)) : null;
    const afterIndex = input.max_tokens - countTokens(indexExcerpt);
    const rawReserve = input.verify_raw_sources ? Math.floor(afterIndex / 4) : 0;
    const afterRaw = afterIndex - rawReserve;
    const contextLimit = input.return_mode === "both"
      ? Math.floor(afterRaw * 0.62) : contextsRequested ? afterRaw : Math.max(1600, afterRaw);
    let contextBudget = contextLimit;
    const slices: Omit<WikiContext, "citations">[] = [];
    for (const [i, page] of pages.entries()) {
      const share = Math.min(contextBudget, Math.max(64, Math.floor(contextBudget / (pages.length - i))));
      const excerpt = relevantMarkdown(page.body, input.query, share);
      if (!excerpt || !findAnchors(excerpt).length) continue;
      slices.push({ page_id: page.path, title: page.frontmatter?.title ?? page.path, relevance_reason: page.reason, content: excerpt });
      contextBudget -= countTokens(excerpt);
    }

    let answer: string | null = null;
    if (answerRequested) {
      const answerBudget = contextsRequested ? afterRaw - contextLimit + contextBudget : afterRaw;
      answer = await this.answer(input.query, slices, answerBudget);
    }
    const sources = new SourceReader(this.repo, this.storage, input);
    const rawBudget = input.verify_raw_sources ? { remaining: rawReserve } : null;
    const contexts: WikiContext[] = [];
    if (contextsRequested) {
      for (const page of slices) {
        contexts.push({ ...page, citations: await sources.citations(page.content, rawBudget) });
      }
    }
    const answerCitations = answer && (!contextsRequested || input.return_mode === "both")
      ? await sources.citations(answer, contextsRequested ? null : rawBudget) : [];
    const returnedTokens = countTokens(indexExcerpt) + countTokens(answer)
      + (contextsRequested ? contextLimit - contextBudget : 0) + rawReserve - (rawBudget?.remaining ?? 0);
    return {
      snapshot_version: version, index_excerpt: indexExcerpt, contexts, answer, citations: answerCitations,
      usage: { selected_pages: slices.length, returned_tokens: returnedTokens, latency_ms: Date.now() - started },
    };
  }

  private async answer(query: string, contexts: Omit<WikiContext, "citations">[], budget: number) {
    if (!contexts.length) return noEvidence(query);
    const available = new Set(contexts.flatMap(({ content }) => findAnchors(content).map((a) => a.anchor)));
    const schema = z.object({ answer: z.string().trim() }).superRefine(({ answer }, ctx) => {
      if (!answer) return;
      if (countTokens(answer) > budget) ctx.addIssue({ code: "custom", message: "Answer exceeds token budget" });
      const anchors = findAnchors(answer);
      if (!anchors.length || anchors.length !== (answer.match(/\[src:/g) ?? []).length
        || anchors.some((tag) => !available.has(tag.anchor))) {
        ctx.addIssue({ code: "custom", message: "Every answer citation must occur verbatim in a supplied passage" });
      }
      walk(markdownAst(answer), (node) => {
        if (node.type !== "paragraph" && node.type !== "tableCell") return;
        const raw = answer.slice(node.position?.start.offset, node.position?.end.offset);
        if (!findAnchors(raw).length && needsCitation(plainText(node).trim())) {
          ctx.addIssue({ code: "custom", message: "Each factual paragraph or bullet must include a citation" });
        }
      });
    });
    const result = await this.gateway.structured("strong", prompts.synthesizer, {
      query, max_answer_tokens: budget, passages: contexts.map(({ title, content }) => ({ title, content })),
    }, schema, zeroUsage(), Math.max(128, budget + 100));
    return result.answer || noEvidence(query);
  }
}
