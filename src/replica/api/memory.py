import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.models.memory_note import MemoryNote, NoteSource
from replica.services.memory_service import search_memory
from replica.api.schemas import (
    MemoryNoteCreate,
    MemoryNoteOut,
    MemorySearchRequest,
    MemorySearchResult,
    ContextBuildRequest,
    ContextBuildResponse,
)

router = APIRouter()


@router.post("/memory/search", response_model=list[MemorySearchResult])
async def memory_search(body: MemorySearchRequest, db: AsyncSession = Depends(get_db)):
    return await search_memory(db, body)


@router.get("/users/{user_id}/memory", response_model=list[MemoryNoteOut])
async def list_memory_notes(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(MemoryNote)
        .where(MemoryNote.user_id == user_id)
        .order_by(MemoryNote.created_at.desc())
    )
    return result.scalars().all()


@router.post("/users/{user_id}/memory", response_model=MemoryNoteOut, status_code=201)
async def create_memory_note(user_id: uuid.UUID, body: MemoryNoteCreate, db: AsyncSession = Depends(get_db)):
    note = MemoryNote(
        user_id=user_id,
        note_type=body.note_type,
        content=body.content,
        source=NoteSource.manual,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    # TODO: async chunk + embed via embedding_service
    return note


@router.delete("/memory/{note_id}", status_code=204)
async def delete_memory_note(note_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    note = await db.get(MemoryNote, note_id)
    if not note:
        raise HTTPException(404, "Memory note not found")
    await db.delete(note)
    await db.commit()


@router.post("/context/build", response_model=ContextBuildResponse)
async def build_context(body: ContextBuildRequest, db: AsyncSession = Depends(get_db)):
    from replica.services.context_service import build_context
    return await build_context(db, body)
