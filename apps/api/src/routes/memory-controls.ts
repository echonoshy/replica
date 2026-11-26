import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { identifierSchema } from "@wiki-memory/shared";
import type { SpaceRef } from "@wiki-memory/shared";
import { spaceKey } from "../db/interfaces.js";
import type { MetadataRepository, WikiStorage } from "../db/interfaces.js";
import { factStorageKey, type SQLiteMemoryStateStore } from "../memory/memory-state.js";
import { isFact, memoryTierSchema, privacyScopeSchema } from "../pipeline/analyzer.js";
import type { Claim } from "../pipeline/analyzer.js";
import { reconcile } from "../pipeline/wiki-compiler.js";
import { readSnapshotClaims, requireSpace, ruleSummary, snapshotFor } from "../retrieval/synthesizer.js";
import { requestErrors } from "./responses.js";

const base = "/v1/memory/spaces/{ns}/{id}";
const tags = ["Memory Controls"];
const params = z.object({ ns: identifierSchema, id: identifierSchema });
const fromParams = ({ ns, id }: z.infer<typeof params>): SpaceRef => ({ namespace: ns, space_id: id });
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const nonempty = z.string().trim().min(1);
const aliasParams = z.object({ kind: z.enum(["entity", "topic"]).default("entity"), alias: nonempty });
const factPatch = z.object({
  fact_key: nonempty,
  pinned: z.boolean().optional(),
  tier_override: memoryTierSchema.nullish(),
  scope_override: privacyScopeSchema.nullish(),
  edited_value: z.string().nullish(),
  archived_reason: z.string().nullish(),
  restore: z.boolean().optional(),
});
const hotInput = z.object({
  kind: z.enum(["remember", "forget"]),
  content: nonempty,
  target_hint: z.string().optional(),
  tier: memoryTierSchema.optional(),
  scope: privacyScopeSchema.optional(),
});

export function memoryControlsView(memoryState: SQLiteMemoryStateStore, key: string, claims: Claim[]) {
  const today = new Date().toISOString().slice(0, 10);
  const { current, rules: activeRules = [] } = reconcile(claims, today);
  const rules = activeRules.map(ruleSummary).filter((rule) => !rule.archived);
  const dates = new Map(claims.filter(isFact).map((f) => [factStorageKey(f), {
    ...(f.valid_from ? { valid_from: f.valid_from } : {}), ...(f.valid_to ? { valid_to: f.valid_to } : {}),
  }]));
  const enrich = (items: Claim[]) => memoryState.enrichFacts(key, items, today)
    .map((f) => ({ ...f, ...dates.get(factStorageKey({ ...f, value: f.original_value })) }));
  const enriched = enrich(current);
  const facts = enriched.filter((fact) => !fact.archived);
  const dreamArchived = claims.filter((claim) => isFact(claim) && claim.archived);
  const archived_facts = [
    ...enriched.filter((fact) => fact.archived),
    ...enrich(dreamArchived).map((fact) => ({ ...fact, archived: true })),
  ];
  return {
    core_profile_card: memoryState.buildCoreProfileCard(key, current, today, { rules: rules.map((r) => ({ ...r, docId: r.doc_id })) }),
    rules, facts,
    archived_facts,
    aliases: memoryState.listAliases(key),
    hot_memories: memoryState.listHotMemories(key, "all"),
    stats: {
      rules_count: rules.length,
      total_active: facts.length,
      pinned_count: facts.filter((fact) => fact.tier === "pinned_redline").length,
      durable_count: facts.filter((fact) => fact.tier === "durable").length,
      working_count: facts.filter((fact) => fact.tier === "working").length,
      fading_count: facts.filter((fact) => fact.decay_state === "fading").length,
      cold_count: facts.filter((fact) => fact.decay_state === "cold").length,
      archived_count: archived_facts.length,
    },
  };
}

export function memoryControlRoutes(
  app: OpenAPIHono, repo: MetadataRepository, storage: WikiStorage, memoryState: SQLiteMemoryStateStore,
) {
  async function existingSpaceKey(path: z.infer<typeof params>) {
    const ref = fromParams(path);
    await requireSpace(repo, ref);
    return spaceKey(ref);
  }

  app.openapi(createRoute({
    method: "get", path: `${base}/controls`, tags, summary: "Read memory controls for the active snapshot",
    request: { params }, responses: { ...requestErrors, 200: { description: "Enriched facts and space memory controls" } },
  }), async (c) => {
    const ref = fromParams(c.req.valid("param"));
    const { snapshot } = await snapshotFor(repo, ref);
    const key = spaceKey(ref);
    const claims = snapshot ? await readSnapshotClaims(storage, ref, snapshot.version) : [];
    return c.json({ space_key: key, snapshot_version: snapshot?.version ?? 0, ...memoryControlsView(memoryState, key, claims) }, 200);
  });

  app.openapi(createRoute({
    method: "patch", path: `${base}/facts`, tags, summary: "Update or restore a fact",
    request: { params, body: body(factPatch) },
    responses: { ...requestErrors, 200: { description: "Updated fact telemetry" } },
  }), async (c) => {
    const key = await existingSpaceKey(c.req.valid("param"));
    const { fact_key, restore, ...patch } = c.req.valid("json");
    if (restore === true) patch.archived_reason = null;
    return c.json({ telemetry: memoryState.upsertFactControl(key, fact_key, patch) }, 200);
  });

  app.openapi(createRoute({
    method: "post", path: `${base}/aliases`, tags, summary: "Register an alias",
    request: { params, body: body(aliasParams.extend({ canonical_subject: nonempty })) },
    responses: { ...requestErrors, 201: { description: "Registered alias and space aliases" } },
  }), async (c) => {
    const key = await existingSpaceKey(c.req.valid("param"));
    const { kind, canonical_subject, alias } = c.req.valid("json");
    const record = memoryState.registerAlias(key, kind, canonical_subject, alias);
    return c.json({ alias: record, aliases: memoryState.listAliases(key) }, 201);
  });

  app.openapi(createRoute({
    method: "delete", path: `${base}/aliases`, tags, summary: "Remove an alias",
    request: { params, query: aliasParams },
    responses: { ...requestErrors, 200: { description: "Deletion result and remaining aliases" } },
  }), async (c) => {
    const key = await existingSpaceKey(c.req.valid("param"));
    const { kind, alias } = c.req.valid("query");
    const deleted = memoryState.removeAlias(key, kind, alias);
    return c.json({ deleted, aliases: memoryState.listAliases(key) }, 200);
  });

  app.openapi(createRoute({
    method: "post", path: `${base}/hot`, tags, summary: "Add an immediate remember or forget instruction",
    request: { params, body: body(hotInput) },
    responses: { ...requestErrors, 201: { description: "Created hot memory" } },
  }), async (c) => {
    const key = await existingSpaceKey(c.req.valid("param"));
    const { target_hint, ...input } = c.req.valid("json");
    const hot_memory = memoryState.addHotMemory({ spaceKey: key, targetHint: target_hint, ...input });
    return c.json({ hot_memory }, 201);
  });

  app.openapi(createRoute({
    method: "delete", path: `${base}/hot/{hot_id}`, tags, summary: "Dismiss a hot memory",
    request: { params: params.extend({ hot_id: nonempty }) },
    responses: { ...requestErrors, 200: { description: "Dismissal result" } },
  }), async (c) => {
    const path = c.req.valid("param");
    const key = await existingSpaceKey(path);
    return c.json({ dismissed: memoryState.updateHotMemoryStatus(key, path.hot_id, "dismissed") }, 200);
  });
}
