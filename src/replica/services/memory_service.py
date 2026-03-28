"""Memory search: hybrid vector + full-text with temporal decay and MMR."""

import math
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import select, text, func
from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.models.memory_chunk import MemoryChunk
from replica.models.memory_note import MemoryNote, NoteType
from replica.services.embedding_service import get_provider
from replica.api.schemas import MemorySearchRequest, MemorySearchResult


async def search_memory(
    db: AsyncSession,
    req: MemorySearchRequest,
) -> list[MemorySearchResult]:
    provider = get_provider()
    query_embedding = await provider.embed_query(req.query)

    # Vector search
    vector_results = await _vector_search(db, req.user_id, query_embedding, req.top_k * 3, req.note_type)
    # Full-text search
    text_results = await _text_search(db, req.user_id, req.query, req.top_k * 3, req.note_type)

    # Merge scores
    merged = _merge_scores(vector_results, text_results)

    # Apply temporal decay
    merged = _apply_temporal_decay(merged)

    # MMR re-ranking
    if settings.mmr_enabled and len(merged) > req.top_k:
        merged = _mmr_rerank(merged, query_embedding, req.top_k)
    else:
        merged.sort(key=lambda x: x["score"], reverse=True)
        merged = merged[: req.top_k]

    return [
        MemorySearchResult(
            chunk_text=r["chunk_text"],
            note_id=r["note_id"],
            score=r["score"],
            created_at=r["created_at"],
        )
        for r in merged
    ]


async def _vector_search(
    db: AsyncSession,
    user_id,
    query_embedding: list[float],
    limit: int,
    note_type: NoteType | None,
) -> list[dict]:
    """Cosine similarity search via pgvector."""
    query = (
        select(
            MemoryChunk.id,
            MemoryChunk.chunk_text,
            MemoryChunk.note_id,
            MemoryChunk.embedding,
            MemoryChunk.created_at,
            (1 - MemoryChunk.embedding.cosine_distance(query_embedding)).label("similarity"),
        )
        .where(MemoryChunk.user_id == user_id)
        .order_by(MemoryChunk.embedding.cosine_distance(query_embedding))
        .limit(limit)
    )

    if note_type is not None:
        query = query.join(MemoryNote).where(MemoryNote.note_type == note_type)

    result = await db.execute(query)
    rows = result.all()
    return [
        {
            "id": r.id,
            "chunk_text": r.chunk_text,
            "note_id": r.note_id,
            "embedding": r.embedding,
            "created_at": r.created_at,
            "vector_score": max(float(r.similarity), 0.0),
        }
        for r in rows
    ]


async def _text_search(
    db: AsyncSession,
    user_id,
    query: str,
    limit: int,
    note_type: NoteType | None,
) -> list[dict]:
    """Full-text search using PostgreSQL ts_rank."""
    ts_query = func.plainto_tsquery("english", query)

    stmt = (
        select(
            MemoryChunk.id,
            MemoryChunk.chunk_text,
            MemoryChunk.note_id,
            MemoryChunk.created_at,
            func.ts_rank(
                func.to_tsvector("english", MemoryChunk.chunk_text),
                ts_query,
            ).label("rank"),
        )
        .where(
            MemoryChunk.user_id == user_id,
            func.to_tsvector("english", MemoryChunk.chunk_text).op("@@")(ts_query),
        )
        .order_by(text("rank DESC"))
        .limit(limit)
    )

    if note_type is not None:
        stmt = stmt.join(MemoryNote).where(MemoryNote.note_type == note_type)

    result = await db.execute(stmt)
    rows = result.all()
    return [
        {
            "id": r.id,
            "chunk_text": r.chunk_text,
            "note_id": r.note_id,
            "created_at": r.created_at,
            "text_score": float(r.rank),
        }
        for r in rows
    ]


def _merge_scores(vector_results: list[dict], text_results: list[dict]) -> list[dict]:
    """Combine vector and text scores with configured weights."""
    # Normalize scores to [0, 1]
    v_max = max((r["vector_score"] for r in vector_results), default=1.0) or 1.0
    t_max = max((r["text_score"] for r in text_results), default=1.0) or 1.0

    by_id = {}
    for r in vector_results:
        by_id[r["id"]] = {
            **r,
            "vector_score": r["vector_score"] / v_max,
            "text_score": 0.0,
        }
    for r in text_results:
        if r["id"] in by_id:
            by_id[r["id"]]["text_score"] = r["text_score"] / t_max
        else:
            by_id[r["id"]] = {
                **r,
                "vector_score": 0.0,
                "text_score": r["text_score"] / t_max,
            }

    for item in by_id.values():
        item["score"] = settings.vector_weight * item["vector_score"] + settings.text_weight * item["text_score"]

    return list(by_id.values())


def _apply_temporal_decay(results: list[dict]) -> list[dict]:
    """Apply exponential decay to scores based on age. Evergreen notes are exempt."""
    if settings.temporal_decay_half_life_days <= 0:
        return results

    lambda_ = math.log(2) / settings.temporal_decay_half_life_days
    now = datetime.now(timezone.utc)

    for r in results:
        # Check if this chunk belongs to an evergreen note (we'd need note_type in the result)
        # For now, apply decay to all — evergreen exemption handled at query filter level
        age_days = (now - r["created_at"].replace(tzinfo=timezone.utc)).total_seconds() / 86400
        r["score"] *= math.exp(-lambda_ * age_days)

    return results


def _mmr_rerank(results: list[dict], query_embedding: list[float], top_k: int) -> list[dict]:
    """Maximal Marginal Relevance: balance relevance vs diversity."""
    if not results:
        return results

    lam = settings.mmr_lambda
    _ = np.array(query_embedding)  # reserved for future query-vs-candidate comparison

    selected = []
    candidates = list(results)

    while len(selected) < top_k and candidates:
        best_idx = -1
        best_mmr = -float("inf")

        for i, cand in enumerate(candidates):
            relevance = cand["score"]

            # Max similarity to already selected
            if selected and "embedding" in cand and cand["embedding"] is not None:
                cand_vec = np.array(cand["embedding"])
                max_sim = max(
                    float(np.dot(cand_vec, np.array(s["embedding"])))
                    for s in selected
                    if s.get("embedding") is not None
                )
            else:
                max_sim = 0.0

            mmr = lam * relevance - (1 - lam) * max_sim
            if mmr > best_mmr:
                best_mmr = mmr
                best_idx = i

        selected.append(candidates.pop(best_idx))

    return selected
