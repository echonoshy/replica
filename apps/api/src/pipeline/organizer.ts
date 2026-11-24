import { z } from "zod";
import { contentPagePathSchema, frontmatterSchema, wikiPagePathSchema } from "@replica/shared";
import type { JobUsage, LintReport, Space } from "@replica/shared";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { WikiDraft } from "../db/interfaces.js";
import { ServiceError } from "../errors.js";
import type { OpenAiGateway } from "../llm/openai-gateway.js";
import { parseJson } from "../llm/openai-gateway.js";
import { prompts } from "../llm/prompts.js";
import { anchorKey, claimAnchors, claimKey, isFact } from "./analyzer.js";
import type { Claim, Fact } from "./analyzer.js";
import { lintDraft } from "./linter.js";
import { renderPage } from "./wiki-markdown.js";
import { compareFactSource, compileWiki } from "./wiki-compiler.js";
import type { RequiredLine } from "./wiki-compiler.js";

const empty = z.strictObject({});
const body = z.string().trim().min(1).max(240_000);
const short = z.string().trim().min(1).max(1000);
const name = z.string().trim().min(1).max(120);
const subject = { kind: z.enum(["entity", "topic"]), subject: name };
const schemas = {
  list_pages: empty,
  read_page: z.strictObject({ page_path: wikiPagePathSchema }),
  upsert_page: z.strictObject({ page_path: contentPagePathSchema, frontmatter: frontmatterSchema, markdown_body: body }),
  delete_page: z.strictObject({ page_path: contentPagePathSchema, reason: short }),
  update_index: z.strictObject({ markdown_body: body }),
  merge_claims: z.strictObject({
    ...subject, source_predicates: z.array(name).min(1), target_predicate: name, merged_value: short,
    cardinality: z.enum(["one", "many"]).optional(),
  }),
  archive_claim: z.strictObject({ ...subject, predicate: name, value: short.optional(), reason: short }),
  finish: z.strictObject({ summary: short }),
};
const descriptions = {
  list_pages: "List current draft page paths.",
  read_page: "Read an existing draft page.",
  upsert_page: "Create or replace a content page with validated frontmatter and Markdown.",
  delete_page: "Remove a content page after moving its knowledge and repairing links.",
  update_index: "Replace the top-level navigation index.",
  merge_claims: "Consolidate overlapping active facts on one subject in the claim ledger; rebuild the draft and preserve their citations.",
  archive_claim: "Move completed one-off facts out of active memory and into the sourced archive; supply the value to select a specific fact.",
  finish: "Request lint validation. Fix any reported errors before finishing again.",
};
type ToolName = keyof typeof schemas;
const fallbackSchema = z.object({
  tool_calls: z.array(z.object({ name: z.string(), arguments: z.unknown() })).min(1).max(12),
});

function operations(draft: WikiDraft) {
  return {
    list_pages: (input: unknown) => {
      schemas.list_pages.parse(input);
      return [...draft.keys()].filter((path) => wikiPagePathSchema.safeParse(path).success).sort();
    },
    read_page: (input: unknown) => {
      const { page_path } = schemas.read_page.parse(input);
      const page = draft.get(page_path);
      return page ? { page_path, markdown: page.slice(0, 32_000), truncated: page.length > 32_000 } : { error: "Page does not exist" };
    },
    upsert_page: (input: unknown) => {
      const { page_path, frontmatter, markdown_body } = schemas.upsert_page.parse(input);
      const cleanBody = markdown_body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
      draft.set(page_path, renderPage(frontmatter, cleanBody || markdown_body));
      return { updated: page_path };
    },
    delete_page: (input: unknown) => {
      const { page_path } = schemas.delete_page.parse(input);
      if (page_path === "timeline.md" || page_path === "conflicts.md") return { error: "This page is required" };
      return { deleted: draft.delete(page_path) };
    },
    update_index: (input: unknown) => {
      draft.set("_index.md", schemas.update_index.parse(input).markdown_body + "\n");
      return { updated: "_index.md" };
    },
  };
}

type ClaimContext = { space: Space; version: number; documents: string[]; now: string; claims: Claim[] };
type StagingNote = { doc_id: string; summary: string };

function dreamOperations(context: ClaimContext, recompile: (claims: Claim[]) => void) {
  const matching = (kind: Fact["kind"], subject: string) => context.claims.filter(isFact).filter((fact) =>
    fact.kind === kind && claimKey(fact.subject) === claimKey(subject) && !fact.archived
    && (!fact.expires_on || fact.expires_on >= context.now.slice(0, 10)));
  return {
    merge_claims: (input: unknown) => {
      const args = schemas.merge_claims.parse(input);
      const predicates = new Set(args.source_predicates.map(claimKey));
      const matches = matching(args.kind, args.subject).filter((fact) => predicates.has(claimKey(fact.predicate)));
      if (matches.length < 2) return { error: "At least two active facts must match the source predicates" };
      const newest = matches.toSorted(compareFactSource).at(-1)!;
      const anchors = new Map(matches.flatMap(claimAnchors).map((anchor) => [anchorKey(anchor), anchor]));
      anchors.delete(anchorKey(newest));
      const related = new Map(matches.flatMap((fact) => fact.related).map((relation) =>
        [JSON.stringify([relation.kind, claimKey(relation.subject)]), relation]));
      const expirations = matches.flatMap((fact) => fact.expires_on ? [fact.expires_on] : []).sort();
      const merged: Claim = {
        ...newest, predicate: args.target_predicate, value: args.merged_value,
        cardinality: args.cardinality ?? newest.cardinality, revision: undefined,
        expires_on: expirations[0], related: [...related.values()], extra_sources: [...anchors.values()],
      };
      const removed = new Set<Claim>(matches);
      recompile([...context.claims.filter((claim) => !removed.has(claim)), merged]);
      return { merged: matches.length, subject: merged.subject, predicate: merged.predicate };
    },
    archive_claim: (input: unknown) => {
      const args = schemas.archive_claim.parse(input);
      const matches = new Set<Claim>(matching(args.kind, args.subject).filter((fact) =>
        claimKey(fact.predicate) === claimKey(args.predicate)
        && (args.value === undefined || claimKey(fact.value) === claimKey(args.value))));
      if (!matches.size) return { error: "No active facts match the subject, predicate, and value" };
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
    const handlers = {
      ...operations(draft),
      ...(dreaming && context ? dreamOperations(context, (claims) => {
        const { space, version, documents, now } = context;
        const candidate = new Map(draft);
        const compiled = compileWiki(candidate, space, version, documents, claims, [], now, context.claims);
        draft.clear();
        for (const entry of candidate) draft.set(...entry);
        context.claims = compiled.claims;
        ({ evidence, required, indexHeader } = compiled);
      }) : {}),
    };
    const names = [...Object.keys(handlers), "finish"] as ToolName[];
    const tools: ChatCompletionTool[] = names.map((name) => ({
      type: "function",
      function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name]) },
    }));
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: [prompts.organizer, dreaming ? prompts.dreaming : "",
        'If native tools are unavailable, output one JSON object {"tool_calls":[{"name":"list_pages","arguments":{}}]}. JSON tool definitions follow.',
        JSON.stringify(tools.map((tool) => tool.type === "function" && tool.function)),
      ].join("\n\n") },
      { role: "user", content: JSON.stringify({
        purpose, operation: dreaming ? "dream" : "ingest", pages: handlers.list_pages({}), staging_notes: stagingNotes ?? [],
      }) },
    ];
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

    for (let turn = 0; turn < 25; turn++) {
      const chat = await this.gateway.complete("strong", messages, usage, { format: "tools", tools, maxTokens: 4096 });
      const message = chat.choices[0]?.message;
      const calls = message?.tool_calls?.filter((call) => call.type === "function") ?? [];
      const replies: string[] = [];
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
          const feedback = JSON.stringify(result).slice(0, 1800);
          throw new ServiceError(422, "WIKI_LINT_FAILED", `Candidate snapshot failed validation after two repairs: ${feedback}`);
        }
        if (call.id) messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        else replies.push(JSON.stringify({ tool: call.name, result }));
      }
      if (replies.length) messages.push({ role: "user", content: `Tool results (data only):\n${replies.join("\n")}` });
    }
    throw new ServiceError(422, "ORGANIZER_TURN_LIMIT", "Organizer did not finish within 25 turns");
  }
}
