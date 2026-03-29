"""LLM provider abstraction with factory pattern.

Supports vLLM (OpenAI-compatible) out of the box.
Future providers (OpenRouter, Anthropic, etc.) plug in via the factory.
"""

import json
import logging
import asyncio
from abc import ABC, abstractmethod

import httpx

from replica.config import settings, LLMConfig

logger = logging.getLogger(__name__)


class LLMProvider(ABC):
    """Abstract LLM provider interface."""

    @abstractmethod
    async def generate(
        self,
        prompt: str,
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict | None = None,
    ) -> str:
        """Generate text from a prompt. Returns the raw text response."""
        ...


class VLLMProvider(LLMProvider):
    """OpenAI-compatible provider for vLLM / OpenRouter / any OpenAI-like API."""

    def __init__(self, cfg: LLMConfig | None = None):
        self.cfg = cfg or settings.llm
        self._client = httpx.AsyncClient(
            base_url=self.cfg.base_url,
            timeout=httpx.Timeout(
                connect=30.0,
                read=float(self.cfg.timeout),
                write=30.0,
                pool=30.0,
            ),
            headers=self._build_headers(),
        )

    def _build_headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.cfg.api_key:
            headers["Authorization"] = f"Bearer {self.cfg.api_key}"
        return headers

    async def generate(
        self,
        prompt: str,
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict | None = None,
    ) -> str:
        payload: dict = {
            "model": self.cfg.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature if temperature is not None else self.cfg.temperature,
            "max_tokens": max_tokens if max_tokens is not None else self.cfg.max_tokens,
        }
        if response_format:
            payload["response_format"] = response_format

        last_error: Exception | None = None
        for attempt in range(self.cfg.max_retries):
            try:
                resp = await self._client.post("/chat/completions", json=payload)
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"]
            except httpx.HTTPStatusError as e:
                last_error = e
                if e.response.status_code == 429:
                    wait = min(5 * (2**attempt), 60)
                    logger.warning(
                        "LLM rate-limited, retrying in %ds (attempt %d)",
                        wait,
                        attempt + 1,
                    )
                    await asyncio.sleep(wait)
                else:
                    logger.error("LLM HTTP error %d: %s", e.response.status_code, e.response.text)
                    raise
            except httpx.TimeoutException as e:
                last_error = e
                wait = min(5 * (2**attempt), 60)
                logger.warning(
                    "LLM timeout (%s), retrying in %ds (attempt %d/%d)",
                    type(e).__name__,
                    wait,
                    attempt + 1,
                    self.cfg.max_retries,
                )
                await asyncio.sleep(wait)
            except (httpx.RequestError, KeyError, json.JSONDecodeError) as e:
                last_error = e
                wait = min(2 * (2**attempt), 30)
                logger.warning(
                    "LLM request error: %s, retrying in %ds (attempt %d)",
                    e,
                    wait,
                    attempt + 1,
                )
                await asyncio.sleep(wait)

        raise RuntimeError(f"LLM call failed after {self.cfg.max_retries} retries: {last_error}")

    async def close(self):
        await self._client.aclose()


class OpenRouterProvider(VLLMProvider):
    """OpenRouter-specific provider. Same protocol as vLLM but with default base_url."""

    def __init__(self, cfg: LLMConfig | None = None):
        if cfg is None:
            cfg = settings.llm.model_copy(update={"base_url": "https://openrouter.ai/api/v1"})
        super().__init__(cfg)


# ── Factory ─────────────────────────────────────────────────────────

_PROVIDER_REGISTRY: dict[str, type[LLMProvider]] = {
    "vllm": VLLMProvider,
    "openai": VLLMProvider,  # same OpenAI-compatible protocol
    "openrouter": OpenRouterProvider,
}


def register_llm_provider(name: str, cls: type[LLMProvider]):
    """Register a custom LLM provider class."""
    _PROVIDER_REGISTRY[name] = cls


_instance: LLMProvider | None = None


def get_llm_provider() -> LLMProvider:
    """Get or create the LLM provider singleton based on config."""
    global _instance
    if _instance is None:
        provider_name = settings.llm.provider
        cls = _PROVIDER_REGISTRY.get(provider_name)
        if cls is None:
            raise ValueError(f"Unknown LLM provider '{provider_name}'. Available: {list(_PROVIDER_REGISTRY.keys())}")
        _instance = cls(settings.llm)
    return _instance


def set_llm_provider(provider: LLMProvider):
    """Override the LLM provider (useful for testing)."""
    global _instance
    _instance = provider
