"""ConversationStatus — Tracks conversation processing state."""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Index, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from replica.db.database import Base


class ConversationStatus(Base):
    __tablename__ = "conversation_statuses"
    __table_args__ = (Index("ix_conv_status_group", "group_id", unique=True),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id: Mapped[str] = mapped_column(String(255))
    old_msg_start_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    new_msg_start_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_memcell_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
