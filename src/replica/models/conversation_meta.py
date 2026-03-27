"""ConversationMeta — Conversation metadata (scene, participants, etc.)."""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Index, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from replica.db.database import Base


class ConversationMeta(Base):
    __tablename__ = "conversation_metas"
    __table_args__ = (Index("ix_conv_meta_group", "group_id", unique=True),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    scene: Mapped[str | None] = mapped_column(String(100), nullable=True)  # group_chat | assistant
    scene_desc: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    description: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    default_timezone: Mapped[str | None] = mapped_column(String(100), nullable=True)
    conversation_created_at: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # {user_id: {full_name, role, extra}}
    user_details: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    tags: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # list of tags

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
