import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.session import Session
from replica.models.message import Message
from replica.api.schemas import SessionCreate, SessionOut, MemorizeResponse

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
