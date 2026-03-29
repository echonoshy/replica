"""Memory API — Evergreen CRUD, knowledge search, and context building."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.evergreen_memory import EvergreenMemory, EvergreenSource
from replica.services.memory_service import search_knowledge
from replica.api.schemas import (
    EvergreenMemoryCreate,
    EvergreenMemoryOut,
    KnowledgeSearchRequest,
    KnowledgeSearchResult,
    ContextBuildRequest,
    ContextBuildResponse,
)

router = APIRouter()


# ---------- Evergreen Memory ----------


@router.get("/users/{user_id}/evergreen", response_model=list[EvergreenMemoryOut])
async def list_evergreen(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(EvergreenMemory).where(EvergreenMemory.user_id == user_id).order_by(EvergreenMemory.created_at.desc())
    )
    return result.scalars().all()


@router.post("/users/{user_id}/evergreen", response_model=EvergreenMemoryOut, status_code=201)
async def create_evergreen(user_id: uuid.UUID, body: EvergreenMemoryCreate, db: AsyncSession = Depends(get_db)):
    mem = EvergreenMemory(
        user_id=user_id,
        category=body.category,
        content=body.content,
        source=EvergreenSource.manual,
    )
    db.add(mem)
    await db.commit()
    await db.refresh(mem)
    return mem


@router.delete("/evergreen/{memory_id}", status_code=204)
async def delete_evergreen(memory_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    mem = await db.get(EvergreenMemory, memory_id)
    if not mem:
        raise HTTPException(404, "Evergreen memory not found")
    await db.delete(mem)
    await db.commit()


# ---------- Knowledge Search ----------


@router.post("/knowledge/search", response_model=list[KnowledgeSearchResult])
async def knowledge_search(body: KnowledgeSearchRequest, db: AsyncSession = Depends(get_db)):
    return await search_knowledge(db, body)


# ---------- Context Build ----------


@router.post("/context/build", response_model=ContextBuildResponse)
async def build_context(body: ContextBuildRequest, db: AsyncSession = Depends(get_db)):
    from replica.services.context_service import build_context

    return await build_context(db, body)
