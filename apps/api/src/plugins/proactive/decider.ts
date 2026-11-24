import { readFileSync } from "node:fs";
import { z } from "zod";
import { anchorSchema, citationSchema, nudgeKindSchema, proactiveInstantSchema, urgencySchema } from "@replica/shared";
import type { Citation, ProactivePolicy, SpaceRef } from "@replica/shared";
import { spaceKey, zeroUsage } from "../../db/interfaces.js";
import type { SnapshotRecord } from "../../db/interfaces.js";
import { ServiceError } from "../../errors.js";
import type { OpenAiGateway } from "../../llm/openai-gateway.js";
import { countTokens, relevantMarkdown, trimIndex, truncateTokens } from "../../retrieval/token-budget.js";
import type { MemoryKernelPort } from "./kernel.js";
import type { Store } from "./store.js";
import { snapshotTimers } from "./planner.js";
import type { Trigger } from "./planner.js";
import { DAY, iso, localTime, quietUntil, shiftDay } from "./time.js";

const modelNudge = z.object({
  trigger_ids: z.array(z.string()).min(1).max(100), kind: nudgeKindSchema, urgency: urgencySchema,
  title: z.string().trim().min(1).max(240), body: z.string().trim().min(1).max(4000),
  suggested_action: z.string().max(1000).nullish(),
  citations: z.array(z.union([z.string(), z.object({ anchor: z.string() })])).max(32),
});
const decisionSchema = z.object({
  decision: z.enum(["push", "digest", "silent"]), nudges: z.array(modelNudge).max(20).default([]),
  follow_ups: z.array(z.object({
    parent_trigger_id: z.string(), fire_at: proactiveInstantSchema, text: z.string().trim().min(1).max(1000),
  })).max(20).default([]),
});
export type Decision = z.infer<typeof decisionSchema>;
export type VerifiedNudge = Omit<z.infer<typeof modelNudge>, "citations"> & { citations: Citation[] };
const sourceTag = /\[src:([^\]]*)\]/g;

async function verify(port: MemoryKernelPort, ref: SpaceRef, snapshot: SnapshotRecord, drafts: Decision["nudges"]) {
  const sources = port.sources(ref);
  const documents = new Set(snapshot.documents);
  const checked = new Map<string, Citation | null>();
  const verified: VerifiedNudge[] = [];
  for (const draft of drafts) {
    const anchors = new Set([
      ...draft.citations.map((c) => (typeof c === "string" ? c : c.anchor).replace(/^\[src:(.*)\]$/, "$1")),
      ...Array.from(draft.body.matchAll(sourceTag), (m) => m[1]),
    ]);
    for (const anchor of anchors) {
      if (checked.has(anchor)) continue;
      const [doc, loc] = anchor.split("#");
      checked.set(anchor, null);
      if (!anchorSchema.safeParse(anchor).success || !documents.has(doc)) continue;
      try {
        const source = await sources.lookup(doc, loc);
        checked.set(anchor, citationSchema.parse({ ...source, raw_excerpt: truncateTokens(source.raw_excerpt ?? "", 160) }));
      } catch (error) {
        if (!(error instanceof ServiceError && error.code === "SOURCE_NOT_FOUND")) throw error;
      }
    }
    const citations = [...anchors].flatMap((a) => checked.get(a) ?? []);
    let body = draft.body.replace(sourceTag, (tag, anchor: string) => checked.get(anchor) ? tag : "").trim();
    if (citations.length && !Array.from(body.matchAll(sourceTag)).length) body += " [src:" + citations[0].anchor + "]";
    verified.push({ ...draft, body, citations });
  }
  return verified;
}

function fitRows<T>(rows: T[], budget: number) {
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

  async decide(ref: SpaceRef, snapshot: SnapshotRecord, policy: ProactivePolicy, ms: number, batch: Trigger[]) {
    const { version } = snapshot;
    const index = await this.port.file(ref, version, "_index.md");
    const subjects = new Set(batch.flatMap((t) => t.payload.subjects));
    const digest = batch.some((t) => t.source_type === "daily_digest");
    const today = localTime(ms, policy.timezone).date;
    const horizon = shiftDay(today, 3);
    const candidates = digest ? await snapshotTimers(this.port, ref, version, policy, ms) : [];
    const upcoming = candidates.filter((t) => t.payload.occurs_on && t.payload.occurs_on >= today &&
      t.payload.occurs_on <= horizon && !this.store.blocked(spaceKey(ref), t, ms, policy.cooldown_hours));
    const agenda = new Map(upcoming.map((t) => [t.payload.item_keys[0], t]));
    for (const item of agenda.values()) item.payload.subjects.forEach((subject) => subjects.add(subject));
    const query = batch.slice(0, 12).map((t) => t.payload.text).join(" ");
    const paths = Object.entries(snapshot.page_titles ?? {}).filter(([, title]) =>
      subjects.has(title) || /约束|偏好|政策|constraint|policy|preference/i.test(title));
    const memory = [];
    let remaining = digest ? 400 : 700;
    for (const [path] of paths) {
      const excerpt = relevantMarkdown(await this.port.file(ref, version, path), query, Math.min(remaining, 350));
      if (excerpt) memory.push(excerpt);
      remaining -= countTokens(excerpt) + 4;
      if (remaining < 40) break;
    }
    const triggers = fitRows(batch.map((t) => ({
      trigger_id: t.trigger_id, source_type: t.source_type, fire_at: t.fire_at, chain_depth: t.chain_depth,
      text: truncateTokens(t.payload.text, 120), anchors: t.payload.anchors.slice(0, 6),
    })), 1000);
    const shown = new Set(triggers.map((t) => t.trigger_id));
    const overflow = Map.groupBy(batch.filter((t) => !shown.has(t.trigger_id)), (t) => "group:" + t.source_type);
    const context = {
      now: iso(ms), timezone: policy.timezone, quiet: quietUntil(ms, policy) > ms,
      total_due: batch.length, triggers,
      trigger_groups: [...overflow].map(([id, group]) => ({
        group_id: id, count: group.length, example: truncateTokens(group[0].payload.text, 50), anchors: group[0].payload.anchors.slice(0, 1),
      })),
      index: trimIndex(index, 240), related_memory: memory,
      upcoming: fitRows([...agenda.values()].map(({ payload: p }) => ({ text: truncateTokens(p.text, 100), anchors: p.anchors.slice(0, 3) })), 300),
      working_state: fitRows(this.store.working(spaceKey(ref), iso(ms - 7 * DAY), iso(ms)), 340),
    };
    // Measure the serialized payload too: escaping Markdown can cost extra tokens.
    while (countTokens(JSON.stringify(context)) > 2500) {
      if (context.related_memory.length) context.related_memory.pop();
      else if (context.working_state.length) context.working_state.pop();
      else if (context.upcoming.length) context.upcoming.pop();
      else { context.index = ""; break; }
    }
    const decision = await this.gateway.structured("fast", this.prompt, context, decisionSchema, zeroUsage());
    const drafts = await verify(this.port, ref, snapshot, decision.decision === "silent" ? [] : decision.nudges);
    for (const draft of drafts) {
      draft.trigger_ids = draft.trigger_ids.flatMap((id) => overflow.get(id)?.map((t) => t.trigger_id) ?? [id]);
    }
    return { decision, agenda: [...agenda.values()], drafts };
  }
}
