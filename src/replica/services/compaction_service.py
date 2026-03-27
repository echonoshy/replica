"""Compaction and memory flush logic.

Handles:
- Pre-compaction flush: when token_count > soft_threshold, extract key info into memory_notes
- Hard compaction: when token_count > hard_threshold, summarize old messages and soft-delete them
- Session-end archive: extract last N messages into a memory note
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.models.message import Message, MessageType, MessageRole
from replica.models.memory_note import MemoryNote, NoteType, NoteSource
from replica.models.memory_chunk import MemoryChunk
from replica.models.session import Session
from replica.services.embedding_service import count_tokens, chunk_text, get_provider


async def check_and_compact(db: AsyncSession, session: Session) -> None:
    """Check if session needs flush or compaction, and execute if so."""
    if session.token_count >= settings.soft_threshold_tokens:
        await memory_flush(db, session)

    if session.token_count >= settings.hard_threshold_tokens:
        await compact(db, session)


async def memory_flush(db: AsyncSession, session: Session) -> MemoryNote:
    """Pre-compaction flush: save important context as a memory note.

    In production, this would call an LLM to summarize. For now, it concatenates
    recent messages as a note. Replace the content generation with your LLM call.
    """
    result = await db.execute(
        select(Message)
        .where(Message.session_id == session.id, Message.is_compacted == False)  # noqa: E712
        .order_by(Message.created_at.desc())
        .limit(settings.session_end_extract_messages)
    )
    messages = list(reversed(result.scalars().all()))

    if not messages:
        return None

    # TODO: replace with LLM summarization call
    content = _format_messages_as_note(messages)

    note = MemoryNote(
        user_id=session.user_id,
        session_id=session.id,
        note_type=NoteType.daily,
        content=content,
        source=NoteSource.auto_flush,
    )
    db.add(note)
    await db.flush()

    # Chunk and embed
    await _index_note(db, note)
    return note


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

    # Keep recent messages under keep_recent_tokens
    keep = []
    kept_tokens = 0
    for msg in reversed(all_messages):
        if kept_tokens + msg.token_count > settings.keep_recent_tokens:
            break
        keep.append(msg)
        kept_tokens += msg.token_count
    keep_ids = {m.id for m in keep}

    # Mark old messages as compacted
    old_messages = [m for m in all_messages if m.id not in keep_ids]
    if not old_messages:
        return

    # TODO: replace with LLM summarization
    summary_text = _format_messages_as_note(old_messages)

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

    # Recalculate session token count
    session.token_count = kept_tokens + summary.token_count
    session.compaction_count += 1
    await db.commit()


async def archive_session_memory(
    db: AsyncSession, session_id: uuid.UUID
) -> MemoryNote | None:
    """Extract memory from a session being archived."""
    session = await db.get(Session, session_id)
    if not session:
        return None

    result = await db.execute(
        select(Message)
        .where(
            Message.session_id == session_id,
            Message.is_compacted == False,  # noqa: E712
            Message.role.in_([MessageRole.user, MessageRole.assistant]),
        )
        .order_by(Message.created_at.desc())
        .limit(settings.session_end_extract_messages)
    )
    messages = list(reversed(result.scalars().all()))

    if not messages:
        return None

    # TODO: replace with LLM summarization
    content = _format_messages_as_note(messages)

    note = MemoryNote(
        user_id=session.user_id,
        session_id=session_id,
        note_type=NoteType.daily,
        content=content,
        source=NoteSource.session_end,
    )
    db.add(note)
    await db.flush()
    await _index_note(db, note)
    await db.commit()
    return note


async def _index_note(db: AsyncSession, note: MemoryNote) -> None:
    """Chunk a note and create embeddings."""
    chunks = chunk_text(note.content)
    if not chunks:
        return

    provider = get_provider()
    texts = [c["text"] for c in chunks]
    embeddings = await provider.embed_texts(texts)

    for chunk_data, embedding in zip(chunks, embeddings):
        chunk = MemoryChunk(
            user_id=note.user_id,
            note_id=note.id,
            chunk_text=chunk_data["text"],
            embedding=embedding,
            chunk_index=chunk_data["chunk_index"],
            start_offset=chunk_data["start_offset"],
            end_offset=chunk_data["end_offset"],
        )
        db.add(chunk)


def _format_messages_as_note(messages: list[Message]) -> str:
    """Simple formatting — replace with LLM summarization in production."""
    lines = []
    for msg in messages:
        lines.append(f"[{msg.role.value}]: {msg.content}")
    return "\n\n".join(lines)
