import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  ackNudgeSchema, evaluateResultSchema, evaluateSchema, nudgeParamsSchema, nudgeSchema, nudgesQuerySchema,
  nudgesResultSchema, openNudgeSessionResultSchema, openNudgeSessionSchema, proactivePolicySchema,
  proactivePolicyUpdateSchema, proactiveSpaceParamsSchema, intentionsQuerySchema, intentionsResultSchema, createIntentionSchema,
  prospectiveIntentionSchema, updateIntentionSchema, intentionParamsSchema, spaceRefSchema, proactiveProfileSchema,
  executeNudgeActionSchema, executeNudgeActionResultSchema, proactiveEventInputSchema, proactiveEventResultSchema,
  scoutRequestSchema, scoutResultSchema, replayRequestSchema, replayResultSchema,
} from "@wiki-memory/shared";
import type { ProposedAction } from "@wiki-memory/shared";
import type { SQLiteChatStore } from "../../chat/chat-store.js";
import { spaceKey } from "../../db/interfaces.js";
import { ServiceError } from "../../errors.js";
import { json, requestErrors } from "../../routes/responses.js";
import type { OpenAiGateway } from "../../llm/openai-gateway.js";
import { Events } from "./events.js";
import { scout } from "./scout.js";
import { replay } from "./replay.js";
import type { Engine } from "./engine.js";
import type { NudgeStreams } from "./stream.js";
import { iso, localTime } from "./time.js";

const tags = ["Proactive"];
const base = "/v1/proactive";
const policy = "/v1/proactive/spaces/{ns}/{id}/policy";
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const fromParams = ({ ns, id }: z.infer<typeof proactiveSpaceParamsSchema>) => ({ namespace: ns, space_id: id });

function confirmedActionSummary(action: ProposedAction, note?: string) {
  const lines = [action.label];
  for (const key of ["summary", "new_date", "choice"]) {
    const value = action.payload[key];
    const text = typeof value === "string" ? value.trim() : "";
    if (text && text.length <= 240 && !/\p{Cc}/u.test(text)) lines.push(text);
  }
  if (note) lines.push(note);
  return lines.join("\n");
}

export type NudgeChatStore = Pick<SQLiteChatStore, "getSession" | "getMessages" | "createSessionFromNudge">;

export function proactiveRoutes(app: OpenAPIHono, engine: Engine, streams: NudgeStreams, chatStore: NudgeChatStore, gateway: OpenAiGateway) {
  app.openapi(createRoute({
    method: "get", path: `${base}/nudges`, tags, summary: "List visible nudges or subscribe to pending deliveries",
    request: { query: nudgesQuerySchema },
    responses: { ...requestErrors, 200: { description: "Visible nudges or an event stream", content: {
      "application/json": { schema: nudgesResultSchema },
      "text/event-stream": { schema: z.string().describe("snapshot carries a NudgesResult, nudge carries one Nudge, comments are heartbeats") },
    } } },
  }), (c) => {
    const query = c.req.valid("query");
    engine.port.version(query);
    if (c.req.header("Accept")?.toLowerCase().includes("text/event-stream")) {
      return c.body(streams.open(query, c.req.raw.signal), 200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
      });
    }
    return c.json(engine.store.list(query, iso(query.now ? Date.parse(query.now) : engine.clock())), 200);
  });
  app.openapi(createRoute({
    method: "post", path: `${base}/nudges/{nudge_id}/ack`, tags, summary: "Acknowledge or snooze a nudge",
    request: { params: nudgeParamsSchema, body: body(ackNudgeSchema) },
    responses: { ...requestErrors, 200: json(nudgeSchema, "Updated nudge") },
  }), (c) => {
    const ack = c.req.valid("json");
    return c.json(engine.store.ack(c.req.valid("param").nudge_id, ack, () => engine.port.version(ack), engine.clock()), 200);
  });
  app.openapi(createRoute({
    method: "post", path: `${base}/nudges/{nudge_id}/session`, tags, summary: "Open a chat session for a nudge",
    request: { params: nudgeParamsSchema, body: body(openNudgeSessionSchema) },
    responses: { ...requestErrors, 200: json(openNudgeSessionResultSchema, "Nudge and chat session") },
  }), (c) => {
    const ref = c.req.valid("json");
    const { nudge_id } = c.req.valid("param");
    const { store } = engine;
    const key = spaceKey(ref);
    const result = store.connection.transaction(() => {
      engine.port.version(ref);
      const nudge = store.getNudge(key, nudge_id);
      if (!nudge) throw new ServiceError(404, "NUDGE_NOT_FOUND", "Nudge not found in this space");
      const existing = nudge.session_id ? chatStore.getSession(nudge.session_id) : undefined;
      if (existing) {
        return { nudge, session: existing, messages: chatStore.getMessages(existing.session_id), created: false };
      }
      if (nudge.status === "expired") throw new ServiceError(409, "NUDGE_CLOSED", "This nudge has expired");

      const ms = engine.clock();
      const { timezone } = store.policy(key);
      const opening = [`## ${nudge.title}`, nudge.body];
      if (nudge.suggested_action) {
        opening.push(`> 建议下一步：${nudge.suggested_action.replace(/\r?\n/g, "\n> ")}`);
      }
      const chat = chatStore.createSessionFromNudge({
        spaceKey: key,
        title: nudge.title,
        sessionDate: localTime(ms, timezone).date,
        nudgeId: nudge.nudge_id,
        nudgeKind: nudge.kind,
        assistantContent: opening.join("\n\n"),
        citations: nudge.citations,
        snapshotVersion: nudge.snapshot_version,
        createdAt: iso(ms),
      });
      return { ...chat, nudge: store.linkSession(key, nudge_id, chat.session.session_id, ms), created: true };
    });
    return c.json(result, 200);
  });
  app.openapi(createRoute({
    method: "get", path: policy, tags, summary: "Read the space delivery policy",
    request: { params: proactiveSpaceParamsSchema }, responses: { ...requestErrors, 200: json(proactivePolicySchema, "Effective policy") },
  }), (c) => {
    const ref = fromParams(c.req.valid("param"));
    engine.port.version(ref);
    return c.json(engine.store.policy(spaceKey(ref)), 200);
  });
  app.openapi(createRoute({
    method: "put", path: policy, tags, summary: "Update the space delivery policy and reschedule pending timers",
    request: { params: proactiveSpaceParamsSchema, body: body(proactivePolicyUpdateSchema) },
    responses: { ...requestErrors, 200: json(proactivePolicySchema, "Effective policy") },
  }), async (c) => {
    const ref = fromParams(c.req.valid("param"));
    return c.json(await engine.plan(ref, engine.port.version(ref), c.req.valid("json")), 200);
  });
  app.openapi(createRoute({
    method: "post", path: `${base}/evaluate`, tags, summary: "Evaluate all due triggers in one space",
    request: { body: body(evaluateSchema) }, responses: { ...requestErrors, 200: json(evaluateResultSchema, "Evaluation result") },
  }), async (c) => c.json(await engine.evaluate(c.req.valid("json")), 200));

  const { store, port } = engine;
  const events = new Events(engine);
  app.openapi(createRoute({
    method: "get", path: `${base}/intentions`, tags, summary: "List prospective intentions",
    request: { query: intentionsQuerySchema }, responses: { ...requestErrors, 200: json(intentionsResultSchema, "Intentions in this space") },
  }), c => {
    const q = c.req.valid("query");
    port.version(q);
    return c.json(store.intentions.list(q), 200);
  });
  app.openapi(createRoute({
    method: "post", path: `${base}/intentions`, tags, summary: "Create a prospective intention",
    request: { body: body(createIntentionSchema) }, responses: { ...requestErrors, 201: json(prospectiveIntentionSchema, "Created intention") },
  }), c => {
    const input = c.req.valid("json"), now = iso(engine.clock());
    const result = store.connection.transaction(() => {
      const version = port.version(input), i = store.intentions.create(input, now, version);
      store.syncIntentionTimer(input, version, i.intention_id, i, now);
      return i;
    });
    return c.json(result, 201);
  });
  const intentionPath = `${base}/intentions/{intention_id}`;
  app.openapi(createRoute({
    method: "patch", path: intentionPath, tags, summary: "Update an intention and its reminder",
    request: { params: intentionParamsSchema, body: body(updateIntentionSchema) },
    responses: { ...requestErrors, 200: json(prospectiveIntentionSchema, "Updated intention") },
  }), c => {
    const input = c.req.valid("json"), { intention_id } = c.req.valid("param"), now = iso(engine.clock());
    const result = store.connection.transaction(() => {
      const version = port.version(input), i = store.intentions.update(intention_id, input, now);
      store.syncIntentionTimer(input, version, intention_id, i, now);
      return i;
    });
    return c.json(result, 200);
  });
  app.openapi(createRoute({
    method: "delete", path: intentionPath, tags, summary: "Delete a prospective intention",
    request: { params: intentionParamsSchema, query: spaceRefSchema },
    responses: { ...requestErrors, 200: json(z.object({ deleted: z.boolean() }), "Deletion result") },
  }), c => {
    const ref = c.req.valid("query"), { intention_id } = c.req.valid("param");
    const deleted = store.connection.transaction(() => {
      const version = port.version(ref);
      store.syncIntentionTimer(ref, version, intention_id, undefined, iso(engine.clock()));
      return store.intentions.delete(spaceKey(ref), intention_id);
    });
    return c.json({ deleted }, 200);
  });
  app.openapi(createRoute({
    method: "post", path: `${base}/events`, tags, summary: "Evaluate a real-time event against armed intentions",
    request: { body: body(proactiveEventInputSchema) }, responses: { ...requestErrors, 200: json(proactiveEventResultSchema, "Event result") },
  }), async c => c.json(await events.ingest(c.req.valid("json")), 200));
  app.openapi(createRoute({
    method: "post", path: `${base}/scout`, tags, summary: "Scout the snapshot for grounded risks and open loops",
    request: { body: body(scoutRequestSchema) }, responses: { ...requestErrors, 200: json(scoutResultSchema, "Scout findings") },
  }), async c => c.json(await engine.track(() => scout(engine, gateway, c.req.valid("json"))), 200));
  app.openapi(createRoute({
    method: "post", path: `${base}/replay`, tags, summary: "Replay a timeline without committing deliveries",
    request: { body: body(replayRequestSchema) }, responses: { ...requestErrors, 200: json(replayResultSchema, "Replay metrics") },
  }), async c => c.json(await engine.track(() => replay(engine, events, c.req.valid("json"))), 200));
  app.openapi(createRoute({
    method: "get", path: `${base}/spaces/{ns}/{id}/profile`, tags, summary: "Read engagement and feedback history",
    request: { params: proactiveSpaceParamsSchema }, responses: { ...requestErrors, 200: json(proactiveProfileSchema, "Proactive profile") },
  }), c => {
    const ref = fromParams(c.req.valid("param"));
    port.version(ref);
    return c.json(store.profile(ref, engine.clock()), 200);
  });
  app.openapi(createRoute({
    method: "post", path: `${base}/nudges/{nudge_id}/execute-action`, tags, summary: "Confirm a proposed nudge action",
    request: { params: nudgeParamsSchema, body: body(executeNudgeActionSchema) },
    responses: { ...requestErrors, 200: json(executeNudgeActionResultSchema, "Confirmed action") },
  }), c => {
    const input = c.req.valid("json"), { nudge_id } = c.req.valid("param"), key = spaceKey(input);
    const result = store.connection.transaction(() => {
      const version = port.version(input), n = store.getNudge(key, nudge_id, version), ms = engine.clock();
      if (!n) throw new ServiceError(404, "NUDGE_NOT_FOUND", "Nudge not found in this space");
      const action = n.proposed_actions?.find(a => a.action_id === input.action_id);
      if (!action) throw new ServiceError(404, "ACTION_NOT_FOUND", "Action not found on this nudge");
      if (["completed", "dismissed", "expired"].includes(n.status)) throw new ServiceError(409, "NUDGE_CLOSED", "This nudge is already closed");
      const nudge = store.ack(nudge_id, { ...input, action: "completed", reason: "helpful" }, () => version, ms);
      let intention_updated = false;
      const i = n.intention_id && store.intentions.get(key, n.intention_id);
      if (i && ["mark_done", "resolve_conflict", "reply_draft"].includes(action.kind)) {
        const fulfilled = store.intentions.update(i.intention_id, { ...input, status: "fulfilled" }, iso(ms));
        store.syncIntentionTimer(input, version, i.intention_id, fulfilled, iso(ms));
        intention_updated = true;
      }
      const hot = ["reschedule", "resolve_conflict"].includes(action.kind) && port.memoryState
        ? port.memoryState.addHotMemory({ spaceKey: key, sessionId: n.session_id, kind: "remember", targetHint: action.label,
          content: confirmedActionSummary(action, input.note) }) : undefined;
      return { nudge, executed_action: action, hot_memory_id: hot?.id ?? null, intention_updated };
    });
    return c.json(result, 200);
  });
}
