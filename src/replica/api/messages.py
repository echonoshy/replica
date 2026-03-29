import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.message import Message
from replica.models.session import Session
from replica.services.embedding_service import count_tokens
from replica.services.compaction_service import check_and_compact
from replica.api.schemas import MessageCreate, MessageOut

router = APIRouter()


@router.post("/sessions/{session_id}/messages", response_model=MessageOut, status_code=201)
async def create_message(session_id: uuid.UUID, body: MessageCreate, db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    tokens = count_tokens(body.content)
    msg = Message(
        session_id=session_id,
        parent_id=body.parent_id,
        role=body.role,
        content=body.content,
        token_count=tokens,
        message_type=body.message_type,
    )
    db.add(msg)

    # Update session token count
    session.token_count += tokens
    await db.commit()
    await db.refresh(msg)

    await check_and_compact(db, session)
    return msg


@router.get("/sessions/{session_id}/messages", response_model=list[MessageOut])
async def list_messages(
    session_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    include_compacted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
):
    query = select(Message).where(Message.session_id == session_id)
    if not include_compacted:
        query = query.where(Message.is_compacted == False)  # noqa: E712
    result = await db.execute(query.order_by(Message.created_at).offset(offset).limit(limit))
    return result.scalars().all()
