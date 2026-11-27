import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { anchorSchema, citationSchema, intentionStatusSchema, proposedActionSchema, utilityScoreSchema, nudgeKindSchema, proactiveInstantSchema, urgencySchema } from "@wiki-memory/shared";
import type { Citation, ProspectiveIntention, ProactivePolicy, SpaceRef } from "@wiki-memory/shared";
import { spaceKey, zeroUsage } from "../../db/interfaces.js";
import type { SnapshotRecord } from "../../db/interfaces.js";
import { errorMessage, ServiceError } from "../../errors.js";
import type { OpenAiGateway } from "../../llm/openai-gateway.js";
import { countTokens, relevantMarkdown, trimIndex, truncateTokens } from "../../retrieval/token-budget.js";
import type { MemoryKernelPort } from "./kernel.js";
import type { Store } from "./store.js";
import { anchorKey } from "../../pipeline/analyzer.js";
import { activeLedger, snapshotTimers } from "./planner.js";
import type { Trigger } from "./planner.js";
import { DAY, iso, localTime, quietUntil, shiftDay } from "./time.js";

const modelAction = z.preprocess(value => {
  if (!value || typeof value !== "object") return value;
  const a = value as Record<string, unknown>;
  const content = a.payload ?? a.content;
  return { ...a, kind: a.kind ?? a.type, action_id: a.action_id ?? randomUUID(),
    payload: typeof content === "string" || Array.isArray(content) ? { content } : content };
}, proposedActionSchema);
const modelNudge = z.object({
  trigger_ids: z.array(z.string()).min(1).max(100), kind: nudgeKindSchema, urgency: urgencySchema,
  title: z.string().trim().min(1).max(240), body: z.string().trim().min(1).max(4000),
  suggested_action: z.string().max(1000).nullish(),
  prepared_brief: z.string().trim().min(1).max(5000).nullish(), why_now: z.string().trim().min(1).max(1000).nullish(),
  intention_id: z.string().max(128).nullish(), proposed_actions: z.array(modelAction).max(12).optional(),
  utility_score: utilityScoreSchema.nullish(),
  citations: z.array(z.union([z.string(), z.object({ anchor: z.string() })])).max(32),
});
const decisionSchema = z.object({
  decision: z.enum(["push", "digest", "silent"]), nudges: z.array(modelNudge).max(20).default([]),
  intention_updates: z.array(z.object({ intention_id: z.string(), status: intentionStatusSchema, reason: z.string().optional() })).max(100).default([]),
  follow_ups: z.array(z.object({
    parent_trigger_id: z.string(), fire_at: proactiveInstantSchema, text: z.string().trim().min(1).max(1000),
  })).max(20).default([]),
});
export type Decision = z.infer<typeof decisionSchema>;
export type VerifiedNudge = Omit<z.infer<typeof modelNudge>, "citations"> & { citations: Citation[]; ungrounded_citations?: boolean };
const sourceTag = /\[src:([^\]]*)\]/g;

export async function resolveCitation(sources: ReturnType<MemoryKernelPort["sources"]>, documents: Set<string>, anchor: string) {
  const [doc, loc] = anchor.split("#");
  if (!anchorSchema.safeParse(anchor).success || !documents.has(doc)) return null;
  try {
    const source = await sources.lookup(doc, loc);
    return citationSchema.parse({ ...source, raw_excerpt: truncateTokens(source.raw_excerpt ?? "", 160) });
  } catch (error) {
    if (error instanceof ServiceError && error.code === "SOURCE_NOT_FOUND") return null;
    throw error;
  }
}

type Snapshot = Pick<SnapshotRecord, "documents" | "version" | "page_titles">;

async function verify(port: MemoryKernelPort, ref: SpaceRef, snapshot: Snapshot, drafts: Decision["nudges"]) {
  const sources = port.sources(ref);
  const documents = new Set(snapshot.documents);
  const checked = new Map<string, Citation | null>();
  const verified: VerifiedNudge[] = [];
  for (const draft of drafts) {
    const anchors = new Set([
      ...draft.citations.map((c) => (typeof c === "string" ? c : c.anchor).replace(/^\[src:(.*)\]$/, "$1")),
      ...Array.from((draft.body + "\n" + (draft.prepared_brief ?? "")).matchAll(sourceTag), (m) => m[1]),
    ]);
    for (const anchor of anchors) {
      if (checked.has(anchor)) continue;
      checked.set(anchor, await resolveCitation(sources, documents, anchor));
    }
    const citations = [...anchors].flatMap((a) => checked.get(a) ?? []);
    const ungrounded = anchors.size > 0 && citations.length === 0;
    let body = draft.body.replace(sourceTag, (tag, anchor: string) => checked.get(anchor) ? tag : "").trim();
    if (citations.length && !Array.from(body.matchAll(sourceTag)).length) body += " [src:" + citations[0].anchor + "]";
    const { prepared_brief, proposed_actions, utility_score, intention_id, why_now, ...base } = draft;
    const brief = prepared_brief?.replace(sourceTag, (tag, anchor: string) => checked.get(anchor) ? tag : "").trim();
    verified.push({ ...base, body, citations, ...(ungrounded && { ungrounded_citations: true }), ...(brief && { prepared_brief: brief }), ...(why_now && { why_now }),
      ...(proposed_actions?.length && { proposed_actions }), ...(intention_id && { intention_id }), ...(utility_score && { utility_score }) });
  }
  return verified;
}

export function fitRows<T>(rows: T[], budget: number) {
  const kept = [];
  for (const row of rows) {
    const cost = countTokens(JSON.stringify(row)) + 1;
    if (cost > budget) continue;
    kept.push(row);
    budget -= cost;
  }
  return kept;
}

export class Decider {
  private readonly prompt = readFileSync(new URL("../../prompts/proactive.md", import.meta.url), "utf8").trim();
  constructor(private readonly port: MemoryKernelPort, private readonly store: Store, private readonly gateway: OpenAiGateway) {}

  async decide(ref: SpaceRef, snapshot: Snapshot, policy: ProactivePolicy, ms: number, batch: Trigger[],
    armed: ProspectiveIntention[] = this.store.intentions.armed(spaceKey(ref))) {
    const { version } = snapshot;
    const candidateIds = new Set(batch.map(t => t.payload.intention_id));
    const index = version ? await this.port.file(ref, version, "_index.md") : "";
    const subjects = new Set(batch.flatMap((t) => t.payload.subjects));
    const digest = batch.some((t) => t.source_type === "daily_digest");
    const today = localTime(ms, policy.timezone).date;
    const horizon = shiftDay(today, 3);
    const candidates = digest ? await snapshotTimers(this.port, ref, version, policy, ms) : [];
    const upcoming = candidates.filter((t) => t.payload.occurs_on && t.payload.occurs_on >= today &&
      t.payload.occurs_on <= horizon && !this.store.blocked(spaceKey(ref), t, ms, policy.cooldown_hours));
    const agenda = new Map(upcoming.map((t) => [t.payload.item_keys[0], t]));
    for (const item of agenda.values()) item.payload.subjects.forEach((subject) => subjects.add(subject));
    const query = truncateTokens([...subjects, ...batch.slice(0, 12).map(t => t.payload.text)].join(" "), 1200);
    const retrieved = await this.port.retrieveContext?.(ref, query, { version }).catch(error => {
      console.warn("Proactive context retrieval unavailable", spaceKey(ref), errorMessage(error));
      return undefined;
    });

    const memory = retrieved?.contexts.map(c => c.content) ?? [];
    const controlled = !retrieved && [...(this.port.telemetry?.(ref)?.values() ?? [])].some(t => t.archived_reason || t.edited_value != null);
    if (controlled) {
      // Raw published Markdown can predate a user's edits. Use the active facts
      // as the fallback when the unified retriever cannot render its filtered view.
      const ledger = await activeLedger(this.port, ref, version, today);
      const facts = ledger.current.filter(f => subjects.has(f.subject))
        .map(f => f.subject + " · " + f.predicate + ": " + f.value + " [src:" + anchorKey(f) + "]");
      memory.push(...fitRows(facts, 700));
    } else if (!retrieved) {
      let remaining = digest ? 400 : 700;
      for (const [path, title] of Object.entries(snapshot.page_titles ?? {})) {
        if (!subjects.has(title) && !/约束|偏好|政策|constraint|policy|preference/i.test(title)) continue;
        const excerpt = relevantMarkdown(await this.port.file(ref, version, path), query, Math.min(remaining, 350));
        if (excerpt) memory.push(excerpt);
        remaining -= countTokens(excerpt) + 4;
        if (remaining < 40) break;
      }
    }
    const triggers = fitRows(batch.map((t) => ({
      trigger_id: t.trigger_id, source_type: t.source_type, fire_at: t.fire_at, chain_depth: t.chain_depth,
      text: truncateTokens(t.payload.text, 160), anchors: t.payload.anchors.slice(0, 6),
      ...(t.payload.intention_id && { intention_id: t.payload.intention_id }),
      ...(t.payload.user_authored && { user_authored: true }),
    })), 1200);
    const shown = new Set(triggers.map((t) => t.trigger_id));
    const overflow = Map.groupBy(batch.filter((t) => !shown.has(t.trigger_id)), (t) => "group:" + t.source_type);
    const deliveryMs = quietUntil(ms, policy);
    const deliveryLocal = localTime(deliveryMs, policy.timezone);
    const context = {
      now: iso(ms), timezone: policy.timezone, quiet: deliveryMs > ms,
      delivery_local_date: deliveryLocal.date,
      delivery_local_time: deliveryLocal.time,
      deferred_from_quiet_hours: deliveryMs > ms,
      total_due: batch.length, triggers,
      trigger_groups: [...overflow].map(([id, group]) => ({
        group_id: id, count: group.length, example: truncateTokens(group[0].payload.text, 50), anchors: group[0].payload.anchors.slice(0, 1),
      })),
      index: trimIndex(index, 240), related_memory: memory,
      upcoming: fitRows([...agenda.values()].map(({ payload: p }) => ({ text: truncateTokens(p.text, 100), anchors: p.anchors.slice(0, 3) })), 300),
      core_card: truncateTokens(retrieved?.core_card ?? "", 350),
      rules: fitRows(retrieved?.rules ?? [], 300),
      hot_memories: fitRows(retrieved?.hot_memories ?? [], 300),
      pending_chat_hits: fitRows(retrieved?.pending_chat_hits ?? [], 450),
      proactive_profile: this.store.profile(ref, ms),
      armed_intentions: fitRows(armed.filter(i => candidateIds.has(i.intention_id)).map(i => ({ intention_id: i.intention_id, goal: truncateTokens(i.goal, 100), kind: i.kind,
        priority: i.priority, source: i.source, subjects: i.subjects.slice(0, 6), evidence_anchors: i.evidence_anchors.slice(0, 4) })), 600),
      working_state: fitRows(this.store.working(spaceKey(ref), iso(ms - 7 * DAY), iso(ms)), 340),
    };
    // Measure the serialized payload too: escaping Markdown can cost extra tokens.
    while (countTokens(JSON.stringify(context)) > (overflow.size ? 2500 : 4500)) {
      if (context.related_memory.length) context.related_memory.pop();
      else if (context.working_state.length) context.working_state.pop();
      else if (context.upcoming.length) context.upcoming.pop();
      else if (context.pending_chat_hits.length) context.pending_chat_hits.pop();
      else if (context.armed_intentions.length) context.armed_intentions.pop();
      else if (context.hot_memories.length) context.hot_memories.pop();
      else if (context.rules.length) context.rules.pop();
      else if (context.core_card) context.core_card = "";
      else { context.index = ""; break; }
    }
    const decision = await this.gateway.structured("fast", this.prompt, context, decisionSchema, zeroUsage());
    const supplied = new Set(context.armed_intentions.map(i => i.intention_id));
    triggers.forEach(t => { if (t.intention_id) supplied.add(t.intention_id); });
    decision.intention_updates = decision.intention_updates.filter(i => supplied.has(i.intention_id));
    const drafts = await verify(this.port, ref, snapshot, decision.decision === "silent" ? [] : decision.nudges);
    for (const draft of drafts) {
      draft.trigger_ids = draft.trigger_ids.flatMap((id) => overflow.get(id)?.map((t) => t.trigger_id) ?? [id]);
    }
    return { decision, agenda: [...agenda.values()], drafts };
  }
}
