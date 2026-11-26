import { z } from "zod";
import { contentPagePathSchema, docIdSchema, findAnchors, frontmatterSchema, locatorSchema, wikiPagePathSchema } from "@wiki-memory/shared";
import type { JobUsage, LintReport, Space } from "@wiki-memory/shared";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { WikiDraft } from "../db/interfaces.js";
import { ServiceError } from "../errors.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { parseJson } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";
import { inferFactTier } from "../memory/memory-state.js";
import type { FactTelemetryRecord } from "../memory/memory-state.js";
import { anchorKey, claimAnchors, claimKey, isFact, isRule, proceduralRuleInputSchema, ruleId } from "./analyzer.js";
import type { AtomicFact, Claim, Fact, ProceduralRuleClaim, Relation } from "./analyzer.js";
import { lintDraft } from "./linter.js";
import { renderPage } from "./wiki-markdown.js";
import { compareFactSource, compileWiki, factTelemetry, reconcile, retainTelemetryKey, rewriteSubjectInClaims } from "./wiki-compiler.js";
import type { RequiredLine } from "./wiki-compiler.js";

const empty = z.strictObject({});
const body = z.string().trim().min(1).max(240_000);
const short = z.string().trim().min(1).max(1000);
const name = z.string().trim().min(1).max(120);
const subject = { kind: z.enum(["entity", "topic"]), subject: name };
const source = { doc_id: docIdSchema, locator: locatorSchema };
const schemas = {
  list_pages: empty,
  read_page: z.strictObject({ page_path: wikiPagePathSchema }),
  upsert_page: z.strictObject({ page_path: contentPagePathSchema, frontmatter: frontmatterSchema, markdown_body: body }),
  delete_page: z.strictObject({ page_path: contentPagePathSchema, reason: short }),
  update_index: z.strictObject({ markdown_body: body }),
  merge_subjects: z.strictObject({
    kind: subject.kind, source_subjects: z.array(name).min(1).max(10), target_subject: name, reason: short,
  }),
  register_alias: z.strictObject({ kind: subject.kind, canonical_subject: name, alias: name }),
  merge_claims: z.strictObject({
    ...subject, source_predicates: z.array(name).min(1), target_predicate: name, merged_value: short,
    cardinality: z.enum(["one", "many"]).optional(),
  }),
  archive_claim: z.strictObject({ ...subject, predicate: name, value: short.optional(), reason: short }),
  archive_event: z.strictObject({ date: z.iso.date(), text: short, reason: short }),
  read_source: z.strictObject(source),
  correct_claim: z.strictObject({
    ...subject, ...source, predicate: name, old_value: short, new_value: short, reason: short,
    valid_from: z.iso.date().nullish(), valid_to: z.iso.date().nullish(),
  }),
  upsert_rule: proceduralRuleInputSchema.extend({ doc_id: docIdSchema }).strict(),
  archive_rule: z.strictObject({ rule_id: name.optional(), trigger_context: name.optional(), reason: short }),
  mark_hot_memory_processed: z.strictObject({ hot_id: name, action: name, note: short.optional() }),
  finish: z.strictObject({ summary: short }),
};
const descriptions = {
  list_pages: "List current draft page paths.",
  read_page: "Read an existing draft page.",
  upsert_page: "Create or replace a content page with validated frontmatter and Markdown.",
  delete_page: "Remove a content page after moving its knowledge and repairing links.",
  update_index: "Replace the top-level navigation index.",
  merge_subjects: "Move facts and related references from the source subjects to a single canonical subject. Register the former names as aliases.",
  register_alias: "Register an evidenced alternate name for a canonical subject and update the navigation index.",
  merge_claims: "Consolidate overlapping active facts on one subject in the claim ledger; rebuild the draft and preserve their citations.",
  archive_claim: "Move completed one-off facts or superseded companion notes out of active memory and into the sourced archive; supply the value to select a specific fact.",
  archive_event: "Retire a cancelled, rescheduled, or superseded timeline event out of active timeline.md and into the sourced archive.",
  read_source: "Read a published source passage with its neighbors to verify the speaker and exact wording.",
  correct_claim: "Correct an active sourced fact and its optional validity dates. Preserve its citation and audit the correction.",
  upsert_rule: "Record or update a reusable user instruction at a known evidence anchor.",
  archive_rule: "Archive a superseded or withdrawn rule by its ID or an unambiguous trigger.",
  mark_hot_memory_processed: "Acknowledge a reviewed hot memory by ID and describe the action taken. Consumption follows publication.",
  finish: "Request lint validation. Fix any reported errors before finishing again.",
};
type ToolName = keyof typeof schemas;
const fallbackSchema = z.object({
  tool_calls: z.array(z.object({ name: z.string(), arguments: z.unknown() })).min(1).max(12),
});

function operations(
  draft: WikiDraft,
  getState: () => { required: RequiredLine[]; indexHeader?: string },
) {
  return {
    list_pages: (input: unknown) => {
      schemas.list_pages.parse(input);
      return [...draft.keys()].filter((path) => wikiPagePathSchema.safeParse(path).success).sort();
    },
    read_page: (input: unknown) => {
      const { page_path } = schemas.read_page.parse(input);
      const page = draft.get(page_path);
      return page ? { page_path, markdown: page.slice(0, 64_000), truncated: page.length > 64_000 } : { error: "Page does not exist" };
    },
    upsert_page: (input: unknown) => {
      const { page_path, frontmatter, markdown_body } = schemas.upsert_page.parse(input);
      const cleanBody = markdown_body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
      const finalBody = cleanBody || markdown_body;
      // Deterministically derive frontmatter.id and sorted frontmatter.sources from inline
      // citations so large multi-source pages never fail lint due to a missed doc_id hash.
      const canonicalSources = [...new Set(findAnchors(finalBody).map((a) => a.docId))].sort();
      const canonicalFrontmatter = {
        ...frontmatter,
        id: page_path.slice(0, -3),
        sources: canonicalSources.length ? canonicalSources : frontmatter.sources,
      };
      draft.set(page_path, renderPage(canonicalFrontmatter, finalBody));
      return { updated: page_path };
    },
    delete_page: (input: unknown) => {
      const { page_path } = schemas.delete_page.parse(input);
      if (page_path === "timeline.md" || page_path === "conflicts.md") return { error: "This page is required" };
      const existing = draft.get(page_path);
      if (!existing) return { deleted: false };
      const { required } = getState();
      const folderPrefix = page_path.startsWith("entities/") ? "entities/" : page_path.startsWith("topics/") ? "topics/" : "";
      if (folderPrefix && required.length) {
        const otherLines = new Set<string>();
        for (const [otherPath, text] of draft) {
          if (otherPath === page_path || !otherPath.startsWith(folderPrefix)) continue;
          for (const line of text.split(/\r?\n/)) otherLines.add(line.trim());
        }
        const pageLines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
        const missing = required
          .filter((req) => !req.path && pageLines.has(req.line) && !otherLines.has(req.line))
          .map((req) => req.line);
        if (missing.length) {
          return {
            error: "Copy these required source-backed lines verbatim into another page in the same folder before deleting this page",
            missing_lines: missing.slice(0, 10),
          };
        }
      }
      return { deleted: draft.delete(page_path) };
    },
    update_index: (input: unknown) => {
      const raw = schemas.update_index.parse(input).markdown_body.trim();
      const { indexHeader } = getState();
      let finalIndex = raw;
      if (indexHeader && !raw.startsWith(indexHeader + "\n")) {
        const sectionIdx = raw.search(/^##\s+/m);
        finalIndex = sectionIdx >= 0
          ? `${indexHeader}\n\n${raw.slice(sectionIdx).trim()}`
          : `${indexHeader}\n\n${raw}`;
      }
      draft.set("_index.md", finalIndex + "\n");
      return { updated: "_index.md" };
    },
  };
}

export type ClaimContext = {
  space: Space; version: number; documents: string[]; now: string; claims: Claim[];
  onRegisterAlias?: (kind: Relation["kind"], canonical: string, alias: string) => void;
  aliases?: Map<string, string>;
  aliasGroups?: Map<string, string[]>;
  telemetry?: Map<string, FactTelemetryRecord>;
  readSource?: (docId: string, locator: string) => Promise<{
    anchor: string; filename: string; doc_date: string; raw_excerpt: string | null; previous: string | null; next: string | null;
  }>;
  hotMemories?: Array<{
    id: string; kind: "remember" | "forget"; content: string; target_hint: string | null;
    tier: string; scope: string; created_at: string;
  }>;
  consumedHotIds?: Set<string>;
  decayCandidates?: Array<{
    subject: string; predicate: string; value: string; tier: string; activation_score: number; doc_date: string;
  }>;
};
type StagingNote = { doc_id: string; summary: string };

function atomicOriginals(fact: Claim & Fact): AtomicFact[] {
  if (fact.merged_from?.length) return fact.merged_from;
  const { extra_sources: _extra, archived: _archived, merged_from: _merged, ...atomic } = fact;
  return [atomic];
}

function dreamOperations(context: ClaimContext, recompile: (claims: Claim[], correctedAnchors?: string[]) => void,
  hasEvidence: (anchor: string) => boolean) {
  const today = context.now.slice(0, 10);
  const redline = (fact: Fact) => fact.pinned || (fact.tier ?? inferFactTier(fact)) === "pinned_redline";
  const matching = (kind: Fact["kind"], subject: string) => {
    const { current, originalByFact } = reconcile(context.claims, today, context);
    return current.filter((fact) => fact.kind === kind && claimKey(fact.subject) === claimKey(subject))
      .map((fact) => ({ fact, original: originalByFact.get(fact)! }));
  };
  const register = (kind: Relation["kind"], canonical: string, alias: string) => {
    const lookup = context.aliases ??= new Map<string, string>();
    const groups = context.aliasGroups ??= new Map<string, string[]>();
    const key = claimKey(alias);
    if (key === claimKey(canonical)) return;
    context.onRegisterAlias?.(kind, canonical, alias);
    // Mirror the store's reassignment of aliases that used to point to this name.
    const moved = new Map([[key, alias]]);
    for (const [oldCanonical, names] of groups) {
      const remaining = names.filter((name) => {
        const nameKey = claimKey(name);
        if (nameKey !== key && !(claimKey(oldCanonical) === key && lookup.get(`${kind}:${nameKey}`) === oldCanonical)) return true;
        if (!moved.has(nameKey)) moved.set(nameKey, name);
        const otherKind = kind === "topic" ? "entity" : "topic";
        return lookup.get(`${otherKind}:${nameKey}`) === oldCanonical;
      });
      if (remaining.length) groups.set(oldCanonical, remaining);
      else groups.delete(oldCanonical);
    }
    for (const nameKey of moved.keys()) lookup.set(`${kind}:${nameKey}`, canonical);
    groups.set(canonical, [...new Set([...(groups.get(canonical) ?? []), ...moved.values()])]);
  };
  return {
    read_source: async (input: unknown) => {
      const { doc_id, locator } = schemas.read_source.parse(input);
      if (!context.readSource || !context.documents.includes(doc_id)) return { error: "Source is unavailable in this snapshot" };
      try {
        return await context.readSource(doc_id, locator);
      } catch (error) {
        if (error instanceof ServiceError && error.code === "SOURCE_NOT_FOUND") return { error: error.message };
        throw error;
      }
    },
    correct_claim: (input: unknown) => {
      const args = schemas.correct_claim.parse(input);
      const anchor = `${args.doc_id}#${args.locator}`;
      const entries = matching(args.kind, args.subject).filter(({ fact }) =>
        claimKey(fact.predicate) === claimKey(args.predicate) && claimKey(fact.value) === claimKey(args.old_value)
        && claimAnchors(fact).some((source) => anchorKey(source) === anchor));
      if (entries.length !== 1) return { error: "Select one active fact with its exact value and source" };
      const { original } = entries[0];
      const userEdit = factTelemetry(original, context.telemetry)?.edited_value;
      if (userEdit != null && args.new_value !== userEdit) return { error: "This value has an explicit user edit" };
      const corrected = { ...original, value: args.new_value,
        ...(args.valid_from !== undefined ? { valid_from: args.valid_from } : {}),
        ...(args.valid_to !== undefined ? { valid_to: args.valid_to } : {}),
        corrections: [...(original.corrections ?? []), {
          old_value: args.old_value, new_value: args.new_value, reason: args.reason, corrected_at: context.now,
          subject: args.subject, predicate: args.predicate, sources: claimAnchors(original),
        }],
      };
      if (corrected.valid_from && corrected.valid_to && corrected.valid_from > corrected.valid_to) {
        return { error: "valid_from must precede or equal valid_to" };
      }
      recompile(context.claims.map((claim) => claim === original ? retainTelemetryKey(original, corrected) : claim),
        claimAnchors(original).map(anchorKey));
      return { corrected: true, anchor };
    },
    upsert_rule: async (input: unknown) => {
      const { doc_id, ...args } = schemas.upsert_rule.parse(input);
      const anchor = `${doc_id}#${args.locator}`;
      if (!hasEvidence(anchor)) return { error: "Rule needs a known evidence anchor" };
      const backing = context.claims.find((claim) => anchorKey(claim) === anchor);
      const prior = context.claims.filter(isRule).find((rule) => !rule.archived && anchorKey(rule) === anchor
        && claimKey(rule.trigger_context) === claimKey(args.trigger_context) && claimKey(rule.instruction) === claimKey(args.instruction));
      const docDate = backing?.docDate ?? (await context.readSource?.(doc_id, args.locator))?.doc_date;
      if (!docDate) return { error: "Cannot establish the source date for this anchor" };
      const updated: ProceduralRuleClaim = {
        ...prior, ...args, kind: "rule", rule_id: ruleId(args.trigger_context, args.instruction),
        docId: doc_id, docDate,
      };
      recompile([...context.claims.filter((claim) => claim !== prior), updated]);
      return { rule_id: updated.rule_id };
    },
    archive_rule: (input: unknown) => {
      const { rule_id, trigger_context, reason } = schemas.archive_rule.parse(input);
      const rules = reconcile(context.claims, today, context).rules.filter((rule) =>
        (rule_id || trigger_context) && (!rule_id || rule_id === rule.rule_id)
        && (!trigger_context || claimKey(trigger_context) === claimKey(rule.trigger_context)));
      if (rules.length !== 1) return { error: "Select one active rule by ID or unique trigger" };
      const [target] = rules;
      recompile(context.claims.map((claim) => isRule(claim) && !claim.archived
        && claimKey(claim.trigger_context) === claimKey(target.trigger_context)
        && claimKey(claim.instruction) === claimKey(target.instruction)
        ? { ...claim, archived: { reason, archived_at: context.now } } : claim));
      return { archived: target.rule_id };
    },
    mark_hot_memory_processed: (input: unknown) => {
      const { hot_id, action } = schemas.mark_hot_memory_processed.parse(input);
      if (!context.hotMemories?.some(({ id }) => id === hot_id)) return { error: "Unknown active hot memory" };
      (context.consumedHotIds ??= new Set()).add(hot_id);
      return { processed: hot_id, action };
    },
    merge_subjects: (input: unknown) => {
      const args = schemas.merge_subjects.parse(input);
      const canonical = context.aliases?.get(`${args.kind}:${claimKey(args.target_subject)}`);
      if (canonical) return { error: `Target is an alias. Use its canonical subject: ${canonical}` };
      const sources = new Map(args.source_subjects.map((src) => [claimKey(src), src]));
      sources.delete(claimKey(args.target_subject));
      const rewritten = rewriteSubjectInClaims(context.claims, args.kind, [...sources.values()], args.target_subject);
      for (const src of sources.values()) register(args.kind, args.target_subject, src);
      recompile(rewritten.claims);
      return { changed: rewritten.changed, target_subject: args.target_subject };
    },
    register_alias: (input: unknown) => {
      const args = schemas.register_alias.parse(input);
      const canonical = context.aliases?.get(`${args.kind}:${claimKey(args.canonical_subject)}`) ?? args.canonical_subject;
      register(args.kind, canonical, args.alias);
      recompile(context.claims);
      return { canonical_subject: canonical, alias: args.alias };
    },
    merge_claims: (input: unknown) => {
      const args = schemas.merge_claims.parse(input);
      if (/[<＜][｜|]DSML[｜|]|<\/merged_value>/i.test(args.merged_value)) {
        return { error: "merged_value contains invalid tool markup; return clean plain text only" };
      }
      const predicates = new Set(args.source_predicates.map(claimKey));
      const entries = matching(args.kind, args.subject).filter(({ fact }) => predicates.has(claimKey(fact.predicate)));
      const matches = entries.map(({ fact }) => fact);
      if (matches.length < 2) return { error: "At least two active facts must match the source predicates" };
      const newest = matches.toSorted(compareFactSource).at(-1)!;
      if (matches.some((fact) => (fact.valid_from ?? null) !== (newest.valid_from ?? null)
        || (fact.valid_to ?? null) !== (newest.valid_to ?? null))) {
        return { error: "Keep facts with different validity periods separate" };
      }
      const anchors = new Map(matches.flatMap(claimAnchors).map((anchor) => [anchorKey(anchor), anchor]));
      anchors.delete(anchorKey(newest));
      const related = new Map(matches.flatMap((fact) => fact.related).map((relation) =>
        [JSON.stringify([relation.kind, claimKey(relation.subject)]), relation]));
      const expirations = matches.flatMap((fact) => fact.expires_on ? [fact.expires_on] : []).sort();
      const atomicMap = new Map(entries.flatMap(({ original }) => atomicOriginals(original)).map((atomic) => [
        JSON.stringify([atomic.docId, atomic.locator, claimKey(atomic.predicate), claimKey(atomic.value)]), atomic,
      ]));
      const corrections = entries.flatMap(({ original }) => original.corrections ?? []);
      const merged: Claim = {
        kind: newest.kind, subject: newest.subject, docDate: newest.docDate, docId: newest.docId, locator: newest.locator,
        predicate: args.target_predicate, value: args.merged_value, cardinality: args.cardinality ?? newest.cardinality,
        tier: matches.some(redline) ? "pinned_redline" : newest.tier, scope: newest.scope,
        ...(matches.some((fact) => fact.pinned) ? { pinned: true } : {}),
        expires_on: expirations[0], related: [...related.values()], extra_sources: [...anchors.values()],
        valid_from: newest.valid_from, valid_to: newest.valid_to,
        ...(corrections.length ? { corrections } : {}),
        merged_from: [...atomicMap.values()],
      };
      const removed = new Set<Claim>(entries.map(({ original }) => original));
      recompile([...context.claims.filter((claim) => !removed.has(claim)), merged]);
      return { merged: matches.length, subject: merged.subject, predicate: merged.predicate };
    },
    archive_claim: (input: unknown) => {
      const args = schemas.archive_claim.parse(input);
      const entries = matching(args.kind, args.subject).filter(({ fact }) =>
        claimKey(fact.predicate) === claimKey(args.predicate)
        && (args.value === undefined || claimKey(fact.value) === claimKey(args.value)));
      if (entries.some(({ fact }) => redline(fact))) {
        return { error: "Pinned redlines must remain active" };
      }
      const matches = new Set<Claim>(entries.map(({ original }) => original));
      if (!matches.size) return { error: "No active facts match the subject, predicate, and value" };
      const archived = { reason: args.reason, archived_at: context.now };
      recompile(context.claims.map((claim) => matches.has(claim) ? { ...claim, archived } : claim));
      return { archived: matches.size };
    },
    archive_event: (input: unknown) => {
      const args = schemas.archive_event.parse(input);
      const targetText = claimKey(args.text);
      const matches = new Set<Claim>(context.claims.filter((claim) =>
        !isFact(claim) && !isRule(claim) && !claim.archived && claim.date === args.date
        && (claimKey(claim.text) === targetText || claimKey(claim.text).includes(targetText))));
      if (!matches.size) return { error: "No active timeline event matches that date and text" };
      const archived = { reason: args.reason, archived_at: context.now };
      recompile(context.claims.map((claim) => matches.has(claim) ? { ...claim, archived } : claim));
      return { archived: matches.size };
    },
  };
}

export class Organizer {
  constructor(private readonly gateway: OpenAiGateway) {}

  async organize(input: {
    draft: WikiDraft; purpose: string; dreaming: boolean; usage: JobUsage; evidence: Set<string>;
    required: RequiredLine[]; linting: (inProgress: boolean) => Promise<void>;
    context?: ClaimContext; stagingNotes?: StagingNote[]; indexHeader?: string;
  }): Promise<LintReport> {
    const { draft, purpose, dreaming, usage, linting, context, stagingNotes } = input;
    let { evidence, required, indexHeader = draft.get("_index.md")?.split("\n").slice(0, 5).join("\n") } = input;
    const messages: ChatCompletionMessageParam[] = [];
    type ReadResult = { turn: number; page_path?: string; anchor?: string; replace: (result: unknown) => void };
    const reads = new Set<ReadResult>();
    const clearRead = (read: ReadResult, reason: string) => {
      read.replace({ cleared: true, reason, page_path: read.page_path, anchor: read.anchor });
      reads.delete(read);
    };
    const handlers = {
      ...operations(draft, () => ({ required, indexHeader })),
      ...(dreaming && context ? dreamOperations(context, (claims, correctedAnchors) => {
        const { space, version, documents, now } = context;
        const candidate = new Map(draft);
        const compiled = compileWiki(candidate, space, version, documents, claims, [], now, context.claims, { ...context, correctedAnchors });
        draft.clear();
        for (const entry of candidate) draft.set(...entry);
        context.claims = compiled.claims;
        ({ evidence, required, indexHeader } = compiled);
        for (const read of reads) if (read.page_path) clearRead(read, "stale_after_recompile");
      }, (anchor) => evidence.has(anchor)) : {}),
    };
    const names = [...Object.keys(handlers), "finish"] as ToolName[];
    const tools: ChatCompletionTool[] = names.map((name) => ({
      type: "function",
      function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name]) },
    }));
    messages.push(
      { role: "system", content: [prompts.organizer, dreaming ? prompts.dreaming : "",
        'If native tools are unavailable, output one JSON object {"tool_calls":[{"name":"list_pages","arguments":{}}]}. JSON tool definitions follow.',
        JSON.stringify(tools.map((tool) => tool.type === "function" && tool.function)),
      ].join("\n\n") },
      { role: "user", content: JSON.stringify({
        purpose, operation: dreaming ? "dream" : "ingest", pages: handlers.list_pages({}), staging_notes: stagingNotes ?? [],
        ...(dreaming ? {
          decay_candidates: context?.decayCandidates ?? [],
          hot_memories: context?.hotMemories ?? [],
          active_rules: context ? reconcile(context.claims, context.now.slice(0, 10), context).rules : [],
          existing_aliases: [...(context?.aliasGroups ?? [])].map(([canonical, aliases]) => ({ canonical, aliases })),
        } : {}),
      }) },
    );
    let lintFailures = 0;
    let accepted: LintReport | undefined;
    const run = async (name: string, input: unknown) => {
      if (!names.includes(name as ToolName)) return { error: "Unknown tool" };
      if (name !== "finish") return handlers[name as keyof typeof handlers]!(input);
      schemas.finish.parse(input);
      await linting(true);
      const result = lintDraft(draft, evidence, required, indexHeader);
      if (!result.issues.length) {
        accepted = result;
        return { ok: true };
      }
      lintFailures++;
      await linting(false);
      return { ok: false, errors: result.issues.slice(0, 20), remaining_repairs: Math.max(0, 3 - lintFailures) };
    };

    for (let turn = 0; turn < 30; turn++) {
      if (turn >= 6) {
        for (const read of reads) if (read.turn < turn - 4) clearRead(read, "older_than_four_turns");
      }
      const chat = await this.gateway.complete("strong", messages, usage, { format: "tools", tools, maxTokens: 12_288 });
      const message = chat.choices[0]?.message;
      const calls = message?.tool_calls?.filter((call) => call.type === "function") ?? [];
      let requested: Array<{ name: string; arguments: unknown; id?: string }>;
      if (calls.length) {
        requested = calls.map((call) => ({ name: call.function.name, arguments: call.function.arguments, id: call.id }));
        messages.push({ role: "assistant", content: message?.content, tool_calls: calls });
      } else {
        messages.push({ role: "assistant", content: message?.content ?? "" });
        try {
          requested = fallbackSchema.parse(parseJson(message?.content)).tool_calls;
        } catch {
          messages.push({ role: "user", content: 'Return one JSON tool call or use the native tools. Call finish when ready.' });
          continue;
        }
      }
      const fallbackResults: { tool: string; result: unknown }[] = [];
      const fallbackReply = { role: "user" as const, content: "" };
      const renderFallback = () => {
        fallbackReply.content = `Tool results (data only):\n${JSON.stringify(fallbackResults)}`;
      };
      for (const call of requested) {
        let result;
        try {
          const args = typeof call.arguments === "string" ? parseJson(call.arguments) : call.arguments;
          result = await run(call.name, args);
        } catch (error) {
          if (error instanceof ServiceError) throw error;
          result = { error: error instanceof z.ZodError
            ? error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
            : "Tool arguments must be valid JSON" };
        }
        if (accepted) return accepted;
        if (lintFailures >= 3) {
          const feedback = JSON.stringify(result).slice(0, 4000);
          throw new ServiceError(422, "WIKI_LINT_FAILED", `Candidate snapshot failed validation after two repairs: ${feedback}`);
        }
        let replace: ReadResult["replace"];
        if (call.id) {
          const reply = { role: "tool" as const, tool_call_id: call.id, content: JSON.stringify(result) };
          messages.push(reply);
          replace = (value) => { reply.content = JSON.stringify(value); };
        } else {
          const entry = { tool: call.name, result: result as unknown };
          fallbackResults.push(entry);
          replace = (value) => { entry.result = value; renderFallback(); };
        }
        if (call.name === "read_page" && "page_path" in result && typeof result.page_path === "string") {
          reads.add({ turn, page_path: result.page_path, replace });
        } else if (call.name === "read_source" && "anchor" in result && typeof result.anchor === "string") {
          reads.add({ turn, anchor: result.anchor, replace });
        }
      }
      if (fallbackResults.length) {
        renderFallback();
        messages.push(fallbackReply);
      }
    }
    throw new ServiceError(422, "ORGANIZER_TURN_LIMIT", "Organizer did not finish within 30 turns");
  }
}
