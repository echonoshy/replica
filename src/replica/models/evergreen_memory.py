"""EvergreenMemory — Long-term persistent facts about the user."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import Text, Float, DateTime, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import UUID, ENUM
from sqlalchemy.orm import Mapped, mapped_column, relationship

from replica.db.database import Base


class EvergreenCategory(str, enum.Enum):
    fact = "fact"
    preference = "preference"
    relationship = "relationship"
    goal = "goal"


class EvergreenSource(str, enum.Enum):
    manual = "manual"
    profile_extract = "profile_extract"


class EvergreenMemory(Base):
    __tablename__ = "evergreen_memories"
    __table_args__ = (Index("ix_evergreen_user_category", "user_id", "category"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), index=True)
    category: Mapped[EvergreenCategory] = mapped_column(
        ENUM(EvergreenCategory, name="evergreen_category"), default=EvergreenCategory.fact
    )
    content: Mapped[str] = mapped_column(Text)
    source: Mapped[EvergreenSource] = mapped_column(
        ENUM(EvergreenSource, name="evergreen_source"), default=EvergreenSource.manual
    )
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship(back_populates="evergreen_memories")  # noqa: F821
