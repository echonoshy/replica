# Replica

Memory management service for AI applications. (用于 AI 的记忆管理服务)

Replica 为 AI 应用提供长期记忆能力——管理对话上下文、自动提取和压缩记忆、并通过混合搜索在需要时高效召回相关信息。

## Features

- **对话管理** — 用户、会话、消息的完整生命周期管理
- **混合记忆搜索** — 结合 pgvector 向量相似度搜索与 PostgreSQL 全文检索，并支持时间衰减和 MMR 多样性重排
- **渐进式压缩** — 软阈值触发记忆提取，硬阈值触发消息摘要压缩，自动控制上下文窗口大小
- **三层记忆体系**
  - **Evergreen 记忆** — 长期持久知识，不受时间衰减影响
  - **Daily 记忆** — 会话中自动提取的短期记忆
  - **消息分块** — 通过向量嵌入和全文索引支持细粒度检索
- **上下文组装** — 自动组合长期记忆、相关记忆和近期消息，为 AI 模型构建完整上下文

## Tech Stack

- **Framework:** FastAPI + Uvicorn
- **Database:** PostgreSQL + pgvector
- **ORM:** SQLAlchemy (async)
- **Migration:** Alembic
- **Embedding:** vLLM (all-MiniLM-L6-v2, 384 维)
- **Tokenizer:** tiktoken (cl100k_base)

## Project Structure

```
src/replica/
├── main.py                 # FastAPI 入口，路由注册
├── config.py               # Pydantic Settings 配置管理
├── models/                 # SQLAlchemy ORM 模型
│   ├── user.py             # 用户
│   ├── session.py          # 会话
│   ├── message.py          # 消息
│   ├── memory_note.py      # 记忆笔记
│   └── memory_chunk.py     # 记忆分块 (向量嵌入)
├── api/                    # API 路由
│   ├── schemas.py          # Pydantic 请求/响应模型
│   ├── users.py            # 用户管理
│   ├── sessions.py         # 会话管理
│   ├── messages.py         # 消息管理
│   └── memory.py           # 记忆搜索与上下文构建
├── services/               # 业务逻辑
│   ├── embedding_service.py    # 嵌入与分词
│   ├── memory_service.py       # 混合记忆搜索
│   ├── context_service.py      # 上下文组装
│   └── compaction_service.py   # 记忆压缩与提取
└── db/
    └── database.py         # 异步数据库连接
```

## Quick Start

```bash
# 安装依赖
uv sync

# 安装开发依赖
uv sync --extra dev

# 数据库迁移
uv run alembic upgrade head

# 启动服务
uv run uvicorn replica.main:app --reload
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/users` | 创建用户 |
| GET | `/v1/users/{user_id}` | 获取用户信息 |
| POST | `/v1/users/{user_id}/sessions` | 创建会话 |
| GET | `/v1/users/{user_id}/sessions` | 获取用户会话列表 |
| POST | `/v1/sessions/{session_id}/messages` | 发送消息 |
| GET | `/v1/sessions/{session_id}/messages` | 获取会话消息 |
| POST | `/v1/sessions/{session_id}/archive` | 归档会话并提取记忆 |
| POST | `/v1/memory/search` | 混合记忆搜索 |
| GET | `/v1/users/{user_id}/memory` | 获取用户记忆列表 |
| POST | `/v1/users/{user_id}/memory` | 手动创建记忆 |
| DELETE | `/v1/memory/{note_id}` | 删除记忆 |
| POST | `/v1/context/build` | 构建 AI 上下文 |
| GET | `/health` | 健康检查 |

## Development

```bash
# 格式化
uv run ruff format

# 代码检查
uv run ruff check --fix

# 运行测试
uv run pytest
```

## License

MIT
