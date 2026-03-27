"""Memorize pipeline — end-to-end memory ingestion.

Raw data → Boundary detection → MemCell → Extract memories → Persist.
"""

import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from replica.config import settings
from replica.extractors import (
    MemCellExtractRequest,
    MemoryExtractRequest,
    RawData,
    ParentType,
)
from replica.extractors.memcell_extractor import ConvMemCellExtractor
from replica.extractors.episode_extractor import EpisodeMemoryExtractor
from replica.extractors.event_log_extractor import EventLogExtractor
from replica.extractors.foresight_extractor import ForesightExtractor
from replica.extractors.profile_extractor import ProfileMemoryExtractor
from replica.extractors.group_profile_extractor import GroupProfileExtractor
from replica.extractors.cluster_manager import ClusterManager
from replica.models.memcell import MemCell
from replica.models.episodic_memory import EpisodicMemory
from replica.models.event_log import EventLogRecord
from replica.models.foresight import ForesightRecord

logger = logging.getLogger(__name__)


class MemorizePipeline:
    """Orchestrates the full memory ingestion pipeline."""

    def __init__(self):
        self.memcell_extractor = ConvMemCellExtractor()
        self.episode_extractor = EpisodeMemoryExtractor()
        self.event_log_extractor = EventLogExtractor()
        self.foresight_extractor = ForesightExtractor()
        self.profile_extractor = ProfileMemoryExtractor()
        self.group_profile_extractor = GroupProfileExtractor()
        self.cluster_manager = ClusterManager()

    async def memorize(
        self,
        db: AsyncSession,
        new_raw_data_list: list[dict],
        history_raw_data_list: list[dict] | None = None,
        user_id_list: list[str] | None = None,
        group_id: str | None = None,
        group_name: str | None = None,
        scene: str = "assistant",
    ) -> int:
        """Main memorize entry point.

        Returns count of extracted memory objects.
        """
        history = [RawData(content=d) for d in (history_raw_data_list or [])]
        new_data = [RawData(content=d) for d in new_raw_data_list]

        request = MemCellExtractRequest(
            history_raw_data_list=history,
            new_raw_data_list=new_data,
            user_id_list=user_id_list or [],
            group_id=group_id,
            group_name=group_name,
        )

        # Step 1: Boundary detection
        memcell_data, status = await self.memcell_extractor.extract_memcell(request)
        if memcell_data is None:
            logger.debug("No boundary detected, waiting for more messages")
            return 0

        # Step 2: Save MemCell to DB
        memcell_db = MemCell(
            user_id=memcell_data.user_id_list[0] if memcell_data.user_id_list else None,
            group_id=memcell_data.group_id,
            timestamp=memcell_data.timestamp or datetime.now(timezone.utc),
            summary=memcell_data.summary,
            data_type=memcell_data.data_type.value,
            original_data=memcell_data.original_data,
            participants=memcell_data.participants,
        )
        db.add(memcell_db)
        await db.flush()

        memory_count = 0

        # Step 3: Extract memories
        extract_req = MemoryExtractRequest(
            memcell=memcell_data,
            user_id=memcell_data.user_id_list[0] if memcell_data.user_id_list else None,
            group_id=group_id,
        )

        # 3a: Episode extraction (group + personal)
        is_group = scene == "group_chat"
        episode = await self.episode_extractor.extract_memory(extract_req, is_group=is_group)
        if episode:
            embedding = episode.extend.get("embedding") if episode.extend else None
            ep_db = EpisodicMemory(
                user_id=episode.user_id,
                group_id=episode.group_id,
                timestamp=episode.timestamp or datetime.now(timezone.utc),
                summary=episode.summary or "",
                title=episode.title,
                episode=episode.episode,
                subject=episode.subject,
                participants=episode.participants,
                memcell_event_id_list=[memcell_data.event_id],
                parent_type=ParentType.MEMCELL.value,
                parent_id=str(memcell_db.id),
                embedding=embedding,
                vector_model=settings.embedding.model if embedding else None,
            )
            db.add(ep_db)
            memory_count += 1

            # Update memcell with episode content
            memcell_db.episode = episode.episode
            memcell_db.subject = episode.title

        # 3b: Event log extraction
        event_log = await self.event_log_extractor.extract_memory(extract_req)
        if event_log and event_log.atomic_fact:
            for i, fact in enumerate(event_log.atomic_fact):
                embedding = (
                    event_log.fact_embeddings[i]
                    if event_log.fact_embeddings and i < len(event_log.fact_embeddings)
                    else None
                )
                el_db = EventLogRecord(
                    user_id=event_log.user_id,
                    group_id=event_log.group_id,
                    atomic_fact=fact,
                    parent_type=ParentType.MEMCELL.value,
                    parent_id=str(memcell_db.id),
                    timestamp=event_log.timestamp or datetime.now(timezone.utc),
                    participants=memcell_data.participants,
                    event_type="Conversation",
                    embedding=embedding,
                    vector_model=settings.embedding.model if embedding else None,
                )
                db.add(el_db)
                memory_count += 1

        # 3c: Foresight extraction
        foresights = await self.foresight_extractor.extract_memory(extract_req)
        for fs in foresights:
            fs_db = ForesightRecord(
                user_id=fs.user_id,
                group_id=fs.group_id,
                content=fs.content,
                evidence=fs.evidence,
                parent_type=ParentType.MEMCELL.value,
                parent_id=str(memcell_db.id),
                start_time=fs.start_time,
                end_time=fs.end_time,
                duration_days=fs.duration_days,
                participants=memcell_data.participants,
                embedding=fs.vector,
                vector_model=settings.embedding.model if fs.vector else None,
            )
            db.add(fs_db)
            memory_count += 1

        await db.commit()
        logger.info(
            "Memorize complete: %d memories extracted from MemCell %s",
            memory_count,
            memcell_db.id,
        )
        return memory_count
