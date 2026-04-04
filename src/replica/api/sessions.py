import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.session import Session
from replica.models.message import Message
from replica.api.schemas import SessionCreate, SessionOut, MemorizeResponse, CompactionResponse
from replica.services.extraction_service import ExtractionService
from replica.services.compaction_service import compact

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/users/{user_id}/sessions", response_model=SessionOut, status_code=201)
async def create_session(user_id: uuid.UUID, body: SessionCreate, db: AsyncSession = Depends(get_db)):
    session = Session(user_id=user_id, metadata_=body.metadata)
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


@router.get("/users/{user_id}/sessions", response_model=list[SessionOut])
async def list_sessions(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Session).where(Session.user_id == user_id).order_by(Session.created_at.desc()))
    return result.scalars().all()


@router.get("/sessions/{session_id}", response_model=SessionOut)
async def get_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return session


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Delete a session and all its messages."""
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    await db.execute(delete(Message).where(Message.session_id == session_id))
    await db.delete(session)
    await db.commit()


@router.post("/sessions/{session_id}/memorize", response_model=MemorizeResponse, status_code=201)
async def memorize_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    result = await db.execute(
        select(Message)
        .where(Message.session_id == session_id, Message.is_compacted == False)  # noqa: E712
        .order_by(Message.created_at)
    )
    messages = result.scalars().all()
    if not messages:
        raise HTTPException(400, "No messages to memorize")

    raw_data = [{"role": msg.role, "content": msg.content} for msg in messages if msg.role in ("user", "assistant")]
    if len(raw_data) < 2:
        raise HTTPException(400, "Not enough messages to memorize (need at least 2)")

    from replica.services.memorize_service import MemorizePipeline

    pipeline = MemorizePipeline()
    user_id_str = str(session.user_id) if session.user_id else None

    count = await pipeline.memorize(
        db,
        new_raw_data_list=raw_data,
        user_id_list=[user_id_str] if user_id_str else None,
        force=True,
    )
    return MemorizeResponse(memory_count=count)


@router.post("/sessions/{session_id}/end", response_model=MemorizeResponse)
async def end_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """End a session and extract memories from all messages."""
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    if session.ended_at:
        raise HTTPException(400, "Session already ended")

    # Extract memories
    extraction_service = ExtractionService()
    count = await extraction_service.extract_from_session(db, session_id)

    # Mark session as ended
    session.ended_at = datetime.now(timezone.utc)
    await db.commit()

    logger.info("Session %s ended, extracted %d memories", session_id, count)
    return MemorizeResponse(memory_count=count)


@router.post("/sessions/{session_id}/extract-memory", response_model=MemorizeResponse)
async def manual_extract_memory(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Manually trigger memory extraction for a session."""
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    extraction_service = ExtractionService()
    count = await extraction_service.extract_from_session(db, session_id)

    logger.info("Manual extraction for session %s: %d memories extracted", session_id, count)
    return MemorizeResponse(memory_count=count)


@router.post("/sessions/{session_id}/compact", response_model=CompactionResponse)
async def manual_compact_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Manually trigger compaction for a session.

    For manual compaction, we keep only the most recent 10 messages (approximately 5000 tokens)
    to make the compaction more aggressive and visible to users.
    """
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    # Get message count before compaction
    result = await db.execute(
        select(Message).where(Message.session_id == session_id, Message.is_compacted == False)  # noqa: E712
    )
    messages_before = len(result.scalars().all())

    # Perform compaction with aggressive threshold (keep only ~5000 tokens for manual compaction)
    await compact(db, session, keep_tokens=5000)
    await db.refresh(session)

    # Get message count after compaction
    result = await db.execute(
        select(Message).where(Message.session_id == session_id, Message.is_compacted == False)  # noqa: E712
    )
    messages_after = len(result.scalars().all())

    compacted_count = messages_before - messages_after

    logger.info("Manual compaction for session %s: %d messages compacted", session_id, compacted_count)
    return CompactionResponse(
        compacted_count=compacted_count,
        token_count=session.token_count,
        compaction_count=session.compaction_count,
    )
