"""Rerank provider abstraction with factory pattern.

Supports vLLM via chat/completions + logprobs (Qwen3-Reranker style).
The reranker model judges query-document relevance by outputting "yes"/"no",
and relevance scores are derived from the token log-probabilities.
"""

import math
import logging
import asyncio
from abc import ABC, abstractmethod

import httpx

from replica.config import settings, RerankConfig

logger = logging.getLogger(__name__)

_RERANKER_SYSTEM_PROMPT = "Judge whether the Document is relevant to the Query. Answer only 'yes' or 'no'."


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
    """vLLM rerank provider using chat/completions + logprobs.

    Qwen3-Reranker doesn't expose /v1/rerank; instead we send each
    (query, document) pair as a chat completion with ``max_tokens=1``,
    extract the yes/no log-probabilities, and compute a relevance score.
    """

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

    @staticmethod
    def _compute_score(logprobs: dict[str, float]) -> float:
        """Compute relevance score from yes/no log-probabilities."""
        yes_logprob = logprobs.get("yes", -100)
        no_logprob = logprobs.get("no", -100)
        yes_prob = math.exp(yes_logprob)
        no_prob = math.exp(no_logprob)
        total = yes_prob + no_prob
        if total == 0:
            return 0.0
        return yes_prob / total

    async def _score_single(self, query: str, document: str, index: int) -> dict:
        """Score a single (query, document) pair via chat/completions + logprobs."""
        payload = {
            "model": self.cfg.model,
            "messages": [
                {"role": "system", "content": _RERANKER_SYSTEM_PROMPT},
                {"role": "user", "content": f"<Query>{query}</Query>\n<Document>{document}</Document>"},
            ],
            "logprobs": True,
            "top_logprobs": 5,
            "max_tokens": 1,
            "temperature": 0.0,
            "chat_template_kwargs": {"enable_thinking": False},
        }

        last_error: Exception | None = None
        for attempt in range(self.cfg.max_retries):
            try:
                resp = await self._client.post("/chat/completions", json=payload)
                resp.raise_for_status()
                data = resp.json()
                choice = data["choices"][0]

                token_logprobs = choice.get("logprobs", {}).get("content", [])
                if token_logprobs:
                    top_lp = {item["token"]: item["logprob"] for item in token_logprobs[0].get("top_logprobs", [])}
                    score = self._compute_score(top_lp)
                else:
                    answer = choice["message"]["content"].strip().lower()
                    score = 1.0 if answer.startswith("yes") else 0.0

                return {"index": index, "relevance_score": score}
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
                logger.warning("Rerank scoring error: %s, retrying in %ds", e, wait)
                await asyncio.sleep(wait)

        raise RuntimeError(f"Rerank scoring failed after {self.cfg.max_retries} retries: {last_error}")

    async def rerank(
        self,
        query: str,
        documents: list[str],
        top_k: int | None = None,
    ) -> list[dict]:
        if not documents:
            return []

        tasks = [self._score_single(query, doc, i) for i, doc in enumerate(documents)]
        results = await asyncio.gather(*tasks)

        sorted_results = sorted(results, key=lambda x: x["relevance_score"], reverse=True)
        if top_k is not None:
            sorted_results = sorted_results[:top_k]
        return sorted_results

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
            raise ValueError(f"Unknown rerank provider '{provider_name}'. Available: {list(_PROVIDER_REGISTRY.keys())}")
        _instance = cls(settings.rerank)
    return _instance


def set_rerank_provider(provider: RerankProvider):
    """Override the rerank provider (useful for testing)."""
    global _instance
    _instance = provider
