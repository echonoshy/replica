import { createHash } from "node:crypto";
import { findAnchors, INDEX_MAX_BYTES } from "@replica/shared";
import type { Space } from "@replica/shared";
import type { WikiDraft } from "../db/interfaces.js";
import { anchorKey, claimAnchors, claimKey, claimSource, isFact } from "./analyzer.js";
import type { Claim, Fact, Relation } from "./analyzer.js";
import { clipBytes, inline, markdownAst, readPage, relativeWikiLink, renderPage, walk, wikiLinkTarget } from "./wiki-markdown.js";

type FactClaim = Claim & Fact;
type Page = { kind: Relation["kind"]; subject: string; facts: FactClaim[] };
export type RequiredLine = { path: string | null; kind?: Relation["kind"]; line: string };
export const EMPTY_TIMELINE = "暂无带明确日期的事件。";
export const EMPTY_CONFLICTS = "暂无冲突或修订记录。";

const relationKey = (subject: Relation) => `${subject.kind}:${claimKey(subject.subject)}`;
const slotKey = (fact: FactClaim) => `${relationKey(fact)}:${claimKey(fact.predicate)}`;
const valueKey = (fact: FactClaim) => claimKey(fact.value);

export function vocabularyOf(claims: Claim[], contextText = "", limit = 300) {
  const context = claimKey(contextText);
  const today = new Date().toISOString().slice(0, 10);
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
      active: !!existing?.active || (!claim.archived && (!claim.expires_on || claim.expires_on >= today)),
      count: (existing?.count ?? 0) + 1, lastSeen,
    });
  }
  const core = (slot: { subjectKey: string; count: number }) => slot.count >= 2 || subjects.get(slot.subjectKey)! >= 2;
  return [...slots.values()].sort((a, b) => Number(b.mentioned) - Number(a.mentioned)
    || Number(b.active) - Number(a.active) || Number(core(b)) - Number(core(a)) || b.lastSeen - a.lastSeen)
    .slice(0, Math.max(0, limit)).map(({ vocabulary }) => vocabulary);
}

export function claimIdentity(claim: Claim) {
  return isFact(claim)
    ? JSON.stringify([claim.docId, claim.locator, slotKey(claim), valueKey(claim)])
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

export function reconcile(claims: Claim[], today: string) {
  const factGroups = new Map<string, FactClaim[]>();
  const timeline = new Map<string, Exclude<Claim, Fact>>();
  const audit = new Set<string>();
  for (const claim of claims) {
    if (!isFact(claim)) {
      timeline.set(JSON.stringify([claim.date, claimKey(claim.text)]), claim);
      continue;
    }
    if (claim.archived) {
      audit.add(`- **${inline(claim.subject)} · ${inline(claim.predicate)}** · 梦境归档（${inline(claim.archived.reason)}） · ${datedEvidence(claim)}`);
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
    current.push(...active.filter((fact) => !fact.archived && (!fact.expires_on || fact.expires_on >= today)));
  }
  return {
    current,
    events: [...timeline.values()].sort((a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text)),
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

function canonicalizeClaimKinds(claims: Claim[], previous: Claim[], earlierDraft: WikiDraft): Claim[] {
  const priorFolderBySubject = new Map<string, Relation["kind"]>();
  for (const { fact, kind } of priorFactPlacements(previous, earlierDraft)) {
    const key = claimKey(fact.subject);
    if (!priorFolderBySubject.has(key)) priorFolderBySubject.set(key, kind);
  }

  const canonicalKind = new Map(priorFolderBySubject);
  for (const fact of claims.filter(isFact)) {
    const key = claimKey(fact.subject);
    if (!priorFolderBySubject.has(key) && canonicalKind.get(key) !== "entity") {
      canonicalKind.set(key, fact.kind);
    }
  }

  return claims.map((claim) => {
    const related = claim.related.map((relation) => ({
      ...relation, kind: canonicalKind.get(claimKey(relation.subject)) ?? relation.kind,
    }));
    return isFact(claim)
      ? { ...claim, related, kind: canonicalKind.get(claimKey(claim.subject)) ?? claim.kind }
      : { ...claim, related };
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

function renderIndex(space: Space, version: number, documentCount: number, entries: Map<string, IndexEntry>) {
  const sections = [
    ["实体", "entities/"], ["主题", "topics/"], ["时间线与修订", ""],
  ] as const;
  const header = [
    `# Memory Index · ${space.space_id}`, "",
    `用途 · ${inline(clipBytes(space.purpose, 900))}`, "",
    `v${version} · ${documentCount} 份文档 · ${entries.size} 个知识页`,
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
    const relevant = rows.filter(({ path }) => prefix ? path.startsWith(prefix) : !path.includes("/"));
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
  placementClaims = previous,
) {
  const earlier = new Map(draft);
  draft.clear();
  const claims = canonicalizeClaimKinds(compact([...previous, ...addition]), placementClaims, earlier);
  const { current, audit, events } = reconcile(claims, now.slice(0, 10));
  const evidence = new Set(claims.flatMap(claimAnchors).map(anchorKey));
  const required: RequiredLine[] = [];
  const summaries = new Map<string, IndexEntry>();
  const groups = new Map<string, Page>();
  for (const fact of current) {
    const key = relationKey(fact);
    const page = groups.get(key) ?? { kind: fact.kind, subject: fact.subject, facts: [] };
    page.facts.push(fact);
    groups.set(key, page);
  }

  const placements = priorPlacements(placementClaims, earlier);
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
    const inherited = placements.get(relationKey(group));
    const path = inherited ?? `${pageByKind(group.kind)}/${wikiSlug(group.subject)}.md`;
    let title = usedTitles.get(path) ?? group.subject;
    if (inherited && !usedTitles.has(path)) title = readPage(earlier.get(path)!).frontmatter?.title ?? title;
    usedTitles.set(path, title);
    place(path, title, group);
  }
  if (pages.size > 98) {
    // Pack related material into bounded collections while keeping each subject and claim.
    pages.clear();
    pathBySubject.clear();
    const bucketSize = Math.ceil(subjects.length / 96);
    for (const kind of ["entity", "topic"] as const) {
      const groupsOfKind = subjects.filter((group) => group.kind === kind);
      for (const [i, group] of groupsOfKind.entries()) {
        const number = Math.floor(i / bucketSize) + 1;
        place(`${pageByKind(kind)}/collection-${number}.md`, `${kind === "entity" ? "实体" : "主题"}汇编 ${number}`, group);
      }
    }
  }
  for (const [path, page] of pages) {
    const collection = path.match(/^(entities|topics)\/collection-(\d+)\.md$/u);
    if (collection) {
      const leadSubjects = page.groups.slice(0, 2).map(({ subject }) => clipBytes(subject, 28)).join("、");
      page.title = `${collection[1] === "entities" ? "实体" : "主题"}汇编 ${collection[2]} · ${leadSubjects}`;
    }
  }

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
    for (const group of page.groups) {
      body.push("");
      if (page.groups.length > 1) body.push(`## ${inline(group.subject)}`, "");
      for (const fact of group.facts) {
        const line = factLine(fact);
        body.push(line);
        required.push({ path: null, kind: fact.kind, line });
        descriptors.add(page.groups.length === 1 ? fact.predicate : group.subject);
      }
    }
    const links = relatedLinks(path, page.groups.flatMap((group) => group.facts.flatMap((fact) => fact.related)));
    if (links.length) body.push("", "## 关联页面", "", ...links.map((link) => `- ${link}`));
    writePage(draft, path, page.title, now, body.join("\n"), summaries, [...descriptors].slice(0, 6).join("、"));
    if (/\/collection-\d+\.md$/u.test(path)) summaries.get(path)!.members = page.groups.map(({ subject }) => subject);
  }

  const eventLines = events.map((event) => `- **${event.date}** · ${inline(event.text)} ${claimSource(event)}`);
  const eventLinks = relatedLinks("timeline.md", events.flatMap((event) => event.related));
  const timelineBody = ["# 时间线", "", ...(eventLines.length ? eventLines : [EMPTY_TIMELINE])];
  if (eventLinks.length) timelineBody.push("", "## 关联页面", "", ...eventLinks.map((link) => `- ${link}`));
  writePage(draft, "timeline.md", "时间线", now, timelineBody.join("\n"), summaries, "带日期的事件与承诺");
  writePage(draft, "conflicts.md", "冲突与修订", now,
    ["# 冲突与修订", "", ...(audit.length ? audit : [EMPTY_CONFLICTS])].join("\n"), summaries, "冲突与 supersedes 审计记录");
  for (const line of eventLines) required.push({ path: "timeline.md", line });
  for (const line of audit) required.push({ path: "conflicts.md", line });
  draft.set("_index.md", renderIndex(space, version, documents.length, summaries));
  draft.set("_claims.json", JSON.stringify(claims, null, 2) + "\n");
  return { claims, evidence, required, indexHeader: draft.get("_index.md")!.split("\n").slice(0, 5).join("\n") };
}
