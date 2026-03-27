"""GroupProfile — Group-level topics, roles, and summary (versioned)."""

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, DateTime, Index, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from replica.db.database import Base


class GroupProfile(Base):
    __tablename__ = "group_profiles"
    __table_args__ = (
        UniqueConstraint("group_id", "version", name="uq_group_profile_version"),
        Index("ix_group_profile_latest", "group_id", "is_latest"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    group_id: Mapped[str] = mapped_column(String(255), index=True)
    group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Topics: list of {name, summary, status, evidences, confidence, ...}
    topics: Mapped[dict] = mapped_column(JSONB, default=list)
    # Roles: {role_name: [{speaker, evidences, confidence}]}
    roles: Mapped[dict] = mapped_column(JSONB, default=dict)

    summary: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    subject: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Version control
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_latest: Mapped[bool] = mapped_column(Boolean, default=True)

    extend: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
