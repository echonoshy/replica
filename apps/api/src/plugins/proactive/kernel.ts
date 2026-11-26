import { AsyncLocalStorage } from "node:async_hooks";
import type { RetrieveResult, SpaceRef } from "@wiki-memory/shared";
import type { MetadataRepository, SnapshotRecord, WikiStorage } from "../../db/interfaces.js";
import { spaceKey } from "../../db/interfaces.js";
import type { SQLiteConnection } from "../../db/sqlite-repo.js";
import { SQLiteMemoryStateStore } from "../../memory/memory-state.js";
import type { FactTelemetryRecord } from "../../memory/memory-state.js";
import type { Synthesizer } from "../../retrieval/synthesizer.js";
import { SourceReader } from "../../retrieval/synthesizer.js";
import { ServiceError } from "../../errors.js";

// Background retrieval must not count as a user's recall. Scope this to the async
// retrieval call so concurrent interactive searches still record their own telemetry.
export class ServiceMemoryState extends SQLiteMemoryStateStore {
  private readonly backgroundRecall = new AsyncLocalStorage<boolean>();
  withoutRecall<T>(operation: () => T): T { return this.backgroundRecall.run(true, operation); }

  override recordRecallByFacts(...args: Parameters<SQLiteMemoryStateStore["recordRecallByFacts"]>) {
    if (!this.backgroundRecall.getStore()) super.recordRecallByFacts(...args);
  }
}

export type SnapshotListener = (ref: SpaceRef, version: number) => Promise<void>;
export interface MemoryKernelPort {
  retrieveContext?(ref: SpaceRef, query: string, opts: { version: number }): Promise<RetrieveResult>;
  aliases?(ref: SpaceRef): Map<string, string>;
  expandAliases?(ref: SpaceRef, query: string): string;
  telemetry?(ref: SpaceRef): Map<string, FactTelemetryRecord>;
  memoryState?: SQLiteMemoryStateStore;
  version(ref: SpaceRef): number;
  spaces(): SpaceRef[];
  snapshot(ref: SpaceRef, version: number): Promise<SnapshotRecord | undefined>;
  file(ref: SpaceRef, version: number, path: string): Promise<string>;
  sources(ref: SpaceRef): Pick<SourceReader, "lookup">;
  subscribe(listener: SnapshotListener): () => void;
}

export function memoryKernelPort(connection: SQLiteConnection, repo: MetadataRepository, storage: WikiStorage,
  synthesizer?: Synthesizer, memoryState?: ServiceMemoryState) {
  let listener: SnapshotListener | undefined;
  // A synchronous version read also fences Outbox commits inside BEGIN IMMEDIATE.
  const current = connection.client.prepare<[string], { current_version: number }>(
    "SELECT current_version FROM spaces WHERE id = ?",
  );
  const port: MemoryKernelPort = {
    memoryState,
    ...(memoryState && {
      aliases: (ref: SpaceRef) => memoryState.aliasLookupMap(spaceKey(ref)),
      telemetry: (ref: SpaceRef) => memoryState.listTelemetry(spaceKey(ref)),
      expandAliases: (ref: SpaceRef, query: string) => memoryState.expandQueryWithAliases(spaceKey(ref), query),
    }),
    ...(synthesizer && memoryState && { retrieveContext: (ref: SpaceRef, query: string, opts: { version: number }) =>
      memoryState.withoutRecall(() => synthesizer.retrieve({
        namespace: ref.namespace, space_id: ref.space_id, query, snapshot_version: opts.version,
        return_mode: "context", retrieval_strategy: "multi_hop", include_index: false, verify_raw_sources: false,
        include_core_card: true, include_rules: true, include_hot_memories: true, include_pending_chats: true,
        boost_safety: true, max_tokens: 1800,
      })) }),
    version(ref) {
      const row = current.get(spaceKey(ref));
      if (!row) throw new ServiceError(404, "SPACE_NOT_FOUND", "Memory space not found");
      return row.current_version;
    },
    spaces: () => connection.client.prepare<[], SpaceRef>(
      "SELECT namespace, space_id FROM spaces WHERE current_version > 0",
    ).all(),
    snapshot: (ref, version) => repo.getSnapshot(spaceKey(ref), version),
    file: (ref, version, path) => storage.readSnapshotFile(ref, version, path),
    sources: (ref) => new SourceReader(repo, storage, ref),
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
  };
  return { port, onSnapshotChanged: async (ref: SpaceRef, version: number) => { await listener?.(ref, version); } };
}
