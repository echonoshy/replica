"""Pydantic schema validation and serialization tests."""

import uuid
from datetime import datetime, timezone

import pytest

from replica.api.schemas import (
    UserCreate,
    UserOut,
    SessionCreate,
    SessionOut,
    MessageCreate,
    MessageOut,
    MemoryNoteCreate,
    MemorySearchRequest,
    MemorySearchResult,
    ContextBuildRequest,
    ContextBuildResponse,
    MemorizeRequest,
    MemorizeResponse,
    RetrieveRequest,
)
from replica.models.message import MessageRole, MessageType
from replica.models.memory_note import NoteType
from replica.models.session import SessionStatus


class TestUserSchemas:
    def test_user_create(self):
        u = UserCreate(external_id="test_user")
        assert u.external_id == "test_user"
        assert u.metadata is None

    def test_user_create_with_metadata(self):
        u = UserCreate(external_id="test_user", metadata={"key": "value"})
        assert u.metadata == {"key": "value"}

    def test_user_out(self):
        now = datetime.now(timezone.utc)
        u = UserOut(
            id=uuid.uuid4(),
            external_id="test",
            metadata=None,
            created_at=now,
        )
        assert isinstance(u.id, uuid.UUID)
        assert u.external_id == "test"


class TestSessionSchemas:
    def test_session_create_defaults(self):
        s = SessionCreate()
        assert s.metadata is None

    def test_session_out(self):
        now = datetime.now(timezone.utc)
        s = SessionOut(
            id=uuid.uuid4(),
            user_id=uuid.uuid4(),
            status=SessionStatus.active,
            token_count=0,
            compaction_count=0,
            created_at=now,
        )
        assert s.status == SessionStatus.active
        assert s.token_count == 0


class TestMessageSchemas:
    def test_message_create_defaults(self):
        m = MessageCreate(role=MessageRole.user, content="hello")
        assert m.message_type == MessageType.message
        assert m.parent_id is None

    def test_message_out(self):
        now = datetime.now(timezone.utc)
        m = MessageOut(
            id=uuid.uuid4(),
            session_id=uuid.uuid4(),
            parent_id=None,
            role=MessageRole.user,
            content="test",
            token_count=5,
            message_type=MessageType.message,
            created_at=now,
        )
        assert m.content == "test"
        assert m.parent_id is None


class TestMemorySchemas:
    def test_memory_note_create_defaults(self):
        m = MemoryNoteCreate(content="important note")
        assert m.note_type == NoteType.evergreen

    def test_memory_search_request(self):
        uid = uuid.uuid4()
        r = MemorySearchRequest(user_id=uid, query="test query")
        assert r.top_k == 10
        assert r.note_type is None

    def test_memory_search_result(self):
        now = datetime.now(timezone.utc)
        r = MemorySearchResult(
            chunk_text="some text",
            note_id=uuid.uuid4(),
            score=0.95,
            created_at=now,
        )
        assert r.score == 0.95


class TestContextSchemas:
    def test_context_build_request(self):
        r = ContextBuildRequest(
            user_id=uuid.uuid4(),
            session_id=uuid.uuid4(),
        )
        assert r.query is None

    def test_context_build_response(self):
        r = ContextBuildResponse(
            evergreen_memories=[],
            relevant_memories=[],
            recent_messages=[],
        )
        assert len(r.evergreen_memories) == 0


class TestMemorizeSchemas:
    def test_memorize_request(self):
        r = MemorizeRequest(
            new_raw_data_list=[{"content": "hi", "speaker_name": "Alice"}],
        )
        assert r.scene == "assistant"
        assert r.history_raw_data_list is None
        assert r.group_id is None

    def test_memorize_response_defaults(self):
        r = MemorizeResponse(memory_count=5)
        assert r.status == "ok"
        assert r.memory_count == 5


class TestRetrieveSchema:
    def test_retrieve_request_defaults(self):
        r = RetrieveRequest(query="test")
        assert r.retrieve_method == "hybrid"
        assert r.top_k == 20
        assert r.user_id is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
