import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.user import User
from replica.models.session import Session
from replica.models.message import Message
from replica.models.evergreen_memory import EvergreenMemory
from replica.models.knowledge_entry import KnowledgeEntry
from replica.models.memcell import MemCell
from replica.api.schemas import UserCreate, UserOut

router = APIRouter()


@router.get("/users", response_model=list[UserOut])
async def list_users(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    return result.scalars().all()


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(body: UserCreate, db: AsyncSession = Depends(get_db)):
    user = User(external_id=body.external_id, name=body.name, metadata_=body.metadata)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return user


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Delete a user and all associated data (sessions, messages, memories, knowledge)."""
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    session_ids_result = await db.execute(select(Session.id).where(Session.user_id == user_id))
    session_ids = [row[0] for row in session_ids_result.all()]

    if session_ids:
        await db.execute(delete(Message).where(Message.session_id.in_(session_ids)))
        await db.execute(delete(Session).where(Session.user_id == user_id))

    user_id_str = str(user_id)
    await db.execute(delete(EvergreenMemory).where(EvergreenMemory.user_id == user_id))
    await db.execute(delete(KnowledgeEntry).where(KnowledgeEntry.user_id == user_id_str))
    await db.execute(delete(MemCell).where(MemCell.user_id == user_id_str))

    await db.delete(user)
    await db.commit()
