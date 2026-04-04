"""Semantic compaction service — LLM-based message summarization.

Handles:
- Semantic segmentation of messages by topic/time
- LLM-based summarization of message segments
- Async background compaction
- Manual and auto-triggered compaction
"""

import asyncio
import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.models.message import Message, MessageType, MessageRole
from replica.models.session import Session
from replica.services.embedding_service import count_tokens
from replica.services.task_manager import task_manager, TaskStatus
from replica.providers.llm_provider import get_llm_provider

logger = logging.getLogger(__name__)


async def segment_messages(messages: list[Message], segment_size: int = 20) -> list[list[Message]]:
    """Segment messages into chunks for summarization.

    Current strategy: simple fixed-size windowing.
    Future: can add embedding-based semantic similarity detection.

    Args:
        messages: Messages to segment
        segment_size: Number of messages per segment

    Returns:
        List of message segments
    """
    if len(messages) <= segment_size:
        return [messages] if messages else []

    segments = []
    for i in range(0, len(messages), segment_size):
        segment = messages[i : i + segment_size]
        if segment:
            segments.append(segment)

    return segments


async def summarize_segment(messages: list[Message]) -> str:
    """Use LLM to summarize a segment of messages.

    Args:
        messages: Messages to summarize

    Returns:
        Summary text
    """
    # Format conversation
    conversation_lines = []
    for msg in messages:
        timestamp = msg.created_at.strftime("%Y-%m-%d %H:%M") if msg.created_at else ""
        role_label = "User" if msg.role == MessageRole.user else "Assistant"
        conversation_lines.append(f"[{timestamp}] {role_label}: {msg.content}")

    conversation_text = "\n".join(conversation_lines)

    # Load prompt template
    from replica.prompts.en.compaction_prompts import SEGMENT_SUMMARIZATION_PROMPT

    if settings.memory.language == "zh":
        from replica.prompts.en.compaction_prompts import SEGMENT_SUMMARIZATION_PROMPT_ZH

        prompt = SEGMENT_SUMMARIZATION_PROMPT_ZH.format(conversation_text=conversation_text)
    else:
        prompt = SEGMENT_SUMMARIZATION_PROMPT.format(conversation_text=conversation_text)

    # Call LLM
    llm = get_llm_provider()
    messages_payload = [{"role": "user", "content": prompt}]

    try:
        response = await llm.chat(messages_payload, temperature=0.3, max_tokens=4096)
        summary = response.strip()

        # Remove common prefixes
        for prefix in ["Summary:", "总结:", "总结：", "摘要:", "摘要："]:
            if summary.startswith(prefix):
                summary = summary[len(prefix) :].strip()

        return summary
    except Exception as e:
        logger.error("LLM summarization failed: %s", e)
        # Fallback: simple truncation
        return f"[Summary of {len(messages)} messages from {messages[0].created_at} to {messages[-1].created_at}]"


async def semantic_compact(
    db: AsyncSession,
    session: Session,
    mode: str = "auto",
    keep_recent: int | None = None,
    task_id: str | None = None,
) -> dict:
    """Semantic compaction with LLM summarization.

    Args:
        db: Database session
        session: Session to compact
        mode: "auto" (conservative) or "manual" (aggressive)
        keep_recent: Number of recent messages to keep uncompacted
        task_id: Optional task ID for status tracking

    Returns:
        Compaction result details
    """
    if task_id:
        await task_manager.update_status(task_id, TaskStatus.processing)

    try:
        # Determine keep_recent based on mode
        if keep_recent is None:
            keep_recent = 10 if mode == "manual" else 20

        # Get all uncompacted messages
        result = await db.execute(
            select(Message)
            .where(
                Message.session_id == session.id,
                Message.is_compacted == False,  # noqa: E712
                Message.message_type == MessageType.message,
            )
            .order_by(Message.created_at)
        )
        all_messages = result.scalars().all()

        if len(all_messages) <= keep_recent:
            result_data = {
                "compacted_count": 0,
                "summary_count": 0,
                "segments": [],
                "token_reduction": 0,
                "compression_ratio": "100%",
                "message": "Not enough messages to compact",
            }
            if task_id:
                await task_manager.update_status(task_id, TaskStatus.completed, result=result_data)
            return result_data

        # Split: keep recent, compress older
        keep_messages = all_messages[-keep_recent:]
        to_compress = all_messages[:-keep_recent]

        logger.info(
            "Starting semantic compaction for session %s: %d messages to compress, %d to keep",
            session.id,
            len(to_compress),
            len(keep_messages),
        )

        # Segment messages
        segments = await segment_messages(to_compress, segment_size=20)

        logger.info("Compacting %d segments in parallel...", len(segments))

        # Generate summaries for all segments in parallel
        summary_tasks = [summarize_segment(segment) for segment in segments]
        summary_texts = await asyncio.gather(*summary_tasks)

        # Create summary messages and mark originals as compacted
        summaries = []
        segment_details = []

        for i, (segment, summary_text) in enumerate(zip(segments, summary_texts)):
            summary_tokens = count_tokens(summary_text)

            # Create summary message
            summary_msg = Message(
                session_id=session.id,
                role=MessageRole.assistant,
                content=summary_text,
                message_type=MessageType.compaction_summary,
                token_count=summary_tokens,
                parent_id=segment[0].id,  # Link to first message in segment
                is_compacted=False,  # Summary itself is not compacted
            )
            db.add(summary_msg)
            summaries.append(summary_msg)

            # Mark original messages as compacted
            for msg in segment:
                msg.is_compacted = True

            # Record segment details
            original_tokens = sum(m.token_count for m in segment)
            segment_details.append(
                {
                    "segment_id": i + 1,
                    "original_count": len(segment),
                    "original_tokens": original_tokens,
                    "summary_tokens": summary_tokens,
                    "compression_ratio": f"{summary_tokens / original_tokens * 100:.1f}%",
                    "time_range": {
                        "start": segment[0].created_at.isoformat() if segment[0].created_at else None,
                        "end": segment[-1].created_at.isoformat() if segment[-1].created_at else None,
                    },
                }
            )

        # Update session token count
        old_token_count = session.token_count
        new_token_count = sum(s.token_count for s in summaries) + sum(m.token_count for m in keep_messages)
        session.token_count = new_token_count
        session.compaction_count += 1

        await db.commit()

        token_reduction = old_token_count - new_token_count
        compression_ratio = f"{new_token_count / old_token_count * 100:.1f}%" if old_token_count > 0 else "100%"

        logger.info(
            "Semantic compaction completed for session %s (%s mode): "
            "%d messages → %d summaries, %d → %d tokens (%.1f%% reduction)",
            session.id,
            mode,
            len(to_compress),
            len(summaries),
            old_token_count,
            new_token_count,
            (token_reduction / old_token_count * 100) if old_token_count > 0 else 0,
        )

        result_data = {
            "compacted_count": len(to_compress),
            "summary_count": len(summaries),
            "segments": segment_details,
            "token_reduction": token_reduction,
            "compression_ratio": compression_ratio,
            "old_token_count": old_token_count,
            "new_token_count": new_token_count,
        }

        if task_id:
            await task_manager.update_status(task_id, TaskStatus.completed, result=result_data)

        return result_data

    except Exception as e:
        logger.exception("Semantic compaction failed for session %s", session.id)
        error_msg = str(e)
        if task_id:
            await task_manager.update_status(task_id, TaskStatus.failed, error=error_msg)
        raise


async def check_and_compact_auto(db: AsyncSession, session: Session) -> None:
    """Check if session needs compaction and trigger async compaction.

    This is called after each chat message. Does not block the response.
    """
    if session.token_count < settings.hard_threshold_tokens:
        return

    logger.info("Session %s exceeds threshold (%d tokens), triggering auto compaction", session.id, session.token_count)

    # Create background task (fire and forget)
    asyncio.create_task(_auto_compact_background(session.id))


async def _auto_compact_background(session_id: UUID) -> None:
    """Background task for auto compaction.

    Creates its own DB session to avoid conflicts.
    """
    from replica.db.database import async_session_maker

    try:
        async with async_session_maker() as db:
            # Lock session to prevent concurrent compaction
            result = await db.execute(select(Session).where(Session.id == session_id).with_for_update(skip_locked=True))
            session = result.scalar_one_or_none()

            if session is None:
                logger.debug("Session %s already being compacted, skipping", session_id)
                return

            if session.token_count < settings.hard_threshold_tokens:
                logger.debug("Session %s no longer needs compaction", session_id)
                return

            # Perform compaction
            await semantic_compact(db, session, mode="auto")

    except Exception:
        logger.exception("Auto compaction background task failed for session %s", session_id)


async def _compact_with_new_session(session_id: UUID, task_id: str, mode: str = "manual") -> None:
    """Background task for manual async compaction.

    Creates its own DB session to avoid conflicts.
    """
    from replica.db.database import async_session_maker

    try:
        async with async_session_maker() as db:
            # Lock session to prevent concurrent compaction
            result = await db.execute(select(Session).where(Session.id == session_id).with_for_update(skip_locked=True))
            session = result.scalar_one_or_none()

            if session is None:
                await task_manager.update_status(task_id, TaskStatus.failed, error="Session not found or locked")
                return

            # Perform compaction
            await semantic_compact(db, session, mode=mode, task_id=task_id)

    except Exception as e:
        logger.exception("Manual async compaction failed for session %s", session_id)
        await task_manager.update_status(task_id, TaskStatus.failed, error=str(e))
