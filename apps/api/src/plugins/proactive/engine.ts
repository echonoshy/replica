import type { EvaluateInput, EvaluateResult, ProactivePolicy, SpaceRef } from "@replica/shared";
import { spaceKey } from "../../db/interfaces.js";
import { ServiceError, errorMessage } from "../../errors.js";
import type { OpenAiGateway } from "../../llm/openai-gateway.js";
import type { EvaluationGate } from "./evaluation-gate.js";
import { Decider } from "./decider.js";
import type { Decision, VerifiedNudge } from "./decider.js";
import type { MemoryKernelPort } from "./kernel.js";
import { digests, snapshotTimers } from "./planner.js";
import type { Trigger } from "./planner.js";
import { Store } from "./store.js";
import { iso } from "./time.js";
import { deliveries, eligible, followUps, hasDeliveryBudget } from "./guardrails.js";

const changed = () => new ServiceError(409, "PROACTIVE_STATE_CHANGED", "Space changed during evaluation. Retry against the current state");

export class Engine {
  readonly decider: Decider;
  private polling?: NodeJS.Timeout;
  private pollRun?: Promise<void>;
  private readonly evaluations = new Set<Promise<EvaluateResult>>();
  private stopping = false;
  constructor(readonly port: MemoryKernelPort, readonly store: Store, gateway: OpenAiGateway,
    private readonly gate: EvaluationGate, readonly clock: () => number, readonly notify: (key: string) => void) {
    this.decider = new Decider(port, store, gateway);
  }

  private fence(ref: SpaceRef, version: number, prior: ProactivePolicy) {
    if (this.port.version(ref) !== version || JSON.stringify(this.store.policy(spaceKey(ref))) !== JSON.stringify(prior)) throw changed();
  }
  private async projection(ref: SpaceRef, version: number, policy: ProactivePolicy, ms: number) {
    const [timers, snapshot] = await Promise.all([
      snapshotTimers(this.port, ref, version, policy, ms), this.port.snapshot(ref, version),
    ]);
    return { timers, documents: new Set(snapshot?.documents ?? []) };
  }
  async plan(ref: SpaceRef, version: number, update?: Partial<ProactivePolicy>) {
    const key = spaceKey(ref), ms = this.clock(), now = iso(ms);
    if (version) this.gate.prepare(key);
    const prior = this.store.policy(key);
    const policy = { ...prior, ...update };
    const plan = await this.projection(ref, version, policy, ms);
    this.store.connection.transaction(() => {
      this.fence(ref, version, prior);
      if (update) this.store.savePolicy(key, policy, now);
      this.store.reconcile(key, version, plan, now);
      this.store.syncDigests(key, digests(ref, version, policy, ms), now);
    });
    return policy;
  }

  evaluate(input: EvaluateInput) {
    if (this.stopping) throw new ServiceError(503, "SERVICE_STOPPING", "Service is stopping");
    const run = this.run(input);
    this.evaluations.add(run);
    return run.finally(() => this.evaluations.delete(run));
  }
  private async run(input: EvaluateInput): Promise<EvaluateResult> {
    const key = spaceKey(input), version = this.port.version(input);
    const policy = this.store.policy(key), dry = input.dry_run;
    const ms = input.now ? Date.parse(input.now) : this.clock(), now = iso(ms);
    const result: EvaluateResult = {
      evaluated_at: now, triggers_processed: 0, decision_summary: "silent", nudges: [], suppressed_reasons: [], dry_run: dry,
    };
    if (!version || !policy.enabled) return result;
    const releaseGate = this.gate.acquire(key, dry);
    let lease: ReturnType<Store["lease"]> | undefined;
    try {
      if (dry) this.store.checkAvailable(key);
      else lease = this.store.lease(key);
      const calendar = digests(input, version, policy, ms);
      const rebuild = this.store.planned(key) !== version;
      const plan = rebuild ? await this.projection(input, version, policy, ms) : undefined;
      this.fence(input, version, policy);
      if (!dry) this.store.connection.transaction(() => {
        this.fence(input, version, policy);
        lease!.check();
        if (plan) this.store.reconcile(key, version, plan, now);
        this.store.syncDigests(key, calendar, now);
      });
      const due = dry ? this.store.previewDue(key, version, plan, calendar, now) : this.store.pending(key, now);
      result.triggers_processed = due.length;
      if (!due.length) return result;
      const reasons = new Set<string>();
      const window = { ref: input, version, policy, ms };
      const batch = eligible(this.store, window, due, reasons);
      const budget = batch.length > 0 && hasDeliveryBudget(this.store, window);
      let decision: Decision = { decision: "silent", nudges: [], follow_ups: [] };
      let agenda: Trigger[] = [];
      let drafts: VerifiedNudge[] = [];
      if (budget) {
        const snapshot = await this.port.snapshot(input, version);
        if (!snapshot) throw changed();
        ({ decision, drafts, agenda } = await this.decider.decide(input, snapshot, policy, ms, batch));
      } else if (batch.length) reasons.add("daily_limit");

      // No async work inside this transaction. Recheck every mutable guard after the model returns.
      const finish = () => {
        this.fence(input, version, policy);
        lease?.check();
        if (!dry) {
          const current = new Map(this.store.pending(key, now).map((t) => [t.trigger_id, t]));
          for (const t of due) if (current.get(t.trigger_id)?.fire_at !== t.fire_at) throw changed();
        }
        const allowed = new Map(eligible(this.store, window, batch, reasons).map((t) => [t.trigger_id, t]));
        const accepted = deliveries(this.store, window, allowed, decision, drafts, agenda, reasons);
        const follow = followUps(window, allowed, decision, reasons);
        if (!dry) {
          for (const { nudge, items } of accepted) this.store.insert(key, nudge, items);
          for (const t of follow) this.store.schedule(key, t, now);
          for (const t of due) this.store.mark(t.trigger_id, budget && allowed.has(t.trigger_id) ? "done" : "skipped", now);
        }
        result.nudges = accepted.map(({ nudge }) => nudge);
        result.decision_summary = decision.decision;
        result.suppressed_reasons = [...reasons];
      };
      if (dry) finish();
      else {
        this.store.connection.transaction(finish);
        if (result.nudges.length) this.notify(key);
      }
      return result;
    } finally {
      try { lease?.release(); } finally { releaseGate(); }
    }
  }

  start(seconds: number) {
    if (!seconds || this.polling) return;
    this.polling = setInterval(() => {
      if (!this.pollRun) this.pollRun = this.poll().catch((err) => console.error("Proactive poll", errorMessage(err)))
        .finally(() => { this.pollRun = undefined; });
    }, seconds * 1000).unref();
  }
  private async poll() {
    for (const ref of this.port.spaces()) {
      if (this.stopping) break;
      try {
        const key = spaceKey(ref), version = this.port.version(ref), policy = this.store.policy(key);
        if (!version || !policy.enabled) continue;
        const ms = this.clock();
        if (this.store.planned(key) !== version || this.store.hasDue(key, iso(ms)) ||
          digests(ref, version, policy, ms).some((t) => !this.store.status(key, t.dedup_key))) {
          await this.evaluate({ ...ref, dry_run: false });
        }
      } catch (error) {
        if (!(error instanceof ServiceError && error.status === 409)) console.error("Proactive evaluation", spaceKey(ref), errorMessage(error));
      }
    }
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.polling);
    await this.pollRun;
    await Promise.allSettled(this.evaluations);
  }
}
