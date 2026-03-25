from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "REPLICA_"}

    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/replica"

    # Compaction
    soft_threshold_tokens: int = 12000
    hard_threshold_tokens: int = 16000
    keep_recent_tokens: int = 4000

    # Chunking
    chunk_size_tokens: int = 400
    chunk_overlap_tokens: int = 80

    # Search
    vector_weight: float = 0.7
    text_weight: float = 0.3
    temporal_decay_half_life_days: int = 30
    mmr_enabled: bool = True
    mmr_lambda: float = 0.7
    default_top_k: int = 10

    # Embedding (vLLM)
    embedding_base_url: str = "http://localhost:8000"
    embedding_model: str = "all-MiniLM-L6-v2"
    embedding_dim: int = 384

    # Session Memory
    session_end_extract_messages: int = 15


settings = Settings()
