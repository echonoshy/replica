"""Compaction service — simple token-based compaction.

Handles:
- Hard compaction: when token_count >= hard_threshold, keep recent messages and mark old ones as compacted.
- Uses SELECT FOR UPDATE on the session row to prevent concurrent compactions.
- No LLM summarization, no memory extraction (extraction is handled separately).
"""

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.models.message import Message, MessageType
from replica.models.session import Session

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
    """Simple compaction: keep recent messages, mark old ones as compacted.

    No LLM summarization, no memory extraction.
    """
    result = await db.execute(
        select(Message)
        .where(Message.session_id == session.id, Message.is_compacted == False)  # noqa: E712
        .order_by(Message.created_at)
    )
    all_messages = result.scalars().all()

    if not all_messages:
        return

    # Separate chat messages from summaries
    chat_messages = [m for m in all_messages if m.message_type == MessageType.message]

    if not chat_messages:
        logger.debug("No chat messages to compact for session %s, skipping", session.id)
        return

    # Keep recent messages up to keep_recent_tokens
    keep = []
    kept_tokens = 0
    for msg in reversed(chat_messages):
        if kept_tokens + msg.token_count > settings.keep_recent_tokens:
            break
        keep.append(msg)
        kept_tokens += msg.token_count
    keep_ids = {m.id for m in keep}

    # Mark old messages as compacted
    old_chat = [m for m in chat_messages if m.id not in keep_ids]
    if not old_chat:
        logger.debug("No messages to compact for session %s, all within keep threshold", session.id)
        return

    for msg in old_chat:
        msg.is_compacted = True

    session.token_count = kept_tokens
    session.compaction_count += 1
    await db.commit()

    logger.info(
        "Compaction #%d for session %s: %d msgs compacted, token_count %d → %d",
        session.compaction_count,
        session.id,
        len(old_chat),
        kept_tokens + sum(m.token_count for m in old_chat),
        session.token_count,
    )
