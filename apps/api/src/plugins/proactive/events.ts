import { randomUUID } from "node:crypto";
import type { ProactiveEventInput, ProactiveEventMatch, ProactiveEventResult } from "@wiki-memory/shared";
import { spaceKey } from "../../db/interfaces.js";
import { queryTerms } from "../../db/tokenize.js";
import { ServiceError } from "../../errors.js";
import { cosineSimilarity, inferFactTier, vectorizeSemanticText } from "../../memory/memory-state.js";
import { anchorKey, claimAnchors, claimKey } from "../../pipeline/analyzer.js";
import type { Engine } from "./engine.js";
import { deliveries, eligible, followUps, hasDeliveryBudget } from "./guardrails.js";
import { activeLedger, controlState, timer } from "./planner.js";
import type { Payload, Trigger } from "./planner.js";
import { iso, localTime } from "./time.js";

const stateChange = /取消|改期|已完成|搞定了|推迟|不去了|\b(?:cancel(?:led|ed)?|reschedul(?:e|ed)|done|completed)\b/i;

function matcher(text: string, entities: string[]) {
  const normalized = claimKey(text);
  const terms = new Set(queryTerms(text));
  const vector = vectorizeSemanticText(text);
  return (goal: string, subjects: string[]) => {
    const target = claimKey([goal, ...subjects].join(" "));
    const subject = subjects.some(s => s && normalized.includes(claimKey(s))) ||
      entities.some(e => target.includes(claimKey(e)));
    const tokens = queryTerms(target);
    const common = tokens.filter(t => terms.has(t));
    const lexical = common.length / Math.max(1, Math.min(terms.size, tokens.length));
    const semantic = cosineSimilarity(vector, vectorizeSemanticText(target));
    const matched_by: string[] = [];
    if (subject) matched_by.push("entity");
    if (common.length && (common.length >= 2 || lexical >= 0.4)) matched_by.push("lexical");
    if (semantic >= 0.56) matched_by.push("semantic");
    return { subject, matched_by, score: Math.min(1, (subject ? 0.65 : 0) + lexical * 0.55 + semantic * 0.45) };
  };
}

export class Events {
  constructor(private readonly engine: Engine) {}

  ingest(input: ProactiveEventInput) {
    return this.engine.withEventGate(input, () => this.run(input));
  }
  private async run(input: ProactiveEventInput): Promise<ProactiveEventResult> {
    const { port, store } = this.engine;
    const ref = { namespace: input.namespace, space_id: input.space_id };
    const key = spaceKey(ref), version = port.version(ref), policy = store.policy(key);
    const ms = input.occurred_at ? Date.parse(input.occurred_at) : this.engine.clock();
    const now = iso(ms), day = localTime(ms, policy.timezone).date;
    const event_id = "event_" + randomUUID(), dry = input.dry_run;
    const result: ProactiveEventResult = { event_id, evaluated_at: now, l1_matches: [], llm_called: false,
      decision_summary: "silent", nudges: [], updated_intention_ids: [], suppressed_reasons: [], dry_run: dry };
    const log = () => store.connection.client.prepare(`INSERT INTO proactive_events_log (event_id,space_key,event_type,
      summary,entities_json,occurred_at,l1_match_count,llm_called,decision_summary,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(event_id, key, input.event_type, input.summary, JSON.stringify(input.entities), now, result.l1_matches.length,
        Number(result.llm_called), result.decision_summary, iso(this.engine.clock()));
    const controls = controlState(port, ref);
    const [ledger, snapshot] = await Promise.all([activeLedger(port, ref, version, day), port.snapshot(ref, version)]);
    const docs = new Set(snapshot?.documents ?? []);
    const rebuild = store.planned(key) !== version;
    const armed = rebuild ? store.intentions.project(ref, ledger.intentions, docs, policy.timezone, version, now, false)
      : store.intentions.armed(key);
    const text = [input.summary, ...input.entities, input.event_type.replaceAll("_", " ")].join(" ");
    const match = matcher(port.expandAliases?.(ref, text) ?? text, input.entities);
    const changed = stateChange.test(input.summary);
    const triggers: Trigger[] = [];
    const add = (key: string, payload: Omit<Payload, "item_keys">) => {
      triggers.push(timer(ref, version, "event_trigger", event_id + ":" + key, ms, {
        ...payload, text: input.event_type + ": " + input.summary + "\n" + payload.text, item_keys: [key],
      }));
    };
    const facts = ledger.current.map(f => ({ fact: f, ...match(f.predicate + " " + f.value, [f.subject]) }));
    const upcoming = ledger.events.filter(ev => ev.date >= day).map(ev => {
      const subjects = [...ev.related.map(r => r.subject), ...(ev.event_key ? [ev.event_key] : [])];
      return { ev, subjects, hit: match(ev.text, subjects) };
    });
    const fallback = [...new Set([
      ...facts.filter(f => f.matched_by.length).sort((a, b) => b.score - a.score).flatMap(f => claimAnchors(f.fact).map(anchorKey)),
      ...upcoming.filter(e => e.hit.matched_by.length).map(e => anchorKey(e.ev)),
    ])].slice(0, 6);
    for (const i of armed) {
      const c = i.condition;
      if ((c.not_before && Date.parse(c.not_before) > ms) || (c.deadline && Date.parse(c.deadline) < ms)) continue;
      if (c.match_event_types?.length && !c.match_event_types.includes(input.event_type)) continue;
      const hit = match(i.goal + " " + (c.cue_text ?? ""), i.subjects);
      if (!hit.matched_by.length) continue;
      if (c.match_event_types?.length) hit.matched_by.push("event_type");
      if (changed && hit.subject) hit.matched_by.push("state_change");
      const record: ProactiveEventMatch = { intention_id: i.intention_id, goal: i.goal, kind: i.kind,
        matched_by: hit.matched_by, score: hit.score };
      result.l1_matches.push(record);
      add("intention:" + i.intention_id, { intention_id: i.intention_id, subjects: i.subjects,
        text: i.goal, anchors: i.evidence_anchors.length ? i.evidence_anchors : fallback,
        redline: i.priority === "redline", risk_watch: i.kind === "risk_watch", occurs_on: c.fire_at ?? undefined });
    }
    for (const { fact, matched_by } of facts) {
      if (!matched_by.length || (fact.tier ?? inferFactTier(fact)) !== "pinned_redline") continue;
      add("redline:" + anchorKey(fact), { subjects: [fact.subject], text: fact.predicate + " " + fact.value,
        redline: true, anchors: claimAnchors(fact).map(anchorKey) });
    }
    if (changed) for (const { ev, subjects, hit } of upcoming) {
      if (!hit.subject && !(hit.matched_by.includes("lexical") && hit.matched_by.includes("semantic"))) continue;
      add("event:" + anchorKey(ev), { subjects, text: ev.text, anchors: [anchorKey(ev)], occurs_on: ev.date });
    }
    result.l1_matches.sort((a,b) => b.score-a.score || a.intention_id.localeCompare(b.intention_id));
    const reasons = new Set<string>();
    const window = { ref, version, policy, ms };
    const batch = eligible(store, window, triggers, reasons);
    const matchedIds = new Set(result.l1_matches.map(i => i.intention_id));
    const matched = armed.filter(i => matchedIds.has(i.intention_id));
    // A pending projection can introduce or revive a row. Fence its stored revision
    // before applying that projection, and its evaluated revision afterwards.
    const priorRevisions = rebuild ? matched.map(i => ({
      id: i.intention_id, updatedAt: store.intentions.get(key, i.intention_id)?.updated_at,
    })) : [];
    let evaluation: Awaited<ReturnType<Engine["decider"]["decide"]>> | undefined;
    if (!triggers.length) reasons.add("no_l1_match");
    else if (!policy.enabled) reasons.add("policy_disabled");
    else if (!hasDeliveryBudget(store, window)) reasons.add("daily_limit");
    else if (batch.length) {
      result.llm_called = true;
      evaluation = await this.engine.decider.decide(ref, snapshot ?? { version, documents: [] }, policy, ms, batch, matched);
    }

    const finish = () => {
      this.engine.fence(ref, version, policy, controls);
      if (evaluation) {
        const intentionChanged = () => new ServiceError(409, "PROACTIVE_STATE_CHANGED", "A matched intention changed during evaluation");
        for (const { id, updatedAt } of priorRevisions) {
          if (store.intentions.get(key, id)?.updated_at !== updatedAt) throw intentionChanged();
        }
        const current = rebuild ? store.intentions.project(ref, ledger.intentions, docs, policy.timezone, version, now, !dry)
          : store.intentions.armed(key);
        const revisions = new Map(current.map(i => [i.intention_id, i.updated_at]));
        for (const i of matched) {
          if (revisions.get(i.intention_id) !== i.updated_at) throw intentionChanged();
        }
        const available = eligible(store, window, batch, reasons);
        const parents = new Map(available.map(t => [t.trigger_id, t]));
        const { decision, drafts, agenda } = evaluation;
        const accepted = deliveries(store, window, parents, decision, drafts, agenda, reasons);
        result.nudges = accepted.map(item => item.nudge);
        result.decision_summary = accepted.length ? decision.decision : "silent";
        if (!dry) {
          result.updated_intention_ids = this.engine.applyUpdates(ref, version, decision, parents, now);
          for (const { nudge, items } of accepted) store.insert(key, nudge, items);
          for (const t of followUps(window, parents, decision, reasons)) store.schedule(key, t, now);
        }
      }
      result.suppressed_reasons = [...reasons];
      if (!dry) log();
    };
    if (dry) finish();
    else {
      store.connection.transaction(finish);
      if (result.nudges.length) this.engine.notify(key);
    }
    return result;
  }
}
