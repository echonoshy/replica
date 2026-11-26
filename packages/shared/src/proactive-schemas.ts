import { z } from "zod";
import { citationSchema, docDateSchema, retrieveResultSchema, spaceRefSchema } from "./api-schemas.js";
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
  strict_urgent_quiet_guard: z.boolean().optional(),
});
export const proactivePolicyUpdateSchema = proactivePolicySchema.partial().strict();
export const proactiveSpaceParamsSchema = z.object({ ns: identifierSchema, id: identifierSchema });
export const nudgeParamsSchema = z.object({ nudge_id: z.string().min(1).max(128) });

export const intentionKindSchema = z.enum(["time_based", "event_based", "open_loop", "recurring", "risk_watch"]);
export const intentionPrioritySchema = z.enum(["redline", "high", "normal", "low"]);
export const intentionStatusSchema = z.enum(["armed", "snoozed", "triggered", "fulfilled", "cancelled", "expired"]);
export const proactiveEventTypeSchema = z.enum([
  "email_received", "calendar_changed", "chat_turn", "location_changed", "topic_entered", "app_signal", "custom",
]);

export const intentionConditionSchema = z.object({
  cue_text: z.string().trim().min(1).max(600).optional(),
  match_event_types: z.array(proactiveEventTypeSchema).max(10).optional(),
  fire_at: proactiveInstantSchema.nullable().optional(),
  rrule: z.string().trim().min(1).max(200).nullable().optional(),
  stale_after_days: z.number().int().min(1).max(365).nullable().optional(),
  not_before: proactiveInstantSchema.nullable().optional(),
  deadline: proactiveInstantSchema.nullable().optional(),
});

const intentionGoalSchema = z.string().trim().min(1).max(1000);
const intentionSourceSchema = z.enum(["memory", "scout", "user", "agent"]);
const intentionTermsSchema = z.array(z.string().trim().min(1).max(120)).max(20);

export const prospectiveIntentionSchema = z.object({
  intention_id: z.string(),
  space_key: z.string(),
  kind: intentionKindSchema,
  goal: intentionGoalSchema,
  condition: intentionConditionSchema,
  subjects: z.array(z.string()).default([]),
  priority: intentionPrioritySchema,
  status: intentionStatusSchema,
  evidence_anchors: z.array(z.string()).default([]),
  source: intentionSourceSchema.default("user"),
  snoozed_until: proactiveInstantSchema.nullable().default(null),
  created_at: proactiveInstantSchema,
  updated_at: proactiveInstantSchema,
});
export const createIntentionSchema = spaceRefSchema.extend({
  kind: intentionKindSchema,
  goal: intentionGoalSchema,
  condition: intentionConditionSchema.default({}),
  subjects: intentionTermsSchema.default([]),
  priority: intentionPrioritySchema.default("normal"),
  evidence_anchors: intentionTermsSchema.default([]),
  source: intentionSourceSchema.default("user"),
});
export const intentionParamsSchema = z.object({ intention_id: z.string().min(1).max(128) });
export const updateIntentionSchema = spaceRefSchema.extend({
  goal: intentionGoalSchema.optional(),
  condition: intentionConditionSchema.optional(),
  priority: intentionPrioritySchema.optional(),
  status: intentionStatusSchema.optional(),
  snoozed_until: proactiveInstantSchema.nullable().optional(),
});
export const intentionsQuerySchema = spaceRefSchema.extend({
  status: intentionStatusSchema.or(z.literal("all")).default("armed"),
  kind: intentionKindSchema.or(z.literal("all")).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const intentionsResultSchema = z.object({
  space: spaceRefSchema,
  intentions: z.array(prospectiveIntentionSchema),
  total: z.number().int().nonnegative(),
});

export const nudgeStatusSchema = z.enum(["pending", "read", "completed", "dismissed", "snoozed", "expired"]);
export const nudgeKindSchema = z.enum(["reminder", "conflict_check", "digest", "follow_up", "event_trigger", "risk_alert", "open_loop"]);
export const urgencySchema = z.enum(["urgent", "normal", "low"]);
export const proposedActionKindSchema = z.enum(["reply_draft", "reschedule", "resolve_conflict", "checklist", "mark_done"]);
export const proposedActionSchema = z.object({
  action_id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(120),
  kind: proposedActionKindSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export const utilityScoreSchema = z.object({
  miss_cost: z.number().min(0).max(10),
  actionability: z.number().min(0).max(10),
  value_add: z.number().min(0).max(10),
  interruption_cost: z.number().min(0).max(10),
  net_utility: z.number(),
});
export const ackReasonSchema = z.enum(["helpful", "already_done", "too_early", "not_relevant", "wrong_fact", "too_frequent"]);

export const nudgeSchema = z.object({
  nudge_id: z.string(), snapshot_version: z.number().int().nonnegative(), trigger_ids: z.array(z.string()),
  kind: nudgeKindSchema, urgency: urgencySchema, title: z.string(), body: z.string(),
  suggested_action: z.string().nullable(), citations: z.array(citationSchema), dedup_key: z.string(),
  status: nudgeStatusSchema, deliver_after: proactiveInstantSchema, created_at: proactiveInstantSchema, acked_at: proactiveInstantSchema.nullable(),
  session_id: z.string().nullable().default(null),
  prepared_brief: z.string().nullable().optional(),
  proposed_actions: z.array(proposedActionSchema).optional(),
  utility_score: utilityScoreSchema.nullable().optional(),
  why_now: z.string().nullable().optional(),
  intention_id: z.string().nullable().optional(),
  ack_reason: ackReasonSchema.nullable().optional(),
});
export const nudgesQuerySchema = spaceRefSchema.extend({
  status: nudgeStatusSchema.or(z.literal("all")).default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(20), now: proactiveInstantSchema.optional(),
});
export const nudgesResultSchema = z.object({
  space: spaceRefSchema, nudges: z.array(nudgeSchema), total: z.number().int().nonnegative(),
});
export const ackNudgeSchema = z.discriminatedUnion("action", [
  spaceRefSchema.extend({
    action: z.literal("snooze"),
    snooze_until: proactiveInstantSchema,
    reason: ackReasonSchema.optional(),
  }),
  spaceRefSchema.extend({
    action: z.enum(["completed", "read", "dismissed"]),
    reason: ackReasonSchema.optional(),
    keep_reminding: z.boolean().optional(),
  }),
]);
export const executeNudgeActionSchema = spaceRefSchema.extend({
  action_id: proposedActionSchema.shape.action_id,
  note: z.string().trim().max(1000).optional(),
});
export const executeNudgeActionResultSchema = z.object({
  nudge: nudgeSchema,
  executed_action: proposedActionSchema,
  hot_memory_id: z.string().nullable().default(null),
  intention_updated: z.boolean().default(false),
});
export const openNudgeSessionSchema = spaceRefSchema;

const chatSessionStatusSchema = z.enum(["pending", "dreaming", "dreamed"]);
const chatSessionRecordSchema = z.object({
  session_id: z.string(), space_key: z.string(), title: z.string(), session_date: docDateSchema,
  status: chatSessionStatusSchema, dreamed_doc_id: z.string().nullable(),
  dreamed_version: z.number().int().nonnegative().nullable(), dreamed_job_id: z.string().nullable(),
  dreamed_message_count: z.number().int().nonnegative(), message_count: z.number().int().nonnegative(),
  source_nudge_id: z.string().nullable(), source_nudge_kind: z.string().nullable(),
  created_at: proactiveInstantSchema, updated_at: proactiveInstantSchema,
});
const conversationSearchHitSchema = z.object({
  session_id: z.string(), session_title: z.string(), session_date: docDateSchema,
  session_status: chatSessionStatusSchema, dreamed_doc_id: z.string().nullable(),
  turn_locator: z.string(), excerpt: z.string(), matched_terms: z.array(z.string()), score: z.number(),
});
const chatMessageRecordSchema = z.object({
  id: z.number().int(), session_id: z.string(), role: z.enum(["user", "assistant"]), content: z.string(),
  baseline_reply: z.string().nullable(), retrieval: retrieveResultSchema.nullable(),
  citations: z.array(citationSchema), conversation_hits: z.array(conversationSearchHitSchema),
  tokens: z.number().int().nullable(), latency_ms: z.number().int().nullable(), created_at: proactiveInstantSchema,
});
export const openNudgeSessionResultSchema = z.object({
  nudge: nudgeSchema,
  created: z.boolean(),
  session: chatSessionRecordSchema,
  messages: z.array(chatMessageRecordSchema),
});

export const evaluateSchema = spaceRefSchema.extend({ now: proactiveInstantSchema.optional(), dry_run: z.boolean().default(false) });
export const evaluateResultSchema = z.object({
  evaluated_at: proactiveInstantSchema, triggers_processed: z.number().int().nonnegative(),
  decision_summary: z.enum(["push", "digest", "silent"]), nudges: z.array(nudgeSchema),
  suppressed_reasons: z.array(z.string()), dry_run: z.boolean(),
});

export const proactiveEventInputSchema = spaceRefSchema.extend({
  event_type: proactiveEventTypeSchema,
  summary: z.string().trim().min(1).max(4000),
  entities: intentionTermsSchema.default([]),
  occurred_at: proactiveInstantSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  dry_run: z.boolean().default(false),
});
export const proactiveEventMatchSchema = z.object({
  intention_id: z.string(),
  goal: z.string(),
  kind: intentionKindSchema,
  score: z.number(),
  matched_by: z.array(z.string()),
});
export const proactiveEventResultSchema = z.object({
  event_id: z.string(),
  evaluated_at: proactiveInstantSchema,
  l1_matches: z.array(proactiveEventMatchSchema),
  llm_called: z.boolean(),
  decision_summary: evaluateResultSchema.shape.decision_summary,
  nudges: z.array(nudgeSchema),
  updated_intention_ids: z.array(z.string()).default([]),
  suppressed_reasons: z.array(z.string()),
  dry_run: z.boolean(),
});

export const scoutRequestSchema = spaceRefSchema.extend({
  now: proactiveInstantSchema.optional(),
  dry_run: z.boolean().default(false),
});
export const scoutFindingSchema = z.object({
  kind: z.enum(["risk_watch", "open_loop"]),
  priority: intentionPrioritySchema,
  title: z.string().trim().min(1).max(240),
  goal: intentionGoalSchema,
  rationale: z.string().trim().min(1).max(1000),
  subjects: z.array(z.string()).default([]),
  evidence_anchors: z.array(z.string()).min(1).max(12),
  fire_at: proactiveInstantSchema.nullable().optional(),
  deadline: proactiveInstantSchema.nullable().optional(),
});
export const scoutResultSchema = z.object({
  scouted_at: proactiveInstantSchema,
  snapshot_version: z.number().int().nonnegative(),
  findings: z.array(scoutFindingSchema),
  created_intentions: z.array(prospectiveIntentionSchema),
  dry_run: z.boolean(),
});

export const proactiveKindStatsSchema = z.object({
  kind: nudgeKindSchema,
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  snoozed: z.number().int().nonnegative(),
  acceptance_rate: z.number().min(0).max(1),
});
export const proactiveProfileSchema = z.object({
  space: spaceRefSchema,
  total_nudges: z.number().int().nonnegative(),
  overall_acceptance_rate: z.number().min(0).max(1),
  by_kind: z.array(proactiveKindStatsSchema),
  top_dismiss_reasons: z.array(z.object({ reason: ackReasonSchema, count: z.number().int().positive() })),
  preferred_hours: z.array(z.number().int().min(0).max(23)),
  active_intentions_count: z.number().int().nonnegative(),
  updated_at: proactiveInstantSchema,
});

export const replayStepSchema = z.object({
  step_id: z.string().min(1).max(64),
  at: proactiveInstantSchema,
  kind: z.enum(["evaluate", "event"]),
  event: proactiveEventInputSchema.omit({ namespace: true, space_id: true, dry_run: true, occurred_at: true }).optional(),
  expected_decision: evaluateResultSchema.shape.decision_summary.optional(),
  critical: z.boolean().default(false),
});
export const replayRequestSchema = spaceRefSchema.extend({ steps: z.array(replayStepSchema).min(1).max(100) });
export const replayStepResultSchema = z.object({
  step_id: z.string(),
  at: proactiveInstantSchema,
  expected_decision: evaluateResultSchema.shape.decision_summary.nullable(),
  actual_decision: evaluateResultSchema.shape.decision_summary,
  matched: z.boolean().nullable(),
  nudge_count: z.number().int().nonnegative(),
  grounded_citations: z.number().int().nonnegative(),
  total_citations: z.number().int().nonnegative(),
  suppressed_reasons: z.array(z.string()),
});
export const replayResultSchema = z.object({
  space: spaceRefSchema,
  total_steps: z.number().int().nonnegative(),
  push_precision: z.number().min(0).max(1),
  critical_recall: z.number().min(0).max(1),
  silence_accuracy: z.number().min(0).max(1),
  citation_grounding_rate: z.number().min(0).max(1),
  steps: z.array(replayStepResultSchema),
});

export type ProactivePolicy = z.infer<typeof proactivePolicySchema>;
export type Nudge = z.infer<typeof nudgeSchema>;
export type NudgesQuery = z.infer<typeof nudgesQuerySchema>;
export type NudgesResult = z.infer<typeof nudgesResultSchema>;
export type NudgeAck = z.infer<typeof ackNudgeSchema>;
export type OpenNudgeSessionInput = z.infer<typeof openNudgeSessionSchema>;
export type OpenNudgeSessionResult = z.infer<typeof openNudgeSessionResultSchema>;
export type EvaluateInput = z.infer<typeof evaluateSchema>;
export type EvaluateResult = z.infer<typeof evaluateResultSchema>;

export type IntentionKind = z.infer<typeof intentionKindSchema>;
export type IntentionPriority = z.infer<typeof intentionPrioritySchema>;
export type IntentionStatus = z.infer<typeof intentionStatusSchema>;
export type ProactiveEventType = z.infer<typeof proactiveEventTypeSchema>;
export type IntentionCondition = z.infer<typeof intentionConditionSchema>;
export type ProspectiveIntention = z.infer<typeof prospectiveIntentionSchema>;
export type CreateIntentionInput = z.infer<typeof createIntentionSchema>;
export type IntentionParams = z.infer<typeof intentionParamsSchema>;
export type UpdateIntentionInput = z.infer<typeof updateIntentionSchema>;
export type IntentionsQuery = z.infer<typeof intentionsQuerySchema>;
export type IntentionsResult = z.infer<typeof intentionsResultSchema>;
export type ProposedActionKind = z.infer<typeof proposedActionKindSchema>;
export type ProposedAction = z.infer<typeof proposedActionSchema>;
export type UtilityScore = z.infer<typeof utilityScoreSchema>;
export type AckReason = z.infer<typeof ackReasonSchema>;
export type ExecuteNudgeActionInput = z.infer<typeof executeNudgeActionSchema>;
export type ExecuteNudgeActionResult = z.infer<typeof executeNudgeActionResultSchema>;
export type ProactiveEventInput = z.infer<typeof proactiveEventInputSchema>;
export type ProactiveEventMatch = z.infer<typeof proactiveEventMatchSchema>;
export type ProactiveEventResult = z.infer<typeof proactiveEventResultSchema>;
export type ScoutRequest = z.infer<typeof scoutRequestSchema>;
export type ScoutFinding = z.infer<typeof scoutFindingSchema>;
export type ScoutResult = z.infer<typeof scoutResultSchema>;
export type ProactiveKindStats = z.infer<typeof proactiveKindStatsSchema>;
export type ProactiveProfile = z.infer<typeof proactiveProfileSchema>;
export type ReplayStep = z.infer<typeof replayStepSchema>;
export type ReplayRequest = z.infer<typeof replayRequestSchema>;
export type ReplayStepResult = z.infer<typeof replayStepResultSchema>;
export type ReplayResult = z.infer<typeof replayResultSchema>;
