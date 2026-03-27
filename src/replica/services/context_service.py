"""Context assembly: combine evergreen memories, relevant memories, and recent messages."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.models.message import Message
from replica.models.memory_note import MemoryNote, NoteType
from replica.services.memory_service import search_memory
from replica.api.schemas import (
    ContextBuildRequest,
    ContextBuildResponse,
    MemoryNoteOut,
    MemorySearchRequest,
    MessageOut,
)


async def build_context(
    db: AsyncSession, req: ContextBuildRequest
) -> ContextBuildResponse:
    # 1. Evergreen memories for this user
    result = await db.execute(
        select(MemoryNote)
        .where(
            MemoryNote.user_id == req.user_id,
            MemoryNote.note_type == NoteType.evergreen,
        )
        .order_by(MemoryNote.updated_at.desc())
    )
    evergreen = [MemoryNoteOut.model_validate(n) for n in result.scalars().all()]

    # 2. Relevant memories via hybrid search (if query provided)
    relevant = []
    if req.query:
        search_req = MemorySearchRequest(user_id=req.user_id, query=req.query, top_k=10)
        relevant = await search_memory(db, search_req)

    # 3. Recent messages in session
    result = await db.execute(
        select(Message)
        .where(Message.session_id == req.session_id, Message.is_compacted == False)  # noqa: E712
        .order_by(Message.created_at)
    )
    recent = [MessageOut.model_validate(m) for m in result.scalars().all()]

    return ContextBuildResponse(
        evergreen_memories=evergreen,
        relevant_memories=relevant,
        recent_messages=recent,
    )
