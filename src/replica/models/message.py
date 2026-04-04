import enum
import uuid
from datetime import datetime

from sqlalchemy import Text, Integer, DateTime, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import UUID, ENUM
from sqlalchemy.orm import Mapped, mapped_column, relationship

from replica.db.database import Base


class MessageRole(str, enum.Enum):
    user = "user"
    assistant = "assistant"
    system = "system"
    tool = "tool"


class MessageType(str, enum.Enum):
    message = "message"
    compaction_summary = "compaction_summary"


class ExtractionStatus(str, enum.Enum):
    pending = "pending"
    extracted = "extracted"
    skipped = "skipped"


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_session_created", "session_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("messages.id"), nullable=True)
    role: Mapped[MessageRole] = mapped_column(ENUM(MessageRole, name="message_role"))
    content: Mapped[str] = mapped_column(Text)
    token_count: Mapped[int] = mapped_column(Integer, default=0)
    message_type: Mapped[MessageType] = mapped_column(
        ENUM(MessageType, name="message_type"), default=MessageType.message
    )
    is_compacted: Mapped[bool] = mapped_column(default=False)
    extraction_status: Mapped[ExtractionStatus] = mapped_column(
        ENUM(ExtractionStatus, name="extraction_status"), default=ExtractionStatus.pending
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    session: Mapped["Session"] = relationship(back_populates="messages")  # noqa: F821
