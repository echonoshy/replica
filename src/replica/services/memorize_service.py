"""Memorize pipeline — end-to-end memory ingestion.

Raw data → Boundary detection → MemCell → Extract memories → KnowledgeEntry.

All extracted memories (episodes, events, foresights) are written to the
unified knowledge_entries table.  The three extractors run concurrently
via asyncio.gather to minimise wall-clock time.
"""

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from replica.extractors import (
    MemCellData,
    MemCellExtractRequest,
    MemoryExtractRequest,
    RawData,
    RawDataType,
    ParentType,
)
from replica.extractors.memcell_extractor import ConvMemCellExtractor
from replica.extractors.episode_extractor import EpisodeMemoryExtractor
from replica.extractors.event_log_extractor import EventLogExtractor
from replica.extractors.foresight_extractor import ForesightExtractor
from replica.extractors.profile_extractor import ProfileMemoryExtractor
from replica.models.memcell import MemCell
from replica.models.knowledge_entry import KnowledgeEntry, EntryType

logger = logging.getLogger(__name__)


class MemorizePipeline:
    """Orchestrates the full memory ingestion pipeline."""

    def __init__(self):
        self.memcell_extractor = ConvMemCellExtractor()
        self.episode_extractor = EpisodeMemoryExtractor()
        self.event_log_extractor = EventLogExtractor()
        self.foresight_extractor = ForesightExtractor()
        self.profile_extractor = ProfileMemoryExtractor()

    async def memorize(
        self,
        db: AsyncSession,
        new_raw_data_list: list[dict],
        history_raw_data_list: list[dict] | None = None,
        user_id_list: list[str] | None = None,
        force: bool = False,
    ) -> int:
        """Main memorize entry point.

        When force=True, skip boundary detection and directly create MemCell.
        Returns count of extracted knowledge entries.
        """
        all_data = (history_raw_data_list or []) + new_raw_data_list

        if force and all_data:
            memcell_data = MemCellData(
                user_id_list=user_id_list or [],
                original_data=all_data,
                timestamp=datetime.now(timezone.utc),
                summary="",
                data_type=RawDataType.CONVERSATION,
            )
        else:
            history = [RawData(content=d) for d in (history_raw_data_list or [])]
            new_data = [RawData(content=d) for d in new_raw_data_list]

            request = MemCellExtractRequest(
                history_raw_data_list=history,
                new_raw_data_list=new_data,
                user_id_list=user_id_list or [],
            )

            memcell_data, status = await self.memcell_extractor.extract_memcell(request)
            if memcell_data is None:
                logger.debug("No boundary detected, waiting for more messages")
                return 0

        # Step 2: Save MemCell to DB
        memcell_db = MemCell(
            user_id=memcell_data.user_id_list[0] if memcell_data.user_id_list else None,
            timestamp=memcell_data.timestamp or datetime.now(timezone.utc),
            summary=memcell_data.summary,
            data_type=memcell_data.data_type.value,
            original_data=memcell_data.original_data,
            participants=memcell_data.participants,
        )
        db.add(memcell_db)
        await db.flush()

        memory_count = 0

        # Step 3: Extract memories concurrently → write to unified knowledge_entries
        extract_req = MemoryExtractRequest(
            memcell=memcell_data,
            user_id=memcell_data.user_id_list[0] if memcell_data.user_id_list else None,
        )

        episode, event_log, foresights = await asyncio.gather(
            self.episode_extractor.extract_memory(extract_req),
            self.event_log_extractor.extract_memory(extract_req),
            self.foresight_extractor.extract_memory(extract_req),
        )

        if episode:
            embedding = episode.extend.get("embedding") if episode.extend else None
            entry = KnowledgeEntry(
                user_id=episode.user_id,
                entry_type=EntryType.episode,
                title=episode.title,
                content=episode.episode,
                metadata_={
                    "subject": episode.subject,
                    "summary": episode.summary,
                    "participants": episode.participants,
                    "parent_type": ParentType.MEMCELL.value,
                    "parent_id": str(memcell_db.id),
                },
                embedding=embedding,
                memcell_id=memcell_db.id,
                participants=episode.participants,
            )
            db.add(entry)
            memory_count += 1

            memcell_db.episode = episode.episode
            memcell_db.subject = episode.title

        if event_log and event_log.atomic_fact:
            for i, fact in enumerate(event_log.atomic_fact):
                embedding = (
                    event_log.fact_embeddings[i]
                    if event_log.fact_embeddings and i < len(event_log.fact_embeddings)
                    else None
                )
                entry = KnowledgeEntry(
                    user_id=event_log.user_id,
                    entry_type=EntryType.event,
                    title=fact[:100] if len(fact) > 100 else fact,
                    content=fact,
                    metadata_={
                        "event_type": "Conversation",
                        "parent_type": ParentType.MEMCELL.value,
                        "parent_id": str(memcell_db.id),
                    },
                    embedding=embedding,
                    memcell_id=memcell_db.id,
                    participants=memcell_data.participants,
                )
                db.add(entry)
                memory_count += 1

        for fs in foresights:
            entry = KnowledgeEntry(
                user_id=fs.user_id,
                entry_type=EntryType.foresight,
                title=fs.content[:100] if len(fs.content) > 100 else fs.content,
                content=fs.content,
                metadata_={
                    "evidence": fs.evidence,
                    "start_time": fs.start_time,
                    "end_time": fs.end_time,
                    "duration_days": fs.duration_days,
                    "parent_type": ParentType.MEMCELL.value,
                    "parent_id": str(memcell_db.id),
                },
                embedding=fs.vector,
                memcell_id=memcell_db.id,
                participants=memcell_data.participants,
            )
            db.add(entry)
            memory_count += 1

        await db.commit()
        logger.info(
            "Memorize complete: %d knowledge entries extracted from MemCell %s",
            memory_count,
            memcell_db.id,
        )
        return memory_count
