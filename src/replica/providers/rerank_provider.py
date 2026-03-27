"""Rerank provider abstraction with factory pattern.

Supports vLLM reranking endpoint out of the box.
"""

import logging
import asyncio
from abc import ABC, abstractmethod

import httpx

from replica.config import settings, RerankConfig

logger = logging.getLogger(__name__)


class RerankProvider(ABC):
    """Abstract rerank provider interface."""

    @abstractmethod
    async def rerank(
        self,
        query: str,
        documents: list[str],
        top_k: int | None = None,
    ) -> list[dict]:
        """Rerank documents by relevance to query.

        Returns list of {index, relevance_score} sorted by score descending.
        """
        ...


class VLLMRerankProvider(RerankProvider):
    """vLLM-compatible rerank provider (Jina/Qwen reranker API)."""

    def __init__(self, cfg: RerankConfig | None = None):
        self.cfg = cfg or settings.rerank
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

    async def rerank(
        self,
        query: str,
        documents: list[str],
        top_k: int | None = None,
    ) -> list[dict]:
        if not documents:
            return []

        payload: dict = {
            "model": self.cfg.model,
            "query": query,
            "documents": documents,
        }
        if top_k is not None:
            payload["top_n"] = top_k

        last_error: Exception | None = None
        for attempt in range(self.cfg.max_retries):
            try:
                resp = await self._client.post("/rerank", json=payload)
                resp.raise_for_status()
                data = resp.json()
                results = data.get("results", [])
                return sorted(results, key=lambda x: x["relevance_score"], reverse=True)
            except httpx.HTTPStatusError as e:
                last_error = e
                if e.response.status_code == 429:
                    wait = min(5 * (2**attempt), 60)
                    logger.warning("Rerank rate-limited, retrying in %ds", wait)
                    await asyncio.sleep(wait)
                else:
                    raise
            except (httpx.RequestError, KeyError) as e:
                last_error = e
                wait = min(2 * (2**attempt), 30)
                logger.warning("Rerank error: %s, retrying in %ds", e, wait)
                await asyncio.sleep(wait)

        raise RuntimeError(
            f"Rerank call failed after {self.cfg.max_retries} retries: {last_error}"
        )

    async def close(self):
        await self._client.aclose()


# ── Factory ─────────────────────────────────────────────────────────

_PROVIDER_REGISTRY: dict[str, type[RerankProvider]] = {
    "vllm": VLLMRerankProvider,
    "openai": VLLMRerankProvider,
}


def register_rerank_provider(name: str, cls: type[RerankProvider]):
    """Register a custom rerank provider class."""
    _PROVIDER_REGISTRY[name] = cls


_instance: RerankProvider | None = None


def get_rerank_provider() -> RerankProvider:
    """Get or create the rerank provider singleton."""
    global _instance
    if _instance is None:
        provider_name = settings.rerank.provider
        cls = _PROVIDER_REGISTRY.get(provider_name)
        if cls is None:
            raise ValueError(
                f"Unknown rerank provider '{provider_name}'. "
                f"Available: {list(_PROVIDER_REGISTRY.keys())}"
            )
        _instance = cls(settings.rerank)
    return _instance


def set_rerank_provider(provider: RerankProvider):
    """Override the rerank provider (useful for testing)."""
    global _instance
    _instance = provider
