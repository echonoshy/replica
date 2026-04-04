"""Configuration loading and property access tests."""

import pytest

from replica.config import get_settings, Settings


class TestConfigLoading:
    def test_get_settings_returns_settings_instance(self):
        s = get_settings()
        assert isinstance(s, Settings)

    def test_database_url_is_string(self):
        s = get_settings()
        assert isinstance(s.database_url, str)
        assert "postgresql" in s.database_url


class TestNestedConfig:
    def test_llm_config(self):
        s = get_settings()
        assert s.llm.provider in ("vllm", "openai", "openrouter")
        assert isinstance(s.llm.base_url, str)
        assert isinstance(s.llm.temperature, float)
        assert s.llm.max_retries >= 1

    def test_embedding_config(self):
        s = get_settings()
        assert s.embedding.dimensions > 0
        assert isinstance(s.embedding.model, str)
        assert s.embedding.batch_size >= 1

    def test_memory_config(self):
        s = get_settings()
        assert s.memory.language in ("en", "zh")
        assert s.memory.boundary_max_tokens > 0
        assert s.memory.boundary_max_messages > 0

    def test_compaction_config(self):
        s = get_settings()
        assert s.compaction.hard_threshold_tokens > 0
        assert s.compaction.keep_recent_tokens > 0

    def test_chunking_config(self):
        s = get_settings()
        assert s.chunking.chunk_size_tokens > 0
        assert s.chunking.chunk_overlap_tokens >= 0
        assert s.chunking.chunk_overlap_tokens < s.chunking.chunk_size_tokens

    def test_search_config(self):
        s = get_settings()
        assert 0 <= s.search.vector_weight <= 1
        assert 0 <= s.search.text_weight <= 1
        assert s.search.default_top_k >= 1


class TestFlatPropertyAccessors:
    """Verify backward-compatible flat property access matches nested config."""

    def test_hard_threshold_tokens(self):
        s = get_settings()
        assert s.hard_threshold_tokens == s.compaction.hard_threshold_tokens

    def test_keep_recent_tokens(self):
        s = get_settings()
        assert s.keep_recent_tokens == s.compaction.keep_recent_tokens

    def test_chunk_size_tokens(self):
        s = get_settings()
        assert s.chunk_size_tokens == s.chunking.chunk_size_tokens

    def test_chunk_overlap_tokens(self):
        s = get_settings()
        assert s.chunk_overlap_tokens == s.chunking.chunk_overlap_tokens

    def test_vector_weight(self):
        s = get_settings()
        assert s.vector_weight == s.search.vector_weight

    def test_text_weight(self):
        s = get_settings()
        assert s.text_weight == s.search.text_weight

    def test_temporal_decay_half_life_days(self):
        s = get_settings()
        assert s.temporal_decay_half_life_days == s.search.temporal_decay_half_life_days

    def test_mmr_enabled(self):
        s = get_settings()
        assert s.mmr_enabled == s.search.mmr_enabled

    def test_mmr_lambda(self):
        s = get_settings()
        assert s.mmr_lambda == s.search.mmr_lambda

    def test_embedding_dim(self):
        s = get_settings()
        assert s.embedding_dim == s.embedding.dimensions

    def test_embedding_model(self):
        s = get_settings()
        assert s.embedding_model == s.embedding.model


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
