# Replica 使用指南与配置手册

> Replica — 用于 AI 的记忆管理服务  
> 版本：0.1.0

---

## 目录

- [一、项目简介](#一项目简介)
- [二、系统架构](#二系统架构)
- [三、环境准备](#三环境准备)
- [四、启动服务](#四启动服务)
- [五、配置手册](#五配置手册)
- [六、核心概念](#六核心概念)
- [七、使用流程](#七使用流程)
- [八、记忆体系详解](#八记忆体系详解)
- [九、开发指南](#九开发指南)

---

## 一、项目简介

Replica 为 AI 应用提供**长期记忆能力**。它管理对话上下文、自动提取和压缩记忆，并通过向量搜索在需要时高效召回相关信息。

核心能力：

- **对话管理** — 用户、会话、消息的完整生命周期管理
- **多层记忆体系** — Evergreen 长期记忆 + Knowledge 知识库（Episode/Event/Foresight）
- **向量搜索** — 基于 pgvector 的语义相似度搜索
- **自动压缩** — 超过 token 阈值时自动标记旧消息为已压缩
- **流式聊天** — SSE 流式对话接口，自动整合记忆上下文
- **记忆提取** — 从对话中提取 MemCell → Episode/Event/Foresight

---

## 二、系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    FastAPI HTTP Server                   │
│                   (replica.main:app)                     │
├──────────┬──────────┬──────────┬──────────┬──────────────┤
│ /v1/users│/v1/sess- │/v1/mess- │/v1/memory│/v1/memories  │
│          │ ions     │ ages     │ /knowledge│ (memorize)   │
│          │          │          │ /context │              │
└────┬─────┴────┬─────┴────┬─────┴────┬─────┴──────┬───────┘
     │          │          │          │            │
     ▼          ▼          ▼          ▼            ▼
  ┌──────────────────────────────────────────────────────┐
  │                  Service Layer                        │
  │  memory_service  │ context_service │ compaction_svc   │
  │  embedding_svc   │ memorize_svc (MemorizePipeline)   │
  └────────────────────────┬─────────────────────────────┘
                           │
     ┌─────────────────────┴───────────────────────┐
     ▼                                             ▼
  ┌──────┐                                  ┌────────────┐
  │ LLM  │                                  │ Embedding  │
  │Server│                                  │  Server    │
  │:19000│                                  │  :19001    │
  └──────┘                                  └────────────┘
                           │
                           ▼
              ┌──────────────────────┐
              │  PostgreSQL + pgvec  │
              │  (port 5432)         │
              └──────────────────────┘
```

---

## 三、环境准备

### 3.1 系统要求

| 组件 | 要求 |
|------|------|
| Python | >= 3.13 |
| PostgreSQL | 17 + pgvector 扩展 |
| LLM 推理服务 | vLLM / OpenAI 兼容 API |
| Embedding 模型 | vLLM / OpenAI 兼容 API |
| 包管理 | uv |

### 3.2 数据库安装

使用 Docker 一键部署 PostgreSQL + pgvector：

```bash
# 启动 PostgreSQL + pgvector 容器
docker run -d --name pgvector \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  pgvector/pgvector:pg17

# 创建数据库
docker exec -it pgvector psql -U postgres -c "CREATE DATABASE replica;"

# 启用 pgvector 扩展
docker exec -it pgvector psql -U postgres -d replica -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 3.3 模型服务部署

**LLM 推理服务**（默认端口 19000）：

```bash
vllm serve weights/Qwen3.5-122B-A10B-FP8 \
  --port 19000 \
  --served-model-name Qwen3.5-122B-A10B-FP8  \
  --tensor-parallel-size 4 \
  --max-model-len 65536 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  --gpu-memory-utilization 0.8 \
  --disable-custom-all-reduce \
  --trust-remote-code
```

**Embedding 服务**（默认端口 19001）：

```bash
vllm serve weights/Qwen3-Embedding-4B \
  --port 19001 \
  --served-model-name Qwen3-Embedding-4B \
  --tensor-parallel-size 1 \
  --max-model-len 8192 \
  --dtype auto \
  --gpu-memory-utilization 0.4 \
  --trust-remote-code
```

### 3.4 安装依赖

```bash
# 安装生产依赖
uv sync

# 安装开发依赖（包含 pytest 等）
uv sync --extra dev
```

### 3.5 数据库迁移

```bash
# 生成迁移脚本（首次使用或模型变更后）
uv run alembic revision --autogenerate -m "initial"

# 执行迁移，创建所有数据表
uv run alembic upgrade head
```

---

## 四、启动服务

```bash
# 标准启动（带热重载）
uv run uvicorn replica.main:app --reload

# 指定主机和端口
uv run uvicorn replica.main:app --host 0.0.0.0 --port 8000 --reload

# 生产模式（多 worker）
uv run uvicorn replica.main:app --host 0.0.0.0 --port 8000 --workers 4
```

启动后访问：

| 地址 | 说明 |
|------|------|
| `http://localhost:8000/health` | 健康检查 |
| `http://localhost:8000/docs` | Swagger UI |
| `http://localhost:8000/redoc` | ReDoc 文档 |

---

## 五、配置手册

所有配置集中在 `config/settings.yaml` 文件中。

### 5.1 配置文件结构

```yaml
database:       # 数据库连接
llm:            # 大语言模型
embedding:      # 向量嵌入
memory:         # 记忆提取
compaction:     # 上下文压缩
chunking:       # 文本分块
search:         # 混合搜索
```

### 5.2 database — 数据库配置

```yaml
database:
  url: "postgresql+asyncpg://postgres:password@localhost:5432/replica"
```

### 5.3 llm — 大语言模型配置

```yaml
llm:
  provider: "vllm"
  base_url: "http://localhost:19000/v1"
  api_key: "EMPTY"
  model: "Qwen3.5-122B-A10B-FP8"
  temperature: 0.3
  max_tokens: 128000
  timeout: 600
  max_retries: 5
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | string | `"vllm"` | 可选 `vllm` / `openai` / `openrouter` |
| `base_url` | string | — | LLM 服务的 API 基础 URL |
| `api_key` | string | `""` | API 密钥 |
| `model` | string | — | 模型名称 |
| `temperature` | float | `0.3` | 生成温度 |
| `max_tokens` | int | `128000` | 单次生成最大 token 数 |
| `timeout` | int | `600` | 请求超时时间（秒） |
| `max_retries` | int | `5` | 请求失败最大重试次数 |

### 5.4 embedding — 向量嵌入配置

```yaml
embedding:
  provider: "vllm"
  base_url: "http://localhost:19001/v1"
  api_key: ""
  model: "Qwen3-Embedding-4B"
  dimensions: 2560
  timeout: 30
  max_retries: 3
  batch_size: 10
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dimensions` | int | `2560` | 向量维度，必须与模型输出维度一致 |
| `batch_size` | int | `10` | 批量嵌入时每批的文本数量 |

### 5.5 memory — 记忆提取配置

```yaml
memory:
  language: "en"
  min_messages_for_extraction: 3
  boundary_max_tokens: 8192
  boundary_max_messages: 50
  profile_min_memcells: 1
  profile_min_confidence: 0.6
  profile_life_max_items: 25
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `language` | string | `"en"` | 提示词语言，可选 `en` / `zh` |
| `min_messages_for_extraction` | int | `3` | 触发提取的最小消息数 |
| `boundary_max_tokens` | int | `8192` | 边界检测窗口最大 token 数 |
| `boundary_max_messages` | int | `50` | 边界检测窗口最大消息条数 |
| `profile_min_memcells` | int | `1` | 触发画像提取的最小 MemCell 数量 |
| `profile_min_confidence` | float | `0.6` | 画像属性最低置信度 |
| `profile_life_max_items` | int | `25` | 画像中每个维度的最大条目数 |

### 5.6 compaction — 上下文压缩配置

```yaml
compaction:
  hard_threshold_tokens: 64000
  keep_recent_tokens: 32000
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hard_threshold_tokens` | int | `64000` | 硬阈值。超过此值触发压缩，将旧消息标记为已压缩 |
| `keep_recent_tokens` | int | `32000` | 压缩时保留的最近消息 token 数 |

**压缩流程**：

```
token_count >= hard_threshold
    │
    ├── 保留最近 keep_recent_tokens 的消息
    ├── 标记旧消息 is_compacted=true
    └── 重新计算 session.token_count
```

### 5.7 chunking — 分块配置

```yaml
chunking:
  chunk_size_tokens: 400
  chunk_overlap_tokens: 80
```

### 5.8 search — 混合搜索配置

```yaml
search:
  vector_weight: 0.7
  text_weight: 0.3
  temporal_decay_half_life_days: 30
  mmr_enabled: true
  mmr_lambda: 0.7
  default_top_k: 10
  rrf_k: 60
```

---

## 六、核心概念

| 概念 | 说明 |
|------|------|
| **User** | 用户实体，通过 `external_id` 关联外部系统 |
| **Session** | 一次对话会话，属于某个 User |
| **Message** | 会话中的单条消息，角色为 `user` / `assistant` / `system` |
| **EvergreenMemory** | 长期记忆，手动创建或从 UserProfile 提取 |
| **KnowledgeEntry** | 知识库条目，包含 Episode/Event/Foresight 三种类型 |
| **MemCell** | 原子记忆单元，由边界检测切分 |

---

## 七、使用流程

### 7.1 完整对话流程

```bash
# 1. 创建用户
curl -X POST http://localhost:8000/v1/users \
  -H "Content-Type: application/json" \
  -d '{"external_id": "user123", "name": "张三"}'

# 2. 创建会话
curl -X POST http://localhost:8000/v1/users/{user_id}/sessions \
  -H "Content-Type: application/json" \
  -d '{}'

# 3. 流式聊天
curl -X POST http://localhost:8000/v1/sessions/{session_id}/chat \
  -H "Content-Type: application/json" \
  -d '{"content": "你好", "use_memory": true}'

# 4. 手动提取记忆
curl -X POST http://localhost:8000/v1/sessions/{session_id}/extract-memory

# 5. 搜索知识库
curl -X POST http://localhost:8000/v1/knowledge/search \
  -H "Content-Type: application/json" \
  -d '{"user_id": "uuid", "query": "张三的信息", "top_k": 5}'
```

### 7.2 Memorize 管线记忆摄入

```bash
curl -X POST http://localhost:8000/v1/memories \
  -H "Content-Type: application/json" \
  -d '{
    "new_raw_data_list": [
      {"role": "user", "content": "我最近在学习 Rust"},
      {"role": "assistant", "content": "Rust 确实有一定的学习曲线"}
    ],
    "user_id_list": ["user-001"]
  }'
```

---

## 八、记忆体系详解

### 8.1 两层记忆模型

| 层级 | 数据表 | 特点 |
|------|--------|------|
| **Evergreen 记忆** | `evergreen_memories` | 长期持久，手动创建或从 UserProfile 提取 |
| **Knowledge 知识库** | `knowledge_entries` | Episode/Event/Foresight 三种类型，向量搜索 |

### 8.2 KnowledgeEntry 类型

| 类型 | EntryType | 说明 |
|------|-----------|------|
| **Episode** | `episode` | 情节记忆，叙事性描述 |
| **Event** | `event` | 事件日志，原子事实 |
| **Foresight** | `foresight` | 前瞻预测，未来计划 |

### 8.3 压缩机制

```
会话进行中
    │
    │  每条消息自动计算 token 数
    │  累加到 session.token_count
    │
    ├── token_count < hard_threshold (64000)
    │   └── 正常状态，不做处理
    │
    └── token_count >= hard_threshold
        └── 触发压缩
            ├── 保留最近 keep_recent_tokens (32000) 的消息
            ├── 标记旧消息 is_compacted=true
            └── 重新计算 session.token_count
```

---

## 九、开发指南

### 9.1 项目结构

```
replica/
├── config/
│   └── settings.yaml               # 配置文件
├── src/replica/
│   ├── main.py                      # FastAPI 入口
│   ├── config.py                    # 配置加载
│   ├── db/
│   │   └── database.py              # 异步数据库连接
│   ├── models/                      # SQLAlchemy ORM 模型
│   │   ├── user.py
│   │   ├── session.py
│   │   ├── message.py
│   │   ├── evergreen_memory.py
│   │   ├── knowledge_entry.py
│   │   ├── memcell.py
│   │   └── user_profile.py
│   ├── api/                         # API 路由
│   │   ├── users.py
│   │   ├── sessions.py
│   │   ├── messages.py
│   │   ├── memory.py
│   │   ├── memorize.py
│   │   ├── chat.py
│   │   ├── admin.py
│   │   └── config.py
│   ├── services/                    # 业务逻辑
│   │   ├── memory_service.py
│   │   ├── context_service.py
│   │   ├── compaction_service.py
│   │   ├── embedding_service.py
│   │   ├── extraction_service.py
│   │   ├── semantic_compaction_service.py
│   │   └── memorize_service.py
│   ├── extractors/                  # 记忆提取器
│   │   ├── memcell_extractor.py
│   │   ├── episode_extractor.py
│   │   ├── event_log_extractor.py
│   │   ├── foresight_extractor.py
│   │   └── profile_extractor.py
│   └── providers/                   # 外部服务适配
│       ├── llm_provider.py
│       └── embedding_provider.py
├── tests/
├── alembic/
├── docs/
│   ├── api.md                       # API 接口文档
│   └── guide.md                     # 本文档
└── pyproject.toml
```

### 9.2 代码规范

```bash
# 格式化代码
uv run ruff format

# 代码检查
uv run ruff check

# 代码检查并自动修复
uv run ruff check --fix
```

### 9.3 运行测试

```bash
# 运行全部测试
uv run pytest

# 运行指定测试文件
uv run pytest tests/test_schemas.py

# 运行测试并显示详细输出
uv run pytest -v
```

### 9.4 数据库模型一览

| 表名 | 模型类 | 说明 |
|------|--------|------|
| `users` | `User` | 用户表 |
| `sessions` | `Session` | 会话表 |
| `messages` | `Message` | 消息表 |
| `evergreen_memories` | `EvergreenMemory` | 长期记忆表 |
| `knowledge_entries` | `KnowledgeEntry` | 知识库表（Episode/Event/Foresight） |
| `memcells` | `MemCell` | 原子记忆单元表 |
| `user_profiles` | `UserProfile` | 用户画像表 |

---

## 附录：API 参考

详细的 API 接口文档请参考 [docs/api.md](./api.md)。
