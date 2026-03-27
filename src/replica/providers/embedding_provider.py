"""Embedding provider abstraction with factory pattern.

Supports vLLM (OpenAI-compatible /v1/embeddings) out of the box.
"""

import logging
import asyncio
from abc import ABC, abstractmethod

import httpx

from replica.config import settings, EmbeddingConfig

logger = logging.getLogger(__name__)


class EmbeddingProvider(ABC):
    """Abstract embedding provider interface."""

    @abstractmethod
    async def embed_texts(self, texts: list[str]) -> list[list[float]]: ...

    async def embed_query(self, query: str) -> list[float]:
        result = await self.embed_texts([query])
        return result[0]


class VLLMEmbeddingProvider(EmbeddingProvider):
    """OpenAI-compatible embedding provider for vLLM."""

    def __init__(self, cfg: EmbeddingConfig | None = None):
        self.cfg = cfg or settings.embedding
        self._client = httpx.AsyncClient(
            base_url=self.cfg.base_url,
            timeout=httpx.Timeout(self.cfg.timeout),
            headers=self._build_headers(),
        )

    def _build_headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.cfg.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"
        return headers

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed texts in batches."""
        all_embeddings: list[list[float]] = []
        batch_size = self.cfg.batch_size

        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            embeddings = await self._embed_batch(batch)
            all_embeddings.extend(embeddings)

        return all_embeddings

    async def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        payload = {
            "model": self.cfg.model,
            "input": texts,
        }

        last_error: Exception | None = None
        for attempt in range(self.cfg.max_retries):
            try:
                resp = await self._client.post("/embeddings", json=payload)
                resp.raise_for_status()
                data = resp.json()
                # Sort by index to ensure order matches input
                sorted_data = sorted(data["data"], key=lambda x: x["index"])
                return [item["embedding"] for item in sorted_data]
            except httpx.HTTPStatusError as e:
                last_error = e
                if e.response.status_code == 429:
                    wait = min(5 * (2**attempt), 60)
                    logger.warning("Embedding rate-limited, retrying in %ds", wait)
                    await asyncio.sleep(wait)
                else:
                    raise
            except (httpx.RequestError, KeyError) as e:
                last_error = e
                wait = min(2 * (2**attempt), 30)
                logger.warning("Embedding error: %s, retrying in %ds", e, wait)
                await asyncio.sleep(wait)

        raise RuntimeError(f"Embedding call failed after {self.cfg.max_retries} retries: {last_error}")

    async def close(self):
        await self._client.aclose()


# ── Factory ─────────────────────────────────────────────────────────

_PROVIDER_REGISTRY: dict[str, type[EmbeddingProvider]] = {
    "vllm": VLLMEmbeddingProvider,
    "openai": VLLMEmbeddingProvider,  # same protocol
}


def register_embedding_provider(name: str, cls: type[EmbeddingProvider]):
    """Register a custom embedding provider class."""
    _PROVIDER_REGISTRY[name] = cls


_instance: EmbeddingProvider | None = None


def get_embedding_provider() -> EmbeddingProvider:
    """Get or create the embedding provider singleton."""
    global _instance
    if _instance is None:
        provider_name = settings.embedding.provider
        cls = _PROVIDER_REGISTRY.get(provider_name)
        if cls is None:
            raise ValueError(
                f"Unknown embedding provider '{provider_name}'. Available: {list(_PROVIDER_REGISTRY.keys())}"
            )
        _instance = cls(settings.embedding)
    return _instance


def set_embedding_provider(provider: EmbeddingProvider):
    """Override the embedding provider (useful for testing)."""
    global _instance
    _instance = provider
