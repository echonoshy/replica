import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import {
  compactRequestSchema, compactResultSchema, errorSchema, hotMemorySummarySchema, sourceResultSchema,
  toolHotMemorySchema, toolIndexQuerySchema, toolIndexResultSchema, toolPageQuerySchema, toolPageResultSchema,
  toolSearchSchema, toolSearchResultSchema, toolSourceQuerySchema, versionSchema,
} from "@wiki-memory/shared";
import type { SQLiteChatStore } from "../chat/chat-store.js";
import { spaceKey, type LexicalSearchProvider, type MetadataRepository, type WikiStorage } from "../db/interfaces.js";
import { ServiceError } from "../errors.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { inferFactScope, type SQLiteMemoryStateStore } from "../memory/memory-state.js";
import { anchorKey, claimAnchors, isFact, type Fact } from "../pipeline/analyzer.js";
import { factTelemetry } from "../pipeline/wiki-compiler.js";
import type { SessionCompactor } from "../retrieval/compactor.js";
import { extractWikiLinks, rankWikiHits, vectorPages } from "../retrieval/navigator.js";
import { externalScopes, readSnapshotClaims, requireSpace, searchChatTurns, snapshotFor, SourceReader, wikiView } from "../retrieval/synthesizer.js";
import { relevantMarkdown, truncateTokens } from "../retrieval/token-budget.js";
import { json, requestErrors } from "./responses.js";

const tags = ["Memory Tools"];
const base = "/v1/memories/tools";
const version = z.coerce.number().pipe(versionSchema).optional();
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });

export function memoryToolRoutes(app: OpenAPIHono, repo: MetadataRepository, storage: WikiStorage,
  gateway: OpenAiGateway, state: SQLiteMemoryStateStore, chats: SQLiteChatStore,
  compactor: SessionCompactor, lexical: LexicalSearchProvider) {
  const viewFor = (input: z.infer<typeof toolIndexQuerySchema>) => wikiView(repo, storage, state, input,
    input.version, input.privacy_mode === "external_safe" ? externalScopes : []);

  app.openapi(createRoute({
    method: "get", path: base + "/index", tags, summary: "Read the memory index and active instructions",
    request: { query: toolIndexQuerySchema.extend({ version }) },
    responses: { 200: json(toolIndexResultSchema, "Snapshot index"), ...requestErrors },
  }), async (c) => {
    const view = await viewFor(c.req.valid("query"));
    return c.json({ snapshot_version: view.version, index_markdown: view.index, core_card: view.coreCard(),
      rules: view.rules, hot_memories: view.hotMemories(), page_count: view.paths.length }, 200);
  });

  app.openapi(createRoute({
    method: "post", path: base + "/search", tags, summary: "Search Wiki evidence and pending conversation turns",
    request: { body: body(toolSearchSchema) },
    responses: { 200: json(toolSearchResultSchema, "Ranked search hits"), ...requestErrors },
  }), async (c) => {
    const input = c.req.valid("json");
    const view = await viewFor({ ...input, version: input.snapshot_version });
    const key = spaceKey(input);
    const query = state.expandQueryWithAliases(key, input.query);
    const [terms, vectors] = view.version ? await Promise.all([
      lexical.search(key, view.version, query, input.limit, input.include_audit),
      vectorPages(gateway, state, key, view.version, query, input.limit, input.include_audit),
    ]) : [[], []];
    const paths = new Set(view.paths);
    const ranked = rankWikiHits(terms, vectors.map((hit) => hit.page_id))
      .filter((h) => paths.has(h.path) && (input.include_audit || h.path !== "conflicts.md")).slice(0, input.limit);
    const wiki_hits = await Promise.all(ranked.map(async ({ path, score, source }) => {
      const { title, body } = await view.page(path);
      return { page_id: path, title, score, source,
        excerpt: relevantMarkdown(body, query, 180) || truncateTokens(body, 180) };
    }));
    const chat_hits = input.include_pending_chats && input.privacy_mode !== "external_safe"
      ? await searchChatTurns(chats, state, gateway, key, input.query, { limit: input.limit, prioritizePending: true }, true) : [];
    return c.json({ snapshot_version: view.version, wiki_hits, chat_hits }, 200);
  });

  app.openapi(createRoute({
    method: "get", path: base + "/page", tags, summary: "Read a Wiki page and its outgoing links",
    request: { query: toolPageQuerySchema.extend({ version }) },
    responses: { 200: json(toolPageResultSchema, "Wiki page"), ...requestErrors },
  }), async (c) => {
    const input = c.req.valid("query");
    const view = await viewFor(input);
    const path = input.path;
    if (!view.version || (path !== "_index.md" && !view.paths.includes(path))) {
      throw new ServiceError(404, "WIKI_PAGE_NOT_FOUND", "Wiki page not found in this view");
    }
    const page = path === "_index.md" ? { frontmatter: null, body: view.index, title: "Memory Index" } : await view.page(path);
    return c.json({ path, title: page.title, version: view.version, frontmatter: page.frontmatter, markdown: page.body,
      outgoing_links: extractWikiLinks(path, page.body).filter((p) => view.paths.includes(p)) }, 200);
  });

  app.openapi(createRoute({
    method: "get", path: base + "/source", tags, summary: "Verify an anchored passage in a published snapshot",
    request: { query: toolSourceQuerySchema.extend({ version }) },
    responses: { 200: json(sourceResultSchema, "Source passage"), 403: json(errorSchema, "Restricted source passage"), ...requestErrors },
  }), async (c) => {
    const input = c.req.valid("query");
    const { snapshot } = await snapshotFor(repo, input, input.version);
    if (!snapshot?.documents.includes(input.doc_id)) throw new ServiceError(404, "SOURCE_NOT_FOUND", "Source is outside this snapshot");
    const checkPassage = async (text: string) => {
      const claims = await readSnapshotClaims(storage, input, snapshot.version);
      const controls = state.listTelemetry(spaceKey(input));
      const anchor = `${input.doc_id}#${input.locator}`;
      const restricted = (fact: Fact) => {
        const control = factTelemetry(fact, controls);
        return fact.archived || control?.archived_reason ||
          externalScopes.includes(control?.scope_override ?? fact.scope ?? inferFactScope(fact));
      };
      if (externalScopes.includes(inferFactScope({ subject: "", predicate: "", value: text })) ||
        claims.some((fact) => isFact(fact) && (
          (claimAnchors(fact).some((source) => anchorKey(source) === anchor) && restricted(fact)) ||
          fact.merged_from?.some((atom) => anchorKey(atom) === anchor && restricted(atom))
        ))) {
        throw new ServiceError(403, "SOURCE_RESTRICTED", "Source passage contains private information under external_safe mode");
      }
    };
    const source = await new SourceReader(repo, storage, input).lookup(input.doc_id, input.locator,
      input.privacy_mode === "external_safe" ? checkPassage : undefined);
    return c.json(source, 200);
  });

  app.openapi(createRoute({
    method: "post", path: base + "/hot", tags, summary: "Remember or forget an instruction immediately",
    request: { body: body(toolHotMemorySchema) },
    responses: { 201: json(z.object({ hot_memory: hotMemorySummarySchema }), "Created hot memory"), ...requestErrors },
  }), async (c) => {
    const input = c.req.valid("json");
    await requireSpace(repo, input);
    const hot = state.addHotMemory({ spaceKey: spaceKey(input), sessionId: input.session_id, kind: input.kind,
      content: input.content, targetHint: input.target_hint, tier: input.tier, scope: input.scope });
    return c.json({ hot_memory: hotMemorySummarySchema.parse(hot) }, 201);
  });

  app.openapi(createRoute({
    method: "post", path: "/v1/memories/compact", tags: ["Memory"], summary: "Compact a conversation into bounded session context",
    request: { body: body(compactRequestSchema) },
    responses: { 200: json(compactResultSchema, "Summary and retained turns"), ...requestErrors },
  }), async (c) => {
    const input = c.req.valid("json");
    if (input.persist_hot_memories) await requireSpace(repo, input);
    return c.json(await compactor.compact(input), 200);
  });
}
