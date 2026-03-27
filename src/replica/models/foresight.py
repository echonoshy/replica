"""ForesightRecord — Prospective associations / future behavior predictions."""

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import String, Text, Integer, DateTime, Index, func
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from replica.config import settings
from replica.db.database import Base


class ForesightRecord(Base):
    __tablename__ = "foresight_records"
    __table_args__ = (
        Index("ix_foresight_user_ts", "user_id", "start_time", "end_time"),
        Index("ix_foresight_group_ts", "group_id", "start_time", "end_time"),
        Index("ix_foresight_parent", "parent_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    user_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    group_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content: Mapped[str] = mapped_column(Text)
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_type: Mapped[str] = mapped_column(String(50))
    parent_id: Mapped[str] = mapped_column(String(255))
    start_time: Mapped[str | None] = mapped_column(
        String(20), nullable=True
    )  # YYYY-MM-DD
    end_time: Mapped[str | None] = mapped_column(String(20), nullable=True)
    duration_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    participants: Mapped[list | None] = mapped_column(ARRAY(String(255)), nullable=True)
    # Vector embedding
    embedding = mapped_column(Vector(settings.embedding.dimensions), nullable=True)
    vector_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    extend: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
