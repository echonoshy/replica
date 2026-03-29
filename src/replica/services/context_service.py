"""Context assembly: evergreen memories + knowledge search + recent messages.

Three-layer context building:
1. Evergreen — all long-term facts for the user (always injected)
2. Knowledge — relevant entries retrieved via hybrid search
3. Session — recent un-compacted messages from the current session
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.models.message import Message
from replica.models.evergreen_memory import EvergreenMemory
from replica.services.memory_service import search_knowledge
from replica.api.schemas import (
    ContextBuildRequest,
    ContextBuildResponse,
    EvergreenMemoryOut,
    KnowledgeSearchRequest,
    MessageOut,
)


async def build_context(db: AsyncSession, req: ContextBuildRequest) -> ContextBuildResponse:
    # 1. Evergreen memories (all, no search needed)
    result = await db.execute(
        select(EvergreenMemory)
        .where(EvergreenMemory.user_id == req.user_id)
        .order_by(EvergreenMemory.updated_at.desc())
    )
    evergreen = [EvergreenMemoryOut.model_validate(n) for n in result.scalars().all()]

    # 2. Relevant knowledge via hybrid search
    relevant = []
    if req.query:
        search_req = KnowledgeSearchRequest(user_id=req.user_id, query=req.query, top_k=10)
        relevant = await search_knowledge(db, search_req)

    # 3. Recent messages in session
    result = await db.execute(
        select(Message)
        .where(Message.session_id == req.session_id, Message.is_compacted == False)  # noqa: E712
        .order_by(Message.created_at)
    )
    recent = [MessageOut.model_validate(m) for m in result.scalars().all()]

    return ContextBuildResponse(
        evergreen_memories=evergreen,
        relevant_knowledge=relevant,
        recent_messages=recent,
    )
