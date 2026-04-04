"""Retrieval utilities — RRF fusion for multi-strategy retrieval."""

import logging

from replica.config import settings

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
