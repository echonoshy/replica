"""Token counting and text chunking tests."""

import pytest

from replica.services.embedding_service import count_tokens, chunk_text


class TestCountTokens:
    def test_empty_string(self):
        assert count_tokens("") == 0

    def test_english_text(self):
        tokens = count_tokens("Hello world")
        assert tokens > 0

    def test_chinese_text(self):
        tokens = count_tokens("你好世界")
        assert tokens > 0

    def test_special_characters(self):
        tokens = count_tokens("!@#$%^&*()")
        assert tokens > 0

    def test_special_token_literal_in_user_text(self):
        text = "<|endoftext|>"
        assert count_tokens(text) > 1
        assert chunk_text(text, chunk_size=10, overlap=0)[0]["text"] == text

    def test_long_text_more_tokens(self):
        short = count_tokens("hello")
        long = count_tokens("hello world this is a longer sentence with more words")
        assert long > short

    def test_whitespace_only(self):
        tokens = count_tokens("   ")
        assert isinstance(tokens, int)


class TestChunkText:
    @pytest.mark.parametrize("chunk_size,overlap", [(0, 0), (-1, 0), (2, -1), (2, 2), (2, 3)])
    def test_invalid_window(self, chunk_size, overlap):
        with pytest.raises(ValueError, match="chunk_size"):
            chunk_text("input", chunk_size=chunk_size, overlap=overlap)

    @pytest.mark.parametrize("overlap", [0, 1])
    def test_unicode_offsets_match_source(self, overlap):
        text = "左🤦🏿‍♀️右！"
        chunks = chunk_text(text, chunk_size=2, overlap=overlap)
        assert all(chunk["text"] == text[chunk["start_offset"] : chunk["end_offset"]] for chunk in chunks)
        assert all(chunk["text"] for chunk in chunks)
        assert chunks[0]["start_offset"] == 0 and chunks[-1]["end_offset"] == len(text)
        for left, right in zip(chunks, chunks[1:]):
            assert left["start_offset"] < right["start_offset"] <= left["end_offset"]
        if overlap == 0:
            assert "".join(chunk["text"] for chunk in chunks) == text

    def test_empty_string(self):
        result = chunk_text("")
        assert result == []

    def test_short_text_single_chunk(self):
        text = "This is a short text."
        chunks = chunk_text(text, chunk_size=100, overlap=10)
        assert len(chunks) == 1
        assert chunks[0]["text"] == text
        assert chunks[0]["chunk_index"] == 0
        assert chunks[0]["start_offset"] == 0

    def test_long_text_multiple_chunks(self):
        text = " ".join(["word"] * 500)
        chunks = chunk_text(text, chunk_size=50, overlap=10)
        assert len(chunks) > 1

    def test_chunk_index_sequential(self):
        text = " ".join(["word"] * 500)
        chunks = chunk_text(text, chunk_size=50, overlap=10)
        for i, chunk in enumerate(chunks):
            assert chunk["chunk_index"] == i

    def test_chunk_has_required_keys(self):
        text = "Hello world, this is a test."
        chunks = chunk_text(text, chunk_size=100, overlap=5)
        for chunk in chunks:
            assert "text" in chunk
            assert "start_offset" in chunk
            assert "end_offset" in chunk
            assert "chunk_index" in chunk

    def test_overlap_creates_more_chunks(self):
        text = " ".join(["word"] * 200)
        no_overlap = chunk_text(text, chunk_size=50, overlap=0)
        with_overlap = chunk_text(text, chunk_size=50, overlap=20)
        assert len(with_overlap) >= len(no_overlap)

    def test_offsets_are_non_negative(self):
        text = " ".join(["hello"] * 100)
        chunks = chunk_text(text, chunk_size=30, overlap=5)
        for chunk in chunks:
            assert chunk["start_offset"] >= 0
            assert chunk["end_offset"] >= chunk["start_offset"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
