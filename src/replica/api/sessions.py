import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.session import Session, SessionStatus
from replica.api.schemas import SessionCreate, SessionOut

router = APIRouter()


@router.post("/users/{user_id}/sessions", response_model=SessionOut, status_code=201)
async def create_session(
    user_id: uuid.UUID, body: SessionCreate, db: AsyncSession = Depends(get_db)
):
    session = Session(user_id=user_id, metadata_=body.metadata)
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


@router.get("/users/{user_id}/sessions", response_model=list[SessionOut])
async def list_sessions(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Session)
        .where(Session.user_id == user_id)
        .order_by(Session.created_at.desc())
    )
    return result.scalars().all()


@router.post("/sessions/{session_id}/archive", response_model=SessionOut)
async def archive_session(session_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    session.status = SessionStatus.archived
    await db.commit()
    await db.refresh(session)
    # TODO: trigger session-end memory extraction via compaction_service
    return session
