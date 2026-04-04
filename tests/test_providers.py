"""Provider layer tests — call real LLM / Embedding APIs."""

import pytest

from replica.config import get_settings
from replica.providers.llm_provider import VLLMProvider, get_llm_provider, set_llm_provider
from replica.providers.embedding_provider import VLLMEmbeddingProvider, get_embedding_provider, set_embedding_provider


def _fresh_llm() -> VLLMProvider:
    return VLLMProvider(get_settings().llm)


def _fresh_embedding() -> VLLMEmbeddingProvider:
    return VLLMEmbeddingProvider(get_settings().embedding)


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
