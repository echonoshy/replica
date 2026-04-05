"""Auto-extraction service for inactive sessions.

Automatically extracts memories from sessions that have been inactive for 24+ hours
and have unextracted messages.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, exists

from replica.db.database import async_session
from replica.models.session import Session, SessionStatus
from replica.models.message import Message, ExtractionStatus
from replica.services.extraction_service import ExtractionService

logger = logging.getLogger(__name__)


async def auto_extract_inactive_sessions():
    """Auto-extract memories from inactive sessions (24h+ no activity) with pending messages."""
    async with async_session() as db:
        threshold = datetime.now(timezone.utc) - timedelta(hours=24)

        # Find sessions that are inactive AND have unextracted messages
        result = await db.execute(
            select(Session)
            .where(
                Session.updated_at < threshold,
                Session.status == SessionStatus.active,
                exists(
                    select(1)
                    .where(
                        Message.session_id == Session.id,
                        Message.extraction_status == ExtractionStatus.pending,
                    )
                ),
            )
        )
        sessions = result.scalars().all()

        if not sessions:
            logger.debug("No inactive sessions with pending messages to auto-extract")
            return

        logger.info("Found %d inactive sessions for auto-extraction", len(sessions))

        extraction_service = ExtractionService()
        for session in sessions:
            try:
                count = await extraction_service.extract_from_session(db, session.id)
                await db.commit()
                logger.info("Auto-extracted session %s: %d memories", session.id, count)
            except Exception as e:
                logger.error("Failed to auto-extract session %s: %s", session.id, e)
                await db.rollback()


async def start_auto_extraction_scheduler():
    """Run auto-extraction every hour."""
    logger.info("Starting auto-extraction scheduler (runs every hour)")
    while True:
        try:
            await auto_extract_inactive_sessions()
        except Exception as e:
            logger.exception("Auto-extraction scheduler error: %s", e)

        # Wait 1 hour
        await asyncio.sleep(3600)
