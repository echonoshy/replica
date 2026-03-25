from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text

from replica.db.database import engine
from replica.api import users, sessions, messages, memory


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure pgvector extension exists
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    yield
    await engine.dispose()


app = FastAPI(title="Replica", version="0.1.0", lifespan=lifespan)

app.include_router(users.router, prefix="/v1", tags=["users"])
app.include_router(sessions.router, prefix="/v1", tags=["sessions"])
app.include_router(messages.router, prefix="/v1", tags=["messages"])
app.include_router(memory.router, prefix="/v1", tags=["memory"])


@app.get("/health")
async def health():
    return {"status": "ok"}
