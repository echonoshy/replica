import { randomUUID } from "node:crypto";
import { contentPagePathSchema } from "@wiki-memory/shared";
import type { JobProgress, JobStatus, Space, SpaceRef } from "@wiki-memory/shared";
import { zeroUsage } from "../db/interfaces.js";
import type {
  ClaimedJob, DocumentRecord, IndexedPage, Job, JobQueue, MetadataRepository, NormalizedDocument, SnapshotRecord, SpaceConfigProjection, WikiStorage,
} from "../db/interfaces.js";
import { errorMessage, ServiceError } from "../errors.js";
import { indexText } from "../db/tokenize.js";
import { computeFactActivation } from "../memory/memory-state.js";
import type { SQLiteMemoryStateStore } from "../memory/memory-state.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { SourceReader } from "../retrieval/synthesizer.js";
import { anchorKey, claimAnchors, isFact, isIntention, isRule } from "./analyzer.js";
import type { AtomicFact, ClaimAnchor } from "./analyzer.js";
import type { Analyzer, Analysis, Claim } from "./analyzer.js";
import { lintDraft } from "./linter.js";
import { anchoredSections } from "./normalizer.js";
import type { DocumentNormalizer } from "./normalizer.js";
import type { Organizer } from "./organizer.js";
import { classifyMissingActiveFacts, compileWiki, factTelemetry, vocabularyOf } from "./wiki-compiler.js";
import { readPage } from "./wiki-markdown.js";

export async function syncSpaceConfig(
  repo: MetadataRepository, projection: SpaceConfigProjection, ref: SpaceRef,
) {
  try {
    const latest = await repo.findSpace(ref);
    if (latest) await projection.write(latest);
  } catch (error) {
    console.error("Could not update space.json projection", errorMessage(error));
  }
}

type Dependencies = {
  memoryState?: SQLiteMemoryStateStore;
  gateway?: Pick<OpenAiGateway, "hasEmbeddings" | "embed"> & Partial<Pick<OpenAiGateway, "structured">>;
  onSnapshotChanged?: (ref: SpaceRef, version: number) => Promise<void>;
  repo: MetadataRepository; queue: JobQueue; storage: WikiStorage; projection: SpaceConfigProjection;
  normalizer: DocumentNormalizer; analyzer: Analyzer; organizer: Organizer; concurrency: number;
};

const turnNumber = (locator: string) => locator.startsWith("t") ? Number(locator.slice(1)) : 0;
type Replacement = { docId: string; retainedLocators: Set<string> };

const retractionStopWords = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "each", "every", "their", "its",
  "against", "about", "when", "then", "will", "have", "been", "only", "also", "must", "should",
  "could", "would", "after", "before", "under", "over", "same", "other", "more", "most", "some",
]);

function contentTokens(text: string) {
  return new Set(
    (indexText(text).match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => ([...token].length > 1) && !retractionStopWords.has(token)),
  );
}

function reliesOnRetractedContent(mergedValue: string, retracted: AtomicFact[], surviving: AtomicFact[]) {
  const survivingTokens = new Set<string>();
  for (const item of surviving) {
    for (const token of contentTokens(`${item.predicate} ${item.value}`)) survivingTokens.add(token);
  }
  const retractedOnly = new Set<string>();
  for (const item of retracted) {
    for (const token of contentTokens(`${item.predicate} ${item.value}`)) {
      if (!survivingTokens.has(token)) retractedOnly.add(token);
    }
  }
  if (!retractedOnly.size) return false;
  for (const token of contentTokens(mergedValue)) {
    if (retractedOnly.has(token)) return true;
  }
  return false;
}

async function retainClaims(
  claims: Claim[], retracted: Set<string>, replacements: Map<string, Replacement>,
  readDocDate: (docId: string) => Promise<string | undefined>,
) {
  if (!retracted.size && !replacements.size) return claims;
  const retain = (anchor: ClaimAnchor) => {
    if (retracted.has(anchor.docId)) return undefined;
    const replacement = replacements.get(anchor.docId);
    if (!replacement) return anchor;
    return replacement.retainedLocators.has(anchor.locator) ? { docId: replacement.docId, locator: anchor.locator } : undefined;
  };
  const retained: Claim[] = [];
  const docDates = new Map<string, string | undefined>();
  const retainCorrections = <T extends AtomicFact>(fact: T): T => {
    if (!fact.corrections?.length) return fact;
    const corrections = fact.corrections.flatMap((edit) => {
      const sources = edit.sources.map(retain).filter((source) => source !== undefined);
      return sources.length === edit.sources.length ? [{ ...edit, sources }] : [];
    });
    return { ...fact, corrections };
  };
  for (const original of claims) {
    const claim = isFact(original) ? retainCorrections(original) : original;
    if (isFact(claim) && claim.merged_from?.length) {
      const survivingAtoms: AtomicFact[] = [];
      const retractedAtoms: AtomicFact[] = [];
      for (const atom of claim.merged_from) {
        const kept = retain(atom);
        if (kept) survivingAtoms.push({ ...retainCorrections(atom), docId: kept.docId });
        else retractedAtoms.push(atom);
      }
      if (!survivingAtoms.length) continue;
      if (retractedAtoms.length && reliesOnRetractedContent(claim.value, retractedAtoms, survivingAtoms)) {
        // The merged text contains statements uniquely backed by retracted evidence:
        // restore only the surviving atomic claims so retracted facts cannot survive on unrelated citations.
        retained.push(...survivingAtoms);
        continue;
      }
      const primary = retain(claim);
      const extras = new Map<string, ClaimAnchor>();
      for (const source of claim.extra_sources ?? []) {
        const kept = retain(source);
        if (kept) extras.set(anchorKey(kept), kept);
      }
      const anchor = primary ?? extras.values().next().value ?? survivingAtoms[0];
      extras.delete(anchorKey(anchor));
      if (!primary && !docDates.has(anchor.docId)) docDates.set(anchor.docId, await readDocDate(anchor.docId));
      retained.push({
        ...claim, docId: anchor.docId, locator: anchor.locator,
        docDate: primary ? claim.docDate : docDates.get(anchor.docId) ?? claim.docDate,
        extra_sources: extras.size ? [...extras.values()] : undefined,
        merged_from: survivingAtoms,
      });
      continue;
    }
    const primary = retain(claim);
    if ((!isFact(claim) && !isRule(claim) && !isIntention(claim)) || !claim.extra_sources?.length) {
      if (primary) retained.push({ ...claim, docId: primary.docId });
      continue;
    }
    const extras = new Map<string, ClaimAnchor>();
    for (const source of claim.extra_sources) {
      const kept = retain(source);
      if (kept) extras.set(anchorKey(kept), kept);
    }
    const anchor = primary ?? extras.values().next().value;
    if (!anchor) continue;
    extras.delete(anchorKey(anchor));
    if (!primary && !docDates.has(anchor.docId)) docDates.set(anchor.docId, await readDocDate(anchor.docId));
    retained.push({
      ...claim, docId: anchor.docId, locator: anchor.locator,
      docDate: primary ? claim.docDate : docDates.get(anchor.docId) ?? claim.docDate,
      extra_sources: extras.size ? [...extras.values()] : undefined,
    });
  }
  return retained;
}

export class CompileWorker {
  private readonly id = randomUUID();
  private readonly active = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private stopped = true;

  constructor(private readonly deps: Dependencies) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 250);
    this.timer.unref();
    this.wake();
  }

  wake() {
    if (this.stopped || this.pumping || this.active.size >= this.deps.concurrency) return;
    this.pumping = this.pump().catch((error: unknown) => {
      console.error("Cannot claim compile jobs", errorMessage(error));
    }).finally(() => { this.pumping = undefined; });
  }

  private async pump() {
    while (!this.stopped && this.active.size < this.deps.concurrency) {
      const claim = await this.deps.queue.claimNext(this.id);
      if (!claim) return;
      const active = this.process(claim).catch((error: unknown) => {
        console.error("Compile worker could not settle job", claim.job.id, errorMessage(error));
      }).finally(() => {
        this.active.delete(active);
        this.wake();
      });
      this.active.add(active);
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pumping;
    await Promise.allSettled(this.active);
  }

  private async finishPublication(job: Job, snapshot: SnapshotRecord, space: Space, publishedPages?: IndexedPage[]) {
    const { memoryState, storage } = this.deps;
    if (!memoryState) return;
    if (snapshot.processed_hot_ids?.length) memoryState.markHotMemoriesConsumedByIds(job.spaceKey, snapshot.processed_hot_ids);
    if (snapshot.digested_session_ids?.length) {
      // Commands may arrive while extraction runs or while a published job is awaiting recovery.
      const sessions = new Set(snapshot.digested_session_ids);
      const active = memoryState.listHotMemories(job.spaceKey, "active").filter((item) => item.session_id && sessions.has(item.session_id));
      const changed = new Set(active.filter((item) => item.created_at >= job.createdAt).map((item) => item.session_id));
      memoryState.markSessionHotMemoriesConsumed(job.spaceKey, [...sessions].filter((id) => !changed.has(id)));
      const earlier = active.filter((item) => changed.has(item.session_id) && item.created_at < job.createdAt);
      if (earlier.length) memoryState.markHotMemoriesConsumedByIds(job.spaceKey, earlier.map(({ id }) => id));
    }
    const pages = publishedPages ?? await Promise.all(Object.entries(snapshot.page_titles ?? {}).map(async ([path, title]) => {
      const { body } = readPage(await storage.readSnapshotFile(space, snapshot.version, path));
      return { path, title, content: body };
    }));
    const texts = pages.map((page) => `${page.title}\n${page.content}`);
    const { gateway } = this.deps;
    let vectors: number[][] | null = null;
    if (gateway?.hasEmbeddings()) {
      try {
        vectors = await gateway.embed(texts);
      } catch (error) {
        console.error("Embedding published Wiki pages failed, using local vectors", errorMessage(error));
      }
    }
    for (const [i, page] of pages.entries()) {
      const vector = vectors?.[i];
      memoryState.upsertWikiPageVector(job.spaceKey, snapshot.version, page.path, vector ?? texts[i], !!vector);
    }
  }

  private async process(claim: ClaimedJob) {
    const { repo, queue, storage, projection, normalizer, analyzer, organizer } = this.deps;
    const { job, lease } = claim;
    const started = Date.now();
    const usage = { ...zeroUsage(), ...job.usage };
    const priorLatency = usage.latency_ms;
    const touchUsage = () => { usage.latency_ms = priorLatency + Date.now() - started; };
    const mark = async (status: JobStatus, progress: JobProgress) => {
      touchUsage();
      await queue.heartbeat(lease, { id: job.id, status, progress, usage });
    };
    let published: SnapshotRecord | undefined;
    const heart = setInterval(() => {
      void queue.heartbeat(lease).catch(() => { /* Every mutation rechecks the lease. */ });
    }, 8000);
    heart.unref();
    try {
      const recovered = await repo.findPublication(job.id);
      if (recovered) {
        const space = await repo.findSpaceByKey(job.spaceKey);
        if (space) await this.finishPublication(job, recovered, space);
        if (space?.current_version === recovered.version) await this.deps.onSnapshotChanged?.(space, recovered.version);
        if (space) await syncSpaceConfig(repo, projection, space);
        await queue.complete(claim, recovered.version, usage);
        return;
      }
      const space = await repo.findSpaceByKey(job.spaceKey);
      if (!space) throw new ServiceError(404, "SPACE_NOT_FOUND", "Memory space not found");
      published = await this.compile(space, claim, mark, usage, { repo, storage, normalizer, analyzer, organizer });
      if (published) {
        await this.deps.onSnapshotChanged?.(space, published.version);
        await syncSpaceConfig(repo, projection, space);
      }
      touchUsage();
      await queue.complete(claim, published?.version ?? space.current_version, usage);
    } catch (error) {
      // A durable publication receipt wins if a failure occurs while settling the queue.
      if (published || await repo.findPublication(job.id)) throw error;
      touchUsage();
      await queue.fail(claim, errorMessage(error), usage);
    } finally {
      clearInterval(heart);
      await lease.release();
    }
  }

  private async compile(
    space: Space, { job, lease }: ClaimedJob,
    mark: (status: JobStatus, progress: JobProgress) => Promise<void>,
    usage: ReturnType<typeof zeroUsage>,
    { repo, storage, normalizer, analyzer, organizer }: Pick<Dependencies, "repo" | "storage" | "normalizer" | "analyzer" | "organizer">,
  ): Promise<SnapshotRecord | undefined> {
    const baseVersion = space.current_version;
    const dreaming = job.type === "dream";
    const base = baseVersion ? await repo.getSnapshot(job.spaceKey, baseVersion) : undefined;
    if (dreaming && !base) throw new ServiceError(409, "NO_PUBLISHED_SNAPSHOT", "Publish a snapshot before Dreaming");
    const publishedDocs = new Set(base?.documents ?? []);
    const retractIds = new Set(job.payload.retract_doc_ids ?? []);
    const accepted = new Map(job.payload.docs.map((doc) => [doc.doc_id, doc]));
    const pending: DocumentRecord[] = [];
    for (const { doc_id, replaces_doc_id } of accepted.values()) {
      if (publishedDocs.has(doc_id) || retractIds.has(doc_id)) continue;
      const doc = await repo.findDocument(job.spaceKey, doc_id);
      if (!doc) throw new Error(`Missing accepted document ${doc_id}`);
      if (doc.firstPublishedVersion === null || (replaces_doc_id && publishedDocs.has(replaces_doc_id))) pending.push(doc);
    }
    if (!dreaming && !pending.length && !retractIds.size) return undefined;

    const draft = await storage.cloneSnapshotToStaging(space, job.id, baseVersion);
    const priorClaims: Claim[] = JSON.parse(draft.get("_claims.json") ?? "[]");
    const activeRetractions = [...retractIds].some((id) => publishedDocs.has(id))
      || priorClaims.some((claim) => claimAnchors(claim).some(({ docId }) => retractIds.has(docId)));
    if (!dreaming && !pending.length && !activeRetractions) return undefined;
    await mark("normalizing", { completed: 0, total: pending.length });
    const replacedBy = new Map<string, Replacement>();
    const normalized: Array<{ doc: DocumentRecord; text: NormalizedDocument }> = [];
    for (const doc of pending) {
      const fullText = await storage.readNormalized(space, doc, (bytes) => normalizer.normalize(bytes, doc.extension));
      if (!fullText) throw new Error(`Missing normalized document ${doc.docId}`);
      await repo.recordNormalization(doc.docId, fullText);
      const { replaces_doc_id, analyze_from_turn } = accepted.get(doc.docId)!;
      const replaces = replaces_doc_id && publishedDocs.has(replaces_doc_id) && !retractIds.has(replaces_doc_id);
      const delta = analyze_from_turn !== undefined && analyze_from_turn > 1;
      const sections = replaces || delta ? anchoredSections(fullText.markdown) : [];
      let text = fullText;
      if (replaces) {
        const retainedLocators = new Set(sections.filter(({ locator }) =>
          analyze_from_turn === undefined || turnNumber(locator) < analyze_from_turn).map(({ locator }) => locator));
        replacedBy.set(replaces_doc_id, { docId: doc.docId, retainedLocators });
      }
      if (delta) {
        const markdown = sections.filter(({ locator }) => turnNumber(locator) >= analyze_from_turn)
          .map(({ locator, text, date }) => `<!-- loc:${locator} -->${date ? `\n<!-- date:${date} -->` : ""}\n\n${text}`).join("\n\n");
        text = { ...fullText, markdown };
      }
      normalized.push({ doc, text });
      await mark("normalizing", { completed: normalized.length, total: pending.length });
    }
    const previous = await retainClaims(priorClaims, retractIds, replacedBy,
      async (docId) => (await repo.findDocument(job.spaceKey, docId))?.docDate);

    const progress = { completed: 0, total: normalized.length };
    const analyses: Analysis[] = [];
    const { memoryState } = this.deps;
    const existingAliases = [...(memoryState?.canonicalAliasGroups(job.spaceKey) ?? [])]
      .map(([canonical, aliases]) => ({ canonical, aliases }));
    await mark("extracting", progress);
    let next = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(6, normalized.length) }, async () => {
      while (next < normalized.length) {
        const index = next++;
        const { doc, text } = normalized[index];
        if (text.warnings.length) {
          await storage.writeStagingNote(space, job.id, doc.docId, `# ${doc.filename}\n\n${text.warnings.join("\n")}\n`);
          analyses[index] = { claims: [] };
        } else if (text.markdown) {
          analyses[index] = await analyzer.analyze(space, space.purpose, job.id, doc, text,
            vocabularyOf(previous, text.markdown), usage, existingAliases);
        } else {
          analyses[index] = { claims: [] };
        }
        await mark("extracting", { completed: ++progress.completed, total: progress.total });
      }
    }));
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejection) throw rejection.reason;

    await mark("organizing", progress);
    const version = await repo.reserveVersion(lease);
    const addedDocuments = pending.map((doc) => doc.docId);
    for (const id of retractIds) publishedDocs.delete(id);
    for (const id of replacedBy.keys()) publishedDocs.delete(id);
    const documents = [...publishedDocs, ...addedDocuments];
    const now = new Date().toISOString();
    if (memoryState) {
      for (const analysis of analyses) {
        for (const item of analysis.entityAliases ?? []) {
          for (const alias of item.aliases) memoryState.registerAlias(job.spaceKey, "entity", item.canonical, alias);
        }
      }
    }
    const aliases = memoryState?.aliasLookupMap(job.spaceKey);
    const aliasGroups = memoryState?.canonicalAliasGroups(job.spaceKey);
    const telemetry = memoryState?.listTelemetry(job.spaceKey);
    let combinedClaims: Claim[] = [...previous, ...analyses.flatMap(({ claims, intentions = [] }) => [...claims, ...intentions])];
    if ((pending.length || dreaming) && this.deps.gateway?.structured) {
      const classified = await classifyMissingActiveFacts(
        { structured: this.deps.gateway.structured.bind(this.deps.gateway) },
        combinedClaims,
        now.slice(0, 10),
        usage,
        { aliases, telemetry },
      );
      combinedClaims = classified.claims;
    }
    const { claims, current, originalByFact, evidence, required, indexHeader } = compileWiki(draft, space, version, documents,
      combinedClaims, [], now, priorClaims, { aliases, aliasGroups, telemetry });
    const consumedHotIds = new Set<string>();
    let lint;
    if ((!pending.length && activeRetractions) || (!dreaming && job.payload.organize_mode === "skip")) {
      await mark("linting", progress);
      lint = lintDraft(draft, evidence, required, indexHeader);
      if (lint.issues.length) throw new ServiceError(422, "WIKI_LINT_FAILED", JSON.stringify(lint.issues.slice(0, 20)));
    } else {
      const notes = await storage.listStagingNotes(space, job.id);
      let remaining = 4_000;
      const stagingNotes = [];
      for (const { doc_id, markdown } of notes.slice(0, 12)) {
        const summary = markdown.replace(/\s+/g, " ").trim().slice(0, Math.min(400, remaining));
        if (summary) stagingNotes.push({ doc_id, summary });
        remaining -= summary.length;
      }
      const decayCandidates = dreaming ? current.flatMap((fact) => {
        if (fact.pinned) return [];
        const control = factTelemetry(originalByFact.get(fact)!, telemetry);
        const { tier, score, state } = computeFactActivation(fact, control, now.slice(0, 10));
        if (!(tier === "working" && (state === "cold" || score < 0.45) || tier === "durable" && state === "cold")) return [];
        return [{ subject: fact.subject, predicate: fact.predicate, value: fact.value, tier, activation_score: score, doc_date: fact.docDate }];
      }) : [];
      const reader = dreaming ? new SourceReader(repo, storage, space) : undefined;
      lint = await organizer.organize({
        draft, purpose: space.purpose, dreaming, usage, evidence, required, indexHeader, stagingNotes,
        context: {
          space, version, documents, now, claims, aliases, aliasGroups, telemetry, decayCandidates,
          ...(reader ? {
            readSource: reader.lookup.bind(reader), hotMemories: memoryState?.listHotMemories(job.spaceKey, "active") ?? [], consumedHotIds,
          } : {}),
          onRegisterAlias: memoryState && ((kind, canonical, alias) => memoryState.registerAlias(job.spaceKey, kind, canonical, alias)),
        },
        linting: (inProgress) => mark(inProgress ? "linting" : "organizing", progress),
      });
    }
    const pages = [...draft].filter(([path]) => contentPagePathSchema.safeParse(path).success)
      .map(([path, markdown]) => {
        const { frontmatter, body } = readPage(markdown);
        return { path, title: frontmatter!.title, content: body };
      });
    const sessionIds = pending.flatMap((doc) => {
      const match = /^session_(.+)_m\d+\.json$/.exec(accepted.get(doc.docId)!.filename);
      return match ? [match[1]] : [];
    });
    const snapshot: SnapshotRecord = {
      version, job_id: job.id, created_at: now, documents, document_count: documents.length,
      page_count: pages.length, page_titles: Object.fromEntries(pages.map(({ path, title }) => [path, title])), lint,
      ...(consumedHotIds.size ? { processed_hot_ids: [...consumedHotIds] } : {}),
      ...(sessionIds.length ? { digested_session_ids: [...new Set(sessionIds)] } : {}),
    };
    draft.set("_meta.json", JSON.stringify(snapshot, null, 2) + "\n");
    await storage.publishSnapshot(space, job.id, version, draft);
    await repo.publish({ lease, expectedVersion: baseVersion, snapshot, pages, addedDocuments, dreaming });
    await this.finishPublication(job, snapshot, space, pages);
    return snapshot;
  }
}
