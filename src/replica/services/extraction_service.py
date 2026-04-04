"""Memory extraction service — independent from compaction.

Extracts memories from session messages when session ends or manually triggered.
"""

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from replica.models.message import Message, MessageRole, ExtractionStatus
from replica.models.session import Session
from replica.services.memorize_service import MemorizePipeline

logger = logging.getLogger(__name__)


class ExtractionService:
    """Handles memory extraction from session messages."""

    def __init__(self):
        self.pipeline = MemorizePipeline()

    async def extract_from_session(self, db: AsyncSession, session_id: UUID) -> int:
        """Extract memories from all unextracted messages in a session.

        Returns count of extracted knowledge entries.
        """
        session = await db.get(Session, session_id)
        if not session:
            logger.warning("Session %s not found", session_id)
            return 0

        # Get all pending messages
        result = await db.execute(
            select(Message)
            .where(
                Message.session_id == session_id,
                Message.extraction_status == ExtractionStatus.pending,
                Message.role.in_([MessageRole.user, MessageRole.assistant]),
            )
            .order_by(Message.created_at)
        )
        messages = result.scalars().all()

        if len(messages) < 3:
            logger.debug("Session %s has only %d messages, skipping extraction", session_id, len(messages))
            return 0

        # Format messages for pipeline
        raw_data = [
            {
                "role": msg.role.value,
                "content": msg.content,
                "timestamp": msg.created_at.isoformat() if msg.created_at else None,
            }
            for msg in messages
        ]

        # Extract memories
        try:
            count = await self.pipeline.memorize(
                db,
                new_raw_data_list=raw_data,
                user_id_list=[str(session.user_id)] if session.user_id else None,
                force=True,  # Skip boundary detection, extract directly
            )

            # Mark messages as extracted
            for msg in messages:
                msg.extraction_status = ExtractionStatus.extracted

            await db.commit()

            logger.info(
                "Extracted %d knowledge entries from session %s (%d messages)", count, session_id, len(messages)
            )
            return count

        except Exception:
            logger.exception("Memory extraction failed for session %s", session_id)
            return 0
