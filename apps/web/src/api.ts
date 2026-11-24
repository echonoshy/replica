import type {
  Citation, FileResult, JobResult, RetrieveResult, Snapshot, SourceResult, Space, SpaceRef, TreeResult,
} from "@replica/shared";

export type ChatSessionStatus = "pending" | "dreaming" | "dreamed";

export interface ModelInfo {
  id: string;
  label: string;
  switchable: false;
  note: string;
}

export interface ChatSession {
  session_id: string;
  space_key: string;
  title: string;
  session_date: string;
  status: ChatSessionStatus;
  dreamed_doc_id: string | null;
  dreamed_version: number | null;
  dreamed_job_id: string | null;
  dreamed_message_count: number;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface SessionTurnSource {
  session_id: string;
  session_title: string;
  session_date: string;
  session_status: ChatSessionStatus;
  dreamed_doc_id: string | null;
}

export interface ConversationSearchHit extends SessionTurnSource {
  turn_locator: string;
  excerpt: string;
  matched_terms: string[];
  score: number;
}

export interface SessionTurnResult extends SessionTurnSource {
  locator: string;
  raw_excerpt: string;
  previous: string | null;
  next: string | null;
}

export interface ChatMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  baseline_reply: string | null;
  retrieval: RetrieveResult | null;
  citations: Citation[];
  conversation_hits?: ConversationSearchHit[];
  tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface SessionsListResponse {
  model?: ModelInfo;
  space: Space;
  sessions: ChatSession[];
  pending_count: number;
  dreaming_count: number;
  active_dream_job_id: string | null;
}

export interface SendMessageResponse {
  session: ChatSession;
  user_message: ChatMessage;
  assistant_message: ChatMessage;
}

export interface DreamTriggerResponse {
  mode: "digest_pending" | "consolidate_wiki";
  digested_sessions: Array<{ session_id: string; title: string }>;
  job: JobResult;
}

export interface DemoPromptPreset {
  id: string;
  badge: string;
  title: string;
  description: string;
  query: string;
}

export interface ScenariosResponse {
  model?: ModelInfo;
  default_space: {
    namespace: string;
    space_id: string;
    display_name: string;
    persona?: string;
    purpose: string;
  };
  prompts: DemoPromptPreset[];
}

export interface OverviewDocument {
  doc_id: string;
  filename: string;
  doc_date: string;
  char_count: number;
  extension: string;
  first_published_version: number | null;
  warnings: string[];
  created_at: string;
}

export interface SnapshotExtended extends Snapshot {
  documents: string[];
  page_titles?: Record<string, string>;
}

export interface ExtractedFact {
  kind: "entity" | "topic";
  subject: string;
  predicate: string;
  value: string;
  locator: string;
  docId: string;
  docDate: string;
  cardinality?: "one" | "many";
  revision?: { explicit: true; previous_value?: string | null; previous_date?: string | null } | null;
  expires_on?: string | null;
}

export interface ExtractedEvent {
  date: string;
  text: string;
  locator: string;
  docId: string;
  docDate: string;
}

export interface ParsedConflict {
  label: string;
  rule: string;
  new_value: string;
  new_date: string;
  new_anchor: string;
  old_value: string;
  old_date: string;
  old_anchor: string;
}

export interface ConflictItem {
  raw: string;
  type: "superseded" | "same_day_conflict" | "revision" | "archived";
  anchors: string[];
  parsed?: ParsedConflict | null;
}

export interface TimelineItem {
  date: string;
  text: string;
  raw: string;
  anchors: string[];
}

export interface SpaceOverviewResponse {
  space: Space;
  active_snapshot: SnapshotExtended | null;
  snapshots: SnapshotExtended[];
  files: string[];
  documents: OverviewDocument[];
  jobs: JobResult[];
  stats: {
    fact_count: number;
    event_count: number;
    conflict_count: number;
    entity_pages: number;
    topic_pages: number;
  };
  claims: {
    facts: ExtractedFact[];
    events: ExtractedEvent[];
  };
  conflicts: ConflictItem[];
  timeline: TimelineItem[];
  index_markdown: string;
  stage_notes: {
    job_id: string | null;
    notes: Array<{ doc_id: string; markdown: string }>;
  };
}

export interface SnapshotDiffResponse {
  from_version: number;
  to_version: number;
  pages: Array<{
    path: string;
    title: string;
    status: "added" | "updated" | "removed";
    added_lines: string[];
    removed_lines: string[];
  }>;
  new_conflicts: ConflictItem[];
  summary: {
    added_pages: number;
    updated_pages: number;
    removed_pages: number;
    new_facts: number;
    new_conflicts: number;
  };
}

export const spaceKeyOf = (ref: SpaceRef) => `${ref.namespace}:${ref.space_id}`;
export const spaceRefOf = ({ namespace, space_id }: SpaceRef): SpaceRef => ({ namespace, space_id });

const adminSpaceUrl = (ref: SpaceRef) =>
  `/v1/admin/spaces/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.space_id)}`;
const demoSpaceUrl = (ref: SpaceRef) =>
  `/v1/demo/spaces/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.space_id)}`;
const chatSpaceUrl = (ref: SpaceRef) =>
  `/v1/chat/spaces/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.space_id)}`;

export function withQuery(path: string, params: Record<string, string | number | undefined | null>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  return qs.size ? `${path}?${qs.toString()}` : path;
}

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
  if (body === null) throw new Error("服务端返回了空响应");
  return body as T;
}

export function apiPost<T>(url: string, payload?: unknown, method: "POST" | "PATCH" | "DELETE" = "POST") {
  return apiRequest<T>(url, {
    method,
    headers: payload !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

export const api = {
  listSpaces: () => apiRequest<{ spaces: Space[] }>("/v1/admin/spaces"),
  createSpace: (input: { namespace: string; space_id: string; purpose: string }) =>
    apiPost<Space>("/v1/admin/spaces", input),
  getTree: (ref: SpaceRef, version?: number) =>
    apiRequest<TreeResult>(withQuery(`${adminSpaceUrl(ref)}/tree`, { version })),
  getFile: (ref: SpaceRef, path: string, version?: number) =>
    apiRequest<FileResult>(withQuery(`${adminSpaceUrl(ref)}/file`, { path, version })),
  getSource: (ref: SpaceRef, docId: string, locator: string, version?: number) =>
    apiRequest<SourceResult>(withQuery(`${adminSpaceUrl(ref)}/source`, { doc_id: docId, locator, version })),
  rollback: (ref: SpaceRef, version: number) =>
    apiPost<Space>(`${adminSpaceUrl(ref)}/rollback`, { version }),
  getJob: (jobId: string) =>
    apiRequest<JobResult>(`/v1/memories/jobs/${encodeURIComponent(jobId)}`),

  listSessions: (ref: SpaceRef) =>
    apiRequest<SessionsListResponse>(`${chatSpaceUrl(ref)}/sessions`),
  searchConversations: (ref: SpaceRef, q: string, limit?: number) =>
    apiRequest<{ query: string; hits: ConversationSearchHit[] }>(withQuery(`${chatSpaceUrl(ref)}/search`, { q, limit })),
  createSession: (ref: SpaceRef, input?: { title?: string; session_date?: string }) =>
    apiPost<{ session: ChatSession; messages: ChatMessage[] }>(`${chatSpaceUrl(ref)}/sessions`, input ?? {}),
  getSession: (sessionId: string) =>
    apiRequest<{ session: ChatSession; messages: ChatMessage[] }>(`/v1/chat/sessions/${encodeURIComponent(sessionId)}`),
  getSessionTurn: (sessionId: string, locator: string) =>
    apiRequest<SessionTurnResult>(withQuery(`/v1/chat/sessions/${encodeURIComponent(sessionId)}/turn`, { locator })),
  deleteSession: (sessionId: string) =>
    apiPost<{ deleted: boolean; forget_job_id?: string | null }>(`/v1/chat/sessions/${encodeURIComponent(sessionId)}`, undefined, "DELETE"),
  sendMessage: (
    sessionId: string,
    payload: { content: string; compare_baseline?: boolean; max_tokens?: number; verify_raw_sources?: boolean },
  ) => apiPost<SendMessageResponse>(`/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`, payload),
  triggerDream: (ref: SpaceRef, forceConsolidate = false) =>
    apiPost<DreamTriggerResponse>(`${chatSpaceUrl(ref)}/dream`, { force_consolidate: forceConsolidate }),

  getScenarios: () => apiRequest<ScenariosResponse>("/v1/demo/scenarios"),
  getOverview: (ref: SpaceRef, opts?: { version?: number; jobId?: string }) =>
    apiRequest<SpaceOverviewResponse>(
      withQuery(`${demoSpaceUrl(ref)}/overview`, { version: opts?.version, job_id: opts?.jobId }),
    ),
  getDiff: (ref: SpaceRef, opts?: { from?: number; to?: number }) =>
    apiRequest<SnapshotDiffResponse>(
      withQuery(`${demoSpaceUrl(ref)}/diff`, { from: opts?.from, to: opts?.to }),
    ),
};

export function conversationPreview(excerpt: string) {
  return excerpt.replace(/^\*\*(User|Assistant)\*\*\s*/gm, "").replace(/\s+/g, " ").trim();
}

export function friendlyDocLabel(filename: string, docDate: string) {
  const shortDate = docDate ? docDate.slice(5) : "";
  const chatMatch = filename.match(/chat0?(\d+)/i);
  if (chatMatch) return `对话${chatMatch[1].padStart(2, "0")}`;
  if (/session_/i.test(filename)) return `对话 (${shortDate})`;
  const stem = filename.replace(/\.(json|md|txt|pdf|docx)$/i, "");
  return stem.length > 12 ? `${stem.slice(0, 11)}…` : stem;
}

export function buildDocLabelMap(documents?: OverviewDocument[]) {
  const map: Record<string, string> = {};
  for (const doc of documents ?? []) {
    map[doc.doc_id] = friendlyDocLabel(doc.filename, doc.doc_date);
  }
  return map;
}

export function formatNumber(n: number) {
  return new Intl.NumberFormat("zh-CN").format(n);
}

export function formatShortDate(iso: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const spaceLabels = new Map([
  ["personal:lin_yuan", "林远 · 复杂样例"],
  ["personal:my_space", "我的个人空间"],
  ["engineering:atlas_platform", "Atlas 平台 · 研发架构与排障"],
  ["sales:enterprise_q4", "Q4 大客户 · 商务谈判空间"],
  ["personal:zhou_ran", "周然 · 生活与独立开发"],
]);

export function spaceDisplayName(space: Space | null) {
  return space ? spaceLabels.get(spaceKeyOf(space)) ?? space.space_id : "个人空间";
}
