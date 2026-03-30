import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from replica.models.message import MessageRole, MessageType
from replica.models.session import SessionStatus
from replica.models.evergreen_memory import EvergreenCategory, EvergreenSource
from replica.models.knowledge_entry import EntryType


# ---------- Users ----------


class UserCreate(BaseModel):
    external_id: str
    name: str | None = None
    metadata: dict | None = None


class UserOut(BaseModel):
    id: uuid.UUID
    external_id: str
    name: str | None = None
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
    is_compacted: bool = False
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Evergreen Memory ----------


class EvergreenMemoryCreate(BaseModel):
    content: str
    category: EvergreenCategory = EvergreenCategory.fact


class EvergreenMemoryOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    category: EvergreenCategory
    content: str
    source: EvergreenSource
    confidence: float
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------- Knowledge Search ----------


class KnowledgeSearchRequest(BaseModel):
    user_id: uuid.UUID
    query: str
    top_k: int = Field(default=10, ge=1, le=100)
    entry_type: EntryType | None = None


class KnowledgeSearchResult(BaseModel):
    id: uuid.UUID
    entry_type: EntryType
    title: str | None
    content: str
    score: float
    created_at: datetime

    model_config = {"from_attributes": True}


class KnowledgeEntryOut(BaseModel):
    id: uuid.UUID
    user_id: str | None
    entry_type: EntryType
    title: str | None
    content: str
    metadata: dict | None = Field(validation_alias="metadata_")
    participants: list[str] | None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Context Build ----------


class ContextBuildRequest(BaseModel):
    user_id: uuid.UUID
    session_id: uuid.UUID
    query: str | None = None


class ContextBuildResponse(BaseModel):
    evergreen_memories: list[EvergreenMemoryOut]
    relevant_knowledge: list[KnowledgeSearchResult]
    recent_messages: list[MessageOut]


# ---------- Memorize (memory ingestion pipeline) ----------


class MemorizeRequest(BaseModel):
    new_raw_data_list: list[dict]
    history_raw_data_list: list[dict] | None = None
    user_id_list: list[str] | None = None


class MemorizeResponse(BaseModel):
    memory_count: int
    status: str = "ok"
