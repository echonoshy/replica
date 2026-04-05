<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Press+Start+2P&size=40&duration=2000&pause=1000&color=4ADE80&center=true&vCenter=true&width=600&height=100&lines=R+E+P+L+I+C+A;MEMORY+UNLOCKED" alt="REPLICA" />
</p>

<p align="center">
  <b>Memory layer for AI.</b><br/>
  Give your AI the ability to <i>remember</i>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-beta-E8A23E?style=flat-square" alt="Status" />
  <img src="https://img.shields.io/badge/python-≥3.13-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/license-MIT-0D0D0D?style=flat-square" alt="License" />
</p>

<p align="center">
  <b>English</b> | <a href="README_zh.md">简体中文</a>
</p>

---

## What is Replica?

Your AI has the memory of a goldfish. Every conversation? Fresh start. That thing you mentioned yesterday? Gone. Your preferences? Vanished into the void.

**Replica** fixes this. It's a memory layer that gives AI the ability to actually remember things. Not just for 5 minutes. Not just within a single chat. But across conversations, sessions, and time.

Think of it as RAM for your AI's brain. Except it doesn't forget when you close the tab.

> 💬 **"Remember when I told you about my trip to Tokyo last month?"**
> 
> → Replica searches 10,000+ memories  
> → Finds: "User visited Tokyo in March 2026"  
> → Returns relevant context in **50ms**

### The Problem

**AI amnesia is real.** Without memory, your AI is like that friend who asks "wait, what were we talking about?" every 30 seconds.

- Every conversation starts from scratch
- Context windows are expensive (and finite)
- RAG alone doesn't cut it - you need structured memory, not just keyword matching
- Facts, events, plans, preferences... they all need different handling

Replica solves this. Automatically. No prompt engineering gymnastics required.

---

## ✨ Features

### 🎯 Smart Memory Extraction

Replica doesn't just store text. It **understands** conversations and extracts structured memories:

- **Episodes** - "User discussed Python async programming best practices"
- **Events** - "User has a meeting tomorrow at 3 PM"
- **Foresights** - "User plans to learn Rust next week"
- **User Profiles** - Interests, skills, preferences, goals

### 🔎 Hybrid Search That Actually Works

Simple vector search? That's so 2023. Replica uses:

- **Vector Search** - Semantic similarity via pgvector
- **Full-Text Search** - PostgreSQL's battle-tested text search
- **RRF Fusion** - Reciprocal Rank Fusion (fancy way of saying "best of both")
- **Temporal Decay** - Recent stuff matters more (just like real memory)
- **MMR Reranking** - Diverse results, not 10 variations of the same thing

### 🗜️ Automatic Context Compression

Long conversations? No problem. Replica automatically:

- Tracks token counts in real-time
- Compresses old messages when hitting limits
- Keeps recent context fresh and relevant
- Extracts important info before compression

### 🎨 Beautiful Web UI

Chat with your AI and watch memories being created in real-time:

<p align="center">
  <img src="assets/chat.png" width="800" alt="Chat Interface" />
  <br/>
  <em>Real-time streaming chat with memory context</em>
</p>

<p align="center">
  <img src="assets/admin.png" width="800" alt="Admin Interface" />
  <br/>
  <em>Database explorer for debugging and inspection</em>
</p>

---

## 🚀 Quick Start

### Prerequisites

| Component | Requirement |
|-----------|-------------|
| Python | ≥ 3.13 |
| PostgreSQL | 17 + pgvector |
| Package Manager | [uv](https://docs.astral.sh/uv/) |
| Node Runtime | [Bun](https://bun.sh/) (recommended) or Node.js |
| LLM / Embedding | vLLM or any OpenAI-compatible API |

### 1. Start Database

```bash
docker run -d --name pgvector \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  pgvector/pgvector:pg17

docker exec -it pgvector psql -U postgres -c "CREATE DATABASE replica;"
docker exec -it pgvector psql -U postgres -d replica -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 2. Install & Migrate

```bash
uv sync
uv run alembic upgrade head
```

### 3. Configure

Edit `config/settings.yaml` with your model endpoints:

```yaml
llm:
  provider: "vllm"
  base_url: "http://localhost:19000/v1"
  model: "Qwen3.5-122B-A10B-FP8"

embedding:
  provider: "vllm"
  base_url: "http://localhost:19001/v1"
  model: "Qwen3-Embedding-4B"
  dimensions: 2560
```

> 💡 Full config reference: [`config/settings.yaml`](config/settings.yaml) | Detailed guide: [`docs/guide.md`](docs/guide.md)

### 4. Launch

**Backend API** (port `8790`):

```bash
uv run uvicorn replica.main:app --host 0.0.0.0 --port 8790 --reload
```

**Frontend UI** (port `8780`):

```bash
cd web
bun install
bun run dev
```

Then visit:

| URL | Description |
|-----|-------------|
| `http://localhost:8780` | 🎨 Web UI |
| `http://localhost:8790/docs` | 📚 Swagger API Docs |
| `http://localhost:8790/health` | ❤️ Health Check |

---

## 🎮 How It Works

### Memory Lifecycle

```
1. User chats with AI
   ↓
2. Replica stores messages
   ↓
3. When conversation reaches a natural boundary...
   ↓
4. Extract structured memories:
   • Episodes (what happened)
   • Events (specific facts)
   • Foresights (future plans)
   • User profile updates
   ↓
5. Generate embeddings
   ↓
6. Store in knowledge base
   ↓
7. Next time user asks something...
   ↓
8. Hybrid search retrieves relevant memories
   ↓
9. Inject into AI context
   ↓
10. AI responds with full memory context
```

### Memory Types Explained

| Type | What It Stores | Example |
|------|----------------|---------|
| **Episode** | Conversation summaries | "User asked about async/await patterns in Python and discussed event loops" |
| **Event** | Concrete facts | "User's birthday is March 15" |
| **Foresight** | Future intentions | "User wants to build a web scraper next month" |
| **Evergreen** | Long-term facts | "User is a software engineer living in Shanghai" |

---

## 💻 API Examples

### Create a User & Session

```python
import httpx

async with httpx.AsyncClient() as client:
    # Create user
    user = await client.post(
        "http://localhost:8790/v1/users",
        json={"external_id": "alice", "name": "Alice"}
    )
    user_id = user.json()["id"]
    
    # Create session
    session = await client.post(
        f"http://localhost:8790/v1/users/{user_id}/sessions",
        json={}
    )
    session_id = session.json()["id"]
```

### Stream Chat with Memory

```python
# Stream chat (Server-Sent Events)
async with client.stream(
    "POST",
    f"http://localhost:8790/v1/sessions/{session_id}/chat",
    json={"content": "What did I tell you about my trip?", "use_memory": True}
) as response:
    async for line in response.aiter_lines():
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if "token" in data:
                print(data["token"], end="", flush=True)
            elif "context" in data:
                print("\n\n📚 Retrieved memories:", data["context"])
```

### Extract Memories from Raw Data

```python
# Batch memory extraction
response = await client.post(
    "http://localhost:8790/v1/memories",
    json={
        "new_raw_data_list": [
            {"role": "user", "content": "I'm planning a trip to Tokyo next month"},
            {"role": "assistant", "content": "That sounds exciting! Have you been before?"},
            {"role": "user", "content": "No, first time. I want to visit Shibuya and try real ramen."}
        ],
        "user_id_list": ["alice"]
    }
)
print(f"Extracted {response.json()['memory_count']} memories")
```

### Search Knowledge Base

```python
# Semantic search
results = await client.post(
    "http://localhost:8790/v1/knowledge/search",
    json={
        "user_id": user_id,
        "query": "travel plans",
        "top_k": 5
    }
)

for memory in results.json():
    print(f"[{memory['entry_type']}] {memory['content']} (score: {memory['score']:.2f})")
```

---

## 🏗️ Architecture

**Frontend** → React 19 web interface (`:5173`)

**Backend** → FastAPI server (`:8790`)
- User/Session/Message APIs
- Memory extraction & knowledge search
- Context compression & embedding generation

**LLM Services**
- Main LLM (`:19000`) - Chat completion & memory extraction
- Embedding model (`:19001`) - Vector generation

**Storage** → PostgreSQL 17 + pgvector (`:5432`)

---

## 🛠️ Development

```bash
# Format code
uv run ruff format

# Lint & fix
uv run ruff check --fix

# Run tests
uv run pytest

# Run tests with coverage
uv run pytest --cov=replica
```

---

## 📚 Documentation

- **[Complete Guide](docs/guide.md)** - Configuration, concepts, and usage
- **[API Reference](docs/api.md)** - Full API documentation
- **[Swagger UI](http://localhost:8790/docs)** - Interactive API explorer

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built by developers tired of explaining the same thing to AI twice
</p>

<p align="center">
  <a href="https://github.com/echonoshy/replica">⭐ Star on GitHub</a>
</p>
