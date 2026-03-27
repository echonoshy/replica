"""Retrieval utilities — BM25, RRF fusion, and multi-strategy retrieval."""

import logging


from replica.config import settings
from replica.providers.rerank_provider import get_rerank_provider

logger = logging.getLogger(__name__)


def reciprocal_rank_fusion(
    results1: list[tuple[str, float]],
    results2: list[tuple[str, float]],
    k: int | None = None,
) -> list[tuple[str, float]]:
    """RRF fusion of two ranked result lists.

    Args:
        results1: [(id, score), ...] sorted by score desc
        results2: [(id, score), ...] sorted by score desc
        k: RRF parameter (default from config)

    Returns:
        [(id, fused_score), ...] sorted by fused_score desc
    """
    if k is None:
        k = settings.search.rrf_k

    scores: dict[str, float] = {}

    for rank, (doc_id, _) in enumerate(results1):
        scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)

    for rank, (doc_id, _) in enumerate(results2):
        scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)

    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


def multi_rrf_fusion(
    result_lists: list[list[tuple[str, float]]],
    k: int | None = None,
) -> list[tuple[str, float]]:
    """RRF fusion of N ranked result lists."""
    if k is None:
        k = settings.search.rrf_k

    scores: dict[str, float] = {}
    for results in result_lists:
        for rank, (doc_id, _) in enumerate(results):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)

    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


async def rerank_candidates(
    query: str,
    candidates: list[dict],
    text_key: str = "text",
    top_k: int = 20,
) -> list[dict]:
    """Rerank candidate documents using the rerank provider.

    Args:
        query: Search query
        candidates: [{text_key: str, ...}]
        text_key: Key containing text to rerank
        top_k: Max results to return

    Returns:
        Reranked candidates with added 'rerank_score' field
    """
    if not candidates:
        return []

    documents = [c.get(text_key, "") for c in candidates]
    try:
        provider = get_rerank_provider()
        results = await provider.rerank(query, documents, top_k=top_k)
    except Exception as e:
        logger.warning("Rerank failed, returning original order: %s", e)
        return candidates[:top_k]

    reranked = []
    for item in results:
        idx = item.get("index", 0)
        if 0 <= idx < len(candidates):
            c = candidates[idx].copy()
            c["rerank_score"] = item.get("relevance_score", 0.0)
            reranked.append(c)

    return reranked[:top_k]
