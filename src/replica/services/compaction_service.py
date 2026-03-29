"""Compaction service — hard compaction only.

The old memory_flush (daily notes) has been removed. Knowledge extraction is
now handled by the Memorize pipeline (triggered asynchronously).

Handles:
- Hard compaction: when token_count >= hard_threshold, summarize old messages
  and soft-delete them, keeping the most recent messages.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.models.message import Message, MessageType, MessageRole
from replica.models.session import Session
from replica.services.embedding_service import count_tokens


async def check_and_compact(db: AsyncSession, session: Session) -> None:
    """Check if session needs compaction and execute if so."""
    if session.token_count >= settings.hard_threshold_tokens:
        await compact(db, session)


async def compact(db: AsyncSession, session: Session) -> None:
    """Hard compaction: summarize old messages and soft-delete them."""
    result = await db.execute(
        select(Message)
        .where(Message.session_id == session.id, Message.is_compacted == False)  # noqa: E712
        .order_by(Message.created_at)
    )
    all_messages = result.scalars().all()

    if not all_messages:
        return

    keep = []
    kept_tokens = 0
    for msg in reversed(all_messages):
        if kept_tokens + msg.token_count > settings.keep_recent_tokens:
            break
        keep.append(msg)
        kept_tokens += msg.token_count
    keep_ids = {m.id for m in keep}

    old_messages = [m for m in all_messages if m.id not in keep_ids]
    if not old_messages:
        return

    # TODO: replace with LLM summarization
    summary_text = _format_messages_as_summary(old_messages)

    summary = Message(
        session_id=session.id,
        role=MessageRole.system,
        content=summary_text,
        token_count=count_tokens(summary_text),
        message_type=MessageType.compaction_summary,
    )
    db.add(summary)

    for msg in old_messages:
        msg.is_compacted = True

    session.token_count = kept_tokens + summary.token_count
    session.compaction_count += 1
    await db.commit()


def _format_messages_as_summary(messages: list[Message]) -> str:
    """Simple formatting — replace with LLM summarization in production."""
    lines = []
    for msg in messages:
        lines.append(f"[{msg.role.value}]: {msg.content}")
    return "\n\n".join(lines)
