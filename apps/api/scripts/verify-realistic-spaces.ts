// Standalone audit: pnpm --filter @replica/api exec tsx scripts/verify-realistic-spaces.ts
import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { FileResult, RetrieveResult, SourceResult } from "@replica/shared";
import type { ChatMessage, ChatSession, ConversationSearchHit, SendMessageResponse, SpaceOverviewResponse } from "../../web/src/api.js";
import { datasets, type Dataset } from "./realistic-datasets.js";
import { expectedVersions, http, origin, overview, sessionId, sessions, stem } from "./seed-realistic-spaces.js";

const reportPath = process.env.ASTRA_REPORT_PATH ??
  "./data/astra_verification_report.md";
const keywords = ["红烧排骨", "黄焖鸡", "空调", "机械键盘", "X100VI", "爬山", "瞎猜", "热锅", "火锅"];
type Rule = [string, RegExp];
interface Query { prompt: string; rules: Rule[]; obsolete?: RegExp; unsupported?: RegExp; }
interface Scenario { truths: Query[]; dual: Query; pending: number[]; }
const ddl: Rule[] = [
  ["Friday cutoff", /(?:周五|星期五|礼拜五).{0,16}(?:16[:：]?00|下午[四4]点|16点)/],
  ["production DDL prohibition", /(?:禁|不许|不允许|不得|不能|禁止|不做|不可以).{0,40}(?:ddl|表结构)|(?:ddl|表结构).{0,25}(?:禁止|不允许|不能|不做)/i],
  ["staging rehearsal", /staging/i], ["online schema tool", /pt-online-schema-change/i],
];
const price: Rule = ["148 万", /148万|一百四十八万|1[,.]?480[,.]?000/];
const subscription: Rule[] = [["annual subscription 68", /68元?(?:人民币)?(?:\/|每)?年|每年68|年.{0,8}68元/], ["subscription", /订阅/]];
const cases: Record<string, Scenario> = {
  atlas_platform: {
    truths: [
      { prompt: "Atlas 目前采用哪套向量库，版本和部署方式是什么？", rules: [["Milvus 2.5", /milvus2\.5/i], ["dedicated", /独立集群/]], obsolete: /qdrant|pgvector/i,
        unsupported: /已(?:经)?(?:在|于)(?:2026[-年])?12[-月]0?5日?.{0,6}完成/ },
      { prompt: "Atlas 核心检索接口现行的 P99 验收上限是多少？", rules: [["P99", /p99/i], ["180 ms upper bound", /(?:≤|<=|不超过|上限.{0,12}|目标.{0,12}|收紧至)180(?:ms|毫秒)|180(?:ms|毫秒)(?:以内|以下)/i]] },
      { prompt: "核心线上值班现在首呼谁？赵峰现在负责哪方面的架构？", rules: [["primary on-call", /陈思远/], ["international handover", /赵峰.{0,40}(?:国际|出海)|(?:国际|出海).{0,20}赵峰/]] },
      { prompt: "Atlas 周五下午生产环境做 DDL 的具体禁令是什么？大表变更要在哪里用什么工具提前演练？", rules: ddl },
      { prompt: "调用第三方支付回调必须携带什么幂等键？现行超时上限是多少？", rules: [["idempotency header", /X-Idempotency-Key/i], ["8 s", /(?:8|八)(?:个)?(?:秒|s)/i]] },
    ],
    dual: { prompt: "Redis 连接池参数之前怎么调的？周五下午能做表结构变更吗？",
      rules: [["maxIdle 64", /maxidle[=`为到调至:：]*64/i], ["minIdle 16", /minidle[=`为到调至:：]*16/i], ...ddl.slice(0, 2)] }, pending: [1],
  },
  enterprise_q4: {
    truths: [
      { prompt: "星海制造最终含税报价、服务方式、驻场安排、分期比例和签约截止日分别是什么？",
        rules: [price, ["tax included", /含税/], ["remote", /远程/], ["on-site removed", /(?:取消|不再|不含|无|没有|不设|不提供|去掉).{0,8}驻场|驻场.{0,8}(?:取消|改为|不再)/], ["4-4-2", /4[-:：、成\/，]?4[-:：、成\/，]?2|40%.{0,6}40%.{0,6}20%|四.{0,3}四.{0,3}[两二]/], ["Dec 10", /12[-月/]10/]], obsolete: /(?:155|180|95)万/ },
      { prompt: "锦程医药目前采购对接人是谁？等保、部署地点、数据出境和公有云模型调用分别有什么硬限制？",
        rules: [["current contact", /周慧/], ["level 3", /等保三级|等级保护三级|三级等保/], ["local private deployment", /本地.{0,12}私有化|私有化.{0,12}本地/], ["no data export", /(?:禁|不|不能|不得).{0,12}出境/], ["no public model API", /(?:禁|不得|不能|不允许|不可|不接入).{0,30}公有云/]], obsolete: /王志强|刘伟/ },
      { prompt: "远景能源找谁确认，POC 的当前验收日期、延期原因与预算上限是什么？",
        rules: [["Liu Wei", /刘伟/], ["Dec 9", /12[-月/]0?9/], ["legacy SAP", /sap/i], ["95 万", /95万|九十五万/]], obsolete: /148万|155万|王志强|周慧/ },
    ],
    dual: { prompt: "星海制造最终报价和违约金条款是什么？锦程医药 12 月 3 日演示有什么注意事项？",
      rules: [price, ["old cap", /20%/], ["requested cap", /10%/], ["approval pending", /待批|审批|批准|未生效/], ["Chinese slides", /全中文|全部.{0,4}中文|全程.{0,4}中文/], ["no English abbreviations", /英文缩写|英语缩写/], ["HDMI", /HDMI/i]] }, pending: [0, 1],
  },
  zhou_ran: {
    truths: [
      { prompt: "周然现在周五能喝什么？医生要求戒掉的酒和海鲜具体是什么？",
        rules: [["abstain from beer", /(?:戒|禁|避开|避免|不能|不喝|忌).{0,18}啤酒/], ["high-purine seafood", /高嘌呤海鲜/], ["permitted drinks", /温白开|温开水|柠檬苏打水/]] },
      { prompt: "小宇花生过敏后如果误食应该立刻去哪家医院？班级发点心要注意什么？",
        rules: [["peanut allergy", /花生.{0,12}过敏|过敏.{0,12}花生/], ["ER hospital", /儿研所/], ["snack label & teacher", /配料|老师/]] },
      { prompt: "拾光记对新用户的现行收费方式是什么？已买断的老用户有什么权益？年底前计划上线什么同步功能？",
        rules: [...subscription, ["grandfathered", /(?:老用户|原有用户|已买断|已购买).{0,30}(?:权益|保留|继续|无需|不需|买断)/], ["iCloud sync", /icloud/i]] },
    ],
    dual: { prompt: "周末带小宇去吃海鲜大餐配花生酱可以吗？拾光记现在怎么收费？莫干山住宿预算多少？",
      rules: [["peanut allergy", /花生.{0,18}过敏|过敏.{0,10}花生/], ["seafood restriction", /高嘌呤海鲜|高嘌呤的海鲜/], ...subscription, ["Moganshan", /莫干山/], ["nightly limit", /(?:1500|1,500|一千五百).{0,12}(?:晚|夜)|(?:晚|夜).{0,18}(?:1500|1,500|一千五百)/]] }, pending: [0],
  },
};

function grade(q: Query, answer: string) {
  const clean = answer.normalize("NFKC").replace(/\[(?:src|chat):[^\]]+\]/g, "").replace(/[\s*`]/g, "");
  const missing = q.rules.filter(([, re]) => !re.test(clean)).map(([label]) => label);
  const obsoleteSentence = q.obsolete && clean.split(/[。；！\n]/).find(sentence =>
    q.obsolete!.test(sentence) && !/原先|此前|曾经|先前|之前|旧版|旧方案|原定|原方案|原来|取代|替代|替换|改为|改用|切换|作废|取消|不再|已从|已由|而非/.test(sentence));
  const obsolete = obsoleteSentence ? q.obsolete!.exec(obsoleteSentence)?.[0] ?? null : null;
  const unsupported = q.unsupported?.exec(clean)?.[0] ?? null;
  return { pass: missing.length === 0 && !obsolete && !unsupported, missing, obsolete, unsupported };
}
async function retrieve(s: Dataset, query: string, v: number) {
  const input = {
    namespace: s.namespace, space_id: s.space_id, query, snapshot_version: v,
    return_mode: "both", verify_raw_sources: true, max_tokens: 7000,
  };
  try { return await http<RetrieveResult>("/v1/memories/retrieve", input); }
  catch (error) {
    if (!/HTTP (?:429|5\d\d)|MODEL_OUTPUT|LLM_FORMAT/.test(String(error))) throw error;
    console.error(`[${s.space_id}] read-only retrieval failed; retrying once: ${String(error)}`);
    return http<RetrieveResult>("/v1/memories/retrieve", input);
  }
}
async function truth(s: Dataset, q: Query, v: number) {
  const r = await retrieve(s, q.prompt + " 只列当前有效的结论，并附出处。", v);
  const score = grade(q, r.answer ?? "");
  return { query: q.prompt, ...score, pass: score.pass && r.snapshot_version === v && !!r.citations.length,
    answer: r.answer, sources: r.citations.map(c => ({ anchor: c.anchor, filename: c.filename })), pages: r.contexts.map(c => c.title) };
}
function auditNoise(v: number, pages: FileResult[]) {
  const hits = pages.flatMap(p => {
    assert.equal(p.version, v);
    // Count literal occurrences in compiled titles and bodies, including index,
    // timeline and conflicts. No raw excerpts, retrieval output or source JSON.
    return [p.frontmatter?.title ?? "", ...p.markdown.split("\n")].flatMap((line, index) =>
      keywords.flatMap(keyword => {
        const occurrences = line.split(keyword).length - 1;
        return occurrences ? [{ path: p.path, location: index ? `body line ${index}` : "frontmatter.title", keyword, occurrences, line }] : [];
      }));
  });
  return { files_scanned: pages.length, occurrences: hits.reduce((n, hit) => n + hit.occurrences, 0), hits };
}

// Inventory mentions of superseded values in the current entity/topic pages.
// Keep their full sentences: a page can legitimately mention a former price
// while explaining the newer one. The strict answer checks above test recall.
function legacyMentions(s: Dataset, pages: FileResult[]) {
  const terms: Record<string, RegExp> = {
    atlas_platform: /Qdrant|pgvector|350\s*(?:ms|毫秒)/i,
    enterprise_q4: /(?:180|155)\s*万|11\s*[-月/]\s*28|李总/,
    zhou_ran: /18\s*元|精酿|生蚝|阿里云\s*ECS/i,
  };
  return pages.filter(p => /^(entities|topics)\//.test(p.path)).flatMap(p => p.markdown.split("\n").filter(line => terms[s.space_id].test(line))
    .map(line => ({ path: p.path, title: p.frontmatter?.title, line })));
}
async function dual(s: Dataset, scenario: Scenario, v: number) {
  const q = scenario.dual;
  let wiki: RetrieveResult | undefined, wikiError: string | undefined;
  try { wiki = await retrieve(s, q.prompt, v); }
  catch (error) { wikiError = String(error); }
  const { session } = await http<{ session: ChatSession }>(stem(s, "chat") + "/sessions", { title: "Astra 双通道验收（临时）" });
  const path = "/v1/chat/sessions/" + session.session_id;
  try {
    const { assistant_message: m } = await http<SendMessageResponse>(path + "/messages", {
      content: q.prompt, max_tokens: 7000, verify_raw_sources: true, compare_baseline: false,
    });
    const hits = m.conversation_hits ?? [];
    const expected = scenario.pending.map(i => sessionId(s, s.pending[i]));
    const chats = hits.filter(h => h.session_status === "pending" && m.content.includes(`[chat:${h.session_id}#${h.turn_locator}]`));
    const turns = await Promise.all(chats.map(h => http<{ raw_excerpt: string }>(
      `/v1/chat/sessions/${h.session_id}/turn?locator=${h.turn_locator}`)));
    const score = grade(q, m.content);
    const citedIds = new Set(chats.map(h => h.session_id));
    const missingPending = expected.filter(id => !citedIds.has(id));
    const wikiAnchors = new Set(m.retrieval?.contexts.flatMap(c => c.citations.map(cit => cit.anchor)));
    const wikiCited = m.citations.filter(c => wikiAnchors.has(c.anchor)).map(c => c.anchor);
    return { query: q.prompt, ...score, wiki_only_pass: wiki?.snapshot_version === v,
      pass: score.pass && !missingPending.length && wikiCited.length > 0 && m.retrieval?.snapshot_version === v,
      wiki_only_answer: wiki?.answer, wiki_only_error: wikiError, wiki_only_pages: wiki?.contexts.map(c => c.title), chat_answer: m.content,
      wiki_citations: wikiCited, missing_pending_citations: missingPending,
      cited_pending_turns: chats.map((h, i) => ({ session: h.session_id, locator: h.turn_locator, raw: turns[i].raw_excerpt })),
      raw_hits: hits.map(h => ({ session: h.session_id, status: h.session_status, locator: h.turn_locator })) };
  } finally {
    const removed = await http<{ deleted: boolean; forget_job_id: string | null }>(path, undefined, "DELETE");
    assert(removed.deleted && !removed.forget_job_id, "Audit probe was not removed cleanly");
  }
}

async function incremental(s: Dataset, final: SpaceOverviewResponse) {
  if (!s.followUp) return null;
  const sorted = [...final.snapshots].sort((x, y) => x.version - y.version);
  const baseSnap = sorted[s.batches.length - 1];
  const deltaSnap = sorted[s.batches.length];
  if (!baseSnap || !deltaSnap) return null;
  const [vBase, vDelta] = await Promise.all([overview(s, baseSnap.version), overview(s, deltaSnap.version)]);
  const a = vBase.active_snapshot!, b = vDelta.active_snapshot!;
  const job = final.jobs.find(j => j.job_id === b.job_id)!;
  const doc = job.accepted_docs[0], old = doc?.replaces_doc_id;
  const chat = s.batches.flat().find(c => c.title === s.followUp!.title)!;
  const totalDocs = s.batches.flat().length;
  const replacement = doc && old && !b.documents.includes(old) && a.documents.includes(old) &&
    b.documents.includes(doc.doc_id) && a.documents.filter(id => id !== old).every(id => b.documents.includes(id));
  const selfConflicts = (state: SpaceOverviewResponse) => state.conflicts.filter(item => {
    if (item.anchors.length < 2) return false;
    const ids = item.anchors.map(anchor => anchor.split("#")[0]);
    return ids.every(id => id === old || id === doc?.doc_id);
  });
  const conflicts = selfConflicts(vDelta);
  const afterDeep = selfConflicts(final);
  const from = chat.messages.length / 2 + 1;
  const source = await http<SourceResult>(stem(s, "admin") + `/source?version=${b.version}&doc_id=${doc.doc_id}&locator=t${from}`);
  const learned = vDelta.claims.facts.filter(f => f.docId === doc.doc_id && Number(f.locator.slice(1)) >= from && /外婆/.test(f.subject + f.value));
  const counts = [a.document_count, b.document_count, final.active_snapshot!.document_count];
  const expectedName = `session_${sessionId(s, chat)}_m${chat.messages.length + s.followUp.messages.length}.json`;
  return { pass: !!replacement && job.accepted_docs.length === 1 && doc.filename === expectedName &&
      doc.analyze_from_turn === from && counts.every(n => n === totalDocs) && !conflicts.length && !afterDeep.length &&
      !!learned.length && source.raw_excerpt?.includes("外婆") === true,
    versions: [a.version, b.version, final.active_snapshot!.version], document_counts: counts, old_doc: old, new_doc: doc.doc_id, analyze_from_turn: doc.analyze_from_turn,
    other_nine_retained: !!replacement, self_conflicts: conflicts, self_conflicts_after_deep: afterDeep,
    delta_source: source.raw_excerpt, delta_facts: learned };
}

async function audit(s: Dataset) {
  const state = await overview(s);
  const snap = state.active_snapshot!;
  const v = snap.version;
  const scenario = cases[s.space_id];
  const pages = await Promise.all(state.files.map(path =>
    http<FileResult>(stem(s, "admin") + `/file?version=${v}&path=${encodeURIComponent(path)}`)));
  const noise = auditNoise(v, pages);
  const legacy = legacyMentions(s, pages);
  const staleInstructions = s.space_id === "atlas_platform" ? legacy.filter(({ line }) =>
    /按\s*P99.{0,14}350\s*(?:ms|毫秒).{0,15}(?:出具|验收|出报告)/i.test(line) &&
    !/180\s*(?:ms|毫秒)|作废|曾按|原先|不再按|旧版/i.test(line)) : [];
  const checks = [];
  for (const q of scenario.truths) {
    try { checks.push(await truth(s, q, v)); }
    catch (error) { checks.push({ query: q.prompt, pass: false, error: String(error) }); }
  }
  let recall;
  try { recall = await dual(s, scenario, v); }
  catch (error) { recall = { query: scenario.dual.prompt, pass: false, error: String(error) }; }
  const delta = await incremental(s, state);
  const listing = await sessions(s);
  const pendingSearch = await Promise.all(s.pending.map(async c => {
    const id = sessionId(s, c);
    const { hits } = await http<{ hits: ConversationSearchHit[] }>(stem(s, "chat") +
      "/search?q=" + encodeURIComponent(c.title) + "&limit=8");
    const found = hits.filter(h => h.session_id === id && h.session_status === "pending" && !h.dreamed_doc_id);
    return { query: c.title, session: id, pass: found.length > 0, hits: found.map(h => ({ turn: h.turn_locator, excerpt: h.excerpt })) };
  }));
  const dreamed = listing.sessions.filter(r => r.status === "dreamed");
  const pendingIds = listing.sessions.filter(r => r.status === "pending").map(r => r.session_id).sort();
  const chats = [...s.batches.flat(), ...s.pending];
  const contentChecks = await Promise.all(chats.map(async c => {
    const id = sessionId(s, c);
    if (!listing.sessions.some(r => r.session_id === id)) {
      return { id, date: c.date, messages: 0, noise_messages: 0, pass: false, error: "Session missing" };
    }
    const row = await http<{ session: ChatSession; messages: ChatMessage[] }>(`/v1/chat/sessions/${id}`);
    const extra = s.followUp?.title === c.title ? s.followUp : undefined;
    const expected = [...c.messages, ...(extra?.messages ?? [])];
    const noiseCount = c.noiseMessages.length + (extra?.noiseMessages.length ?? 0);
    return { id, date: row.session.session_date, messages: row.messages.length, noise_messages: noiseCount, pass:
      row.session.title === c.title && row.session.session_date === c.date && row.session.space_key === `${s.namespace}:${s.space_id}` &&
      expected.length === row.messages.length && expected.every((m, i) => m.content === row.messages[i].content && m.role === row.messages[i].role) &&
      (s.pending.includes(c) ? row.session.status === "pending" && !row.session.dreamed_doc_id && !row.session.dreamed_message_count :
        row.session.status === "dreamed" && row.session.dreamed_message_count === expected.length) };
  }));
  const jobs = state.jobs.map(j => ({ id: j.job_id, type: j.job_type, version: j.target_version, status: j.status, calls: j.usage.llm_calls, error: j.error_message }));
  const versions = state.snapshots.sort((a, b) => a.version - b.version).map(p => ({
    version: p.version, documents: p.document_count, pages: p.page_count, job: p.job_id }));
  const totalHistorical = s.batches.flat().length;
  const totalChats = totalHistorical + s.pending.length;
  const expectedCounts: number[] = [];
  let acc = 0;
  for (const batch of s.batches) { acc += batch.length; expectedCounts.push(acc); }
  if (s.followUp) expectedCounts.push(totalHistorical);
  expectedCounts.push(totalHistorical);
  const historyOK = versions.every((p, i) => p.documents === expectedCounts[i] &&
    jobs.some(j => j.id === p.job && j.status === "published" && j.calls > 0 && j.type === (i + 1 === expectedVersions(s) ? "dream" : "ingest")));
  const shape = versions.length === expectedVersions(s) && historyOK && snap.document_count === totalHistorical &&
    listing.sessions.length === totalChats && listing.pending_count === s.pending.length && listing.dreaming_count === 0 && dreamed.length === totalHistorical &&
    pendingIds.join() === s.pending.map(c => sessionId(s, c)).sort().join() && contentChecks.every(c => c.pass) &&
    dreamed.every(r => snap.documents.includes(r.dreamed_doc_id!));
  const stats = { version: v, documents: snap.document_count, pages: snap.page_count, facts: state.stats.fact_count,
    conflicts: state.stats.conflict_count, pending_count: listing.pending_count };
  return { space: `${s.namespace}:${s.space_id}`, stats, shape, model: listing.model, pendingIds, contentChecks, versions, jobs,
    legacy_mentions_on_current_pages: legacy, stale_instructions: staleInstructions, conflict_entries: state.conflicts, pending_search: pendingSearch,
    noise, checks, dual: recall, incremental: delta, pass: shape && !staleInstructions.length && !noise.occurrences && checks.every(c => c.pass) &&
      pendingSearch.every(p => p.pass) && recall.pass && ("wiki_only_pass" in recall && recall.wiki_only_pass) && (delta?.pass ?? true) };
}

export async function verify() {
  const settled = await Promise.allSettled(datasets.map(audit));
  const spaces = settled.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
  const errors = settled.flatMap((r, i) => r.status === "rejected" ? [{ space: datasets[i].space_id, error: String(r.reason) }] : []);
  const pass = errors.length === 0 && spaces.every(s => s.pass);
  const report = { checked_at: new Date().toISOString(), server: origin, pass, keywords, spaces, errors };
  const md = ["# Astra live memory verification", "",
    `Checked ${report.checked_at} on ${origin}. Overall result **${pass ? "PASS" : "FAIL"}**.`, "",
    "| Space | Version | Documents | Pages | Facts | Conflicts | Pending | Noise occurrences |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...spaces.map(s => `| ${s.space} | ${Object.values(s.stats).join(" | ")} | ${s.noise.occurrences} |`), "",
    "Documents are active snapshot documents. Facts and conflicts are the live overview counts. Noise is the number of literal keyword occurrences in all final published Markdown titles and bodies, including index, timeline and conflict history. The JSON gives every matching line. The input noise fraction is measured by annotated messages.", ""];
  for (const s of spaces) {
    md.push(`## ${s.space}`, "", `Snapshot progression: ${s.versions.map(v => `v${v.version} (${v.documents} docs)`).join(" → ")}.`, "",
      `Historical transcripts, live LLM publications and final queue: **${s.shape ? "PASS" : "FAIL"}**. Pending sessions: ${s.pendingIds.join(", ")}.`, "",
      `Noise target: **${s.noise.occurrences === 0 ? "PASS" : "FAIL"}**. ${s.noise.files_scanned} files scanned. ` +
      keywords.map(k => `${k} ${s.noise.hits.filter(h => h.keyword === k).reduce((n, h) => n + h.occurrences, 0)}`).join(" · "), "");
    for (const hit of s.stale_instructions) md.push(`**FAIL** · Superseded reporting instruction still present in ${hit.path}.`, "", "> " + hit.line, "");
    for (const c of s.checks) {
      md.push(`- **${c.pass ? "PASS" : "FAIL"}** ${c.query}`);
      if ("error" in c) md.push(`  ${c.error}`);
      else {
        if (c.missing.length || c.obsolete) md.push(`  Missing: ${c.missing.join(", ") || "none"}. Obsolete term: ${c.obsolete ?? "none"}.`);
        if (c.unsupported) md.push(`  Unsupported assertion: ${c.unsupported}.`);
        md.push("", ...(c.answer ?? "(no answer)").split("\n").map(l => "> " + l), "");
      }
    }
    md.push("", `### Dual-track recall · ${s.dual.pass ? "PASS" : "FAIL"}`, "", s.dual.query, "");
    if ("chat_answer" in s.dual) {
      md.push(`Standalone Wiki retrieval for the same question: **${s.dual.wiki_only_pass ? "PASS" : "FAIL"}**. ${s.dual.wiki_only_error ?? ""}`, "",
        ...s.dual.chat_answer.split("\n").map(l => "> " + l), "",
        `Missing answer details: ${s.dual.missing.join(", ") || "none"}. Missing pending citations: ${s.dual.missing_pending_citations.join(", ") || "none"}. Matched Wiki citations: ${s.dual.wiki_citations.length}.`, "");
    } else md.push(s.dual.error, "");
    if (s.incremental) md.push(`### Incremental re-dream · ${s.incremental.pass ? "PASS" : "FAIL"}`, "",
      `v4/v5/v6 documents: ${s.incremental.document_counts.join(" / ")}. Analysis began at t${s.incremental.analyze_from_turn}. Self-conflict entries: ${s.incremental.self_conflicts.length} at v5, ${s.incremental.self_conflicts_after_deep.length} at v6.`, "",
      `Replaced \`${s.incremental.old_doc}\` with \`${s.incremental.new_doc}\`. The source and extracted delta are included below.`, "");
  }
  for (const e of errors) md.push(`## ${e.space} audit error`, "", e.error, "");
  md.push("## Machine-readable evidence", "", "```json", JSON.stringify(report, null, 2), "```", "");
  await mkdir(dirname(reportPath), { recursive: true });
  const temp = reportPath + "." + process.pid + ".tmp";
  await writeFile(temp, md.join("\n"));
  await rename(temp, reportPath);
  console.log(JSON.stringify({ reportPath, pass, errors, spaces: spaces.map(s => ({ space: s.space, ...s.stats, noise: s.noise.occurrences,
    shape: s.shape, truth: s.checks.map(c => c.pass), dual: s.dual.pass, incremental: s.incremental?.pass })) }, null, 2));
  if (!pass) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  verify().catch(error => { console.error(error); process.exitCode = 1; });
}
