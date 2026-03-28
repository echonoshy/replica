import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from replica.models.message import MessageRole, MessageType
from replica.models.memory_note import NoteType, NoteSource
from replica.models.session import SessionStatus


# ---------- Users ----------


class UserCreate(BaseModel):
    external_id: str
    metadata: dict | None = None


class UserOut(BaseModel):
    id: uuid.UUID
    external_id: str
    metadata: dict | None = Field(validation_alias="metadata_")
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Sessions ----------


class SessionCreate(BaseModel):
    metadata: dict | None = None


class SessionOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    status: SessionStatus
    token_count: int
    compaction_count: int
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Messages ----------


class MessageCreate(BaseModel):
    role: MessageRole
    content: str
    parent_id: uuid.UUID | None = None
    message_type: MessageType = MessageType.message


class MessageOut(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    parent_id: uuid.UUID | None
    role: MessageRole
    content: str
    token_count: int
    message_type: MessageType
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Memory Notes ----------


class MemoryNoteCreate(BaseModel):
    content: str
    note_type: NoteType = NoteType.evergreen


class MemoryNoteOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    session_id: uuid.UUID | None
    note_type: NoteType
    content: str
    source: NoteSource
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Memory Search ----------


class MemorySearchRequest(BaseModel):
    user_id: uuid.UUID
    query: str
    top_k: int = Field(default=10, ge=1, le=100)
    note_type: NoteType | None = None


class MemorySearchResult(BaseModel):
    chunk_text: str
    note_id: uuid.UUID
    score: float
    created_at: datetime


# ---------- Context Build ----------


class ContextBuildRequest(BaseModel):
    user_id: uuid.UUID
    session_id: uuid.UUID
    query: str | None = None


class ContextBuildResponse(BaseModel):
    evergreen_memories: list[MemoryNoteOut]
    relevant_memories: list[MemorySearchResult]
    recent_messages: list[MessageOut]


# ---------- Memorize (new memory ingestion) ----------


class MemorizeRequest(BaseModel):
    new_raw_data_list: list[dict]
    history_raw_data_list: list[dict] | None = None
    user_id_list: list[str] | None = None
    group_id: str | None = None
    group_name: str | None = None
    scene: str = "assistant"


class MemorizeResponse(BaseModel):
    memory_count: int
    status: str = "ok"


# ---------- Episodic Memory ----------


class EpisodicMemoryOut(BaseModel):
    id: uuid.UUID
    user_id: str | None
    group_id: str | None
    timestamp: datetime
    title: str | None
    episode: str
    summary: str
    participants: list[str] | None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Event Log ----------


class EventLogOut(BaseModel):
    id: uuid.UUID
    user_id: str | None
    group_id: str | None
    atomic_fact: str
    timestamp: datetime
    parent_type: str
    parent_id: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Foresight ----------


class ForesightOut(BaseModel):
    id: uuid.UUID
    user_id: str | None
    group_id: str | None
    content: str
    evidence: str | None
    start_time: str | None
    end_time: str | None
    duration_days: int | None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Retrieve ----------


class RetrieveRequest(BaseModel):
    query: str
    user_id: str | None = None
    group_id: str | None = None
    memory_types: list[str] | None = None
    retrieve_method: str = "hybrid"  # keyword | vector | hybrid | rrf | agentic
    top_k: int = Field(default=20, ge=1, le=100)
