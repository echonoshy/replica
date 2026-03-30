"""Compaction service — hard compaction with auto memory extraction.

Handles:
- Hard compaction: when token_count >= hard_threshold, summarize old messages,
  extract knowledge from them, and soft-delete them.
- Uses SELECT FOR UPDATE on the session row to prevent concurrent compactions.
- Replaces any existing compaction_summary rather than stacking summaries.
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.models.message import Message, MessageType, MessageRole
from replica.models.session import Session
from replica.services.embedding_service import count_tokens

logger = logging.getLogger(__name__)


async def check_and_compact(db: AsyncSession, session: Session) -> None:
    """Check if session needs compaction and execute if so."""
    if session.token_count < settings.hard_threshold_tokens:
        return

    locked = await db.execute(select(Session).where(Session.id == session.id).with_for_update(skip_locked=True))
    locked_session = locked.scalar_one_or_none()
    if locked_session is None:
        logger.debug("Session %s already being compacted by another request, skipping", session.id)
        return

    if locked_session.token_count < settings.hard_threshold_tokens:
        return

    await compact(db, locked_session)


async def compact(db: AsyncSession, session: Session) -> None:
    """Hard compaction: extract knowledge from old messages, summarize, and soft-delete."""
    result = await db.execute(
        select(Message)
        .where(Message.session_id == session.id, Message.is_compacted == False)  # noqa: E712
        .order_by(Message.created_at)
    )
    all_messages = result.scalars().all()

    if not all_messages:
        return

    chat_messages = [m for m in all_messages if m.message_type == MessageType.message]
    old_summaries = [m for m in all_messages if m.message_type == MessageType.compaction_summary]

    keep = []
    kept_tokens = 0
    for msg in reversed(chat_messages):
        if kept_tokens + msg.token_count > settings.keep_recent_tokens:
            break
        keep.append(msg)
        kept_tokens += msg.token_count
    keep_ids = {m.id for m in keep}

    old_chat = [m for m in chat_messages if m.id not in keep_ids]
    if not old_chat:
        logger.debug("No chat messages to compact for session %s, skipping", session.id)
        return

    await _extract_knowledge_from_messages(db, session, old_chat)

    summary_text = _build_compacted_summary(old_summaries, old_chat)

    for msg in old_chat:
        msg.is_compacted = True
    for msg in old_summaries:
        msg.is_compacted = True

    summary = Message(
        session_id=session.id,
        role=MessageRole.system,
        content=summary_text,
        token_count=count_tokens(summary_text),
        message_type=MessageType.compaction_summary,
    )
    db.add(summary)

    session.token_count = kept_tokens + summary.token_count
    session.compaction_count += 1
    await db.commit()
    logger.info(
        "Compaction #%d for session %s: %d msgs compacted, token_count %d → %d",
        session.compaction_count,
        session.id,
        len(old_chat) + len(old_summaries),
        kept_tokens + sum(m.token_count for m in old_chat) + sum(m.token_count for m in old_summaries),
        session.token_count,
    )


async def _extract_knowledge_from_messages(db: AsyncSession, session: Session, messages: list[Message]) -> None:
    """Run the memorize pipeline on messages being compacted."""
    raw_data = [{"role": msg.role, "content": msg.content} for msg in messages if msg.role in ("user", "assistant")]
    if len(raw_data) < 3:
        return

    try:
        from replica.services.memorize_service import MemorizePipeline

        pipeline = MemorizePipeline()
        user_id_str = str(session.user_id) if session.user_id else None

        count = await pipeline.memorize(
            db,
            new_raw_data_list=raw_data,
            user_id_list=[user_id_str] if user_id_str else None,
            force=True,
        )
        logger.info("Auto-memorize during compaction: extracted %d knowledge entries", count)
    except Exception:
        logger.exception("Auto-memorize during compaction failed, continuing with compaction")


def _build_compacted_summary(old_summaries: list[Message], old_chat: list[Message]) -> str:
    """Build a compacted summary from previous summaries + new chat messages.

    Keeps the latest previous summary as-is (it already covers earlier history)
    and appends only the new chat messages, avoiding the snowball effect of
    re-including all previous summary content.
    """
    parts: list[str] = []

    if old_summaries:
        latest_summary = max(old_summaries, key=lambda m: m.created_at)
        parts.append(latest_summary.content)

    for msg in old_chat:
        parts.append(f"[{msg.role.value}]: {msg.content}")

    return "\n\n".join(parts)
