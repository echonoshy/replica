from abc import ABC, abstractmethod

import tiktoken

from replica.config import settings

_tokenizer = tiktoken.get_encoding("cl100k_base")


# ---------- Embedding Provider (可插拔) ----------

class EmbeddingProvider(ABC):
    @abstractmethod
    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        ...

    async def embed_query(self, query: str) -> list[float]:
        result = await self.embed_texts([query])
        return result[0]


class VLLMProvider(EmbeddingProvider):
    """Placeholder: call your vLLM embedding endpoint."""

    def __init__(self, base_url: str = settings.embedding_base_url, model: str = settings.embedding_model):
        self.base_url = base_url
        self.model = model

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        # TODO: implement HTTP call to your vLLM /v1/embeddings endpoint
        raise NotImplementedError("Wire up your vLLM embedding service here")


_provider: EmbeddingProvider | None = None


def get_provider() -> EmbeddingProvider:
    global _provider
    if _provider is None:
        _provider = VLLMProvider()
    return _provider


def set_provider(provider: EmbeddingProvider) -> None:
    global _provider
    _provider = provider


# ---------- Token counting ----------

def count_tokens(text: str) -> int:
    return len(_tokenizer.encode(text))


# ---------- Chunking ----------

def chunk_text(
    text: str,
    chunk_size: int = settings.chunk_size_tokens,
    overlap: int = settings.chunk_overlap_tokens,
) -> list[dict]:
    """Split text into overlapping chunks by token count.

    Returns list of {text, start_offset, end_offset, chunk_index}.
    """
    tokens = _tokenizer.encode(text)
    if not tokens:
        return []

    chunks = []
    start = 0
    index = 0

    while start < len(tokens):
        end = min(start + chunk_size, len(tokens))
        chunk_tokens = tokens[start:end]
        chunk_str = _tokenizer.decode(chunk_tokens)

        start_offset = len(_tokenizer.decode(tokens[:start]))
        end_offset = start_offset + len(chunk_str)

        chunks.append({
            "text": chunk_str,
            "start_offset": start_offset,
            "end_offset": end_offset,
            "chunk_index": index,
        })

        if end >= len(tokens):
            break

        start = end - overlap
        index += 1

    return chunks
