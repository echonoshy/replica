import { createHash, randomUUID } from "node:crypto";
import { UPLOAD_BATCH_BYTES, UPLOAD_FILE_BYTES } from "@replica/shared";
import type { AcceptedDocument, JobResult, Space, SpaceRef } from "@replica/shared";
import { spaceKey } from "../db/interfaces.js";
import type { DocumentRecord, Job, JobQueue, MetadataRepository, NormalizedDocument, SpaceConfigProjection, WikiStorage } from "../db/interfaces.js";
import { ServiceError } from "../errors.js";
import { documentType } from "./normalizer.js";
import type { DocumentNormalizer } from "./normalizer.js";
import { syncSpaceConfig } from "./worker.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const newJobId = () => `job_${randomUUID().replaceAll("-", "")}`;

export interface UploadItem {
  filename: string;
  docDate?: string;
  bytes: Uint8Array;
  replacesDocId?: string;
  analyzeFromTurn?: number;
}

export class Ingestion {
  constructor(
    private readonly repo: MetadataRepository, private readonly queue: JobQueue, private readonly storage: WikiStorage,
    private readonly projection: SpaceConfigProjection, private readonly normalizer: DocumentNormalizer,
  ) {}

  async submit(ref: SpaceRef, items: UploadItem[], purpose: string | undefined, key?: string, onEnqueued?: (job: Job) => void): Promise<Job> {
    const totalBytes = items.reduce((size, item) => size + item.bytes.byteLength, 0);
    if (totalBytes > UPLOAD_BATCH_BYTES || items.some((item) => item.bytes.byteLength > UPLOAD_FILE_BYTES)) {
      throw new ServiceError(413, "UPLOAD_TOO_LARGE", "Upload ≤20 MiB per file and ≤48 MiB per request");
    }
    const files = items.map((item) => ({ ...item, ...documentType(item.filename), hash: sha(item.bytes) }));
    const fingerprint = sha(JSON.stringify([purpose ?? null, files.map((file) => [
      file.filename, file.hash, file.docDate ?? null,
      ...(file.replacesDocId || file.analyzeFromTurn ? [file.replacesDocId ?? null, file.analyzeFromTurn ?? null] : []),
    ])]));
    const id = spaceKey(ref);
    if (key) {
      const existing = await this.repo.findIdempotentJob(id, key);
      if (existing) {
        if (existing.type !== "ingest" || existing.payload.fingerprint !== fingerprint) {
          throw new ServiceError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different request");
        }
        return existing;
      }
    }

    let space = await this.repo.findSpace(ref);
    if (!space && !purpose) throw new ServiceError(400, "PURPOSE_REQUIRED", "Provide a purpose when creating a memory space");
    // Preflight text-layer warnings before acknowledging or writing a batch.
    const pdfs = new Map<string, NormalizedDocument>();
    for (const file of files) {
      if (file.extension === "pdf" && !pdfs.has(file.hash) && !await this.repo.findDocumentByHash(id, file.hash)) {
        pdfs.set(file.hash, await this.normalizer.normalize(file.bytes, "pdf"));
      }
    }
    if (!space) {
      space = await this.repo.ensureSpace(ref, purpose!);
      await syncSpaceConfig(this.repo, this.projection, ref);
    }
    const accepted: AcceptedDocument[] = [];
    for (const file of files) {
      const metadata = {
        filename: file.filename,
        ...(file.replacesDocId ? { replaces_doc_id: file.replacesDocId } : {}),
        ...(file.analyzeFromTurn ? { analyze_from_turn: file.analyzeFromTurn } : {}),
      };
      const same = await this.repo.findDocumentByHash(id, file.hash);
      if (same) {
        accepted.push({ ...metadata, doc_id: same.docId, dedup_status: "duplicate", warnings: same.warnings });
        continue;
      }
      const normalized = file.extension === "pdf" ? pdfs.get(file.hash) : undefined;
      const now = new Date().toISOString();
      const doc: DocumentRecord = {
        docId: `doc_${sha(`${id}:${file.hash}:${file.extension}`).slice(0, 32)}`, spaceKey: id,
        filename: file.filename, docDate: file.docDate ?? now.slice(0, 10), charCount: normalized?.charCount ?? 0,
        warnings: normalized?.warnings ?? [], sha256: file.hash, extension: file.extension,
        mimeType: file.mimeType, firstPublishedVersion: null, createdAt: now,
      };
      await this.storage.writeRaw(ref, doc, { bytes: file.bytes, normalized: normalized?.markdown });
      const saved = await this.repo.registerDocument(doc);
      accepted.push({
        ...metadata, doc_id: saved.doc.docId, dedup_status: saved.inserted ? "new" : "duplicate", warnings: saved.doc.warnings,
      });
    }

    const latest = await this.repo.findSpace(ref);
    return this.queue.enqueue({
      id: newJobId(), type: "ingest", spaceKey: id, idempotencyKey: key ?? null,
      payload: { docs: accepted, baseVersion: latest?.current_version ?? space.current_version, fingerprint },
    }, onEnqueued);
  }
}

export function enqueueRetraction(
  queue: Pick<JobQueue, "enqueue">, space: Space, docIds: string[], key?: string, onEnqueued?: (job: Job) => void,
) {
  const retract_doc_ids = [...new Set(docIds)].sort();
  return queue.enqueue({
    id: newJobId(), type: "ingest", spaceKey: spaceKey(space), idempotencyKey: key ?? null,
    payload: {
      docs: [], baseVersion: space.current_version, retract_doc_ids,
      fingerprint: sha(JSON.stringify(["forget", retract_doc_ids])),
    },
  }, onEnqueued);
}

export async function waitForCompile(repo: Pick<MetadataRepository, "getJob">, job: Job, timeout: number) {
  const deadline = Date.now() + timeout;
  while (job.status !== "published" && job.status !== "failed" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    job = await repo.getJob(job.id) ?? job;
  }
  return job;
}

export async function jobResponse(repo: MetadataRepository, job: Job): Promise<JobResult> {
  const [namespace, space_id] = job.spaceKey.split(":");
  const docs = await Promise.all(job.payload.docs.map(async (item) => ({
    ...item,
    warnings: (await repo.findDocument(job.spaceKey, item.doc_id))?.warnings ?? item.warnings,
  })));
  return {
    job_id: job.id, namespace, space_id, status: job.status, accepted_docs: docs,
    base_snapshot_version: job.payload.baseVersion, target_version: job.targetVersion,
    job_type: job.type, progress: job.progress, usage: job.usage, error_message: job.errorMessage,
    created_at: job.createdAt, updated_at: job.updatedAt,
  };
}
