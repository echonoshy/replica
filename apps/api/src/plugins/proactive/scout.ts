import { z } from "zod";
import { scoutFindingSchema } from "@wiki-memory/shared";
import type { ProspectiveIntention, ScoutFinding, ScoutRequest, ScoutResult } from "@wiki-memory/shared";
import { spaceKey, zeroUsage } from "../../db/interfaces.js";
import { queryTerms } from "../../db/tokenize.js";
import type { OpenAiGateway } from "../../llm/openai-gateway.js";
import { prompts } from "../../llm/prompts.js";
import { claimKey } from "../../pipeline/analyzer.js";
import { truncateTokens } from "../../retrieval/token-budget.js";
import { resolveCitation, fitRows } from "./decider.js";
import type { Engine } from "./engine.js";
import { activeLedger, controlState } from "./planner.js";
import { iso, localTime } from "./time.js";

// The offline prompt labels the reason for a finding. The API exposes the
// prospective intention that handles it, and also accepts enriched model output.
const promptFinding = z.object({
  kind: z.enum(["schedule_collision", "redline_conflict", "stale_open_loop"]),
  fire_at: scoutFindingSchema.shape.fire_at, deadline: scoutFindingSchema.shape.deadline, subjects: scoutFindingSchema.shape.subjects,
  summary: z.string().trim().min(1).max(1000), citations: z.array(z.string()).min(1).max(12),
}).transform((f): ScoutFinding => ({
  kind: f.kind === "stale_open_loop" ? "open_loop" : "risk_watch",
  priority: f.kind === "redline_conflict" ? "redline" : "high",
  title: f.summary.slice(0, 240), goal: f.summary, rationale: f.summary, subjects: f.subjects, evidence_anchors: f.citations,
  fire_at: f.fire_at, deadline: f.deadline,
}));
const scoutModelSchema = z.object({ findings: z.array(z.union([scoutFindingSchema, promptFinding])).max(100) });

type Existing = Pick<ProspectiveIntention, "kind" | "goal" | "subjects" | "evidence_anchors" | "condition">;
function covered(f: ScoutFinding, candidates: Existing[]) {
  const terms = queryTerms(f.goal);
  return candidates.some(i => {
    const time = f.fire_at ?? f.deadline, priorTime = i.condition.fire_at ?? i.condition.deadline;
    if (time && priorTime && Date.parse(time) !== Date.parse(priorTime)) return false;
    if (claimKey(i.goal) === claimKey(f.goal)) return true;
    if (i.kind !== f.kind) return false;
    const other = new Set(queryTerms(i.goal));
    const overlap = terms.filter(t => other.has(t)).length / Math.max(1, new Set([...terms, ...other]).size);
    const evidence = i.evidence_anchors.some(a => f.evidence_anchors.includes(a));
    const subject = i.subjects.some(s => f.subjects.some(t => claimKey(s) === claimKey(t)));
    if (subject && time && priorTime && evidence) return true;
    return overlap >= 0.75 || (overlap >= 0.4 && (subject || evidence));
  });
}

export async function scout(engine: Engine, gateway: OpenAiGateway, input: ScoutRequest): Promise<ScoutResult> {
  const { port, store } = engine;
  const ref = { namespace: input.namespace, space_id: input.space_id }, key = spaceKey(ref);
  const version = port.version(ref), ms = input.now ? Date.parse(input.now) : engine.clock(), now = iso(ms);
  const result: ScoutResult = { scouted_at: now, snapshot_version: version, findings: [], created_intentions: [], dry_run: input.dry_run };
  if (!version) return result;
  const policy = store.policy(key), day = localTime(ms, policy.timezone).date;
  const controls = controlState(port, ref);
  const [snapshot, ledger, timeline] = await Promise.all([
    port.snapshot(ref, version), activeLedger(port, ref, version, day), port.file(ref, version, "timeline.md"),
  ]);
  const documents = new Set(snapshot?.documents ?? []);
  const armed = store.intentions.project(ref, ledger.intentions, documents, policy.timezone, version, now, false);
  const core = port.memoryState?.buildCoreProfileCard(key, ledger.current, day);
  const { findings } = await gateway.structured("fast", prompts.proactiveScout, {
    now, timezone: policy.timezone, timeline: truncateTokens(timeline, 1600),
    active_facts: fitRows(ledger.current.map(({ subject, predicate, value, tier, docId, locator }) =>
      ({ subject, predicate, value, tier, anchor: docId + "#" + locator })), 2200),
    core_card: truncateTokens(core ?? "", 800), rules: fitRows(ledger.rules, 700), existing_intentions: fitRows(armed, 1400),
  }, scoutModelSchema, zeroUsage());
  const sources = port.sources(ref);
  const grounded = new Map<string, boolean>();
  const valid: ScoutFinding[] = [];
  for (const f of findings) {
    const anchors = [...new Set(f.evidence_anchors.map(a => a.replace(/^\[src:(.*)\]$/, "$1")))];
    for (const a of anchors) if (!grounded.has(a)) grounded.set(a, !!await resolveCitation(sources, documents, a));
    if (anchors.every(a => grounded.get(a))) valid.push({ ...f, evidence_anchors: anchors });
  }
  const finish = () => {
    engine.fence(ref, version, policy, controls);
    const existing: Existing[] = store.intentions.project(ref, ledger.intentions, documents, policy.timezone, version, now, false);
    const history = store.intentions.scoutFindings(key);
    const anchorSetKey = (anchors: string[]) => JSON.stringify([...new Set(anchors)].sort());
    const goals = new Set(history.map(i => claimKey(i.goal)));
    const evidence = new Set(history.map(i => anchorSetKey(i.evidence_anchors)));
    for (const f of valid) {
      const goal = claimKey(f.goal), anchors = anchorSetKey(f.evidence_anchors);
      if (goals.has(goal) || evidence.has(anchors) || covered(f, existing)) continue;
      goals.add(goal);
      evidence.add(anchors);
      result.findings.push(f);
      existing.push({ ...f, condition: { fire_at: f.fire_at, deadline: f.deadline } });
      if (input.dry_run) continue;
      const intention = store.intentions.create({ ...ref, kind: f.kind, goal: f.goal, subjects: f.subjects,
        priority: f.priority, source: "scout", evidence_anchors: f.evidence_anchors,
        condition: { fire_at: f.fire_at, deadline: f.deadline } }, now, version);
      store.syncIntentionTimer(ref, version, intention.intention_id, intention, now);
      result.created_intentions.push(intention);
    }
  };
  if (input.dry_run) finish();
  else store.connection.transaction(finish);
  return result;
}
