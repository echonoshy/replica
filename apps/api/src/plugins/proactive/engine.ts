import type { EvaluateInput, EvaluateResult, ProactivePolicy, SpaceRef } from "@wiki-memory/shared";
import { spaceKey } from "../../db/interfaces.js";
import { ServiceError, errorMessage } from "../../errors.js";
import type { OpenAiGateway } from "../../llm/openai-gateway.js";
import type { EvaluationGate } from "./evaluation-gate.js";
import { Decider } from "./decider.js";
import type { Decision, VerifiedNudge } from "./decider.js";
import type { MemoryKernelPort } from "./kernel.js";
import { activeLedger, controlState, digests, intentionTimer, snapshotTimers } from "./planner.js";
import type { Trigger } from "./planner.js";
import { Store } from "./store.js";
import { iso, localTime } from "./time.js";
import type { EvaluationWindow } from "./guardrails.js";
import { deliveries, eligible, followUps, hasDeliveryBudget } from "./guardrails.js";

const changed = () => new ServiceError(409, "PROACTIVE_STATE_CHANGED", "Space changed during evaluation. Retry against the current state");

export class Engine {
  readonly decider: Decider;
  private polling?: NodeJS.Timeout;
  private pollRun?: Promise<void>;
  private pollQueued = false;
  private readonly evaluations = new Set<Promise<unknown>>();
  private stopping = false;
  constructor(readonly port: MemoryKernelPort, readonly store: Store, gateway: OpenAiGateway,
    private readonly gate: EvaluationGate, readonly clock: () => number, readonly notify: (key: string) => void) {
    this.decider = new Decider(port, store, gateway);
  }

  fence(ref: SpaceRef, version: number, prior: ProactivePolicy, controls?: string) {
    if (controls !== undefined && controls !== controlState(this.port, ref)) throw changed();
    if (this.port.version(ref) !== version || JSON.stringify(this.store.policy(spaceKey(ref))) !== JSON.stringify(prior)) throw changed();
  }
  private async projection(ref: SpaceRef, version: number, policy: ProactivePolicy, ms: number) {
    const [ledger, snapshot] = await Promise.all([
      activeLedger(this.port, ref, version, localTime(ms, policy.timezone).date), this.port.snapshot(ref, version),
    ]);
    const base = await snapshotTimers(this.port, ref, version, policy, ms, ledger);
    const documents = new Set(snapshot?.documents ?? []);
    return (persist: boolean) => {
      const armed = this.store.intentions.project(ref, ledger.intentions, documents, policy.timezone, version, iso(ms), persist);
      const timers = [...base];
      for (const i of armed) {
        const t = intentionTimer(ref, version, i);
        if (t) timers.push(t);
      }
      const itemKeys = new Set(armed.map(i => "intention:" + i.intention_id));
      for (const f of ledger.current) itemKeys.add("redline:" + f.docId + "#" + f.locator);
      for (const ev of ledger.events) itemKeys.add("event:" + ev.docId + "#" + ev.locator);
      return { timers, documents, armed, itemKeys };
    };
  }
  async plan(ref: SpaceRef, version: number, update?: Partial<ProactivePolicy>) {
    const key = spaceKey(ref), ms = this.clock(), now = iso(ms);
    if (version) this.gate.prepare(key);
    const controls = controlState(this.port, ref);
    const prior = this.store.policy(key);
    const policy = { ...prior, ...update };
    const plan = await this.projection(ref, version, policy, ms);
    this.store.connection.transaction(() => {
      this.fence(ref, version, prior, controls);
      if (update) this.store.savePolicy(key, policy, now);
      this.store.reconcile(key, version, plan(true), now);
      this.store.syncDigests(key, digests(ref, version, policy, ms), now);
    });
    return policy;
  }

  evaluate(input: EvaluateInput) {
    return this.track(() => this.run(input));
  }
  withEventGate<T>(input: SpaceRef & { dry_run: boolean }, operation: () => Promise<T>) {
    return this.track(async () => {
      const key = spaceKey(input);
      const release = this.gate.acquire(key, input.dry_run);
      try { this.store.checkAvailable(key); return await operation(); } finally { release(); }
    });
  }
  track<T>(operation: () => Promise<T>) {
    if (this.stopping) throw new ServiceError(503, "SERVICE_STOPPING", "Service is stopping");
    const run = operation();
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
      const controls = controlState(this.port, input);
      const controlled = this.port.telemetry?.(input).size || this.port.aliases?.(input).size;
      const rebuild = this.store.planned(key) !== version || controlled;
      const project = rebuild ? await this.projection(input, version, policy, ms) : undefined;
      this.fence(input, version, policy, controls);
      let plan = dry ? project?.(false) : undefined;
      if (!dry) this.store.connection.transaction(() => {
        this.fence(input, version, policy, controls);
        lease!.check();
        plan = project?.(true);
        if (plan) this.store.reconcile(key, version, plan, now);
        this.store.syncDigests(key, calendar, now);
      });
      const due = dry ? this.store.previewDue(key, version, plan, calendar, now) : this.store.pending(key, now);
      result.triggers_processed = due.length;
      if (!due.length) return result;
      const reasons = new Set<string>();
      const window: EvaluationWindow = { ref: input, version, policy, ms };
      const batch = eligible(this.store, window, due, reasons);
      const budget = batch.length > 0 && hasDeliveryBudget(this.store, window);
      let decision: Decision = { decision: "silent", nudges: [], follow_ups: [], intention_updates: [] };
      let agenda: Trigger[] = [];
      let drafts: VerifiedNudge[] = [];
      const armed = plan?.armed ?? this.store.intentions.armed(key);
      if (budget) {
        const snapshot = await this.port.snapshot(input, version);
        if (!snapshot) throw changed();
        ({ decision, drafts, agenda } = await this.decider.decide(input, snapshot, policy, ms, batch, armed));
      } else if (batch.length) reasons.add("daily_limit");

      // No async work inside this transaction. Recheck every mutable guard after the model returns.
      const finish = () => {
        this.fence(input, version, policy, controls);
        lease?.check();
        if (!dry) {
          const current = new Map(this.store.pending(key, now).map((t) => [t.trigger_id, t]));
          for (const t of due) if (JSON.stringify(current.get(t.trigger_id)) !== JSON.stringify(t)) throw changed();
        }
        const allowed = new Map(eligible(this.store, window, batch, reasons).map((t) => [t.trigger_id, t]));
        const accepted = deliveries(this.store, window, allowed, decision, drafts, agenda, reasons);
        const follow = followUps(window, allowed, decision, reasons);
        if (!dry) {
          this.applyUpdates(input, version, decision, allowed, now);
          for (const { nudge, items } of accepted) this.store.insert(key, nudge, items);
          for (const t of follow) this.store.schedule(key, t, now);
          const deliveredIds = new Set(accepted.flatMap(({ nudge }) => nudge.trigger_ids));
          const followParentIds = new Set(decision.follow_ups.map((f) => f.parent_trigger_id));
          for (const t of due) {
            const consumed = budget && allowed.has(t.trigger_id)
              && (decision.decision === "silent" || deliveredIds.has(t.trigger_id) || followParentIds.has(t.trigger_id));
            this.store.mark(t.trigger_id, consumed ? "done" : "skipped", now);
          }
        }
        result.nudges = accepted.map(({ nudge }) => nudge);
        result.decision_summary = accepted.length ? decision.decision : "silent";
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

  applyUpdates(ref: SpaceRef, version: number, decision: Decision, candidates: ReadonlyMap<string, Trigger>, now: string) {
    const key = spaceKey(ref), updated: string[] = [];
    const ids = new Set(Array.from(candidates.values(), t => t.payload.intention_id));
    for (const { intention_id, status } of decision.intention_updates) {
      if (!ids.delete(intention_id) || this.store.intentions.get(key, intention_id)?.status !== "armed") continue;
      const next = this.store.intentions.update(intention_id, { ...ref, status }, now);
      this.store.syncIntentionTimer(ref, version, intention_id, next, now);
      updated.push(intention_id);
    }
    return updated;
  }

  start(seconds: number) {
    if (!seconds || this.polling) return;
    this.polling = setInterval(() => this.wake(), seconds * 1000).unref();
  }
  wake() {
    if (!this.polling || this.stopping) return;
    if (this.pollRun) {
      this.pollQueued = true;
      return;
    }
    this.pollRun = this.poll().catch((err) => console.error("Proactive poll", errorMessage(err)))
      .finally(() => {
        this.pollRun = undefined;
        if (this.pollQueued && !this.stopping && this.polling) {
          this.pollQueued = false;
          this.wake();
        }
      });
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
