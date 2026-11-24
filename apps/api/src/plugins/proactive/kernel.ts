import type { SpaceRef } from "@replica/shared";
import type { MetadataRepository, SnapshotRecord, WikiStorage } from "../../db/interfaces.js";
import { spaceKey } from "../../db/interfaces.js";
import type { SQLiteConnection } from "../../db/sqlite-repo.js";
import { SourceReader } from "../../retrieval/synthesizer.js";
import { ServiceError } from "../../errors.js";

export type SnapshotListener = (ref: SpaceRef, version: number) => Promise<void>;
export interface MemoryKernelPort {
  version(ref: SpaceRef): number;
  spaces(): SpaceRef[];
  snapshot(ref: SpaceRef, version: number): Promise<SnapshotRecord | undefined>;
  file(ref: SpaceRef, version: number, path: string): Promise<string>;
  sources(ref: SpaceRef): Pick<SourceReader, "lookup">;
  subscribe(listener: SnapshotListener): () => void;
}

export function memoryKernelPort(connection: SQLiteConnection, repo: MetadataRepository, storage: WikiStorage) {
  let listener: SnapshotListener | undefined;
  // A synchronous version read also fences Outbox commits inside BEGIN IMMEDIATE.
  const current = connection.client.prepare<[string], { current_version: number }>(
    "SELECT current_version FROM spaces WHERE id = ?",
  );
  const port: MemoryKernelPort = {
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
