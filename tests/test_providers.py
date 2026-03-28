"""Provider layer tests — call real LLM / Embedding / Rerank APIs."""

import pytest

from replica.config import get_settings
from replica.providers.llm_provider import VLLMProvider, get_llm_provider, set_llm_provider
from replica.providers.embedding_provider import VLLMEmbeddingProvider, get_embedding_provider, set_embedding_provider
from replica.providers.rerank_provider import VLLMRerankProvider, get_rerank_provider


def _fresh_llm() -> VLLMProvider:
    return VLLMProvider(get_settings().llm)


def _fresh_embedding() -> VLLMEmbeddingProvider:
    return VLLMEmbeddingProvider(get_settings().embedding)


def _fresh_reranker() -> VLLMRerankProvider:
    return VLLMRerankProvider(get_settings().rerank)


class TestLLMProvider:
    async def test_get_provider_returns_instance(self):
        set_llm_provider(None)
        provider = get_llm_provider()
        assert isinstance(provider, VLLMProvider)

    async def test_generate_returns_string(self):
        provider = _fresh_llm()
        result = await provider.generate("Say hello in one word.")
        assert isinstance(result, str)
        assert len(result) > 0
        await provider.close()

    async def test_generate_with_temperature(self):
        provider = _fresh_llm()
        result = await provider.generate("What is 1+1? Answer with just the number.", temperature=0.0)
        assert isinstance(result, str)
        assert "2" in result
        await provider.close()

    async def test_generate_with_max_tokens(self):
        provider = _fresh_llm()
        result = await provider.generate("Count from 1 to 5.", max_tokens=2000)
        assert result is None or isinstance(result, str)
        await provider.close()


class TestEmbeddingProvider:
    async def test_get_provider_returns_instance(self):
        set_embedding_provider(None)
        provider = get_embedding_provider()
        assert isinstance(provider, VLLMEmbeddingProvider)

    async def test_embed_query(self):
        provider = _fresh_embedding()
        embedding = await provider.embed_query("Hello world")
        settings = get_settings()
        assert isinstance(embedding, list)
        assert len(embedding) == settings.embedding.dimensions
        assert all(isinstance(x, float) for x in embedding)
        await provider.close()

    async def test_embed_texts_single(self):
        provider = _fresh_embedding()
        embeddings = await provider.embed_texts(["Hello world"])
        assert len(embeddings) == 1
        settings = get_settings()
        assert len(embeddings[0]) == settings.embedding.dimensions
        await provider.close()

    async def test_embed_texts_batch(self):
        provider = _fresh_embedding()
        texts = ["Hello", "World", "Test"]
        embeddings = await provider.embed_texts(texts)
        assert len(embeddings) == 3
        for emb in embeddings:
            assert isinstance(emb, list)
            assert len(emb) > 0
        await provider.close()

    async def test_different_texts_different_embeddings(self):
        provider = _fresh_embedding()
        embeddings = await provider.embed_texts(["cat", "quantum physics"])
        assert embeddings[0] != embeddings[1]
        await provider.close()


class TestRerankProvider:
    def test_get_provider_returns_instance(self):
        provider = get_rerank_provider()
        assert isinstance(provider, VLLMRerankProvider)

    async def test_rerank_empty_documents(self):
        provider = _fresh_reranker()
        results = await provider.rerank("test query", [])
        assert results == []
        await provider.close()

    async def test_rerank_basic(self):
        provider = _fresh_reranker()
        results = await provider.rerank(
            "What is Python?", ["Python is a programming language.", "Java is also popular."]
        )
        assert isinstance(results, list)
        assert len(results) == 2
        for item in results:
            assert "index" in item
            assert "relevance_score" in item
            assert 0.0 <= item["relevance_score"] <= 1.0
        await provider.close()

    async def test_rerank_relevance_ordering(self):
        provider = _fresh_reranker()
        results = await provider.rerank(
            "capital of France",
            ["Paris is the capital of France.", "Tokyo is in Japan.", "Berlin is in Germany."],
        )
        assert len(results) == 3
        scores = [r["relevance_score"] for r in results]
        assert scores == sorted(scores, reverse=True)
        assert results[0]["index"] == 0
        await provider.close()

    async def test_rerank_top_k(self):
        provider = _fresh_reranker()
        docs = [f"Document number {i} about various topics." for i in range(10)]
        results = await provider.rerank("specific topic", docs, top_k=3)
        assert len(results) <= 3
        for item in results:
            assert "index" in item
            assert "relevance_score" in item
        await provider.close()

    async def test_rerank_score_range(self):
        """Relevant document should score higher than irrelevant one."""
        provider = _fresh_reranker()
        results = await provider.rerank(
            "什么是机器学习？",
            [
                "机器学习是人工智能的一个分支，它使计算机系统能够从数据中学习和改进。",
                "今天北京天气晴朗，最高气温32度，适合户外活动。",
            ],
        )
        score_map = {r["index"]: r["relevance_score"] for r in results}
        assert score_map[0] > score_map[1]
        await provider.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
