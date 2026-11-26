import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { retrieveSchema, retrieveResultSchema } from "@wiki-memory/shared";
import type { Synthesizer } from "../retrieval/synthesizer.js";
import { json, requestErrors } from "./responses.js";

const route = createRoute({
  method: "post", path: "/v1/memories/retrieve", tags: ["Memory"],
  summary: "Retrieve snapshot evidence with fast, multi-hop, or agentic navigation",
  request: { body: { required: true, content: { "application/json": { schema: retrieveSchema } } } },
  responses: { 200: json(retrieveResultSchema, "Version-pinned retrieval result"), ...requestErrors },
});

export function retrieveRoutes(app: OpenAPIHono, synthesizer: Synthesizer) {
  app.openapi(route, async (c) => c.json(await synthesizer.retrieve(c.req.valid("json")), 200));
}
