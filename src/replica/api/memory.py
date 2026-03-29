"""Memory API — Evergreen CRUD, knowledge search, and context building."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.evergreen_memory import EvergreenMemory, EvergreenSource
from replica.models.knowledge_entry import KnowledgeEntry, EntryType
from replica.services.memory_service import search_knowledge
from replica.api.schemas import (
    EvergreenMemoryCreate,
    EvergreenMemoryOut,
    KnowledgeSearchRequest,
    KnowledgeSearchResult,
    KnowledgeEntryOut,
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


@router.get("/users/{user_id}/knowledge", response_model=list[KnowledgeEntryOut])
async def list_user_knowledge(
    user_id: uuid.UUID,
    entry_type: EntryType | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List all knowledge entries for a user, optionally filtered by entry_type."""
    query = select(KnowledgeEntry).where(KnowledgeEntry.user_id == str(user_id))
    if entry_type:
        query = query.where(KnowledgeEntry.entry_type == entry_type)
    query = query.order_by(KnowledgeEntry.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/users/{user_id}/knowledge/count")
async def count_user_knowledge(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Return knowledge count grouped by entry_type for a user."""
    result = await db.execute(
        select(KnowledgeEntry.entry_type, func.count())
        .where(KnowledgeEntry.user_id == str(user_id))
        .group_by(KnowledgeEntry.entry_type)
    )
    counts = {row[0].value: row[1] for row in result.fetchall()}
    total = sum(counts.values())
    return {"total": total, "by_type": counts}


@router.delete("/knowledge/{knowledge_id}", status_code=204)
async def delete_knowledge_entry(knowledge_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    entry = await db.get(KnowledgeEntry, knowledge_id)
    if not entry:
        raise HTTPException(404, "Knowledge entry not found")
    await db.delete(entry)
    await db.commit()


# ---------- Context Build ----------


@router.post("/context/build", response_model=ContextBuildResponse)
async def build_context(body: ContextBuildRequest, db: AsyncSession = Depends(get_db)):
    from replica.services.context_service import build_context

    return await build_context(db, body)
