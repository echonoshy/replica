import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ServiceError } from "../../errors.js";
import { hash } from "./planner.js";

const createEmpty = (path: string) => closeSync(openSync(path, "a", 0o600));

// A preview cannot insert even a temporary lease in the application database.
// SQLite's OS-level RESERVED lock works on an empty file without writing a page
// or journal. Process death releases it. The compiler never opens these files.
function reserve(path: string) {
  const db = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    db.exec("BEGIN IMMEDIATE");
    return () => db.close();
  } catch (error) {
    db.close();
    if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")
      throw new ServiceError(409, "PROACTIVE_BUSY", "Evaluation in progress");
    throw error;
  }
}

export class EvaluationGate {
  private readonly bootstrap: string;
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.bootstrap = join(directory, "bootstrap");
    createEmpty(this.bootstrap);
  }
  private path(key: string) { return join(this.directory, hash(key)); }

  prepare(key: string) {
    if (existsSync(this.path(key))) return;
    // A read-only preview of an unprovisioned space may own the bootstrap
    // lock. Publication can proceed; the next real evaluation provisions it.
    try { this.acquire(key, false)(); }
    catch (error) { if (!(error instanceof ServiceError && error.code === "PROACTIVE_BUSY")) throw error; }
  }

  acquire(key: string, preview: boolean): () => void {
    const path = this.path(key);
    if (existsSync(path)) return reserve(path);
    const releaseBootstrap = reserve(this.bootstrap);
    if (preview && !existsSync(path)) return releaseBootstrap;
    try {
      if (!existsSync(path)) createEmpty(path);
      return reserve(path);
    } finally { releaseBootstrap(); }
  }
}
