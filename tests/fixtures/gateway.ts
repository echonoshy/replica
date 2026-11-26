import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CompactMessage } from "@wiki-memory/shared";

type Message = { role: string; content?: string; tool_call_id?: string };
type Completion = {
  model: string; messages: Message[];
  tools?: Array<{ function: { name: string } }>;
  response_format?: { type: string };
};
type Segment = { locator: string; text: string };
type ExtractionInput = {
  document: { filename: string };
  segments: Segment[];
  vocabulary: Array<{ kind: string; subject: string; predicate: string }>;
};
type ToolCall = { name: string; arguments: object };
type RequestLog = { stage: string; model: string; authorization?: string; native: boolean };
const call = (name: string, args: object = {}): ToolCall => ({ name, arguments: args });
const done = () => call("finish", { summary: "Draft checked" });

const review = { kind: "entity", subject: "张明" };
const preferences = { kind: "topic", subject: "差旅偏好" };
const policy = { kind: "topic", subject: "差旅报销" };

function extract({ document, segments }: ExtractionInput) {
  const text = segments.map((segment) => segment.text).join("\n");
  const location = (re: RegExp) => segments.find((segment) => re.test(segment.text))?.locator;
  const facts: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const add = (predicate: string, value: string, match: RegExp, extras: Record<string, unknown> = {}) => {
    const locator = location(match);
    if (locator) facts.push({ ...preferences, predicate, value, locator, ...extras });
  };
  add("高铁座位", "靠窗", /偏好是靠窗/);
  add("高铁座位", "过道", /从靠窗改为过道/, { revision: { explicit: true, previous_value: "靠窗" } });
  add("高铁座位", "优先前排", /优先前排/);
  add("复盘安排", "上海复盘请带风险清单和预算表", /张明负责上海项目复盘/, { ...review, related: [preferences, policy] });
  add("报销凭证", "Keep the original railway receipt", /Keep the original railway receipt/, { ...policy });
  add("提交期限", "Submit travel reimbursements within fourteen days", /within fourteen days/, { ...policy });
  add("复盘资料", "带预算表用于上海复盘", /带预算表用于上海复盘/, {
    kind: "topic", subject: "复盘资料", related: [review],
  });
  add("reference", "RLS-2026-B belongs to the release checklist", /RLS-2026-B/, { kind: "topic", subject: "Release checklist" });
  add("临时安排", "旧入口今晚关闭", /旧入口今晚关闭/, {
    kind: "topic", subject: "临时安排", expires_on: "2000-01-01",
  });
  add("到期", "通行证需要续期", /通行证需要续期/, { ...policy, expires_on: "2026-12-02" });
  const meeting = location(/2026-12-02/);
  if (meeting && !text.includes("Agenda item ")) events.push({ date: "2026-12-02", text: "上海项目复盘", locator: meeting, related: [review] });
  for (const { locator, text: passage } of segments) {
    for (const match of passage.matchAll(/Agenda item (\d+) due (\d{4}-\d{2}-\d{2})/g)) {
      events.push({ date: match[2], text: match[0], locator, related: [review] });
    }
  }
  if (!facts.length && !events.length && segments[0]) {
    facts.push({ kind: "topic", subject: "项目笔记", predicate: "记录", value: text.slice(0, 130).replace(/\s+/g, " "),
      locator: segments[0].locator, cardinality: "many" });
  }
  return { summary: document.filename, entities: [], facts, conflicts: [], timeline_events: events };
}

function navigate(index: string, query: string) {
  if (query.includes("RLS-2026-B")) return { selected_pages: [] };
  const matches = [...index.matchAll(/\[([^\]]+)\]\(([^)]+\.md)\)/g)];
  const selected = matches.filter(([, title, path]) => (
    /冲突|历史/.test(query) ? path === "conflicts.md"
      : /偏好|座位|高铁|靠窗|过道/.test(query) && title.includes("差旅偏好")
      || /张明|复盘/.test(query) && (title === "张明" || title === "复盘资料" || path === "timeline.md")
      || /报销|railway|reimbursement/i.test(query) && title === "差旅报销"
      || /项目笔记/.test(query) && title === "项目笔记"
  ));
  return { selected_pages: selected.slice(0, 5).map(([_, title, path]) => ({ path, reason: `匹配 ${title}` })) };
}

function organize(messages: Message[], behavior: "accept" | "repair" | "reject") {
  if (behavior === "accept") return [done()];
  if (behavior === "reject") return [call("update_index", { markdown_body: "# Invalid\n\n[missing](missing.md)" }), done()];
  if (messages.length === 2) return [call("read_page", { page_path: "_index.md" })];
  const prior = messages.find(({ role, content }) => role === "tool" && content?.includes('"page_path":"_index.md"'));
  const previousIndex = prior?.content ? (JSON.parse(prior.content) as { markdown: string }).markdown : "";
  if (!messages.some(({ content }) => content?.includes('"BROKEN_LINK"'))) {
    return [call("update_index", { markdown_body: previousIndex + "\n[missing](missing.md)" }), done()];
  }
  return [call("update_index", { markdown_body: previousIndex }), done()];
}

export interface ProactiveContext {
  now: string;
  timezone: string;
  quiet: boolean;
  total_due: number;
  trigger_groups: Array<{ group_id: string; count: number; anchors: string[] }>;
  triggers: Array<{ trigger_id: string; source_type: string; fire_at: string; chain_depth: number; text: string; anchors: string[] }>;
  index: string;
  related_memory: string[];
  upcoming: Array<{text: string; anchors: string[]}>;
  working_state: Array<{ title: string; status: string }>;
}
export interface GatewayOptions {
  embed?: (input: string[]) => number[][] | { status: number; message: string };
  compact?: (input: { messages: CompactMessage[]; max_tokens: number }) => unknown;
  agentic?: (input: {
    query: string; index: string; evidence: Array<{ path: string; excerpt: string }>;
    candidates: string[]; anchors: string[]; verified: string | null;
  }) => unknown;
  proactive?: (input: ProactiveContext) => unknown;
  scout?: (input: unknown) => unknown;
  rejectTools?: boolean;
  rejectJson?: boolean;
  lint?: "accept" | "repair" | "reject";
  beforeAnalysis?: (input: ExtractionInput) => Promise<void>;
  extract?: (input: ExtractionInput) => unknown;
  organize?: (input: {
    stage: "organizer" | "dreaming"; messages: Message[]; tools: string[];
    staging_notes?: Array<{ doc_id: string; summary: string }>;
  }) => ToolCall[] | undefined;
}

export async function startFixtureGateway(options: GatewayOptions = {}) {
  const requests: RequestLog[] = [];
  let serial = 0;
  const server = createServer((req, res) => {
    void serve(req, res).catch(() => {
      res.writeHead(500).end("Fixture gateway failed");
    });
  });

  async function serve(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST" || (req.url !== "/v1/chat/completions" && req.url !== "/v1/embeddings")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === "/v1/embeddings") {
      const { model, input } = payload as { model: string; input: string[] | string };
      const texts = Array.isArray(input) ? input : [input];
      requests.push({ stage: "embeddings", model, authorization: req.headers.authorization, native: true });
      const vectors = options.embed?.(texts) ?? texts.map((text) => {
        const bytes = Array.from(createHash("sha256").update(text).digest(), (byte) => byte - 127.5);
        const norm = Math.hypot(...bytes);
        return bytes.map((value) => value / norm);
      });
      if (!Array.isArray(vectors)) {
        res.writeHead(vectors.status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: vectors.message } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        object: "list", model, data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
        usage: { prompt_tokens: texts.length, total_tokens: texts.length },
      }));
      return;
    }
    const input = payload as Completion;
    const system = input.messages[0].content ?? "";
    const stage = system.startsWith("You extract") ? "analyzer"
      : system.startsWith("Route this") ? "router"
      : system.startsWith("Decide whether") ? "proactive"
      : system.startsWith("Scout the published personal memory") ? "scout"
      : system.startsWith("Select up") ? "navigator"
      : system.startsWith("Summarize the older messages") ? "compactor"
      : system.startsWith("Choose the next evidence") ? "agentic"
      : system.startsWith("Answer in") ? "synthesizer"
      : system.startsWith("你是") ? "chat"
      : system.includes("offline full review") ? "dreaming" : "organizer";
    requests.push({ stage, model: input.model, authorization: req.headers.authorization, native: !!(input.tools || input.response_format) });
    const capability = options.rejectTools && input.tools ? "tools" : options.rejectJson && input.response_format ? "response_format" : null;
    if (capability) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: `Unsupported ${capability}` } }));
      return;
    }
    const data = stage === "chat" ? {} : JSON.parse(input.messages[1].content ?? "{}");
    let content: string | null = null;
    let tool_calls;
    if (stage === "analyzer") {
      await options.beforeAnalysis?.(data);
      content = JSON.stringify(options.extract?.(data) ?? extract(data));
    } else if (stage === "router") {
      content = JSON.stringify({
        memory_mode: "personal",
        search_queries: [data.message],
        needs_inventory: false,
        safety_check: false,
      });
    } else if (stage === "proactive") {
      content = JSON.stringify(await options.proactive?.(data) ?? { decision: "silent" });
    } else if (stage === "scout") {
      content = JSON.stringify(options.scout?.(data) ?? { findings: [] });
    } else if (stage === "compactor") {
      content = JSON.stringify(await options.compact?.(data) ?? {
        summary: "Earlier messages reviewed", active_goals: [], confirmed_constraints: [],
        recent_decisions: [], open_questions: [], extracted_hot_memories: [],
      });
    } else if (stage === "agentic") {
      content = JSON.stringify(await options.agentic?.(data) ?? { read_pages: [], read_source: null });
    } else if (stage === "navigator") {
      content = JSON.stringify(navigate(data.index, data.query));
    } else if (stage === "synthesizer") {
      const answer = (data.passages as Array<{ content: string }>).flatMap(({ content }) => content
        .split("\n").filter((line) => line.includes("[src:")).slice(0, 2)).slice(0, 5).join("\n");
      content = JSON.stringify({ answer });
    } else if (stage === "chat") {
      content = "已记录。";
    } else {
      const calls = options.organize?.({
        stage, messages: input.messages, tools: input.tools?.map((tool) => tool.function.name) ?? [],
        staging_notes: data.staging_notes,
      }) ?? organize(input.messages, options.lint ?? "accept");
      if (input.tools) tool_calls = calls.map(({ name, arguments: args }) => ({
        id: `call_${++serial}`, type: "function", function: { name, arguments: JSON.stringify(args) },
      }));
      else content = JSON.stringify({ tool_calls: calls });
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      id: `fixture_${++serial}`, object: "chat.completion", created: 1, model: input.model,
      choices: [{ index: 0, message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) },
        finish_reason: tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 21, completion_tokens: 12, total_tokens: 33 },
    }));
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture gateway has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, options,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
