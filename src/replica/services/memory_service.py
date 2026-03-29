"""Knowledge search: hybrid vector + full-text with temporal decay and MMR.

Searches the unified knowledge_entries table instead of the old memory_chunks.
"""

import math
from datetime import datetime, timezone

import numpy as np
from sqlalchemy import select, text, func
from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.models.knowledge_entry import KnowledgeEntry, EntryType
from replica.services.embedding_service import get_provider
from replica.api.schemas import KnowledgeSearchRequest, KnowledgeSearchResult


async def search_knowledge(
    db: AsyncSession,
    req: KnowledgeSearchRequest,
) -> list[KnowledgeSearchResult]:
    provider = get_provider()
    query_embedding = await provider.embed_query(req.query)

    vector_results = await _vector_search(db, req.user_id, query_embedding, req.top_k * 3, req.entry_type)
    text_results = await _text_search(db, req.user_id, req.query, req.top_k * 3, req.entry_type)

    merged = _merge_scores(vector_results, text_results)
    merged = _apply_temporal_decay(merged)

    if settings.mmr_enabled and len(merged) > req.top_k:
        merged = _mmr_rerank(merged, query_embedding, req.top_k)
    else:
        merged.sort(key=lambda x: x["score"], reverse=True)
        merged = merged[: req.top_k]

    return [
        KnowledgeSearchResult(
            id=r["id"],
            entry_type=r["entry_type"],
            title=r.get("title"),
            content=r["content"],
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
    entry_type: EntryType | None,
) -> list[dict]:
    query = (
        select(
            KnowledgeEntry.id,
            KnowledgeEntry.entry_type,
            KnowledgeEntry.title,
            KnowledgeEntry.content,
            KnowledgeEntry.embedding,
            KnowledgeEntry.created_at,
            (1 - KnowledgeEntry.embedding.cosine_distance(query_embedding)).label("similarity"),
        )
        .where(KnowledgeEntry.user_id == str(user_id), KnowledgeEntry.embedding.isnot(None))
        .order_by(KnowledgeEntry.embedding.cosine_distance(query_embedding))
        .limit(limit)
    )

    if entry_type is not None:
        query = query.where(KnowledgeEntry.entry_type == entry_type)

    result = await db.execute(query)
    return [
        {
            "id": r.id,
            "entry_type": r.entry_type,
            "title": r.title,
            "content": r.content,
            "embedding": r.embedding,
            "created_at": r.created_at,
            "vector_score": max(float(r.similarity), 0.0),
        }
        for r in result.all()
    ]


async def _text_search(
    db: AsyncSession,
    user_id,
    query: str,
    limit: int,
    entry_type: EntryType | None,
) -> list[dict]:
    ts_query = func.plainto_tsquery("english", query)

    stmt = (
        select(
            KnowledgeEntry.id,
            KnowledgeEntry.entry_type,
            KnowledgeEntry.title,
            KnowledgeEntry.content,
            KnowledgeEntry.created_at,
            func.ts_rank(
                func.to_tsvector("english", KnowledgeEntry.content),
                ts_query,
            ).label("rank"),
        )
        .where(
            KnowledgeEntry.user_id == str(user_id),
            func.to_tsvector("english", KnowledgeEntry.content).op("@@")(ts_query),
        )
        .order_by(text("rank DESC"))
        .limit(limit)
    )

    if entry_type is not None:
        stmt = stmt.where(KnowledgeEntry.entry_type == entry_type)

    result = await db.execute(stmt)
    return [
        {
            "id": r.id,
            "entry_type": r.entry_type,
            "title": r.title,
            "content": r.content,
            "created_at": r.created_at,
            "text_score": float(r.rank),
        }
        for r in result.all()
    ]


def _merge_scores(vector_results: list[dict], text_results: list[dict]) -> list[dict]:
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
    if settings.temporal_decay_half_life_days <= 0:
        return results

    lambda_ = math.log(2) / settings.temporal_decay_half_life_days
    now = datetime.now(timezone.utc)

    for r in results:
        age_days = (now - r["created_at"].replace(tzinfo=timezone.utc)).total_seconds() / 86400
        r["score"] *= math.exp(-lambda_ * age_days)

    return results


def _mmr_rerank(results: list[dict], query_embedding: list[float], top_k: int) -> list[dict]:
    if not results:
        return results

    lam = settings.mmr_lambda

    selected = []
    candidates = list(results)

    while len(selected) < top_k and candidates:
        best_idx = -1
        best_mmr = -float("inf")

        for i, cand in enumerate(candidates):
            relevance = cand["score"]

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
