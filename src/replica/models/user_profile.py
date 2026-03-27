"""UserProfile — User characteristics extracted from conversations (versioned)."""

import uuid
from datetime import datetime

from sqlalchemy import (
    String,
    Integer,
    Float,
    Boolean,
    DateTime,
    Index,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from replica.db.database import Base


class UserProfile(Base):
    __tablename__ = "user_profiles"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "group_id", "version", name="uq_user_profile_version"
        ),
        Index("ix_user_profile_latest", "user_id", "group_id", "is_latest"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[str] = mapped_column(String(255), index=True)
    user_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    group_id: Mapped[str] = mapped_column(String(255), index=True, default="")
    scenario: Mapped[str] = mapped_column(
        String(50), default="assistant"
    )  # group_chat | assistant

    # Profile data stored as JSONB for flexibility (skills, personality, projects, etc.)
    profile_data: Mapped[dict] = mapped_column(JSONB, default=dict)

    # Version control
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_latest: Mapped[bool] = mapped_column(Boolean, default=True)

    # Extraction metadata
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    memcell_count: Mapped[int] = mapped_column(Integer, default=0)
    cluster_ids: Mapped[dict | None] = mapped_column(
        JSONB, nullable=True
    )  # list of cluster ids
    last_updated_cluster: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
