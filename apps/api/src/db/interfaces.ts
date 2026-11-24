import type {
  AcceptedDocument, DocumentExtension, JobProgress, JobStatus, JobUsage,
  Snapshot, Space, SpaceRef, Warning,
} from "@replica/shared";

export const spaceKey = (ref: SpaceRef) => `${ref.namespace}:${ref.space_id}`;

export interface DocumentRecord {
  docId: string;
  spaceKey: string;
  filename: string;
  sha256: string;
  extension: DocumentExtension;
  mimeType: string;
  docDate: string;
  charCount: number;
  warnings: Warning[];
  firstPublishedVersion: number | null;
  createdAt: string;
}

export interface NormalizedDocument {
  markdown: string;
  charCount: number;
  warnings: Warning[];
}

export interface JobPayload {
  docs: AcceptedDocument[];
  baseVersion: number;
  fingerprint?: string;
  retract_doc_ids?: string[];
}

export interface Job {
  id: string;
  spaceKey: string;
  type: "ingest" | "dream";
  status: JobStatus;
  idempotencyKey: string | null;
  payload: JobPayload;
  progress: JobProgress;
  usage: JobUsage;
  targetVersion: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewJob = Pick<Job, "id" | "type" | "spaceKey" | "idempotencyKey" | "payload">;
export const zeroUsage = (): JobUsage => ({
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, llm_calls: 0, latency_ms: 0,
});

export interface SpaceLease {
  spaceKey: string;
  token: string;
  release(): Promise<void>;
}

export interface ClaimedJob {
  job: Job;
  lease: SpaceLease;
}

export interface IndexedPage {
  path: string;
  title: string;
  content: string;
}

export interface SnapshotRecord extends Snapshot {
  documents: string[];
  page_titles?: Record<string, string>;
}

export interface MetadataRepository {
  findSpace(ref: SpaceRef): Promise<Space | undefined>;
  findSpaceByKey(key: string): Promise<Space | undefined>;
  listSpaces(): Promise<Space[]>;
  ensureSpace(ref: SpaceRef, purpose: string): Promise<Space>;
  updatePurpose(ref: SpaceRef, purpose: string): Promise<Space>;
  findDocument(key: string, docId: string): Promise<DocumentRecord | undefined>;
  findDocumentByHash(key: string, sha256: string): Promise<DocumentRecord | undefined>;
  listDocuments(key: string): Promise<DocumentRecord[]>;
  registerDocument(doc: DocumentRecord): Promise<{ doc: DocumentRecord; inserted: boolean }>;
  recordNormalization(docId: string, result: NormalizedDocument): Promise<void>;
  getJob(id: string): Promise<Job | undefined>;
  listJobs(key: string, limit?: number): Promise<Job[]>;
  findIdempotentJob(key: string, idempotencyKey: string): Promise<Job | undefined>;
  getSnapshot(key: string, version: number): Promise<SnapshotRecord | undefined>;
  listSnapshots(key: string): Promise<SnapshotRecord[]>;
  findPublication(jobId: string): Promise<SnapshotRecord | undefined>;
  reserveVersion(lease: SpaceLease): Promise<number>;
  publish(input: {
    lease: SpaceLease;
    expectedVersion: number;
    snapshot: SnapshotRecord;
    pages: IndexedPage[];
    addedDocuments: string[];
    dreaming: boolean;
  }): Promise<void>;
  rollback(lease: SpaceLease, version: number): Promise<Space>;
}

export interface LexicalSearchProvider {
  search(key: string, version: number, query: string, limit: number, includeAudit: boolean): Promise<string[]>;
}

export interface JobQueue {
  // Newly queued jobs and their synchronous metadata changes commit together.
  enqueue(job: NewJob, onEnqueued?: (job: Job) => void): Promise<Job>;
  claimNext(workerId: string): Promise<ClaimedJob | undefined>;
  acquireSpaceLock(key: string): Promise<SpaceLease | undefined>;
  heartbeat(lease: SpaceLease, update?: {
    id: string; status: JobStatus; progress: JobProgress; usage: JobUsage;
  }): Promise<void>;
  complete(claim: ClaimedJob, version: number, usage: JobUsage): Promise<void>;
  fail(claim: ClaimedJob, message: string, usage: JobUsage): Promise<void>;
}

export type WikiDraft = Map<string, string>;
export interface WikiStorage {
  writeRaw(ref: SpaceRef, doc: DocumentRecord, data: { bytes: Uint8Array; normalized?: string }): Promise<void>;
  readNormalized(
    ref: SpaceRef, doc: DocumentRecord, normalize?: (bytes: Uint8Array) => Promise<NormalizedDocument>,
  ): Promise<NormalizedDocument | null>;
  writeStagingNote(ref: SpaceRef, jobId: string, docId: string, markdown: string): Promise<void>;
  listStagingNotes(ref: SpaceRef, jobId: string): Promise<Array<{ doc_id: string; markdown: string }>>;
  cloneSnapshotToStaging(ref: SpaceRef, jobId: string, baseVersion: number): Promise<WikiDraft>;
  publishSnapshot(ref: SpaceRef, jobId: string, version: number, draft: WikiDraft): Promise<void>;
  readSnapshotFile(ref: SpaceRef, version: number, path: string): Promise<string>;
  listSnapshotFiles(ref: SpaceRef, version: number): Promise<string[]>;
}

export interface SpaceConfigProjection {
  write(space: Space): Promise<void>;
}
