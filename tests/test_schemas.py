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
    EvergreenMemoryCreate,
    KnowledgeSearchRequest,
    KnowledgeSearchResult,
    ContextBuildRequest,
    ContextBuildResponse,
    MemorizeRequest,
    MemorizeResponse,
)
from replica.models.message import MessageRole, MessageType
from replica.models.evergreen_memory import EvergreenCategory
from replica.models.knowledge_entry import EntryType
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
            metadata_=None,
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


class TestEvergreenSchemas:
    def test_evergreen_create_defaults(self):
        m = EvergreenMemoryCreate(content="important note")
        assert m.category == EvergreenCategory.fact

    def test_evergreen_create_with_category(self):
        m = EvergreenMemoryCreate(content="likes coffee", category=EvergreenCategory.preference)
        assert m.category == EvergreenCategory.preference


class TestKnowledgeSchemas:
    def test_knowledge_search_request(self):
        uid = uuid.uuid4()
        r = KnowledgeSearchRequest(user_id=uid, query="test query")
        assert r.top_k == 10
        assert r.entry_type is None

    def test_knowledge_search_request_with_type(self):
        uid = uuid.uuid4()
        r = KnowledgeSearchRequest(user_id=uid, query="test", entry_type=EntryType.episode)
        assert r.entry_type == EntryType.episode

    def test_knowledge_search_result(self):
        now = datetime.now(timezone.utc)
        r = KnowledgeSearchResult(
            id=uuid.uuid4(),
            entry_type=EntryType.event,
            title="some fact",
            content="some text",
            score=0.95,
            created_at=now,
        )
        assert r.score == 0.95
        assert r.entry_type == EntryType.event


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
            relevant_knowledge=[],
            recent_messages=[],
        )
        assert len(r.evergreen_memories) == 0
        assert len(r.relevant_knowledge) == 0


class TestMemorizeSchemas:
    def test_memorize_request(self):
        r = MemorizeRequest(
            new_raw_data_list=[{"content": "hi", "speaker_name": "Alice"}],
        )
        assert r.history_raw_data_list is None

    def test_memorize_response_defaults(self):
        r = MemorizeResponse(memory_count=5)
        assert r.status == "ok"
        assert r.memory_count == 5


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
