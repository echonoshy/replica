import type { Space } from "@replica/shared";
import { spaceKey } from "../db/interfaces.js";
import type { MetadataRepository } from "../db/interfaces.js";
import type { Ingestion } from "../pipeline/ingestion.js";
import type { ChatSessionRecord, SQLiteChatStore } from "./chat-store.js";
import { groupMessagesIntoTurns } from "./turns.js";

export interface ChatDreamDependencies {
  chatStore: SQLiteChatStore;
  ingestion: Ingestion;
  getJob: MetadataRepository["getJob"];
  wake: () => void;
}

export function digestPendingChatSessions(
  space: Space, { chatStore, ingestion, getJob, wake }: ChatDreamDependencies,
  select: (pending: ChatSessionRecord[]) => ChatSessionRecord[] = (pending) => pending,
) {
  const key = spaceKey(space);
  return chatStore.withDreamingLock(key, async () => {
    await chatStore.syncDreamingSessions(key, getJob);
    const sessions = chatStore.listSessions(key);
    const active = sessions.filter((session) => session.status === "dreaming");
    if (active.length) {
      const job = await getJob(active[0].dreamed_job_id!);
      return job ? { job, sessions: active, submitted: false } : undefined;
    }

    const pending = select(sessions.filter((session) =>
      session.status === "pending" && session.message_count > session.dreamed_message_count));
    if (!pending.length) return undefined;
    const exports = pending.map((session) => {
      const messages = chatStore.getMessages(session.session_id).map(({ role, content }) => ({ role, content }));
      const filename = `session_${session.session_id}_m${messages.length}.json`;
      const replacesDocId = session.dreamed_version !== null && session.dreamed_message_count > 0
        ? session.dreamed_doc_id ?? undefined : undefined;
      let analyzeFromTurn: number | undefined;
      if (replacesDocId) {
        const prior = groupMessagesIntoTurns(messages.slice(0, session.dreamed_message_count));
        const current = groupMessagesIntoTurns(messages);
        const changed = prior.findIndex((turn, index) => turn.text !== current[index]?.text);
        analyzeFromTurn = (changed < 0 ? prior.length : changed) + 1;
      }
      return {
        session, messageCount: messages.length,
        item: {
          filename, docDate: session.session_date, replacesDocId, analyzeFromTurn,
          bytes: Buffer.from(JSON.stringify({ session_id: session.session_id, messages })),
        },
      };
    });

    const job = await ingestion.submit(space, exports.map(({ item }) => item), space.purpose, undefined, (queued) => {
      const docs = new Map(queued.payload.docs.map((doc) => [doc.filename, doc.doc_id]));
      chatStore.markSessionsDreaming(exports.map(({ session, messageCount, item }) => ({
        sessionId: session.session_id, messageCount, docId: docs.get(item.filename)!, expectedDocId: session.dreamed_doc_id,
      })), queued.id);
    });
    wake();
    return { job, sessions: pending, submitted: true };
  });
}
