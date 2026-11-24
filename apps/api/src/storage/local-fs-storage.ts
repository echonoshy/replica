import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { identifierSchema, jobIdSchema, docIdSchema, wikiPagePathSchema } from "@replica/shared";
import type { Space, SpaceRef } from "@replica/shared";
import type { DocumentRecord, NormalizedDocument, WikiDraft, WikiStorage, SpaceConfigProjection } from "../db/interfaces.js";

const internalFiles = new Set(["_meta.json", "_claims.json"]);
const filePath = (path: string) => internalFiles.has(path) ? path : wikiPagePathSchema.parse(path);
const isError = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;

async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } catch (error) {
    if (!isError(error, "EINVAL")) throw error;
  } finally {
    await directory.close();
  }
}

async function writeAtomic(path: string, value: string | Uint8Array, immutable = false) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.tmp-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    if (immutable) {
      try {
        await link(temporary, path);
      } catch (error) {
        if (!isError(error, "EEXIST")) throw error;
      }
    } else {
      await rename(temporary, path);
    }
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class LocalFsStorage implements WikiStorage, SpaceConfigProjection {
  constructor(private readonly dataDir: string) {}

  private space(ref: SpaceRef) {
    return join(this.dataDir, "spaces", identifierSchema.parse(ref.namespace), identifierSchema.parse(ref.space_id));
  }

  private staging(ref: SpaceRef, jobId: string) {
    return join(this.space(ref), "staging", jobIdSchema.parse(jobId));
  }

  private snapshot(ref: SpaceRef, version: number) {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid snapshot version");
    return join(this.space(ref), "snapshots", `v${version}`);
  }

  private blob(ref: SpaceRef, doc: DocumentRecord) {
    return join(this.space(ref), "raw", "blobs", `${docIdSchema.parse(doc.docId)}.${doc.extension}`);
  }

  private normalized(ref: SpaceRef, doc: DocumentRecord) {
    return join(this.space(ref), "raw", "normalized", `${docIdSchema.parse(doc.docId)}.md`);
  }

  async writeRaw(ref: SpaceRef, doc: DocumentRecord, { bytes, normalized }: Parameters<WikiStorage["writeRaw"]>[2]) {
    await writeAtomic(this.blob(ref, doc), bytes, true);
    if (normalized !== undefined) await writeAtomic(this.normalized(ref, doc), normalized, true);
  }

  async readNormalized(
    ref: SpaceRef, doc: DocumentRecord, normalize?: (bytes: Uint8Array) => Promise<NormalizedDocument>,
  ) {
    const path = this.normalized(ref, doc);
    const saved = await readFile(path, "utf8").catch((error) => {
      if (isError(error, "ENOENT")) return null;
      throw error;
    });
    if (saved !== null) {
      const visible = saved.replace(/^<!-- loc:[pst][1-9][0-9]* -->$/gm, "").trim();
      return {
        markdown: saved,
        charCount: doc.charCount || [...visible].length,
        warnings: doc.warnings.length ? doc.warnings : visible ? [] : ["NO_EXTRACTABLE_TEXT" as const],
      };
    }
    if (!normalize) return null;
    const result = await normalize(await readFile(this.blob(ref, doc)));
    await writeAtomic(path, result.markdown, true);
    return result;
  }

  async writeStagingNote(ref: SpaceRef, jobId: string, docId: string, markdown: string) {
    await writeAtomic(join(this.staging(ref, jobId), "notes", `${docIdSchema.parse(docId)}.md`), markdown);
  }

  async listStagingNotes(ref: SpaceRef, jobId: string) {
    const dir = join(this.staging(ref, jobId), "notes");
    const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
      if (isError(error, "ENOENT")) return [];
      throw error;
    });
    const notes: Array<{ doc_id: string; markdown: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const docId = entry.name.slice(0, -3);
      if (!docIdSchema.safeParse(docId).success) continue;
      const markdown = await readFile(join(dir, entry.name), "utf8");
      notes.push({ doc_id: docId, markdown });
    }
    return notes.sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  }

  async cloneSnapshotToStaging(ref: SpaceRef, jobId: string, baseVersion: number): Promise<WikiDraft> {
    await mkdir(join(this.staging(ref, jobId), "candidate_snap"), { recursive: true });
    if (!baseVersion) return new Map();
    const paths = [...await this.listSnapshotFiles(ref, baseVersion), ...internalFiles];
    return new Map(await Promise.all(paths.map(async (path) => [
      path, await this.readSnapshotFile(ref, baseVersion, path),
    ] as const)));
  }

  async publishSnapshot(ref: SpaceRef, jobId: string, version: number, draft: WikiDraft) {
    const target = this.snapshot(ref, version);
    const candidate = join(this.staging(ref, jobId), "candidate_snap", `v${version}`);
    await mkdir(candidate, { recursive: true });
    await mkdir(dirname(target), { recursive: true });
    for (const [path, value] of draft) await writeAtomic(join(candidate, filePath(path)), value);
    await syncDirectory(candidate);
    await rename(candidate, target);
    await syncDirectory(dirname(candidate));
    await syncDirectory(dirname(target));
    await syncDirectory(this.space(ref));
  }

  async readSnapshotFile(ref: SpaceRef, version: number, path: string) {
    return readFile(join(this.snapshot(ref, version), filePath(path)), "utf8");
  }

  async listSnapshotFiles(ref: SpaceRef, version: number) {
    if (!version) return [];
    const root = this.snapshot(ref, version);
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => {
      const directory = entry.parentPath.slice(root.length + 1);
      return directory ? `${directory}/${entry.name}` : entry.name;
    }).filter((path) => wikiPagePathSchema.safeParse(path).success).sort();
  }

  async write(space: Space) {
    await writeAtomic(join(this.space(space), "space.json"), JSON.stringify(space, null, 2) + "\n");
  }
}
