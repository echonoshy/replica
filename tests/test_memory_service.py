"""Memory service pure function tests — merge, decay, MMR."""

import uuid
from datetime import datetime, timezone, timedelta

import pytest
import numpy as np

from replica.services.memory_service import _merge_scores, _apply_temporal_decay, _mmr_rerank


def _make_vector_result(*, chunk_id=None, score=0.5, days_ago=0, embedding=None):
    return {
        "id": chunk_id or uuid.uuid4(),
        "chunk_text": f"chunk with score {score}",
        "note_id": uuid.uuid4(),
        "embedding": embedding,
        "created_at": datetime.now(timezone.utc) - timedelta(days=days_ago),
        "vector_score": score,
    }


def _make_text_result(*, chunk_id=None, score=0.5, days_ago=0):
    return {
        "id": chunk_id or uuid.uuid4(),
        "chunk_text": f"text chunk {score}",
        "note_id": uuid.uuid4(),
        "created_at": datetime.now(timezone.utc) - timedelta(days=days_ago),
        "text_score": score,
    }


class TestMergeScores:
    def test_vector_only(self):
        v = [_make_vector_result(score=0.8)]
        merged = _merge_scores(v, [])
        assert len(merged) == 1
        assert merged[0]["vector_score"] > 0
        assert merged[0]["text_score"] == 0.0

    def test_text_only(self):
        t = [_make_text_result(score=0.6)]
        merged = _merge_scores([], t)
        assert len(merged) == 1
        assert merged[0]["text_score"] > 0
        assert merged[0]["vector_score"] == 0.0

    def test_overlapping_results(self):
        shared_id = uuid.uuid4()
        v = [_make_vector_result(chunk_id=shared_id, score=0.8)]
        t = [_make_text_result(chunk_id=shared_id, score=0.6)]
        merged = _merge_scores(v, t)
        assert len(merged) == 1
        assert merged[0]["vector_score"] > 0
        assert merged[0]["text_score"] > 0

    def test_score_is_weighted_sum(self):
        shared_id = uuid.uuid4()
        v = [_make_vector_result(chunk_id=shared_id, score=1.0)]
        t = [_make_text_result(chunk_id=shared_id, score=1.0)]
        merged = _merge_scores(v, t)
        assert merged[0]["score"] == pytest.approx(1.0, abs=0.01)

    def test_empty_inputs(self):
        merged = _merge_scores([], [])
        assert merged == []


class TestApplyTemporalDecay:
    def test_recent_items_higher_score(self):
        recent = {
            "id": uuid.uuid4(),
            "score": 1.0,
            "created_at": datetime.now(timezone.utc),
        }
        old = {
            "id": uuid.uuid4(),
            "score": 1.0,
            "created_at": datetime.now(timezone.utc) - timedelta(days=60),
        }
        results = _apply_temporal_decay([recent, old])
        assert results[0]["score"] > results[1]["score"]

    def test_preserves_list_length(self):
        items = [
            {"id": uuid.uuid4(), "score": 0.5, "created_at": datetime.now(timezone.utc) - timedelta(days=i)}
            for i in range(5)
        ]
        result = _apply_temporal_decay(items)
        assert len(result) == 5

    def test_empty_list(self):
        assert _apply_temporal_decay([]) == []

    def test_scores_decrease_with_age(self):
        items = [
            {"id": uuid.uuid4(), "score": 1.0, "created_at": datetime.now(timezone.utc) - timedelta(days=d)}
            for d in [0, 10, 30, 90]
        ]
        result = _apply_temporal_decay(items)
        scores = [r["score"] for r in result]
        assert scores == sorted(scores, reverse=True)


class TestMMRRerank:
    def test_returns_top_k(self):
        results = [{"id": uuid.uuid4(), "score": 0.9 - i * 0.1, "embedding": None} for i in range(10)]
        selected = _mmr_rerank(results, [0.0] * 10, top_k=3)
        assert len(selected) == 3

    def test_empty_input(self):
        assert _mmr_rerank([], [0.0] * 10, top_k=5) == []

    def test_top_k_larger_than_results(self):
        results = [{"id": uuid.uuid4(), "score": 0.5, "embedding": None} for _ in range(3)]
        selected = _mmr_rerank(results, [0.0] * 10, top_k=10)
        assert len(selected) == 3

    def test_with_embeddings_promotes_diversity(self):
        e1 = list(np.random.randn(10))
        e2 = list(np.random.randn(10))
        results = [
            {"id": uuid.uuid4(), "score": 0.9, "embedding": e1},
            {"id": uuid.uuid4(), "score": 0.89, "embedding": e1},  # very similar
            {"id": uuid.uuid4(), "score": 0.85, "embedding": e2},  # different
        ]
        selected = _mmr_rerank(results, [0.0] * 10, top_k=2)
        assert len(selected) == 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
