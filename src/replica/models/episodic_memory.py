"""EpisodicMemory — Narrative episode memories extracted from conversations."""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import String, Text, DateTime, Index, func
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from replica.config import settings
from replica.db.database import Base


class EpisodicMemory(Base):
    __tablename__ = "episodic_memories"
    __table_args__ = (
        Index("ix_episodic_user_ts", "user_id", "timestamp"),
        Index("ix_episodic_group_ts", "group_id", "timestamp"),
        Index("ix_episodic_group_user_ts", "group_id", "user_id", "timestamp"),
        Index("ix_episodic_parent", "parent_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    user_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    group_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    participants: Mapped[list | None] = mapped_column(ARRAY(String(255)), nullable=True)
    summary: Mapped[str] = mapped_column(Text)
    subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    episode: Mapped[str] = mapped_column(Text)
    keywords: Mapped[list | None] = mapped_column(ARRAY(String(255)), nullable=True)
    linked_entities: Mapped[list | None] = mapped_column(
        ARRAY(String(255)), nullable=True
    )
    memcell_event_id_list: Mapped[list | None] = mapped_column(
        ARRAY(String(255)), nullable=True
    )
    parent_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    parent_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Vector embedding for search
    embedding = mapped_column(Vector(settings.embedding.dimensions), nullable=True)
    vector_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    extend: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
