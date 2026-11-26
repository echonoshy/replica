import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  createSpaceSchema, dreamRequestSchema, fileResultSchema, forgetSchema, identifierSchema, jobResultSchema, purposeSchema, sourceQuerySchema,
  sourceResultSchema, spaceResultSchema, spacesResultSchema, treeResultSchema, versionSchema, wikiPagePathSchema,
} from "@wiki-memory/shared";
import type { SpaceRef } from "@wiki-memory/shared";
import { spaceKey } from "../db/interfaces.js";
import type { JobQueue, MetadataRepository, SpaceConfigProjection, WikiStorage } from "../db/interfaces.js";
import { ServiceError } from "../errors.js";
import { digestPendingChatSessions, type ChatDreamDependencies } from "../chat/dream-chats.js";
import { enqueueDream } from "../pipeline/dreaming.js";
import { enqueueRetraction, jobResponse, waitForCompile } from "../pipeline/ingestion.js";
import { readPage } from "../pipeline/wiki-markdown.js";
import { syncSpaceConfig } from "../pipeline/worker.js";
import { requireSpace, snapshotFor, SourceReader } from "../retrieval/synthesizer.js";
import { json, requestErrors } from "./responses.js";

const params = z.object({ ns: identifierSchema, id: identifierSchema });
const queryVersion = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional();
const versionQuery = z.object({ version: queryVersion });
const fromParams = ({ ns, id }: z.infer<typeof params>): SpaceRef => ({ namespace: ns, space_id: id });
const tags = ["Admin"];
const url = "/v1/admin/spaces" as const;
const one = "/v1/admin/spaces/{ns}/{id}" as const;
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

const spacesRoute = createRoute({
  method: "get", path: url, tags, summary: "List memory spaces and current snapshot statistics",
  responses: { 200: json(spacesResultSchema, "Spaces grouped by namespace"), ...requestErrors },
});
const createSpaceRoute = createRoute({
  method: "post", path: url, tags, summary: "Create or open a memory space",
  request: { body: jsonBody(createSpaceSchema) },
  responses: { 200: json(spaceResultSchema, "Created or existing space"), ...requestErrors },
});
const updateSpaceRoute = createRoute({
  method: "patch", path: one, tags, summary: "Update space purpose",
  request: { params, body: jsonBody(z.object({ purpose: purposeSchema })) },
  responses: { 200: json(spaceResultSchema, "Updated space"), ...requestErrors },
});
const treeRoute = createRoute({
  method: "get", path: `${one}/tree`, tags, summary: "List a Wiki snapshot and available versions",
  request: { params, query: versionQuery },
  responses: { 200: json(treeResultSchema, "Wiki file tree and version metadata"), ...requestErrors },
});
const fileRoute = createRoute({
  method: "get", path: `${one}/file`, tags, summary: "Read a Wiki page from a snapshot",
  request: { params, query: versionQuery.extend({ path: wikiPagePathSchema }) },
  responses: { 200: json(fileResultSchema, "Wiki Markdown and parsed frontmatter"), ...requestErrors },
});
const sourceRoute = createRoute({
  method: "get", path: `${one}/source`, tags, summary: "Resolve a Wiki citation to its normalized original passage",
  request: { params, query: sourceQuerySchema.extend({ version: queryVersion }) },
  responses: { 200: json(sourceResultSchema, "Anchored original and surrounding excerpts"), ...requestErrors },
});
const rollbackRoute = createRoute({
  method: "post", path: `${one}/rollback`, tags, summary: "Point the space at an already published version",
  request: { params, body: jsonBody(z.object({ version: versionSchema })) },
  responses: { 200: json(spaceResultSchema, "Space with updated current version"), ...requestErrors },
});
const dreamRoute = createRoute({
  method: "post", path: "/v1/memories/dream", tags: ["Memory"], summary: "Enqueue offline Dreaming for a space",
  request: { body: jsonBody(dreamRequestSchema) },
  responses: { 202: json(jobResultSchema, "Dreaming job accepted"), ...requestErrors },
});
const forgetRoute = createRoute({
  method: "post", path: "/v1/memories/forget", tags: ["Memory"], summary: "Retract documents from the current Wiki snapshot",
  request: { body: jsonBody(forgetSchema) },
  responses: {
    200: json(jobResultSchema, "Synchronous retraction has settled"),
    202: json(jobResultSchema, "Retraction job accepted"),
    ...requestErrors,
  },
});

export function adminRoutes(
  app: OpenAPIHono, repo: MetadataRepository, queue: JobQueue, storage: WikiStorage,
  projection: SpaceConfigProjection, wake: () => void, onSnapshotChanged?: (ref: SpaceRef, version: number) => Promise<void>,
  syncWait = 120_000, onRollback?: (ref: SpaceRef, version: number, documents: string[]) => Promise<void> | void,
  chatDeps?: Pick<ChatDreamDependencies, "chatStore" | "ingestion">,
) {
  app.openapi(spacesRoute, async (c) => c.json({ spaces: await repo.listSpaces() }, 200));
  app.openapi(createSpaceRoute, async (c) => {
    const input = c.req.valid("json");
    const space = await repo.ensureSpace(input, input.purpose);
    if (space.purpose !== input.purpose) throw new ServiceError(409, "SPACE_EXISTS", "This space already exists. Edit its purpose from the space list");
    await syncSpaceConfig(repo, projection, input);
    return c.json(space, 200);
  });
  app.openapi(updateSpaceRoute, async (c) => {
    const ref = fromParams(c.req.valid("param"));
    const space = await repo.updatePurpose(ref, c.req.valid("json").purpose);
    await syncSpaceConfig(repo, projection, ref);
    return c.json(space, 200);
  });
  app.openapi(treeRoute, async (c) => {
    const ref = fromParams(c.req.valid("param"));
    const { space, snapshot } = await snapshotFor(repo, ref, c.req.valid("query").version);
    const [versions, files] = await Promise.all([
      repo.listSnapshots(spaceKey(ref)), storage.listSnapshotFiles(ref, snapshot?.version ?? 0),
    ]);
    return c.json({ space, snapshot: snapshot ?? null, versions, files, titles: snapshot?.page_titles ?? {} }, 200);
  });
  app.openapi(fileRoute, async (c) => {
    const ref = fromParams(c.req.valid("param"));
    const { version, path } = c.req.valid("query");
    const { snapshot } = await snapshotFor(repo, ref, version);
    if (!snapshot || !(await storage.listSnapshotFiles(ref, snapshot.version)).includes(path)) {
      throw new ServiceError(404, "WIKI_PAGE_NOT_FOUND", "Wiki page not found in this version");
    }
    const { frontmatter, body } = readPage(await storage.readSnapshotFile(ref, snapshot.version, path));
    return c.json({ path, version: snapshot.version, frontmatter, markdown: body }, 200);
  });
  app.openapi(sourceRoute, async (c) => {
    const ref = fromParams(c.req.valid("param"));
    const { version, doc_id, locator } = c.req.valid("query");
    const { snapshot } = await snapshotFor(repo, ref, version);
    if (!snapshot?.documents.includes(doc_id)) {
      throw new ServiceError(404, "SOURCE_NOT_FOUND", "Source is not part of this published snapshot");
    }
    return c.json(await new SourceReader(repo, storage, ref).lookup(doc_id, locator), 200);
  });
  app.openapi(rollbackRoute, async (c) => {
    const ref = fromParams(c.req.valid("param"));
    await requireSpace(repo, ref);
    const lease = await queue.acquireSpaceLock(spaceKey(ref));
    if (!lease) throw new ServiceError(409, "SPACE_BUSY", "Wait for the current compile job to finish before rolling back");
    let space;
    try {
      space = await repo.rollback(lease, c.req.valid("json").version);
      const targetSnapshot = await repo.getSnapshot(spaceKey(ref), space.current_version);
      await onRollback?.(ref, space.current_version, targetSnapshot?.documents ?? []);
      await onSnapshotChanged?.(ref, space.current_version);
      await syncSpaceConfig(repo, projection, ref);
    } finally {
      await lease.release();
      wake();
    }
    return c.json(space, 200);
  });
  app.openapi(dreamRoute, async (c) => {
    const input = c.req.valid("json");
    const space = await requireSpace(repo, input);
    const digestion = input.mode !== "consolidate" && chatDeps
      ? await digestPendingChatSessions(space, { ...chatDeps, getJob: (id) => repo.getJob(id), wake }) : undefined;
    if (input.mode === "digest") {
      if (!digestion) throw new ServiceError(409, "NO_PENDING_CHATS", "No pending chat sessions to digest");
      return c.json(await jobResponse(repo, digestion.job), 202);
    }
    if (!space.current_version && !digestion) throw new ServiceError(409, "NO_PUBLISHED_SNAPSHOT", "Publish a snapshot before Dreaming");
    // Space jobs execute in FIFO order, including the digest of a space's first session.
    const job = await enqueueDream(queue, space, input.mode);
    wake();
    return c.json(await jobResponse(repo, job), 202);
  });
  app.openapi(forgetRoute, async (c) => {
    const input = c.req.valid("json");
    const space = await requireSpace(repo, input);
    if (!space.current_version) throw new ServiceError(409, "NO_PUBLISHED_SNAPSHOT", "Publish a snapshot before retracting documents");
    const job = await enqueueRetraction(queue, space, input.doc_ids, input.idempotency_key);
    wake();
    if (input.mode === "async") return c.json(await jobResponse(repo, job), 202);
    const current = await waitForCompile(repo, job, syncWait);
    return c.json(await jobResponse(repo, current), current.status === "published" || current.status === "failed" ? 200 : 202);
  });
}
