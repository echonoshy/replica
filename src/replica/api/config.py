"""Configuration API endpoints."""

from fastapi import APIRouter
from pydantic import BaseModel

from replica.config import settings

router = APIRouter()


class CompactionConfigOut(BaseModel):
    hard_threshold_tokens: int
    keep_recent_tokens: int


@router.get("/config/compaction", response_model=CompactionConfigOut)
async def get_compaction_config():
    """Get current compaction configuration."""
    return CompactionConfigOut(
        hard_threshold_tokens=settings.hard_threshold_tokens,
        keep_recent_tokens=settings.keep_recent_tokens,
    )
