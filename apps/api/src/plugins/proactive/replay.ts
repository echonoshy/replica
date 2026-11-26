import type { ReplayRequest, ReplayResult, ReplayStepResult } from "@wiki-memory/shared";
import { ServiceError } from "../../errors.js";
import { resolveCitation } from "./decider.js";
import type { Engine } from "./engine.js";
import type { Events } from "./events.js";

export async function replay(engine: Engine, events: Events, input: ReplayRequest): Promise<ReplayResult> {
  const ref = { namespace: input.namespace, space_id: input.space_id };
  const version = engine.port.version(ref);
  const snapshot = await engine.port.snapshot(ref, version);
  const documents = new Set(snapshot?.documents ?? []);
  const sources = engine.port.sources(ref);
  const checked = new Map<string, boolean>();
  const rows: ReplayStepResult[] = [];
  const criticalRows: ReplayStepResult[] = [];
  for (const step of [...input.steps].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (step.kind === "event" && !step.event) throw new ServiceError(400, "VALIDATION_ERROR", "An event step requires an event");
    const result = step.kind === "event"
      ? await events.ingest({ ...ref, ...step.event!, occurred_at: step.at, dry_run: true })
      : await engine.evaluate({ ...ref, now: step.at, dry_run: true });
    if (engine.port.version(ref) !== version) throw new ServiceError(409, "SNAPSHOT_CHANGED", "Snapshot changed during replay");
    const actual = result.decision_summary, expected = step.expected_decision;
    let hits = 0, count = 0;
    for (const nudge of result.nudges) for (const { anchor } of nudge.citations) {
      if (!checked.has(anchor)) checked.set(anchor, !!await resolveCitation(sources, documents, anchor));
      count++;
      if (checked.get(anchor)) hits++;
    }
    const row = { step_id: step.step_id, at: step.at, expected_decision: expected ?? null, actual_decision: actual,
      matched: expected === undefined ? null : expected === actual, nudge_count: result.nudges.length,
      grounded_citations: hits, total_citations: count, suppressed_reasons: result.suppressed_reasons };
    rows.push(row);
    if (step.critical && expected !== "silent") criticalRows.push(row);
  }
  const rate = (correct: number, denominator: number) => denominator ? correct / denominator : 1;
  const pushed = (row: ReplayStepResult) => row.actual_decision !== "silent";
  const pushes = rows.filter(r => pushed(r) && r.expected_decision !== null);
  const silent = rows.filter(r => r.expected_decision === "silent");
  return {
    space: ref, total_steps: rows.length, steps: rows,
    push_precision: rate(pushes.filter(r => r.expected_decision !== "silent").length, pushes.length),
    critical_recall: rate(criticalRows.filter(pushed).length, criticalRows.length),
    silence_accuracy: rate(silent.filter(r => !pushed(r)).length, silent.length),
    citation_grounding_rate: rate(rows.reduce((sum, r) => sum + r.grounded_citations, 0),
      rows.reduce((sum, r) => sum + r.total_citations, 0)),
  };
}
