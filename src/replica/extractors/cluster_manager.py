"""Cluster manager — semantic clustering of MemCells."""

import logging

import numpy as np

from replica.config import settings
from replica.providers.embedding_provider import get_embedding_provider
from replica.extractors import MemCellData

logger = logging.getLogger(__name__)


class ClusterState:
    """In-memory cluster state for a group."""

    def __init__(self):
        self.event_ids: list[str] = []
        self.timestamps: list[float] = []
        self.cluster_ids: list[str] = []
        self.eventid_to_cluster: dict[str, str] = {}
        self.next_cluster_idx: int = 0
        self.cluster_centroids: dict[str, list[float]] = {}
        self.cluster_counts: dict[str, int] = {}
        self.cluster_last_ts: dict[str, float | None] = {}

    def to_dict(self) -> dict:
        return {
            "event_ids": self.event_ids,
            "timestamps": self.timestamps,
            "cluster_ids": self.cluster_ids,
            "eventid_to_cluster": self.eventid_to_cluster,
            "next_cluster_idx": self.next_cluster_idx,
            "cluster_centroids": self.cluster_centroids,
            "cluster_counts": self.cluster_counts,
            "cluster_last_ts": self.cluster_last_ts,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ClusterState":
        state = cls()
        state.event_ids = data.get("event_ids", [])
        state.timestamps = data.get("timestamps", [])
        state.cluster_ids = data.get("cluster_ids", [])
        state.eventid_to_cluster = data.get("eventid_to_cluster", {})
        state.next_cluster_idx = data.get("next_cluster_idx", 0)
        state.cluster_centroids = data.get("cluster_centroids", {})
        state.cluster_counts = data.get("cluster_counts", {})
        state.cluster_last_ts = data.get("cluster_last_ts", {})
        return state


class ClusterManager:
    """Auto-cluster MemCells by semantic similarity with centroid tracking."""

    def __init__(
        self,
        similarity_threshold: float | None = None,
        max_time_gap_days: int | None = None,
    ):
        self.similarity_threshold = (
            similarity_threshold or settings.memory.cluster_similarity_threshold
        )
        self.max_time_gap_days = (
            max_time_gap_days or settings.memory.cluster_max_time_gap_days
        )

    async def cluster_memcell(
        self,
        memcell: MemCellData,
        state: ClusterState,
    ) -> tuple[str, ClusterState]:
        """Assign a MemCell to a cluster. Returns (cluster_id, updated_state)."""
        # Get embedding for memcell content
        text = memcell.summary or ""
        if not text and memcell.original_data:
            parts = []
            for msg in memcell.original_data:
                if isinstance(msg, dict) and msg.get("content"):
                    parts.append(msg["content"])
            text = " ".join(parts[:5])

        if not text:
            cluster_id = self._new_cluster(state, memcell)
            return cluster_id, state

        try:
            provider = get_embedding_provider()
            embedding = await provider.embed_query(text)
        except Exception as e:
            logger.warning("Failed to embed for clustering: %s", e)
            cluster_id = self._new_cluster(state, memcell)
            return cluster_id, state

        embedding_np = np.array(embedding)

        # Find best matching cluster
        best_cluster = None
        best_sim = -1.0
        ts_value = memcell.timestamp.timestamp() if memcell.timestamp else 0

        for cid, centroid in state.cluster_centroids.items():
            centroid_np = np.array(centroid)
            # Cosine similarity
            norm_prod = np.linalg.norm(embedding_np) * np.linalg.norm(centroid_np)
            if norm_prod == 0:
                continue
            sim = float(np.dot(embedding_np, centroid_np) / norm_prod)

            # Check time gap
            last_ts = state.cluster_last_ts.get(cid)
            if last_ts is not None and ts_value > 0:
                gap_days = (ts_value - last_ts) / 86400
                if gap_days > self.max_time_gap_days:
                    continue

            if sim > best_sim:
                best_sim = sim
                best_cluster = cid

        if best_cluster is not None and best_sim >= self.similarity_threshold:
            cluster_id = best_cluster
            # Update centroid (online average)
            count = state.cluster_counts.get(cluster_id, 1)
            old_centroid = np.array(state.cluster_centroids[cluster_id])
            new_centroid = (old_centroid * count + embedding_np) / (count + 1)
            state.cluster_centroids[cluster_id] = new_centroid.tolist()
            state.cluster_counts[cluster_id] = count + 1
            state.cluster_last_ts[cluster_id] = ts_value if ts_value > 0 else None
        else:
            cluster_id = self._new_cluster(state, memcell, embedding)

        state.event_ids.append(memcell.event_id)
        state.timestamps.append(ts_value)
        state.cluster_ids.append(cluster_id)
        state.eventid_to_cluster[memcell.event_id] = cluster_id

        return cluster_id, state

    def _new_cluster(
        self,
        state: ClusterState,
        memcell: MemCellData,
        embedding: list[float] | None = None,
    ) -> str:
        cluster_id = f"cluster_{state.next_cluster_idx}"
        state.next_cluster_idx += 1
        if embedding is not None:
            state.cluster_centroids[cluster_id] = (
                embedding if isinstance(embedding, list) else embedding.tolist()
            )
        state.cluster_counts[cluster_id] = 1
        ts_value = memcell.timestamp.timestamp() if memcell.timestamp else None
        state.cluster_last_ts[cluster_id] = ts_value
        return cluster_id

    def get_cluster_memcell_ids(
        self, state: ClusterState, cluster_id: str
    ) -> list[str]:
        """Get all event_ids in a specific cluster."""
        return [
            eid for eid, cid in state.eventid_to_cluster.items() if cid == cluster_id
        ]
