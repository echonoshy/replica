"""Retrieval utility function tests — RRF fusion."""

import pytest

from replica.services.retrieval_utils import reciprocal_rank_fusion, multi_rrf_fusion


class TestReciprocalRankFusion:
    def test_basic_fusion(self):
        r1 = [("a", 0.9), ("b", 0.8), ("c", 0.7)]
        r2 = [("b", 0.95), ("d", 0.85), ("a", 0.75)]
        result = reciprocal_rank_fusion(r1, r2, k=60)
        ids = [doc_id for doc_id, _ in result]
        assert "a" in ids
        assert "b" in ids
        assert "c" in ids
        assert "d" in ids

    def test_sorted_by_score_descending(self):
        r1 = [("a", 0.9), ("b", 0.8)]
        r2 = [("c", 0.7), ("a", 0.6)]
        result = reciprocal_rank_fusion(r1, r2, k=60)
        scores = [score for _, score in result]
        assert scores == sorted(scores, reverse=True)

    def test_overlapping_ids_get_higher_score(self):
        r1 = [("a", 0.9), ("b", 0.8)]
        r2 = [("a", 0.7), ("c", 0.6)]
        result = reciprocal_rank_fusion(r1, r2, k=60)
        score_map = dict(result)
        assert score_map["a"] > score_map["b"]
        assert score_map["a"] > score_map["c"]

    def test_empty_inputs(self):
        result = reciprocal_rank_fusion([], [], k=60)
        assert result == []

    def test_one_empty_input(self):
        r1 = [("a", 0.9), ("b", 0.8)]
        result = reciprocal_rank_fusion(r1, [], k=60)
        assert len(result) == 2

    def test_single_item_lists(self):
        r1 = [("a", 1.0)]
        r2 = [("b", 1.0)]
        result = reciprocal_rank_fusion(r1, r2, k=60)
        assert len(result) == 2


class TestMultiRRFFusion:
    def test_three_lists(self):
        lists = [
            [("a", 0.9), ("b", 0.8)],
            [("b", 0.95), ("c", 0.7)],
            [("c", 0.85), ("a", 0.6)],
        ]
        result = multi_rrf_fusion(lists, k=60)
        ids = [doc_id for doc_id, _ in result]
        assert set(ids) == {"a", "b", "c"}

    def test_sorted_descending(self):
        lists = [
            [("a", 0.9), ("b", 0.8)],
            [("c", 0.7), ("a", 0.6)],
        ]
        result = multi_rrf_fusion(lists, k=60)
        scores = [s for _, s in result]
        assert scores == sorted(scores, reverse=True)

    def test_single_list(self):
        lists = [[("a", 0.9), ("b", 0.8)]]
        result = multi_rrf_fusion(lists, k=60)
        assert len(result) == 2

    def test_empty_lists(self):
        result = multi_rrf_fusion([], k=60)
        assert result == []

    def test_all_same_document(self):
        lists = [
            [("a", 0.9)],
            [("a", 0.8)],
            [("a", 0.7)],
        ]
        result = multi_rrf_fusion(lists, k=60)
        assert len(result) == 1
        assert result[0][0] == "a"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
