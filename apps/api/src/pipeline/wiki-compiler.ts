import { createHash } from "node:crypto";
import { findAnchors, INDEX_MAX_BYTES } from "@wiki-memory/shared";
import type { Space } from "@wiki-memory/shared";
import type { WikiDraft } from "../db/interfaces.js";
import { indexText } from "../db/tokenize.js";
import { factStorageKey, factTelemetry, inferFactTier } from "../memory/memory-state.js";
import type { FactTelemetryRecord } from "../memory/memory-state.js";
import { anchorKey, claimAnchors, claimKey, claimSource, isIntention, isFact, isRule } from "./analyzer.js";
import type { Claim, Fact, IntentionClaim, ProceduralRuleClaim, Relation, TimelineEvent } from "./analyzer.js";
import { clipBytes, inline, markdownAst, plainText, readPage, relativeWikiLink, renderPage, walk, wikiLinkTarget } from "./wiki-markdown.js";

type FactClaim = Extract<Claim, Fact>;
export type ReconcileOptions = { aliases?: Map<string, string>; telemetry?: Map<string, FactTelemetryRecord>; asOfDate?: string };
type CompileOptions = ReconcileOptions & { aliasGroups?: Map<string, string[]>; correctedAnchors?: string[] };
type Page = { kind: Relation["kind"]; subject: string; facts: FactClaim[] };
export type RequiredLine = { path: string | null; kind?: Relation["kind"]; line: string };
export const EMPTY_TIMELINE = "暂无带明确日期的事件。";
export const EMPTY_CONFLICTS = "暂无冲突或修订记录。";

const relationKey = (subject: Relation) => `${subject.kind}:${claimKey(subject.subject)}`;
const slotKey = (fact: FactClaim) => `${relationKey(fact)}:${claimKey(fact.predicate)}`;
const valueKey = (fact: FactClaim) => claimKey(fact.value);

function canonicalizeClaim(claim: Claim, aliases?: Map<string, string>): Claim {
  if (!aliases?.size || isRule(claim) || isIntention(claim)) return claim;
  const subject = isFact(claim) ? aliases.get(relationKey(claim)) : undefined;
  const related = claim.related.map((relation) => {
    const canonical = aliases.get(relationKey(relation));
    return canonical && canonical !== relation.subject ? { ...relation, subject: canonical } : relation;
  });
  if (isFact(claim) && subject && subject !== claim.subject) return { ...claim, subject, related };
  return related.some((relation, i) => relation !== claim.related[i]) ? { ...claim, related } : claim;
}

// A permanent subject rewrite changes the storage key. Keep earlier keys on the ledger
// so a recompile can still find controls and recall history recorded before the merge.
export function retainTelemetryKey(original: FactClaim, rewritten: FactClaim): FactClaim {
  return { ...rewritten, previous_fact_keys: [...new Set([factStorageKey(original), ...(original.previous_fact_keys ?? [])])] };
}

export function rewriteSubjectInClaims(
  claims: Claim[], kind: Relation["kind"], sourceSubjects: string[], targetSubject: string,
): { claims: Claim[]; changed: number } {
  const aliases = new Map(sourceSubjects.map((source) => [relationKey({ kind, subject: source }), targetSubject]));
  let changed = 0;
  const rewritten = claims.map((claim) => {
    let next = canonicalizeClaim(claim, aliases);
    if (isFact(claim) && isFact(next)) {
      if (claim.subject !== next.subject) {
        next = retainTelemetryKey(claim, next);
      }
      if (claim.merged_from?.length) {
        const atoms = rewriteSubjectInClaims(claim.merged_from, kind, sourceSubjects, targetSubject);
        if (atoms.changed) next = { ...next, merged_from: atoms.claims.filter(isFact) };
      }
    }
    if (next !== claim) changed++;
    return next;
  });
  return { claims: rewritten, changed };
}

export { factTelemetry };

function effectiveClaim(original: Claim, options: ReconcileOptions) {
  const claim = canonicalizeClaim(original, options.aliases);
  if (!isFact(original) || !isFact(claim)) return claim;
  const tel = factTelemetry(original, options.telemetry);
  if (!tel) return claim;
  return {
    ...claim, value: tel.edited_value ?? claim.value,
    ...(tel.tier_override ? { tier: tel.tier_override } : {}),
    ...(tel.scope_override ? { scope: tel.scope_override } : {}),
    ...(tel.archived_reason && !claim.archived ? { archived: { reason: tel.archived_reason, archived_at: tel.updated_at } } : {}),
    ...(tel.pinned ? { pinned: true, tier: "pinned_redline" as const } : {}),
  };
}

export function vocabularyOf(claims: Claim[], contextText = "", limit = 300) {
  const context = claimKey(contextText);
  const today = new Date().toISOString().slice(0, 10);
  const activeFacts = new Set<Claim>(reconcile(claims, today).current);
  const subjects = new Map<string, number>();
  const slots = new Map<string, {
    vocabulary: Pick<Fact, "kind" | "subject" | "predicate">;
    subjectKey: string; mentioned: boolean; active: boolean; count: number; lastSeen: number;
  }>();
  for (const [lastSeen, claim] of claims.entries()) {
    if (!isFact(claim)) continue;
    const subjectKey = relationKey(claim);
    const key = slotKey(claim);
    const existing = slots.get(key);
    subjects.set(subjectKey, (subjects.get(subjectKey) ?? 0) + 1);
    slots.set(key, {
      vocabulary: { kind: claim.kind, subject: claim.subject, predicate: claim.predicate },
      subjectKey, mentioned: existing?.mentioned ?? context.includes(claimKey(claim.subject)),
      active: !!existing?.active || activeFacts.has(claim),
      count: (existing?.count ?? 0) + 1, lastSeen,
    });
  }
  const core = (slot: { subjectKey: string; count: number }) => slot.count >= 2 || subjects.get(slot.subjectKey)! >= 2;
  return [...slots.values()].sort((a, b) => Number(b.mentioned) - Number(a.mentioned)
    || Number(b.active) - Number(a.active) || Number(core(b)) - Number(core(a)) || b.lastSeen - a.lastSeen)
    .slice(0, Math.max(0, limit)).map(({ vocabulary }) => vocabulary);
}

export function claimIdentity(claim: Claim) {
  if (isIntention(claim)) return JSON.stringify(["intention", claim.intention_id]);
  if (isRule(claim)) return JSON.stringify([claim.docId, claim.locator, "rule", claimKey(claim.trigger_context), claimKey(claim.instruction)]);
  return isFact(claim)
    ? JSON.stringify([claim.docId, claim.locator, slotKey(claim), valueKey(claim), claim.valid_from, claim.valid_to])
    : JSON.stringify([claim.docId, claim.locator, claim.date, claimKey(claim.text)]);
}

function compact(claims: Claim[]) {
  return [...new Map(claims.map((claim) => [claimIdentity(claim), claim])).values()];
}

function explicitTarget(replacement: FactClaim, previous: FactClaim) {
  const revision = replacement.revision;
  return revision?.explicit && (revision.previous_value || revision.previous_date)
    && (!revision.previous_value || claimKey(revision.previous_value) === valueKey(previous))
    && (!revision.previous_date || revision.previous_date === previous.docDate);
}

function datedEvidence(claim: FactClaim) {
  return `“${inline(claim.value)}”（${claim.docDate}） ${claimSource(claim)}`;
}

const effectiveValue = (fact: FactClaim) => valueKey(fact).replace(/^[。，、；：！？.,;:!?"'“”‘’（）()\s]+|[。，、；：！？.,;:!?"'“”‘’（）()\s]+$/gu, "")
  || valueKey(fact);

export const compareFactSource = (a: FactClaim, b: FactClaim) =>
  a.docDate.localeCompare(b.docDate) || a.docId.localeCompare(b.docId)
  || a.locator.localeCompare(b.locator, undefined, { numeric: true });

type EventClaim = Extract<Claim, TimelineEvent>;

function eventTextTokens(text: string) {
  return new Set((indexText(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => [...t].length > 1));
}

function eventsRelated(a: EventClaim, b: EventClaim) {
  if (a.event_key && b.event_key && claimKey(a.event_key) === claimKey(b.event_key)) return true;
  const aSubjects = new Set(a.related.map((r) => claimKey(r.subject)));
  const bSubjects = new Set(b.related.map((r) => claimKey(r.subject)));
  const sharesSubject = [...aSubjects].some((s) => bSubjects.has(s));
  const aTokens = eventTextTokens(a.text);
  const bTokens = eventTextTokens(b.text);
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap++;
  const denom = Math.max(1, Math.min(aTokens.size, bTokens.size));
  return (sharesSubject && overlap >= 2) || overlap / denom >= 0.5;
}

const compareEventSource = (a: EventClaim, b: EventClaim) =>
  a.docDate.localeCompare(b.docDate) || a.docId.localeCompare(b.docId)
  || a.locator.localeCompare(b.locator, undefined, { numeric: true });

export function reconcile(claims: Claim[], today: string, options: ReconcileOptions = {}) {
  const effectiveDate = options.asOfDate ?? today;
  const intentions = new Map<string, IntentionClaim>();
  const rules = new Map<string, ProceduralRuleClaim>();
  const factGroups = new Map<string, FactClaim[]>();
  const explicitManyRevisions: FactClaim[] = [];
  const rawEvents: EventClaim[] = [];
  const audit = new Set<string>();
  const originalByFact = new Map<FactClaim, FactClaim>();
  for (const original of claims) {
    const claim = effectiveClaim(original, options);
    if (isIntention(claim)) {
      if (options.asOfDate && claim.docDate > effectiveDate) continue;
      if (claim.archived) intentions.delete(claim.intention_id);
      else intentions.set(claim.intention_id, claim);
      continue;
    }
    if (isRule(claim)) {
      if (claim.archived) {
        audit.add(`- **行为准则 · ${inline(claim.trigger_context)}** · 梦境归档（${inline(claim.archived.reason)}） · ${inline(claim.instruction)} ${claimSource(claim)}`);
      } else {
        const key = JSON.stringify([claimKey(claim.trigger_context), claimKey(claim.instruction)]);
        const prior = rules.get(key);
        if (!prior) rules.set(key, claim);
        else {
          const latest = prior.docDate > claim.docDate ? prior : claim;
          const anchors = new Map([...claimAnchors(prior), ...claimAnchors(claim)].map((a) => [anchorKey(a), a]));
          anchors.delete(anchorKey(latest));
          rules.set(key, { ...latest, extra_sources: [...anchors.values()] });
        }
      }
      continue;
    }
    if (!isFact(claim)) {
      if (claim.archived) {
        audit.add(`- **${claim.date} · 时间线事件** · 梦境归档（${inline(claim.archived.reason)}） · “${inline(claim.text)}”（${claim.docDate}） ${claimSource(claim)}`);
        continue;
      }
      rawEvents.push(claim);
      continue;
    }
    if (options.asOfDate && claim.docDate > effectiveDate) continue;
    for (const edit of claim.corrections ?? []) {
      const sources = edit.sources.map((source) => `[src:${anchorKey(source)}]`).join(" ");
      audit.add(`- **${inline(edit.subject)} · ${inline(edit.predicate)}** · 梦境纠错（${inline(edit.reason)}） · “${inline(edit.old_value)}” → “${inline(edit.new_value)}” ${sources}`);
    }
    if (claim.archived) {
      const label = original.archived ? "梦境归档" : "用户归档";
      audit.add(`- **${inline(claim.subject)} · ${inline(claim.predicate)}** · ${label}（${inline(claim.archived.reason)}） · ${datedEvidence(claim)}`);
    }
    if ((claim.valid_to && claim.valid_to < effectiveDate) || (claim.valid_from && claim.valid_from > effectiveDate)) continue;
    if (isFact(original)) originalByFact.set(claim, original);
    if (claim.cardinality === "many" && claim.revision?.explicit) {
      explicitManyRevisions.push(claim);
    }
    // An archived revision still supersedes its predecessors.
    const key = JSON.stringify([slotKey(claim), claim.cardinality === "many" && !claim.revision?.explicit ? effectiveValue(claim) : null]);
    const group = factGroups.get(key);
    if (group) group.push(claim);
    else factGroups.set(key, [claim]);
  }
  const current: FactClaim[] = [];
  for (const group of factGroups.values()) {
    group.sort(compareFactSource);
    const dates = Map.groupBy(group, (fact) => fact.docDate);
    let active: FactClaim[] = [];
    for (const atDate of dates.values()) {
      const byValue = new Map(atDate.map((fact) => [valueKey(fact), fact]));
      const values = [...byValue.values()].sort(compareFactSource);
      const candidates = values.filter((fact) => !values.some((other) => other !== fact && explicitTarget(other, fact)));
      const revisions = candidates.filter((fact) => fact.revision?.explicit);
      let next = revisions.length === 1 ? revisions : candidates.length ? candidates : values;
      if (next.length > 1 && !next.some((fact) => fact.revision?.explicit)) {
        next = [...new Map(next.map((fact) => [effectiveValue(fact), fact])).values()];
      }
      const nextValues = new Set(next.map(valueKey));
      const replaced = active.filter((fact) => !nextValues.has(valueKey(fact)));
      for (const fact of values) {
        if (!nextValues.has(valueKey(fact))) replaced.push(fact);
      }
      const label = `${inline(next[0].subject)} · ${inline(next[0].predicate)}`;
      if (next.length === 1) {
        for (const previous of replaced) {
          if (!next[0].revision?.explicit && effectiveValue(previous) === effectiveValue(next[0])) continue;
          const rule = next[0].revision?.explicit ? "显式修订" : "较新文档";
          audit.add(`- **${label}** · ${rule} · ${datedEvidence(next[0])} · supersedes: ${datedEvidence(previous)}`);
        }
      } else {
        const evidence = [...next, ...replaced].map(datedEvidence).join(" / ");
        audit.add(`- **${label}** · 同日冲突，待确认 · ${evidence}`);
      }
      active = next;
    }
    current.push(...active.filter((fact) => !fact.archived && (!fact.expires_on || fact.expires_on >= effectiveDate)));
  }
  // Allow an explicit revision on a cardinality:"many" slot to supersede its targeted previous member.
  const supersededMany = new Set<FactClaim>();
  for (const replacement of explicitManyRevisions) {
    for (const candidate of current) {
      if (candidate === replacement || slotKey(candidate) !== slotKey(replacement)) continue;
      if (explicitTarget(replacement, candidate) && compareFactSource(candidate, replacement) <= 0) {
        supersededMany.add(candidate);
        const label = `${inline(replacement.subject)} · ${inline(replacement.predicate)}`;
        audit.add(`- **${label}** · 显式修订 · ${datedEvidence(replacement)} · supersedes: ${datedEvidence(candidate)}`);
      }
    }
  }
  const activeFacts = supersededMany.size ? current.filter((fact) => !supersededMany.has(fact)) : current;

  // Event state machine: reconcile planned / rescheduled / cancelled / completed transitions
  // so superseded dates exit active timeline.md and proactive scheduling immediately.
  rawEvents.sort(compareEventSource);
  const activeEvents: EventClaim[] = [];
  for (const ev of rawEvents) {
    const status = ev.status ?? "planned";
    const evLabel = inline(ev.event_key || ev.text);
    const matchesPrior = (prev: EventClaim) => {
      if (ev.event_key && prev.event_key && claimKey(ev.event_key) === claimKey(prev.event_key)) return true;
      if (ev.previous_date && prev.date === ev.previous_date && eventsRelated(prev, ev)) return true;
      if ((status === "cancelled" || status === "completed") && prev.date === ev.date && eventsRelated(prev, ev)) return true;
      return prev.date === ev.date && claimKey(prev.text) === claimKey(ev.text);
    };
    const retired: EventClaim[] = [];
    for (let i = activeEvents.length - 1; i >= 0; i--) {
      if (matchesPrior(activeEvents[i])) {
        retired.push(activeEvents[i]);
        activeEvents.splice(i, 1);
      }
    }
    if (status === "cancelled") {
      if (retired.length) {
        for (const prev of retired) {
          audit.add(`- **${evLabel}** · 事件取消 · “${ev.date} ${inline(ev.text)}”（${ev.docDate}） ${claimSource(ev)} · supersedes: “${prev.date} ${inline(prev.text)}”（${prev.docDate}） ${claimSource(prev)}`);
        }
      } else {
        audit.add(`- **${evLabel}** · 事件取消 · “${ev.date} ${inline(ev.text)}”（${ev.docDate}） ${claimSource(ev)}`);
      }
      continue;
    }
    if (status === "rescheduled") {
      for (const prev of retired) {
        if (prev.date !== ev.date || claimKey(prev.text) !== claimKey(ev.text)) {
          audit.add(`- **${evLabel}** · 事件改期 · “${ev.date} ${inline(ev.text)}”（${ev.docDate}） ${claimSource(ev)} · supersedes: “${prev.date} ${inline(prev.text)}”（${prev.docDate}） ${claimSource(prev)}`);
        }
      }
      activeEvents.push(ev);
      continue;
    }
    if (status === "completed") {
      for (const prev of retired) {
        audit.add(`- **${evLabel}** · 事件已完成 · “${ev.date} ${inline(ev.text)}”（${ev.docDate}） ${claimSource(ev)} · supersedes: “${prev.date} ${inline(prev.text)}”（${prev.docDate}） ${claimSource(prev)}`);
      }
      if (!retired.length) {
        audit.add(`- **${evLabel}** · 事件已完成 · “${ev.date} ${inline(ev.text)}”（${ev.docDate}） ${claimSource(ev)}`);
      }
      continue;
    }
    // status === "planned": if an earlier active event with the same event_key had a different date, supersede it.
    for (const prev of retired) {
      if (prev.date !== ev.date) {
        audit.add(`- **${evLabel}** · 事件更新 · “${ev.date} ${inline(ev.text)}”（${ev.docDate}） ${claimSource(ev)} · supersedes: “${prev.date} ${inline(prev.text)}”（${prev.docDate}） ${claimSource(prev)}`);
      }
    }
    activeEvents.push(ev);
  }

  // Cross-link fact date revisions to active timeline events: if a fact explicitly superseded
  // a previous_date (or previous_value containing an ISO date) for the same subject, retire the stale event.
  const isoDateRegex = /\b(\d{4}-\d{2}-\d{2})\b/g;
  const retiredEventIndices = new Set<number>();
  for (const fact of activeFacts) {
    if (!fact.revision?.explicit) continue;
    const oldDates = new Set<string>();
    if (fact.revision.previous_date) oldDates.add(fact.revision.previous_date);
    if (fact.revision.previous_value) {
      for (const match of fact.revision.previous_value.matchAll(isoDateRegex)) oldDates.add(match[1]);
    }
    if (!oldDates.size) continue;
    const factSubject = claimKey(fact.subject);
    for (const [idx, ev] of activeEvents.entries()) {
      if (retiredEventIndices.has(idx) || !oldDates.has(ev.date)) continue;
      if (ev.docDate > fact.docDate) continue;
      const subjectMatches = claimKey(ev.text).includes(factSubject)
        || ev.related.some((r) => claimKey(r.subject) === factSubject);
      if (subjectMatches && !fact.value.includes(ev.date)) {
        retiredEventIndices.add(idx);
        audit.add(`- **${inline(fact.subject)} · ${inline(fact.predicate)}** · 关联事件失效 · ${datedEvidence(fact)} · supersedes: “${ev.date} ${inline(ev.text)}”（${ev.docDate}） ${claimSource(ev)}`);
      }
    }
  }

  const finalEvents = new Map<string, EventClaim>();
  for (const [idx, ev] of activeEvents.entries()) {
    if (retiredEventIndices.has(idx)) continue;
    finalEvents.set(JSON.stringify([ev.date, claimKey(ev.text)]), ev);
  }

  return {
    intentions: [...intentions.values()],
    current: activeFacts,
    originalByFact,
    rules: [...rules.values()],
    events: [...finalEvents.values()].sort((a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text)),
    audit: [...audit],
  };
}

function wikiSlug(name: string) {
  const slug = claimKey(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 38);
  const hash = createHash("sha256").update(claimKey(name)).digest("hex").slice(0, 16);
  return slug ? `${slug}-${hash}` : `page-${hash}`;
}

function pageByKind(kind: Relation["kind"]) {
  return kind === "entity" ? "entities" : "topics";
}

function factLine(fact: FactClaim) {
  return `- **${inline(fact.subject)} · ${inline(fact.predicate)}** · ${inline(fact.value)} ${claimSource(fact)}`;
}

function* priorFactPlacements(previous: Claim[], draft: WikiDraft) {
  const facts = new Map(previous.filter(isFact).map((fact) => [factLine(fact), fact]));
  for (const [path, markdown] of draft) {
    if (!path.startsWith("entities/") && !path.startsWith("topics/")) continue;
    const kind = path.startsWith("entities/") ? "entity" : "topic";
    for (const line of markdown.split("\n")) {
      const fact = facts.get(line.trim());
      if (fact) yield { fact, path, kind } as const;
    }
  }
}

function canonicalizeClaimKinds(claims: Claim[], previous: Claim[], earlierDraft: WikiDraft, aliases?: Map<string, string>): Claim[] {
  const priorFolderBySubject = new Map<string, Relation["kind"]>();
  for (const { fact, kind } of priorFactPlacements(previous, earlierDraft)) {
    const key = claimKey(fact.subject);
    if (!priorFolderBySubject.has(key)) priorFolderBySubject.set(key, kind);
  }

  const canonicalKind = new Map(priorFolderBySubject);
  const canonicalName = (relation: Relation) => aliases?.get(relationKey(relation)) ?? relation.subject;
  for (const fact of claims.filter(isFact)) {
    const key = claimKey(canonicalName(fact));
    if (!priorFolderBySubject.has(key) && canonicalKind.get(key) !== "entity") {
      canonicalKind.set(key, fact.kind);
    }
  }

  const placement = (relation: Relation): Relation => {
    const subject = canonicalName(relation);
    const kind = canonicalKind.get(claimKey(subject)) ?? relation.kind;
    return kind === relation.kind ? relation : { kind, subject };
  };
  return claims.map((claim) => {
    if (isRule(claim) || isIntention(claim)) return claim;
    const related = claim.related.map(placement);
    if (!isFact(claim)) return { ...claim, related };
    const placed = placement(claim);
    const fact = { ...claim, subject: placed.subject, kind: placed.kind, related };
    return placed.kind === claim.kind ? fact : retainTelemetryKey(claim, fact);
  });
}

function priorPlacements(previous: Claim[], draft: WikiDraft) {
  const placements = new Map<string, string>();
  for (const { fact, path, kind } of priorFactPlacements(previous, draft)) {
    const key = relationKey({ kind, subject: fact.subject });
    if (!placements.has(key)) placements.set(key, path);
  }
  return placements;
}

function priorOverview(markdown: string | undefined, activeAnchors: Set<string>) {
  if (!markdown?.includes("概览与关键结论")) return;
  const { body } = readPage(markdown);
  const { children } = markdownAst(body);
  const start = children.findIndex((node) => node.type === "heading" && node.depth === 2 && plainText(node) === "概览与关键结论");
  if (start < 0) return;
  const after = children.slice(start + 1);
  const end = after.findIndex((node) => node.type === "heading" && node.depth <= 2);
  const nodes = end < 0 ? after : after.slice(0, end);
  let sourced = false;
  let valid = true;
  for (const node of nodes) {
    walk(node, (part) => {
      if (part.type !== "paragraph" && part.type !== "tableCell") return;
      const raw = body.slice(part.position!.start.offset, part.position!.end.offset);
      const anchors = findAnchors(raw);
      if (!anchors.length || anchors.some(({ anchor }) => !activeAnchors.has(anchor))
        || anchors.length !== (raw.match(/(?<!\\)\[src:/g)?.length ?? 0)) valid = false;
      else sourced = true;
    });
  }
  if (valid && sourced) return body.slice(children[start].position!.start.offset, nodes.at(-1)!.position!.end.offset);
}

function writePage(
  draft: WikiDraft, path: string, title: string, now: string,
  body: string, summaries: Map<string, { title: string; summary: string }>, summary: string,
) {
  const sources = [...new Set(findAnchors(body).map((anchor) => anchor.docId))].sort();
  draft.set(path, renderPage({ id: path.slice(0, -3), title, updated_at: now, sources }, body));
  summaries.set(path, { title, summary });
}

type IndexEntry = { title: string; summary: string; members?: string[] };

function clippedInline(value: string, limit: number) {
  return clipBytes(inline(value), limit).replace(/(^|[^\\])((?:\\\\)*)\\…$/u, "$1$2…");
}

function collectionCue(members: string[], limit: number) {
  const names: string[] = [];
  let remaining = limit;
  for (const member of members) {
    const separatorBytes = names.length ? Buffer.byteLength("、") : 0;
    if (remaining - separatorBytes < 12) break;
    const name = clippedInline(member, Math.min(65, remaining - separatorBytes));
    names.push(name);
    remaining -= Buffer.byteLength(name) + separatorBytes;
  }
  return names.join("、");
}

function renderIndex(space: Space, version: number, documentCount: number, entries: Map<string, IndexEntry>, pageCount: number) {
  const sections = [
    ["实体", "entities/"], ["主题", "topics/"], ["行为准则", "rules.md"], ["时间线与修订", ""],
  ] as const;
  const header = [
    `# Memory Index · ${space.space_id}`, "",
    `用途 · ${inline(clipBytes(space.purpose, 900))}`, "",
    `v${version} · ${documentCount} 份文档 · ${pageCount} 个知识页`,
  ];
  const rows = [...entries].map(([path, entry]) => ({
    path,
    link: `- [${clippedInline(entry.title, 99)}](${path})`,
    summary: entry.summary,
    members: entry.members,
  }));
  const linkBytes = rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.link) + 1, 0);
  const perSummary = Math.min(190, Math.max(0, Math.floor(
    (INDEX_MAX_BYTES - Buffer.byteLength(header.join("\n")) - linkBytes - 256) / rows.length,
  )));
  for (const [label, prefix] of sections) {
    const relevant = rows.filter(({ path }) => prefix ? path.startsWith(prefix) : !path.includes("/") && path !== "rules.md");
    if (!relevant.length) continue;
    header.push("", `## ${label}`, "");
    for (const row of relevant) {
      const cue = perSummary < 18 ? "" : row.members
        ? collectionCue(row.members, perSummary - 6) : clippedInline(row.summary, perSummary - 6);
      header.push(row.link + (cue ? ` · ${cue}` : ""));
    }
  }
  return header.join("\n") + "\n";
}

export function compileWiki(
  draft: WikiDraft, space: Space, version: number, documents: string[], previous: Claim[], addition: Claim[], now: string,
  placementClaimsOrOptions: Claim[] | CompileOptions = previous, options: CompileOptions = {},
) {
  const placementClaims = Array.isArray(placementClaimsOrOptions) ? placementClaimsOrOptions : previous;
  if (!Array.isArray(placementClaimsOrOptions)) options = placementClaimsOrOptions;
  const earlier = new Map(draft);
  draft.clear();
  const placementsLedger = placementClaims.map((claim) => effectiveClaim(claim, options));
  const claims = canonicalizeClaimKinds(compact([...previous, ...addition]), placementsLedger, earlier, options.aliases);
  const { current, audit, events, rules, intentions, originalByFact } = reconcile(claims, now.slice(0, 10), options);
  const evidence = new Set(claims.flatMap(claimAnchors).map(anchorKey));
  const required: RequiredLine[] = [];
  const summaries = new Map<string, IndexEntry>();
  const aliasesBySubject = new Map([...(options.aliasGroups ?? [])].map(([subject, names]) => [claimKey(subject), names]));
  const groups = new Map<string, Page>();
  for (const fact of current) {
    const key = relationKey(fact);
    const page = groups.get(key) ?? { kind: fact.kind, subject: fact.subject, facts: [] };
    page.facts.push(fact);
    groups.set(key, page);
  }

  const placements = priorPlacements(placementsLedger, earlier);
  const pages = new Map<string, { title: string; groups: Page[] }>();
  const pathBySubject = new Map<string, string>();
  const place = (path: string, title: string, group: Page) => {
    const page = pages.get(path);
    if (page) page.groups.push(group);
    else pages.set(path, { title, groups: [group] });
    pathBySubject.set(relationKey(group), path);
  };

  const subjects = [...groups.values()].sort((a, b) => a.subject.localeCompare(b.subject));
  const usedTitles = new Map<string, string>();
  for (const group of subjects) {
    const prior = placements.get(relationKey(group));
    // Legacy generated collections can now expose each subject at its own stable path.
    const inherited = prior && !/\/collection-\d+\.md$/.test(prior) ? prior : undefined;
    const path = inherited ?? `${pageByKind(group.kind)}/${wikiSlug(group.subject)}.md`;
    let title = usedTitles.get(path) ?? group.subject;
    if (inherited && !usedTitles.has(path)) title = readPage(earlier.get(path)!).frontmatter?.title ?? title;
    usedTitles.set(path, title);
    place(path, title, group);
  }
  const overviewAnchors = new Set([...current, ...events, ...rules].flatMap(claimAnchors).map(anchorKey));
  for (const anchor of options.correctedAnchors ?? []) overviewAnchors.delete(anchor);
  const writeContent = (path: string, title: string, lines: string[], summary: string) => {
    const overview = priorOverview(earlier.get(path), overviewAnchors);
    if (overview) lines.splice(1, 0, "", overview, "", "## 事实清单");
    writePage(draft, path, title, now, lines.join("\n"), summaries, summary);
  };

  const relatedLinks = (path: string, relations: Relation[]) => {
    const links = new Map<string, string>();
    for (const relation of relations) {
      const target = pathBySubject.get(relationKey(relation));
      if (target && target !== path) links.set(target, `[${inline(relation.subject)}](${relativeWikiLink(path, target)})`);
    }
    const oldPage = earlier.get(path);
    if (oldPage) {
      walk(markdownAst(readPage(oldPage).body), (node) => {
        if (node.type !== "link") return;
        const target = wikiLinkTarget(path, node.url);
        const page = target ? pages.get(target.path) : undefined;
        if (target && page && target.path !== path && !links.has(target.path)) {
          links.set(target.path, `[${inline(page.title)}](${relativeWikiLink(path, target.path)})`);
        }
      });
    }
    return [...links.values()];
  };
  for (const [path, page] of pages) {
    const body = [`# ${inline(page.title)}`];
    const descriptors = new Set<string>();
    const aliases = new Set<string>();
    for (const group of page.groups) {
      const names = aliasesBySubject.get(claimKey(group.subject)) ?? [];
      for (const alias of names) aliases.add(alias);
      body.push("");
      const aliasCue = names.length ? `（别名：${inline(names.join("/"))}）` : "";
      if (page.groups.length > 1) body.push(`## ${inline(group.subject)}${aliasCue}`, "");
      else body[0] += aliasCue;
      for (const fact of group.facts) {
        const line = factLine(fact);
        body.push(line);
        required.push({ path: null, kind: fact.kind, line });
        descriptors.add(page.groups.length === 1 ? fact.predicate : group.subject);
      }
    }
    const links = relatedLinks(path, page.groups.flatMap((group) => group.facts.flatMap((fact) => fact.related)));
    if (links.length) body.push("", "## 关联页面", "", ...links.map((link) => `- ${link}`));
    const summary = [...descriptors].slice(0, 6).join("、");
    writeContent(path, page.title, body,
      aliases.size ? `别名：${[...aliases].join("/")} · ${summary}` : summary);
  }

  const eventLines = events.map((event) => `- **${event.date}** · ${inline(event.text)} ${claimSource(event)}`);
  const eventLinks = relatedLinks("timeline.md", events.flatMap((event) => event.related));
  const timelineBody = ["# 时间线", "", ...(eventLines.length ? eventLines : [EMPTY_TIMELINE])];
  if (eventLinks.length) timelineBody.push("", "## 关联页面", "", ...eventLinks.map((link) => `- ${link}`));
  writeContent("timeline.md", "时间线", timelineBody, "带日期的事件与承诺");
  writeContent("conflicts.md", "冲突与修订",
    ["# 冲突与修订", "", ...(audit.length ? audit : [EMPTY_CONFLICTS])], "冲突与 supersedes 审计记录");
  for (const line of eventLines) required.push({ path: "timeline.md", line });
  for (const line of audit) required.push({ path: "conflicts.md", line });
  if (rules.length) {
    const lines = rules.map((rule) => {
      const rationale = rule.rationale ? `（原因：${inline(rule.rationale)}）` : "";
      return `- **[${rule.priority ?? "normal"}] ${inline(rule.trigger_context)}** · ${inline(rule.instruction)}${rationale} ${claimSource(rule)}`;
    });
    writeContent("rules.md", "行为准则", ["# 行为准则", "", ...lines], "用户明确设定的工作流程与回复规则");
    for (const line of lines) required.push({ path: "rules.md", line });
  }

  if (pages.size > 98) {
    const ranked = [...pages].map(([path, page]) => {
      const facts = page.groups.flatMap((group) => group.facts);
      let latest = "";
      let redline = false;
      for (const fact of facts) {
        redline ||= !!fact.pinned || (fact.tier ?? inferFactTier(fact)) === "pinned_redline";
        const recall = factTelemetry(originalByFact.get(fact)!, options.telemetry)?.last_recalled_at ?? "";
        if (recall > latest) latest = recall;
        if (fact.docDate > latest) latest = fact.docDate;
      }
      return { path, title: page.title, redline, count: facts.length, latest };
    }).sort((a, b) => Number(b.redline) - Number(a.redline) || b.count - a.count
      || b.latest.localeCompare(a.latest) || a.path.localeCompare(b.path));
    const tail = ranked.slice(80);
    // At most 17 hubs across the two categories, even for a very large snapshot.
    const chunkSize = Math.max(24, Math.ceil(tail.length / 16));
    for (const folder of ["entities", "topics"]) {
      const members = tail.filter(({ path }) => path.startsWith(folder + "/"));
      let number = 0;
      for (let offset = 0; offset < members.length; offset += chunkSize) {
        const batch = members.slice(offset, offset + chunkSize);
        let hub: string;
        do { hub = `topics/hub-${folder}-${++number}.md`; } while (draft.has(hub));
        const title = `${folder === "entities" ? "实体" : "主题"}目录 ${number}`;
        const links = batch.map(({ path, title }) => `- [${inline(title)}](${relativeWikiLink(hub, path)})`);
        writePage(draft, hub, title, now, [`# ${title}`, "", ...links].join("\n"), summaries, "");
        summaries.get(hub)!.members = batch.map(({ title }) => title);
        for (const { path } of batch) summaries.delete(path);
      }
    }
  }
  draft.set("_index.md", renderIndex(space, version, documents.length, summaries, draft.size));
  draft.set("_claims.json", JSON.stringify(claims, null, 2) + "\n");
  return { claims, current, rules, intentions, originalByFact, evidence, required, indexHeader: draft.get("_index.md")!.split("\n").slice(0, 5).join("\n") };
}
