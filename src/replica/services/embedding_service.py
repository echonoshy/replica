"""Token counting and text chunking utilities.

Embedding provider is now in replica.providers.embedding_provider.
This module re-exports get_provider / set_provider for backward compatibility.
"""

import tiktoken

from replica.config import settings
from replica.providers.embedding_provider import (
    EmbeddingProvider,
    get_embedding_provider as get_provider,
    set_embedding_provider as set_provider,
)

__all__ = [
    "EmbeddingProvider",
    "get_provider",
    "set_provider",
    "count_tokens",
    "chunk_text",
]

_tokenizer = tiktoken.get_encoding("cl100k_base")


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

        chunks.append(
            {
                "text": chunk_str,
                "start_offset": start_offset,
                "end_offset": end_offset,
                "chunk_index": index,
            }
        )

        if end >= len(tokens):
            break

        start = end - overlap
        index += 1

    return chunks
