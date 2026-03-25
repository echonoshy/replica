"""Test the chunking logic (no DB or embedding service needed)."""
from replica.services.embedding_service import chunk_text, count_tokens


def test_count_tokens():
    assert count_tokens("hello world") > 0


def test_chunk_text_short():
    text = "Hello world, this is a short text."
    chunks = chunk_text(text, chunk_size=400, overlap=80)
    assert len(chunks) == 1
    assert chunks[0]["chunk_index"] == 0
    assert chunks[0]["start_offset"] == 0


def test_chunk_text_overlap():
    # Build a text that is definitely > 400 tokens
    text = " ".join(["word"] * 1000)
    chunks = chunk_text(text, chunk_size=100, overlap=20)
    assert len(chunks) > 1
    # Verify chunk indices are sequential
    for i, c in enumerate(chunks):
        assert c["chunk_index"] == i


def test_chunk_text_empty():
    assert chunk_text("") == []
