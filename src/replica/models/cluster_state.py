"""ClusterState — Semantic clustering state for MemCells."""

import uuid
from datetime import datetime

from sqlalchemy import String, Integer, DateTime, Index, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from replica.db.database import Base


class ClusterState(Base):
    __tablename__ = "cluster_states"
    __table_args__ = (Index("ix_cluster_state_group", "group_id", unique=True),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id: Mapped[str] = mapped_column(String(255))
    event_ids: Mapped[dict] = mapped_column(JSONB, default=list)  # list of event ids
    timestamps: Mapped[dict] = mapped_column(JSONB, default=list)  # list of float timestamps
    cluster_ids: Mapped[dict] = mapped_column(JSONB, default=list)  # list of cluster ids
    eventid_to_cluster: Mapped[dict] = mapped_column(JSONB, default=dict)
    next_cluster_idx: Mapped[int] = mapped_column(Integer, default=0)
    # {cluster_id: [float]} centroid vectors
    cluster_centroids: Mapped[dict] = mapped_column(JSONB, default=dict)
    # {cluster_id: int} counts
    cluster_counts: Mapped[dict] = mapped_column(JSONB, default=dict)
    # {cluster_id: float|null} last timestamp
    cluster_last_ts: Mapped[dict] = mapped_column(JSONB, default=dict)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
