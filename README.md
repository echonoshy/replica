<p align="center">
  <img src="web/public/favicon.svg" width="80" />
</p>

<h1 align="center">Replica</h1>

<p align="center">
  <b>Memory layer for AI.</b><br/>
  Give your AI the ability to <i>remember</i>.
</p>

<p align="center">
  <code>beta</code>&nbsp;&nbsp;·&nbsp;&nbsp;FastAPI&nbsp;&nbsp;·&nbsp;&nbsp;PostgreSQL + pgvector&nbsp;&nbsp;·&nbsp;&nbsp;Vue 3
</p>

---

Replica 为 AI 应用提供长期记忆能力 —— 管理对话上下文、自动提取与压缩记忆，并通过混合检索在需要时高效召回相关信息。

```
User ←→ Web UI ←→ Replica API ←→ LLM / Embedding / Reranker
                        ↕
              PostgreSQL + pgvector
```

## Quick Start

### 0. 前置依赖

| 组件 | 要求 |
|------|------|
| Python | >= 3.13 |
| PostgreSQL | 17 + pgvector |
| 包管理 | [uv](https://docs.astral.sh/uv/) |
| LLM / Embedding | vLLM 或任何 OpenAI 兼容 API |

### 1. 启动数据库

```bash
docker run -d --name pgvector \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  pgvector/pgvector:pg17

docker exec -it pgvector psql -U postgres -c "CREATE DATABASE replica;"
docker exec -it pgvector psql -U postgres -d replica -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 2. 安装 & 迁移

```bash
uv sync
uv run alembic upgrade head
```

### 3. 配置

编辑 `config/settings.yaml`，填入你的模型服务地址：

```yaml
llm:
  provider: "vllm"
  base_url: "http://localhost:19000/v1"
  model: "Qwen3.5-122B-A10B-FP8"

embedding:
  provider: "vllm"
  base_url: "http://localhost:19001/v1"
  model: "Qwen3-Embedding-4B"
```

> 完整配置项见 [`config/settings.yaml`](config/settings.yaml)，详细说明见 [`docs/guide.md`](docs/guide.md)。

### 4. 启动服务

**API 服务** (默认端口 `8790`)：

```bash
uv run uvicorn replica.main:app --host 0.0.0.0 --port 8790 --reload
```

**Web 前端** (默认端口 `8780`)：

```bash
cd web && npm install && npm run dev
```

启动后：

| 地址 | 说明 |
|------|------|
| `http://localhost:8780` | Web UI |
| `http://localhost:8790/docs` | Swagger API 文档 |
| `http://localhost:8790/health` | 健康检查 |

## Development

```bash
uv run ruff format          # 格式化
uv run ruff check --fix     # Lint
uv run pytest               # 测试
```

## License

MIT
