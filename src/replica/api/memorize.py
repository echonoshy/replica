"""Memorize API — ingestion endpoint for new memory data."""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from replica.db.database import get_db
from replica.api.schemas import MemorizeRequest, MemorizeResponse
from replica.services.memorize_service import MemorizePipeline

logger = logging.getLogger(__name__)
router = APIRouter()

_pipeline: MemorizePipeline | None = None


def _get_pipeline() -> MemorizePipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = MemorizePipeline()
    return _pipeline


@router.post("/memories", response_model=MemorizeResponse, status_code=201)
async def memorize(body: MemorizeRequest, db: AsyncSession = Depends(get_db)):
    """Ingest raw data and extract memories (MemCell → Episodes → EventLogs → Foresights)."""
    pipeline = _get_pipeline()
    count = await pipeline.memorize(
        db=db,
        new_raw_data_list=body.new_raw_data_list,
        history_raw_data_list=body.history_raw_data_list,
        user_id_list=body.user_id_list,
        group_id=body.group_id,
        group_name=body.group_name,
        scene=body.scene,
    )
    return MemorizeResponse(memory_count=count)
