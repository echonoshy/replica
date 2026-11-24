import { z } from "zod";
import { citationSchema, spaceRefSchema } from "./api-schemas.js";
import { identifierSchema } from "./wiki-types.js";

export const proactiveInstantSchema = z.iso.datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected a valid timestamp with time zone");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().min(1).max(128).refine((value) => {
  try {
    if (/^[+-]/.test(value)) return false;
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch { return false; }
}, "Expected an IANA time zone");

export const proactivePolicySchema = z.object({
  enabled: z.boolean(), timezone, quiet_start: time, quiet_end: time,
  daily_digest_time: time.nullable(), max_daily_pushes: z.number().int().nonnegative().safe(),
  cooldown_hours: z.number().nonnegative(),
});
export const proactivePolicyUpdateSchema = proactivePolicySchema.partial().strict();
export const proactiveSpaceParamsSchema = z.object({ ns: identifierSchema, id: identifierSchema });
export const nudgeParamsSchema = z.object({ nudge_id: z.string().min(1).max(128) });
export const nudgeStatusSchema = z.enum(["pending", "read", "completed", "dismissed", "snoozed", "expired"]);
export const nudgeKindSchema = z.enum(["reminder", "conflict_check", "digest", "follow_up"]);
export const urgencySchema = z.enum(["urgent", "normal", "low"]);
export const nudgeSchema = z.object({
  nudge_id: z.string(), snapshot_version: z.number().int().nonnegative(), trigger_ids: z.array(z.string()),
  kind: nudgeKindSchema, urgency: urgencySchema, title: z.string(), body: z.string(),
  suggested_action: z.string().nullable(), citations: z.array(citationSchema), dedup_key: z.string(),
  status: nudgeStatusSchema, deliver_after: proactiveInstantSchema, created_at: proactiveInstantSchema, acked_at: proactiveInstantSchema.nullable(),
});
export const nudgesQuerySchema = spaceRefSchema.extend({
  status: nudgeStatusSchema.or(z.literal("all")).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(20), now: proactiveInstantSchema.optional(),
});
export const nudgesResultSchema = z.object({
  space: spaceRefSchema, nudges: z.array(nudgeSchema), total: z.number().int().nonnegative(),
});
export const ackNudgeSchema = z.discriminatedUnion("action", [
  spaceRefSchema.extend({ action: z.literal("snooze"), snooze_until: proactiveInstantSchema }),
  spaceRefSchema.extend({ action: z.enum(["completed", "read", "dismissed"]) }),
]);
export const evaluateSchema = spaceRefSchema.extend({ now: proactiveInstantSchema.optional(), dry_run: z.boolean().default(false) });
export const evaluateResultSchema = z.object({
  evaluated_at: proactiveInstantSchema, triggers_processed: z.number().int().nonnegative(),
  decision_summary: z.enum(["push", "digest", "silent"]), nudges: z.array(nudgeSchema),
  suppressed_reasons: z.array(z.string()), dry_run: z.boolean(),
});

export type ProactivePolicy = z.infer<typeof proactivePolicySchema>;
export type Nudge = z.infer<typeof nudgeSchema>;
export type NudgesQuery = z.infer<typeof nudgesQuerySchema>;
export type NudgesResult = z.infer<typeof nudgesResultSchema>;
export type NudgeAck = z.infer<typeof ackNudgeSchema>;
export type EvaluateInput = z.infer<typeof evaluateSchema>;
export type EvaluateResult = z.infer<typeof evaluateResultSchema>;
