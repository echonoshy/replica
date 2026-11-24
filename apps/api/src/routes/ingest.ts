import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import {
  docDateSchema, filenameSchema, ingestSchema, jobIdSchema, jobResultSchema,
  multipartFieldsSchema, UPLOAD_BATCH_BYTES, UPLOAD_FILE_BYTES, UPLOAD_MAX_ITEMS,
} from "@replica/shared";
import type { MetadataRepository } from "../db/interfaces.js";
import { ServiceError } from "../errors.js";
import { jobResponse, waitForCompile } from "../pipeline/ingestion.js";
import type { Ingestion, UploadItem } from "../pipeline/ingestion.js";
import { json, requestErrors } from "./responses.js";

const upload = z.file().max(UPLOAD_FILE_BYTES);
const multipart = multipartFieldsSchema.extend({
  files: z.array(upload).min(1).max(UPLOAD_MAX_ITEMS),
});

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new ServiceError(400, "VALIDATION_ERROR", message);
  }
  return result.data;
}
const datesSchema = z.record(filenameSchema, docDateSchema);

type RequestDescription = NonNullable<Parameters<typeof createRoute>[0]["request"]>;
type MediaType = NonNullable<RequestDescription["body"]>["content"][string];
type BodySchema = Exclude<MediaType, { $ref: string } | undefined>["schema"];
function describe(schema: z.ZodType): BodySchema {
  // Pass a 3.1 schema so Hono documents both media types without applying both validators to the same body.
  const { $schema: _dialect, ...definition } = z.toJSONSchema(schema, { io: "input" });
  return definition as BodySchema;
}

const ingestRoute = createRoute({
  method: "post", path: "/v1/memories/ingest", tags: ["Memory"],
  summary: "Accept files and compile a memory snapshot",
  middleware: [bodyLimit({ maxSize: UPLOAD_BATCH_BYTES * 2, onError: () => {
    throw new ServiceError(413, "UPLOAD_TOO_LARGE", "Request body exceeds the upload limit");
  } })] as const,
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: describe(ingestSchema) },
        "multipart/form-data": { schema: describe(multipart) },
      },
    },
  },
  responses: {
    202: json(jobResultSchema, "Accepted. Poll the job endpoint for completion"),
    200: json(jobResultSchema, "Synchronous job has settled"),
    ...requestErrors,
  },
});

const jobRoute = createRoute({
  method: "get", path: "/v1/memories/jobs/{job_id}", tags: ["Memory"],
  summary: "Get compile progress and token usage",
  request: { params: z.object({ job_id: jobIdSchema }) },
  responses: { 200: json(jobResultSchema, "Ingest or Dreaming job"), ...requestErrors },
});

export function ingestRoutes(
  app: OpenAPIHono, repo: MetadataRepository, ingestion: Ingestion, wake: () => void, syncWait: number,
) {
  app.openapi(ingestRoute, async (c) => {
    const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    let fields;
    let items: UploadItem[];
    if (contentType === "application/json") {
      const data = await c.req.json().catch(() => { throw new ServiceError(400, "INVALID_JSON", "Malformed JSON request"); });
      fields = validate(ingestSchema, data);
      items = fields.items.map(({ filename, content, doc_date }) => {
        if (typeof content !== "string" && !filename.toLowerCase().endsWith(".json")) {
          throw new ServiceError(400, "INVALID_CONTENT", "Structured content must use a .json filename");
        }
        if (/\.(docx|pdf)$/i.test(filename)) {
          throw new ServiceError(415, "MULTIPART_REQUIRED", "Upload DOCX and PDF via multipart/form-data");
        }
        return { filename, docDate: doc_date, bytes: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)) };
      });
    } else if (contentType === "multipart/form-data") {
      const form = await c.req.formData().catch(() => {
        throw new ServiceError(400, "INVALID_MULTIPART", "Malformed multipart request");
      });
      fields = validate(multipart, { ...Object.fromEntries(form), files: form.getAll("files") });
      let dates: Record<string, string> = {};
      if (fields.doc_dates) {
        try {
          dates = datesSchema.parse(JSON.parse(fields.doc_dates));
        } catch {
          throw new ServiceError(400, "INVALID_DOC_DATES", "doc_dates must map filenames to YYYY-MM-DD strings");
        }
      }
      items = await Promise.all(fields.files.map(async (file) => {
        const filename = filenameSchema.safeParse(file.name);
        if (!filename.success) throw new ServiceError(400, "INVALID_FILENAME", "Invalid uploaded filename");
        return {
          filename: filename.data, docDate: Object.hasOwn(dates, filename.data) ? dates[filename.data] : undefined,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }));
    } else {
      throw new ServiceError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json or multipart/form-data");
    }
    const job = await ingestion.submit(fields, items, fields.purpose, fields.idempotency_key);
    wake();
    if (fields.mode === "async") return c.json(await jobResponse(repo, job), 202);
    const current = await waitForCompile(repo, job, syncWait);
    const response = await jobResponse(repo, current);
    return c.json(response, current.status === "published" || current.status === "failed" ? 200 : 202);
  });

  app.openapi(jobRoute, async (c) => {
    const job = await repo.getJob(c.req.valid("param").job_id);
    if (!job) throw new ServiceError(404, "JOB_NOT_FOUND", "Compile job not found");
    return c.json(await jobResponse(repo, job), 200);
  });
}
