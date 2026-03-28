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
from replica.models.memory_note import MemoryNote, NoteType, NoteSource
from replica.models.memory_chunk import MemoryChunk
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

        session.status = SessionStatus.archived
        await db.commit()
        await db.refresh(session)
        assert session.status == SessionStatus.archived

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


class TestMemoryNoteCRUD:
    async def test_create_memory_note(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        note = MemoryNote(
            user_id=user.id,
            note_type=NoteType.evergreen,
            content="User likes coffee.",
            source=NoteSource.manual,
        )
        db.add(note)
        await db.commit()
        await db.refresh(note)

        assert note.id is not None
        assert note.note_type == NoteType.evergreen

        await db.delete(note)
        await db.delete(user)
        await db.commit()

    async def test_create_chunk_with_embedding(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        note = MemoryNote(
            user_id=user.id,
            note_type=NoteType.daily,
            content="User discussed project deadlines and weekend plans.",
            source=NoteSource.auto_flush,
        )
        db.add(note)
        await db.commit()
        await db.refresh(note)

        provider = _fresh_embedding_provider()
        embedding = await provider.embed_query(note.content)
        await provider.close()

        chunk = MemoryChunk(
            user_id=user.id,
            note_id=note.id,
            chunk_text=note.content,
            embedding=embedding,
            chunk_index=0,
            start_offset=0,
            end_offset=len(note.content),
        )
        db.add(chunk)
        await db.commit()
        await db.refresh(chunk)

        assert chunk.id is not None
        assert chunk.note_id == note.id

        await db.delete(chunk)
        await db.delete(note)
        await db.delete(user)
        await db.commit()

    async def test_note_chunk_relationship(self, db: AsyncSession):
        user = User(external_id=f"test_{uuid.uuid4().hex[:8]}")
        db.add(user)
        await db.commit()
        await db.refresh(user)

        note = MemoryNote(
            user_id=user.id,
            note_type=NoteType.evergreen,
            content="Important information.",
            source=NoteSource.manual,
        )
        db.add(note)
        await db.commit()
        await db.refresh(note)

        provider = _fresh_embedding_provider()
        embedding = await provider.embed_query("Important information.")
        await provider.close()

        chunk = MemoryChunk(
            user_id=user.id,
            note_id=note.id,
            chunk_text="Important information.",
            embedding=embedding,
            chunk_index=0,
            start_offset=0,
            end_offset=22,
        )
        db.add(chunk)
        await db.commit()

        result = await db.execute(select(MemoryChunk).where(MemoryChunk.note_id == note.id))
        chunks = result.scalars().all()
        assert len(chunks) == 1
        assert chunks[0].chunk_text == "Important information."

        await db.delete(chunk)
        await db.delete(note)
        await db.delete(user)
        await db.commit()


class TestMemCellCRUD:
    async def test_create_memcell(self, db: AsyncSession):
        memcell = MemCell(
            user_id="test_user_001",
            group_id="test_group_001",
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
