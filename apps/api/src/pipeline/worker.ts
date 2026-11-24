import { randomUUID } from "node:crypto";
import { contentPagePathSchema } from "@replica/shared";
import type { JobProgress, JobStatus, Space, SpaceRef } from "@replica/shared";
import { zeroUsage } from "../db/interfaces.js";
import type {
  ClaimedJob, DocumentRecord, JobQueue, MetadataRepository, NormalizedDocument, SnapshotRecord, SpaceConfigProjection, WikiStorage,
} from "../db/interfaces.js";
import { errorMessage, ServiceError } from "../errors.js";
import { anchorKey, claimAnchors, isFact } from "./analyzer.js";
import type { ClaimAnchor } from "./analyzer.js";
import type { Analyzer, Analysis, Claim } from "./analyzer.js";
import { lintDraft } from "./linter.js";
import { anchoredSections } from "./normalizer.js";
import type { DocumentNormalizer } from "./normalizer.js";
import type { Organizer } from "./organizer.js";
import { compileWiki, vocabularyOf } from "./wiki-compiler.js";
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
  onSnapshotChanged?: (ref: SpaceRef, version: number) => Promise<void>;
  repo: MetadataRepository; queue: JobQueue; storage: WikiStorage; projection: SpaceConfigProjection;
  normalizer: DocumentNormalizer; analyzer: Analyzer; organizer: Organizer; concurrency: number;
};

const turnNumber = (locator: string) => locator.startsWith("t") ? Number(locator.slice(1)) : 0;
type Replacement = { docId: string; retainedLocators: Set<string> };

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
  for (const claim of claims) {
    const primary = retain(claim);
    if (!isFact(claim) || !claim.extra_sources?.length) {
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
          .map(({ locator, text }) => `<!-- loc:${locator} -->\n\n${text}`).join("\n\n");
        text = { ...fullText, markdown };
      }
      normalized.push({ doc, text });
      await mark("normalizing", { completed: normalized.length, total: pending.length });
    }
    const previous = await retainClaims(priorClaims, retractIds, replacedBy,
      async (docId) => (await repo.findDocument(job.spaceKey, docId))?.docDate);

    const progress = { completed: 0, total: normalized.length };
    const analyses: Analysis[] = [];
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
          analyses[index] = await analyzer.analyze(space, space.purpose, job.id, doc, text, vocabularyOf(previous, text.markdown), usage);
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
    const { claims, evidence, required, indexHeader } = compileWiki(draft, space, version, documents, previous,
      analyses.flatMap((analysis) => analysis.claims), now, priorClaims);
    let lint;
    if (!pending.length && activeRetractions) {
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
      lint = await organizer.organize({
        draft, purpose: space.purpose, dreaming, usage, evidence, required, indexHeader, stagingNotes,
        context: { space, version, documents, now, claims },
        linting: (inProgress) => mark(inProgress ? "linting" : "organizing", progress),
      });
    }
    const pages = [...draft].filter(([path]) => contentPagePathSchema.safeParse(path).success)
      .map(([path, markdown]) => {
        const { frontmatter, body } = readPage(markdown);
        return { path, title: frontmatter!.title, content: body };
      });
    const snapshot: SnapshotRecord = {
      version, job_id: job.id, created_at: now, documents, document_count: documents.length,
      page_count: pages.length, page_titles: Object.fromEntries(pages.map(({ path, title }) => [path, title])), lint,
    };
    draft.set("_meta.json", JSON.stringify(snapshot, null, 2) + "\n");
    await storage.publishSnapshot(space, job.id, version, draft);
    await repo.publish({ lease, expectedVersion: baseVersion, snapshot, pages, addedDocuments, dreaming });
    return snapshot;
  }
}
