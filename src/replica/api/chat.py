"""Streaming chat endpoint: context-aware conversation with LLM via SSE."""

import json
import uuid
import logging
from collections.abc import AsyncGenerator

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.db.database import get_db
from replica.models.session import Session
from replica.models.message import Message
from replica.models.evergreen_memory import EvergreenMemory
from replica.services.embedding_service import count_tokens
from replica.services.compaction_service import check_and_compact

logger = logging.getLogger(__name__)
router = APIRouter()


class ChatRequest(BaseModel):
    content: str
    use_memory: bool = True


def _build_system_prompt(evergreen: list[str], relevant: list[str]) -> str:
    parts = ["你是一个友好的 AI 助手。"]
    if evergreen:
        parts.append("以下是你关于用户的长期记忆：")
        for m in evergreen:
            parts.append(f"- {m}")
    if relevant:
        parts.append("\n以下是与本次对话相关的历史知识：")
        for m in relevant:
            parts.append(f"- {m}")
    parts.append("\n每条记忆前的日期标注了记录时间。当信息存在冲突时，请以较新的记忆为准。")
    parts.append("请基于上述记忆和对话上下文，自然地回复用户。")
    return "\n".join(parts)


async def _stream_llm(messages: list[dict]) -> AsyncGenerator[str, None]:
    cfg = settings.llm
    headers = {"Content-Type": "application/json"}
    if cfg.api_key:
        headers["Authorization"] = f"Bearer {cfg.api_key}"

    payload = {
        "model": cfg.model,
        "messages": messages,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
        "stream": True,
    }

    if "qwen3" in cfg.model.lower():
        payload["chat_template_kwargs"] = {"enable_thinking": False}

    async with httpx.AsyncClient(
        base_url=cfg.base_url,
        timeout=httpx.Timeout(cfg.timeout),
        headers=headers,
    ) as client:
        async with client.stream("POST", "/chat/completions", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                    delta = chunk["choices"][0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        yield content
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue


async def _sse_generator(
    session_id: uuid.UUID,
    user_content: str,
    use_memory: bool,
    db: AsyncSession,
) -> AsyncGenerator[str, None]:
    session = await db.get(Session, session_id)
    if not session:
        yield f"data: {json.dumps({'error': 'Session not found'})}\n\n"
        return

    user_tokens = count_tokens(user_content)
    user_msg = Message(
        session_id=session_id,
        role="user",
        content=user_content,
        token_count=user_tokens,
    )
    db.add(user_msg)
    session.token_count += user_tokens
    await db.commit()

    llm_messages: list[dict] = []
    context_payload: dict = {"evergreen": [], "knowledge": []}

    if use_memory:
        # Layer 1: Evergreen — all long-term facts
        result = await db.execute(
            select(EvergreenMemory)
            .where(EvergreenMemory.user_id == session.user_id)
            .order_by(EvergreenMemory.updated_at.desc())
        )
        evergreen_rows = result.scalars().all()
        evergreen_texts = [f"[{n.updated_at.strftime('%Y-%m-%d')}] {n.content}" for n in evergreen_rows]
        context_payload["evergreen"] = [
            {"id": str(n.id), "content": n.content, "category": n.category.value} for n in evergreen_rows
        ]

        # Layer 3: Knowledge search — relevant historical knowledge
        from replica.services.memory_service import search_knowledge
        from replica.api.schemas import KnowledgeSearchRequest

        relevant_texts = []
        try:
            search_req = KnowledgeSearchRequest(user_id=session.user_id, query=user_content, top_k=5)
            search_results = await search_knowledge(db, search_req)
            relevant_texts = [f"[{r.created_at.strftime('%Y-%m-%d')}] {r.content}" for r in search_results]
            context_payload["knowledge"] = [
                {
                    "id": str(r.id),
                    "content": r.content,
                    "entry_type": r.entry_type.value,
                    "score": round(r.score, 4),
                    "title": r.title,
                }
                for r in search_results
            ]
        except Exception:
            logger.warning("Knowledge search failed, proceeding without relevant memories")

        system_prompt = _build_system_prompt(evergreen_texts, relevant_texts)
        llm_messages.append({"role": "system", "content": system_prompt})

    # Layer 2: Session context — recent un-compacted messages
    result = await db.execute(
        select(Message)
        .where(Message.session_id == session_id, Message.is_compacted == False)  # noqa: E712
        .order_by(Message.created_at)
    )
    history = result.scalars().all()
    for msg in history:
        if msg.role in ("user", "assistant"):
            llm_messages.append({"role": msg.role, "content": msg.content})

    full_response = []
    try:
        async for token in _stream_llm(llm_messages):
            full_response.append(token)
            yield f"data: {json.dumps({'token': token})}\n\n"
    except Exception as e:
        logger.error("LLM streaming error: %s", e)
        yield f"data: {json.dumps({'error': str(e)})}\n\n"
        return

    assistant_content = "".join(full_response)
    assistant_tokens = count_tokens(assistant_content)
    assistant_msg = Message(
        session_id=session_id,
        role="assistant",
        content=assistant_content,
        token_count=assistant_tokens,
    )
    db.add(assistant_msg)
    session.token_count += assistant_tokens
    await db.commit()
    await db.refresh(assistant_msg)

    yield f"data: {json.dumps({'context': context_payload})}\n\n"
    yield f"data: {json.dumps({'done': True, 'message_id': str(assistant_msg.id), 'token_count': session.token_count})}\n\n"

    try:
        await check_and_compact(db, session)
    except Exception:
        logger.exception("Compaction failed for session %s", session_id)


@router.post("/sessions/{session_id}/chat")
async def chat_stream(
    session_id: uuid.UUID,
    body: ChatRequest,
    db: AsyncSession = Depends(get_db),
):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    return StreamingResponse(
        _sse_generator(session_id, body.content, body.use_memory, db),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
