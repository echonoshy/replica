import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  ackNudgeSchema, evaluateResultSchema, evaluateSchema, nudgeParamsSchema, nudgeSchema, nudgesQuerySchema,
  nudgesResultSchema, proactivePolicySchema, proactivePolicyUpdateSchema, proactiveSpaceParamsSchema,
} from "@replica/shared";
import { spaceKey } from "../../db/interfaces.js";
import { json, requestErrors } from "../../routes/responses.js";
import type { Engine } from "./engine.js";
import type { NudgeStreams } from "./stream.js";
import { iso } from "./time.js";

const tags = ["Proactive"];
const base = "/v1/proactive";
const policy = "/v1/proactive/spaces/{ns}/{id}/policy";
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const fromParams = ({ ns, id }: z.infer<typeof proactiveSpaceParamsSchema>) => ({ namespace: ns, space_id: id });

export function proactiveRoutes(app: OpenAPIHono, engine: Engine, streams: NudgeStreams) {
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
}
