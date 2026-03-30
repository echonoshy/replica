"""KnowledgeEntry — Unified knowledge base extracted from conversations.

Merges episodic memories, event logs, and foresight predictions into a single
searchable table with a shared vector index.
"""

import enum
import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import String, Text, DateTime, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY, ENUM
from sqlalchemy.orm import Mapped, mapped_column

from replica.config import settings
from replica.db.database import Base


class EntryType(str, enum.Enum):
    episode = "episode"
    event = "event"
    foresight = "foresight"


class KnowledgeEntry(Base):
    __tablename__ = "knowledge_entries"
    __table_args__ = (
        Index("ix_knowledge_user_type", "user_id", "entry_type"),
        Index("ix_knowledge_user_created", "user_id", "created_at"),
        Index("ix_knowledge_memcell", "memcell_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    entry_type: Mapped[EntryType] = mapped_column(ENUM(EntryType, name="entry_type"))
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    content: Mapped[str] = mapped_column(Text)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSONB, nullable=True)
    embedding = mapped_column(Vector(settings.embedding.dimensions), nullable=True)
    memcell_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("memcells.id"), nullable=True)
    participants: Mapped[list | None] = mapped_column(ARRAY(String(255)), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
