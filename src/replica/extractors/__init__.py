"""Memory data types used across the extraction pipeline."""

from __future__ import annotations

import enum
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


class MemoryType(str, enum.Enum):
    EPISODIC_MEMORY = "episodic_memory"
    FORESIGHT = "foresight"
    EVENT_LOG = "event_log"
    PROFILE = "profile"
    GROUP_PROFILE = "group_profile"


class RetrieveMethod(str, enum.Enum):
    KEYWORD = "keyword"
    VECTOR = "vector"
    HYBRID = "hybrid"
    RRF = "rrf"
    AGENTIC = "agentic"


class RawDataType(str, enum.Enum):
    CONVERSATION = "Conversation"


class ParentType(str, enum.Enum):
    MEMCELL = "memcell"
    EPISODE = "episode"


@dataclass
class RawData:
    content: dict[str, Any]
    timestamp: datetime | str | None = None


@dataclass
class MemCellData:
    """In-memory representation of a MemCell during extraction."""

    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    user_id_list: list[str] = field(default_factory=list)
    original_data: list[dict] = field(default_factory=list)
    timestamp: datetime | None = None
    summary: str = ""
    subject: str | None = None
    group_id: str | None = None
    group_name: str | None = None
    participants: list[str] = field(default_factory=list)
    data_type: RawDataType = RawDataType.CONVERSATION
    keywords: list[str] | None = None
    linked_entities: list[str] | None = None
    episode: str | None = None
    event_log: dict | None = None
    foresight_memories: list | None = None
    extend: dict | None = None


@dataclass
class BaseMemory:
    memory_type: MemoryType
    user_id: str | None = None
    timestamp: datetime | None = None
    ori_event_id_list: list[str] = field(default_factory=list)
    group_id: str | None = None
    subject: str | None = None
    summary: str | None = None


@dataclass
class EpisodeMemory(BaseMemory):
    title: str = ""
    episode: str = ""
    user_name: str | None = None
    group_name: str | None = None
    participants: list[str] = field(default_factory=list)
    memcell_event_id_list: list[str] = field(default_factory=list)
    parent_type: str | None = None
    parent_id: str | None = None
    extend: dict | None = None


@dataclass
class EventLog(BaseMemory):
    time: str = ""
    atomic_fact: list[str] = field(default_factory=list)
    fact_embeddings: list[list[float]] | None = None


@dataclass
class Foresight(BaseMemory):
    content: str = ""
    evidence: str = ""
    start_time: str | None = None
    end_time: str | None = None
    duration_days: int | None = None
    vector: list[float] | None = None


@dataclass
class ProfileMemory(BaseMemory):
    user_name: str | None = None
    output_reasoning: str | None = None
    hard_skills: list[dict] = field(default_factory=list)
    soft_skills: list[dict] = field(default_factory=list)
    personality: list[dict] = field(default_factory=list)
    way_of_decision_making: list[dict] = field(default_factory=list)
    working_habit_preference: list[dict] = field(default_factory=list)
    role_responsibility: list[dict] = field(default_factory=list)
    opinion_tendency: list[dict] = field(default_factory=list)
    projects_participated: list[dict] = field(default_factory=list)
    interests: list[dict] = field(default_factory=list)
    tendency: list[dict] = field(default_factory=list)
    motivation_system: list[dict] = field(default_factory=list)
    fear_system: list[dict] = field(default_factory=list)
    value_system: list[dict] = field(default_factory=list)
    humor_use: list[dict] = field(default_factory=list)
    colloquialism: list[dict] = field(default_factory=list)
    user_goal: list[dict] = field(default_factory=list)
    work_responsibility: list[dict] = field(default_factory=list)
    group_importance_evidence: dict | None = None


@dataclass
class GroupProfileMemory(BaseMemory):
    group_name: str | None = None
    topics: list[dict] = field(default_factory=list)
    roles: dict = field(default_factory=dict)


# ── Request types ───────────────────────────────────────────────────


@dataclass
class MemCellExtractRequest:
    history_raw_data_list: list[RawData]
    new_raw_data_list: list[RawData]
    user_id_list: list[str]
    group_id: str | None = None
    group_name: str | None = None


@dataclass
class MemoryExtractRequest:
    memcell: MemCellData
    user_id: str | None = None
    group_id: str | None = None
    old_memory_list: list[BaseMemory] | None = None


@dataclass
class BoundaryDetectionResult:
    should_end: bool
    should_wait: bool
    reasoning: str
    confidence: float
    topic_summary: str | None = None


@dataclass
class StatusResult:
    should_wait: bool
