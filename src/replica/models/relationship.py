"""Relationship — Connections between entities."""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from replica.db.database import Base


class Relationship(Base):
    __tablename__ = "relationships"
    __table_args__ = (UniqueConstraint("source_entity_id", "target_entity_id", name="uq_relationship_pair"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_entity_id: Mapped[str] = mapped_column(String(255), index=True)
    target_entity_id: Mapped[str] = mapped_column(String(255), index=True)
    # [{type, content, detail}]
    relationship: Mapped[dict] = mapped_column(JSONB, default=list)
    extend: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
