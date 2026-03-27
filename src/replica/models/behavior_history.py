"""BehaviorHistory — User behavior tracking."""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Index, func
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from replica.db.database import Base


class BehaviorHistory(Base):
    __tablename__ = "behavior_histories"
    __table_args__ = (Index("ix_behavior_user_type_ts", "user_id", "timestamp"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(String(255), index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    behavior_type: Mapped[list | None] = mapped_column(ARRAY(String(100)), nullable=True)
    event_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    extend: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
