import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.session import Session
from replica.models.message import Message
from replica.api.schemas import (
    SessionCreate,
    SessionOut,
    MemorizeResponse,
    CompactionTaskResponse,
    TaskStatusResponse,
)
from replica.services.extraction_service import ExtractionService
from replica.services.task_manager import task_manager

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


@router.post("/sessions/{session_id}/compact", response_model=CompactionTaskResponse)
async def manual_compact_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Manually trigger semantic compaction.

    Returns a task_id immediately. Use GET /tasks/{task_id} to check status.
    """
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    # Create task
    task_id = await task_manager.create_task("semantic_compaction", str(session_id))

    # Start background compaction
    from replica.services.semantic_compaction_service import _compact_with_new_session

    import asyncio

    asyncio.create_task(_compact_with_new_session(session_id, task_id, mode="manual"))

    logger.info("Async semantic compaction task %s created for session %s", task_id, session_id)
    return CompactionTaskResponse(
        task_id=task_id,
        status="processing",
        message="Compaction started. Use GET /tasks/{task_id} to check status.",
    )


@router.get("/tasks/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    """Get status of an async task (compaction, extraction, etc.)."""
    task = await task_manager.get_task(task_id)
    if not task:
        raise HTTPException(404, "Task not found")

    return TaskStatusResponse(
        task_id=task.task_id,
        task_type=task.task_type,
        session_id=task.session_id,
        status=task.status.value,
        created_at=task.created_at.isoformat(),
        started_at=task.started_at.isoformat() if task.started_at else None,
        completed_at=task.completed_at.isoformat() if task.completed_at else None,
        result=task.result,
        error=task.error,
    )
