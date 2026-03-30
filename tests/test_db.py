"""Database CRUD tests — real PostgreSQL with pgvector."""

import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from replica.config import get_settings
from replica.db.database import Base
from replica.models.user import User
from replica.models.session import Session, SessionStatus
from replica.models.message import Message, MessageRole, MessageType
from replica.models.evergreen_memory import EvergreenMemory, EvergreenCategory, EvergreenSource
from replica.models.knowledge_entry import KnowledgeEntry, EntryType
from replica.models.memcell import MemCell
from replica.services.embedding_service import count_tokens
from replica.providers.embedding_provider import VLLMEmbeddingProvider


def _fresh_embedding_provider() -> VLLMEmbeddingProvider:
    return VLLMEmbeddingProvider(get_settings().embedding)


@pytest.fixture
async def db():
    """Create a fresh engine+session per test to avoid event loop conflicts."""
    test_engine = create_async_engine(get_settings().database_url, echo=False)
    async with test_engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session

    await test_engine.dispose()


class TestUserCRUD:
    async def test_create_user(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}", metadata_={"name": "Test User"})
        db.add(user)
        await db.commit()
        await db.refresh(user)

        assert user.id is not None
        assert isinstance(user.id, uuid.UUID)
        assert user.created_at is not None

        await db.delete(user)
        await db.commit()

    async def test_query_user_by_id(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        fetched = await db.get(User, user.id)
        assert fetched is not None
        assert fetched.external_id == user.external_id

        await db.delete(user)
        await db.commit()

    async def test_external_id_unique(self, db: AsyncSession):
        ext_id = f"unique_{uuid.uuid4().hex[:8]}"
        u1 = User(external_id=ext_id)
        db.add(u1)
        await db.commit()

        u2 = User(external_id=ext_id)
        db.add(u2)
        with pytest.raises(Exception):
            await db.commit()
        await db.rollback()

        result = await db.execute(select(User).where(User.external_id == ext_id))
        u1_fresh = result.scalar_one()
        await db.delete(u1_fresh)
        await db.commit()


class TestSessionCRUD:
    async def test_create_session(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        session = Session(user_id=user.id, metadata_={"purpose": "test"})
        db.add(session)
        await db.commit()
        await db.refresh(session)

        assert session.id is not None
        assert session.status == SessionStatus.active
        assert session.token_count == 0

        await db.delete(session)
        await db.delete(user)
        await db.commit()

    async def test_list_sessions_by_user(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        s1 = Session(user_id=user.id)
        s2 = Session(user_id=user.id)
        db.add_all([s1, s2])
        await db.commit()

        result = await db.execute(select(Session).where(Session.user_id == user.id))
        sessions = result.scalars().all()
        assert len(sessions) == 2

        for s in sessions:
            await db.delete(s)
        await db.delete(user)
        await db.commit()

    async def test_update_session_status(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        session = Session(user_id=user.id)
        db.add(session)
        await db.commit()
        await db.refresh(session)

        session.status = SessionStatus.deleted
        await db.commit()
        await db.refresh(session)
        assert session.status == SessionStatus.deleted

        await db.delete(session)
        await db.delete(user)
        await db.commit()


class TestMessageCRUD:
    async def test_create_message(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        session = Session(user_id=user.id)
        db.add(session)
        await db.commit()
        await db.refresh(session)

        content = "Hello, this is a test message."
        msg = Message(
            session_id=session.id,
            role=MessageRole.user,
            content=content,
            token_count=count_tokens(content),
            message_type=MessageType.message,
        )
        db.add(msg)
        await db.commit()
        await db.refresh(msg)

        assert msg.id is not None
        assert msg.token_count > 0
        assert msg.is_compacted is False

        await db.delete(msg)
        await db.delete(session)
        await db.delete(user)
        await db.commit()

    async def test_list_messages_by_session(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        session = Session(user_id=user.id)
        db.add(session)
        await db.commit()
        await db.refresh(session)

        for i in range(3):
            msg = Message(
                session_id=session.id,
                role=MessageRole.user if i % 2 == 0 else MessageRole.assistant,
                content=f"Message {i}",
                token_count=count_tokens(f"Message {i}"),
            )
            db.add(msg)
        await db.commit()

        result = await db.execute(select(Message).where(Message.session_id == session.id).order_by(Message.created_at))
        messages = result.scalars().all()
        assert len(messages) == 3

        for m in messages:
            await db.delete(m)
        await db.delete(session)
        await db.delete(user)
        await db.commit()

    async def test_token_count_accumulation(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        session = Session(user_id=user.id)
        db.add(session)
        await db.commit()
        await db.refresh(session)

        total_tokens = 0
        msgs = []
        for text_content in ["Hello world", "How are you?", "Fine thanks"]:
            tokens = count_tokens(text_content)
            total_tokens += tokens
            msg = Message(
                session_id=session.id,
                role=MessageRole.user,
                content=text_content,
                token_count=tokens,
            )
            db.add(msg)
            msgs.append(msg)

        session.token_count = total_tokens
        await db.commit()
        await db.refresh(session)
        assert session.token_count == total_tokens

        for m in msgs:
            await db.delete(m)
        await db.delete(session)
        await db.delete(user)
        await db.commit()


class TestEvergreenMemoryCRUD:
    async def test_create_evergreen(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        mem = EvergreenMemory(
            user_id=user.id,
            category=EvergreenCategory.fact,
            content="User likes coffee.",
            source=EvergreenSource.manual,
        )
        db.add(mem)
        await db.commit()
        await db.refresh(mem)

        assert mem.id is not None
        assert mem.category == EvergreenCategory.fact
        assert mem.confidence == 1.0

        await db.delete(mem)
        await db.delete(user)
        await db.commit()

    async def test_list_evergreen_by_user(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        for content in ["Likes coffee", "Lives in Shanghai", "Software engineer"]:
            db.add(
                EvergreenMemory(
                    user_id=user.id,
                    category=EvergreenCategory.fact,
                    content=content,
                    source=EvergreenSource.manual,
                )
            )
        await db.commit()

        result = await db.execute(select(EvergreenMemory).where(EvergreenMemory.user_id == user.id))
        memories = result.scalars().all()
        assert len(memories) == 3

        for m in memories:
            await db.delete(m)
        await db.delete(user)
        await db.commit()


class TestKnowledgeEntryCRUD:
    async def test_create_knowledge_entry(self, db: AsyncSession):
        entry = KnowledgeEntry(
            user_id="test_user_001",
            entry_type=EntryType.event,
            title="Alice likes hiking",
            content="Alice mentioned she enjoys hiking, especially in the mountains.",
            metadata_={"event_type": "Conversation"},
        )
        db.add(entry)
        await db.commit()
        await db.refresh(entry)

        assert entry.id is not None
        assert entry.entry_type == EntryType.event

        await db.delete(entry)
        await db.commit()

    async def test_create_knowledge_with_embedding(self, db: AsyncSession):
        provider = _fresh_embedding_provider()
        content = "Alice is planning a tech talk about FlashAttention next month."
        embedding = await provider.embed_query(content)
        await provider.close()

        entry = KnowledgeEntry(
            user_id="test_user_002",
            entry_type=EntryType.foresight,
            title="FlashAttention tech talk",
            content=content,
            metadata_={"evidence": "Alice said she's preparing slides", "duration_days": 30},
            embedding=embedding,
        )
        db.add(entry)
        await db.commit()
        await db.refresh(entry)

        assert entry.id is not None
        assert entry.embedding is not None

        await db.delete(entry)
        await db.commit()

    async def test_query_by_type(self, db: AsyncSession):
        for i, etype in enumerate([EntryType.episode, EntryType.event, EntryType.event]):
            db.add(
                KnowledgeEntry(
                    user_id="test_user_003",
                    entry_type=etype,
                    content=f"Entry {i}",
                )
            )
        await db.commit()

        result = await db.execute(
            select(KnowledgeEntry).where(
                KnowledgeEntry.user_id == "test_user_003",
                KnowledgeEntry.entry_type == EntryType.event,
            )
        )
        events = result.scalars().all()
        assert len(events) == 2

        all_result = await db.execute(select(KnowledgeEntry).where(KnowledgeEntry.user_id == "test_user_003"))
        for e in all_result.scalars().all():
            await db.delete(e)
        await db.commit()


class TestMemCellCRUD:
    async def test_create_memcell(self, db: AsyncSession):
        memcell = MemCell(
            user_id="test_user_001",
            timestamp=datetime.now(timezone.utc),
            summary="Test conversation about project planning",
            data_type="Conversation",
            original_data=[
                {"speaker_name": "Alice", "content": "Let's plan the sprint"},
                {"speaker_name": "Bob", "content": "Sure, what tasks do we have?"},
            ],
            participants=["Alice", "Bob"],
        )
        db.add(memcell)
        await db.commit()
        await db.refresh(memcell)

        assert memcell.id is not None
        assert memcell.original_data is not None
        assert len(memcell.original_data) == 2
        assert memcell.participants == ["Alice", "Bob"]

        await db.delete(memcell)
        await db.commit()

    async def test_memcell_jsonb_query(self, db: AsyncSession):
        memcell = MemCell(
            user_id="test_user_002",
            timestamp=datetime.now(timezone.utc),
            summary="Query test",
            original_data=[{"key": "value"}],
        )
        db.add(memcell)
        await db.commit()
        await db.refresh(memcell)

        result = await db.execute(select(MemCell).where(MemCell.user_id == "test_user_002"))
        found = result.scalar_one_or_none()
        assert found is not None
        assert found.summary == "Query test"

        await db.delete(memcell)
        await db.commit()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
