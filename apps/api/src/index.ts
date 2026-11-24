import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readConfig } from "./config.js";
import { createService } from "./service.js";

const config = readConfig();
const service = createService(config);
const webDir = fileURLToPath(new URL("../../web/dist/", import.meta.url));
if (existsSync(webDir)) {
  service.app.use("/assets/*", serveStatic({ root: webDir }));
  const spa = serveStatic({ root: webDir, path: "index.html" });
  service.app.get("/", spa);
  service.app.get("*", async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/v1/") || pathname === "/docs" || pathname === "/openapi.json" || pathname === "/health") {
      return next();
    }
    return spa(c, next);
  });
}

service.start();
const server = serve({ fetch: service.app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  console.log(`Replica Memory API · http://${config.HOST}:${info.port}/docs`);
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => { void service.close(); });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
