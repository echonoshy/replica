import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retrieveResultSchema } from "@wiki-memory/shared";
import { SQLiteChatStore } from "../apps/api/src/chat/chat-store.js";
import { readConfig } from "../apps/api/src/config.js";
import type { DocumentRecord } from "../apps/api/src/db/interfaces.js";
import { SQLiteConnection, SQLiteMetadataRepository } from "../apps/api/src/db/sqlite-repo.js";
import { PERSONAL_DEMO_DAYS, PERSONAL_DEMO_PROMPTS, PENDING_DEMO_CHATS } from "../apps/api/src/demo/scenarios.js";
import { OpenAiGateway } from "../apps/api/src/llm/openai-gateway.js";
import { anchoredSections, TextDocumentNormalizer } from "../apps/api/src/pipeline/normalizer.js";
import { Synthesizer } from "../apps/api/src/retrieval/synthesizer.js";
import { createService } from "../apps/api/src/service.js";
import { LocalFsStorage } from "../apps/api/src/storage/local-fs-storage.js";

const spaceKey = "personal:test";
type Message = Pick<Parameters<SQLiteChatStore["appendMessage"]>[0], "role" | "content">;
const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content });
const userTurn = (text: string) => `**User**\n\n${text}`;

describe("raw conversation search", () => {
  let directory: string;
  let connection: SQLiteConnection;
  let store: SQLiteChatStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "zhiwei-chat-tests-"));
    connection = new SQLiteConnection(directory);
    store = new SQLiteChatStore(connection.client);
  });

  afterEach(() => {
    connection.client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function addSession(
    sessionId: string,
    messages: Message[],
    options: Partial<Parameters<SQLiteChatStore["createSession"]>[0]> = {},
  ) {
    const session = store.createSession({ sessionId, spaceKey, ...options });
    for (const message of messages) store.appendMessage({ sessionId, ...message, preserveStatus: true });
    return session;
  }

  it("shares locator numbering and exact normalized text with ingested conversations", async () => {
    const messages = [
      user(" \t "), assistant("  Welcome \r\n back  "), assistant("Follow-up"),
      user(" 成都天府数科 \r\n<!-- loc:t99 --> "), assistant("\n  "),
      assistant("和李建军见面"), user("下一条用户消息"),
    ];
    addSession("pending", messages, { title: "成都行程" });
    const normalized = await new TextDocumentNormalizer().normalize(Buffer.from(JSON.stringify({ messages })), "json");
    const sections = anchoredSections(normalized.markdown);
    expect(sections.map(({ locator }) => locator)).toEqual(["t1", "t2", "t3"]);
    const [first, second, third] = sections;
    expect(store.getSessionTurn("pending", "t2")).toMatchObject({
      session_id: "pending", session_title: "成都行程", session_status: "pending", dreamed_doc_id: null,
      locator: "t2", previous: first.text, raw_excerpt: second.text, next: third.text,
    });
    expect(second.text).toBe("**User**\n\n成都天府数科 \n&lt;!-- loc:t99 --&gt;\n\n**Assistant**\n\n和李建军见面");
    expect(store.getSessionTurn("pending", "t1")?.previous).toBeNull();
    expect(store.getSessionTurn("pending", "t3")?.next).toBeNull();
    expect(store.getSessionTurn("pending", "t99")).toBeUndefined();
    expect(store.getSessionTurn("missing", "t1")).toBeUndefined();
  });

  it("searches Chinese and English across statuses with exact terms, exclusions, and per-session caps", () => {
    addSession("dreamed", [
      user("客户留存漏斗按试点批次切分，使用 cohort retention。"),
      user("客户留存漏斗 cohort 讨论第二轮"), user("客户留存漏斗 cohort 讨论第三轮"),
    ], { status: "dreamed", dreamedDocId: "doc_day6" });
    addSession("pending", [
      user("成都天府数科约李建军见面。"), assistant("确认 cohort 合作。"),
    ]);
    addSession("other-space", [user("成都天府数科和客户留存漏斗 cohort")], { spaceKey: "personal:other" });

    const combined = store.searchConversations(spaceKey, "成都天府数科 客户留存漏斗");
    expect(combined.map((hit) => hit.session_id)).toEqual(expect.arrayContaining(["dreamed", "pending"]));
    expect(combined.find((hit) => hit.session_id === "dreamed")).toMatchObject({
      session_status: "dreamed", dreamed_doc_id: "doc_day6", matched_terms: ["客户", "户留", "留存", "存漏", "漏斗"],
    });
    expect(combined.find((hit) => hit.session_id === "pending")).toMatchObject({
      session_status: "pending", dreamed_doc_id: null, turn_locator: "t1",
    });
    const english = store.searchConversations(spaceKey, "COHORT", { maxPerSession: 1 });
    expect(english).toHaveLength(2);
    expect(english.every((hit) => hit.matched_terms.join() === "cohort")).toBe(true);
    expect(store.searchConversations(spaceKey, "cohort", { excludeSessionId: "dreamed" }).map((hit) => hit.session_id))
      .toEqual(["pending"]);
    expect(store.searchConversations(spaceKey, "客户留存漏斗")).toHaveLength(2);
    expect(store.searchConversations(spaceKey, "客户留存漏斗", { limit: 1 })).toHaveLength(1);
    expect(store.searchConversations(spaceKey, "天文摄影技巧")).toEqual([]);
    expect(store.searchConversations(spaceKey, "cohort unrelated lunar telescope")).toEqual([]);
    expect(store.searchConversations(spaceKey, "2")).toEqual([]);

    addSession("title-only", [user("周五再确认。")], { title: "Cohort 分析" });
    expect(store.searchConversations(spaceKey, "cohort unrelated lunar telescope").map((hit) => hit.session_id))
      .toEqual(["title-only"]);
  });

  it("returns the pending Chengdu plan and the dreamed funnel decision for starter prompt #3", () => {
    for (const day of PERSONAL_DEMO_DAYS) {
      addSession(day.id, day.messages, { title: day.title, sessionDate: day.doc_date, status: "dreamed", dreamedDocId: `doc_${day.id}` });
    }
    for (const chat of PENDING_DEMO_CHATS) {
      addSession(chat.session_id, chat.messages, { title: chat.title, sessionDate: chat.doc_date });
    }
    const hits = store.searchConversations(spaceKey, PERSONAL_DEMO_PROMPTS[2].query);
    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        session_id: "chat_lin_pending_01", turn_locator: "t2",
        excerpt: expect.stringMatching(/12 月 18 日.*李建军.*春熙路.*800 元.*番茄鸳鸯锅/),
      }),
      expect.objectContaining({ session_id: "day6", turn_locator: "t2", excerpt: expect.stringContaining("试点批次") }),
    ]));
  });

  it("lists recent nonempty sessions by date then update time with first-user previews", () => {
    addSession("empty", [], { sessionDate: "2026-12-31" });
    addSession("blank", [user(" \t\n ")], { sessionDate: "2026-12-30" });
    addSession("older-edited", [user("old")], { sessionDate: "2026-12-01", updatedAt: "2026-12-27" });
    addSession("earlier-update", [user("earlier")], { sessionDate: "2026-12-18", updatedAt: "2026-12-18T08:00:00Z" });
    addSession("latest", [assistant("hello"), user("   "), user(`  首条\n消息 ${"详情".repeat(65)} `), user("后续消息")], {
      title: "最新对话", sessionDate: "2026-12-18", updatedAt: "2026-12-18T10:00:00Z",
    });
    const recent = store.listRecentSessions(spaceKey, { limit: 2 });
    expect(recent.map(({ session_id }) => session_id)).toEqual(["latest", "earlier-update"]);
    expect(recent[0]).toMatchObject({
      title: "最新对话", session_date: "2026-12-18", status: "pending", message_count: 4,
    });
    expect(recent[0].preview).toMatch(/^首条 消息 .+…$/);
    expect(recent[0].preview).toHaveLength(120);
    expect(store.listRecentSessions(spaceKey, { excludeSessionId: "latest" }).map(({ session_id }) => session_id))
      .toEqual(["earlier-update", "older-edited"]);
  });

  it("reindexes after appends and removes turn rows when a session or space is deleted", () => {
    addSession("first", []);
    store.appendMessage({ sessionId: "first", ...user("春熙路酒店") });
    store.appendMessage({ sessionId: "first", ...assistant("番茄鸳鸯锅") });
    addSession("second", [user("番茄鸳鸯锅")]);
    addSession("elsewhere", [user("番茄鸳鸯锅")], { spaceKey: "personal:other" });
    expect(store.searchConversations(spaceKey, "番茄鸳鸯锅")).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: "first", session_title: "春熙路酒店", turn_locator: "t1" }),
    ]));
    const indexedRows = () => connection.client.prepare("SELECT session_id FROM chat_turns_fts ORDER BY session_id").pluck().all();
    expect(indexedRows()).toEqual(["elsewhere", "first", "second"]);
    expect(store.deleteSession("first")).toBe(true);
    expect(store.deleteSession("first")).toBe(false);
    expect(indexedRows()).toEqual(["elsewhere", "second"]);
    store.deleteSpaceSessions(spaceKey);
    expect(indexedRows()).toEqual(["elsewhere"]);
    expect(store.searchConversations(spaceKey, "番茄鸳鸯锅")).toEqual([]);
  });

  it("migrates old messages, backfills existing turns once, and persists recall metadata", () => {
    addSession("legacy", [user("客户留存漏斗"), assistant("按试点批次切分")], { status: "dreamed", dreamedDocId: "doc_legacy" });
    connection.client.exec("DROP TABLE chat_turns_fts; ALTER TABLE chat_messages DROP COLUMN conversation_hits_json");
    store = new SQLiteChatStore(connection.client);
    expect(store.getMessages("legacy").map(({ conversation_hits }) => conversation_hits)).toEqual([[], []]);
    const hits = store.searchConversations(spaceKey, "试点批次");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ dreamed_doc_id: "doc_legacy", turn_locator: "t1" });
    expect(store.getSessionTurn("legacy", "t1")?.raw_excerpt).toBe(`${userTurn("客户留存漏斗")}\n\n**Assistant**\n\n按试点批次切分`);
    addSession("new", [user("怎么切客户留存漏斗？")]);
    const reply = store.appendMessage({ sessionId: "new", ...assistant("按试点批次切分。"), conversationHits: hits });
    expect(reply.conversation_hits).toEqual(hits);

    store = new SQLiteChatStore(connection.client);
    expect(store.getMessages("new").at(-1)?.conversation_hits).toEqual(hits);
    expect(connection.client.prepare("SELECT COUNT(*) FROM chat_turns_fts").pluck().get()).toBe(2);
  });

  it("serves raw search and turns and validates Wiki, dreamed, and pending citations in chat replies", async () => {
    const ref = { namespace: "personal", space_id: "test" };
    const repo = new SQLiteMetadataRepository(connection);
    const storage = new LocalFsStorage(directory);
    await repo.ensureSpace(ref, "记住差旅预算和历史讨论");
    connection.client.prepare("UPDATE spaces SET current_version = 1 WHERE id = ?").run(spaceKey);
    const dreamedText = "客户留存漏斗按试点批次切分。";
    const pendingText = "成都天府数科见李建军。";
    const wikiText = "成都酒店预算每晚 800 元。";
    for (const [index, [docId, locator, text]] of [
      ["doc_funnel", "t1", userTurn(dreamedText)], ["doc_policy", "s1", wikiText],
    ].entries()) {
      const doc: DocumentRecord = {
        docId, spaceKey, filename: `${docId}.txt`, sha256: String(index).repeat(64),
        extension: "txt", mimeType: "text/plain", docDate: "2026-11-21",
        charCount: text.length, warnings: [], firstPublishedVersion: 1, createdAt: "2026-11-21T00:00:00Z",
      };
      await repo.registerDocument(doc);
      await storage.writeRaw(ref, doc, { bytes: Buffer.from(text), normalized: `<!-- loc:${locator} -->\n\n${text}\n` });
    }
    addSession("dreamed-funnel", [user(dreamedText)], {
      status: "dreamed", dreamedDocId: "doc_funnel", sessionDate: "2026-11-21", title: "评审讨论",
    });
    addSession("pending-chengdu", [user(pendingText)], { sessionDate: "2026-11-23", title: "出差安排" });
    addSession("active", []);

    const mockWiki = vi.spyOn(Synthesizer.prototype, "retrieve").mockResolvedValue(retrieveResultSchema.parse({
      snapshot_version: 1, index_excerpt: "# 差旅 Wiki", answer: null, citations: [],
      contexts: [{ page_id: "topics/travel.md", title: "差旅", relevance_reason: "成都差旅", content: `${wikiText} [src:doc_policy#s1]`, citations: [] }],
      usage: { selected_pages: 1, returned_tokens: 30, latency_ms: 0 },
    }));
    const complete = vi.spyOn(OpenAiGateway.prototype, "complete").mockResolvedValue({
      id: "stub", object: "chat.completion", created: 0, model: "stub",
      choices: [{
        index: 0, finish_reason: "stop", logprobs: null,
        message: {
          role: "assistant", refusal: null,
          content: "预算 [src:doc_policy#s1]。漏斗 [src:doc_funnel#t1]。成都 [chat:pending-chengdu#t1]。伪造 [src:doc_funnel#t2] [chat:pending-chengdu#t2] [chat:dreamed-funnel#t1]。",
        },
      }],
    });
    const service = createService(readConfig({ DATA_DIR: directory, PROACTIVE_ENABLED: "false" }));
    try {
      const query = "成都天府数科 客户留存漏斗";
      const search = await service.app.request(`/v1/chat/spaces/personal/test/search?q=${encodeURIComponent(query)}&limit=2`);
      expect(search.status).toBe(200);
      expect(await search.json()).toMatchObject({
        query, hits: expect.arrayContaining([
          expect.objectContaining({ session_id: "pending-chengdu", dreamed_doc_id: null, turn_locator: "t1" }),
          expect.objectContaining({ session_id: "dreamed-funnel", dreamed_doc_id: "doc_funnel", turn_locator: "t1" }),
        ]),
      });
      for (const [id, text] of [["pending-chengdu", pendingText], ["dreamed-funnel", dreamedText]]) {
        const turn = await service.app.request(`/v1/chat/sessions/${id}/turn?locator=t1`);
        expect(turn.status).toBe(200);
        expect(await turn.json()).toMatchObject({ session_id: id, raw_excerpt: userTurn(text), previous: null, next: null });
      }
      for (const path of ["pending-chengdu/turn?locator=t9", "pending-chengdu/turn", "missing/turn?locator=t1"]) {
        expect((await service.app.request(`/v1/chat/sessions/${path}`)).status).toBe(404);
      }

      const response = await service.app.request("/v1/chat/sessions/active/messages", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: query }),
      });
      expect(response.status).toBe(200);
      const { assistant_message: reply } = await response.json();
      expect(retrieveResultSchema.safeParse(reply.retrieval).success).toBe(true);
      expect(reply.citations.map(({ anchor }: { anchor: string }) => anchor)).toEqual(["doc_policy#s1", "doc_funnel#t1"]);
      expect(reply.content.match(/\[(?:src|chat):[^\]]+\]/g)).toEqual([
        "[src:doc_policy#s1]", "[src:doc_funnel#t1]", "[chat:pending-chengdu#t1]",
      ]);
      expect(reply.conversation_hits).toHaveLength(2);
      expect(store.getMessages("active").at(-1)?.conversation_hits).toEqual(reply.conversation_hits);
      const chatCall = complete.mock.calls.find((call) => call[0] === "strong")!;
      const system = chatCall[1][0].content;
      expect(system).toContain("# 差旅 Wiki");
      expect(system).toContain("【通道 1 · 长期 Wiki 记忆");
      expect(system).toContain("【通道 2 · 原始对话直搜");
      expect(system).toContain("【最近对话概览（recent_chats）】");
      expect(system).toContain(`出差安排（待入梦） · ${pendingText}`);
      expect(system).toContain("[src:doc_funnel#t1]");
      expect(system).toContain("[chat:pending-chengdu#t1]");
    } finally {
      mockWiki.mockRestore();
      complete.mockRestore();
      await service.close();
    }
  });
});
