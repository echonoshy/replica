"""MemCell — Atomic memory unit from boundary-detected conversation segments."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import String, Text, DateTime, Index, func
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from replica.db.database import Base


class DataType(str, enum.Enum):
    conversation = "Conversation"


class MemCell(Base):
    __tablename__ = "memcells"
    __table_args__ = (Index("ix_memcells_user_deleted_ts", "user_id", "deleted_at", "timestamp"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    data_type: Mapped[DataType] = mapped_column(String(50), default=DataType.conversation)
    original_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    participants: Mapped[list | None] = mapped_column(ARRAY(String(255)), nullable=True)
    keywords: Mapped[list | None] = mapped_column(ARRAY(String(255)), nullable=True)
    linked_entities: Mapped[list | None] = mapped_column(ARRAY(String(255)), nullable=True)
    episode: Mapped[str | None] = mapped_column(Text, nullable=True)
    event_log: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    foresight_memories: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    extend: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Soft delete
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
