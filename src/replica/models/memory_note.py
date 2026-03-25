import enum
import uuid
from datetime import datetime

from sqlalchemy import Text, DateTime, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import UUID, ENUM
from sqlalchemy.orm import Mapped, mapped_column, relationship

from replica.db.database import Base


class NoteType(str, enum.Enum):
    daily = "daily"
    evergreen = "evergreen"


class NoteSource(str, enum.Enum):
    auto_flush = "auto_flush"
    session_end = "session_end"
    manual = "manual"
    compaction = "compaction"


class MemoryNote(Base):
    __tablename__ = "memory_notes"
    __table_args__ = (
        Index("ix_memory_notes_user_type", "user_id", "note_type"),
        Index("ix_memory_notes_user_created", "user_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"), nullable=True)
    note_type: Mapped[NoteType] = mapped_column(ENUM(NoteType, name="note_type"))
    content: Mapped[str] = mapped_column(Text)
    source: Mapped[NoteSource] = mapped_column(ENUM(NoteSource, name="note_source"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user: Mapped["User"] = relationship(back_populates="memory_notes")  # noqa: F821
    chunks: Mapped[list["MemoryChunk"]] = relationship(back_populates="note", cascade="all, delete-orphan")  # noqa: F821
