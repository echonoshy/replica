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
    return len(_tokenizer.encode_ordinary(text))


# ---------- Chunking ----------


def chunk_text(
    text: str,
    chunk_size: int = settings.chunk_size_tokens,
    overlap: int = settings.chunk_overlap_tokens,
) -> list[dict]:
    """Split text into overlapping chunks, extending token boundaries to keep characters intact.

    Returns list of {text, start_offset, end_offset, chunk_index}.
    """
    if chunk_size <= 0 or overlap < 0 or overlap >= chunk_size:
        raise ValueError("chunk_size must be positive and overlap must be between 0 and chunk_size - 1")
    tokens = _tokenizer.encode_ordinary(text)
    if not tokens:
        return []

    _, offsets = _tokenizer.decode_with_offsets(tokens)
    offsets.append(len(text))

    def character_boundary(index: int) -> int:
        # A token starting with a UTF-8 continuation byte belongs to the previous character.
        while index < len(tokens) and _tokenizer.decode_single_token_bytes(tokens[index])[0] & 0xC0 == 0x80:
            index += 1
        return index

    chunks = []
    start = 0
    index = 0

    while start < len(tokens):
        end = character_boundary(min(start + chunk_size, len(tokens)))
        start_offset = offsets[start]
        end_offset = offsets[end]

        chunks.append(
            {
                "text": text[start_offset:end_offset],
                "start_offset": start_offset,
                "end_offset": end_offset,
                "chunk_index": index,
            }
        )

        if end >= len(tokens):
            break

        start = character_boundary(end - overlap)
        index += 1

    return chunks
