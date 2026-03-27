"""Unified configuration loaded from config/settings.yaml with env overrides."""

from pathlib import Path
from functools import lru_cache

import yaml
from pydantic import BaseModel
from pydantic_settings import BaseSettings


def _load_yaml_config() -> dict:
    """Load YAML config file, searching upwards for config/settings.yaml."""
    search = Path(__file__).resolve().parent
    for _ in range(5):
        candidate = search / "config" / "settings.yaml"
        if candidate.exists():
            with open(candidate) as f:
                return yaml.safe_load(f) or {}
        search = search.parent
    # fallback: project root
    root = Path(__file__).resolve().parent.parent.parent
    candidate = root / "config" / "settings.yaml"
    if candidate.exists():
        with open(candidate) as f:
            return yaml.safe_load(f) or {}
    return {}


# ── Nested config sections ──────────────────────────────────────────


class LLMConfig(BaseModel):
    provider: str = "vllm"
    base_url: str = "http://localhost:8001/v1"
    api_key: str = ""
    model: str = "Qwen/Qwen3-4B"
    temperature: float = 0.3
    max_tokens: int = 16384
    timeout: int = 600
    max_retries: int = 5


class EmbeddingConfig(BaseModel):
    provider: str = "vllm"
    base_url: str = "http://localhost:8002/v1"
    api_key: str = ""
    model: str = "Qwen/Qwen3-Embedding-4B"
    dimensions: int = 1024
    timeout: int = 30
    max_retries: int = 3
    batch_size: int = 10


class RerankConfig(BaseModel):
    provider: str = "vllm"
    base_url: str = "http://localhost:8003/v1"
    api_key: str = ""
    model: str = "Qwen/Qwen3-Reranker-4B"
    timeout: int = 30
    max_retries: int = 3


class MemoryConfig(BaseModel):
    language: str = "en"
    boundary_max_tokens: int = 8192
    boundary_max_messages: int = 50
    cluster_similarity_threshold: float = 0.3
    cluster_max_time_gap_days: int = 7
    profile_min_memcells: int = 1
    profile_min_confidence: float = 0.6
    profile_life_max_items: int = 25


class CompactionConfig(BaseModel):
    soft_threshold_tokens: int = 12000
    hard_threshold_tokens: int = 16000
    keep_recent_tokens: int = 4000
    session_end_extract_messages: int = 15


class ChunkingConfig(BaseModel):
    chunk_size_tokens: int = 400
    chunk_overlap_tokens: int = 80


class SearchConfig(BaseModel):
    vector_weight: float = 0.7
    text_weight: float = 0.3
    temporal_decay_half_life_days: int = 30
    mmr_enabled: bool = True
    mmr_lambda: float = 0.7
    default_top_k: int = 10
    rrf_k: int = 60


# ── Main Settings ───────────────────────────────────────────────────


class Settings(BaseSettings):
    model_config = {"env_prefix": "REPLICA_"}

    # Database
    database_url: str = "postgresql+asyncpg://postgres:password@localhost:5432/replica"

    # Sub-configs
    llm: LLMConfig = LLMConfig()
    embedding: EmbeddingConfig = EmbeddingConfig()
    rerank: RerankConfig = RerankConfig()
    memory: MemoryConfig = MemoryConfig()
    compaction: CompactionConfig = CompactionConfig()
    chunking: ChunkingConfig = ChunkingConfig()
    search: SearchConfig = SearchConfig()

    # ── backwards-compat flat accessors (used by existing services) ──

    @property
    def soft_threshold_tokens(self) -> int:
        return self.compaction.soft_threshold_tokens

    @property
    def hard_threshold_tokens(self) -> int:
        return self.compaction.hard_threshold_tokens

    @property
    def keep_recent_tokens(self) -> int:
        return self.compaction.keep_recent_tokens

    @property
    def session_end_extract_messages(self) -> int:
        return self.compaction.session_end_extract_messages

    @property
    def chunk_size_tokens(self) -> int:
        return self.chunking.chunk_size_tokens

    @property
    def chunk_overlap_tokens(self) -> int:
        return self.chunking.chunk_overlap_tokens

    @property
    def vector_weight(self) -> float:
        return self.search.vector_weight

    @property
    def text_weight(self) -> float:
        return self.search.text_weight

    @property
    def temporal_decay_half_life_days(self) -> int:
        return self.search.temporal_decay_half_life_days

    @property
    def mmr_enabled(self) -> bool:
        return self.search.mmr_enabled

    @property
    def mmr_lambda(self) -> float:
        return self.search.mmr_lambda

    @property
    def default_top_k(self) -> int:
        return self.search.default_top_k

    @property
    def embedding_base_url(self) -> str:
        return self.embedding.base_url

    @property
    def embedding_model(self) -> str:
        return self.embedding.model

    @property
    def embedding_dim(self) -> int:
        return self.embedding.dimensions


@lru_cache()
def get_settings() -> Settings:
    """Build Settings from YAML + env overrides. Cached singleton."""
    yaml_cfg = _load_yaml_config()

    # Flatten YAML sections into constructor kwargs
    kwargs: dict = {}
    if "database" in yaml_cfg and "url" in yaml_cfg["database"]:
        kwargs["database_url"] = yaml_cfg["database"]["url"]
    for section in (
        "llm",
        "embedding",
        "rerank",
        "memory",
        "compaction",
        "chunking",
        "search",
    ):
        if section in yaml_cfg:
            kwargs[section] = yaml_cfg[section]

    return Settings(**kwargs)


settings = get_settings()
