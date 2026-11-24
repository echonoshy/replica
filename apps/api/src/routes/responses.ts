import { errorSchema } from "@replica/shared";
import type { ZodType } from "zod";

export function json<T extends ZodType>(schema: T, description: string) {
  return { description, content: { "application/json": { schema } } };
}

export const requestErrors = {
  400: json(errorSchema, "Invalid request"),
  404: json(errorSchema, "Space, source or snapshot not found"),
  409: json(errorSchema, "Conflicting request or active writer"),
  413: json(errorSchema, "Upload limit exceeded"),
  415: json(errorSchema, "Unsupported media type"),
  422: json(errorSchema, "Input or candidate snapshot cannot be processed"),
  500: json(errorSchema, "Internal error"),
  502: json(errorSchema, "Model gateway error"),
  503: json(errorSchema, "Model gateway not configured"),
};
