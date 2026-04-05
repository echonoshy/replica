import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, delete, exists
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.session import Session
from replica.models.message import Message, ExtractionStatus
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


async def check_has_unextracted_messages(db: AsyncSession, session_id: uuid.UUID) -> bool:
    """Check if a session has any unextracted messages."""
    result = await db.execute(
        select(exists().where(Message.session_id == session_id, Message.extraction_status == ExtractionStatus.pending))
    )
    return result.scalar() or False


async def session_to_out(db: AsyncSession, session: Session) -> SessionOut:
    """Convert Session model to SessionOut schema with has_unextracted_messages."""
    has_unextracted = await check_has_unextracted_messages(db, session.id)
    return SessionOut(
        id=session.id,
        user_id=session.user_id,
        status=session.status,
        token_count=session.token_count,
        compaction_count=session.compaction_count,
        created_at=session.created_at,
        has_unextracted_messages=has_unextracted,
    )


@router.post("/users/{user_id}/sessions", response_model=SessionOut, status_code=201)
async def create_session(user_id: uuid.UUID, body: SessionCreate, db: AsyncSession = Depends(get_db)):
    session = Session(user_id=user_id, metadata_=body.metadata)
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return await session_to_out(db, session)


@router.get("/users/{user_id}/sessions", response_model=list[SessionOut])
async def list_sessions(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Session).where(Session.user_id == user_id).order_by(Session.created_at.desc()))
    sessions = result.scalars().all()
    return [await session_to_out(db, s) for s in sessions]


@router.get("/sessions/{session_id}", response_model=SessionOut)
async def get_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return await session_to_out(db, session)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Delete a session and all its messages."""
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    await db.execute(delete(Message).where(Message.session_id == session_id))
    await db.delete(session)
    await db.commit()




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
