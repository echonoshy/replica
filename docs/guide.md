# Replica 使用指南与配置手册

> Replica — 用于 AI 的记忆管理服务  
> 版本：0.1.0

---

## 目录

- [一、项目简介](#一项目简介)
- [二、系统架构](#二系统架构)
- [三、环境准备](#三环境准备)
  - [3.1 系统要求](#31-系统要求)
  - [3.2 数据库安装](#32-数据库安装)
  - [3.3 模型服务部署](#33-模型服务部署)
  - [3.4 安装依赖](#34-安装依赖)
  - [3.5 数据库迁移](#35-数据库迁移)
- [四、启动服务](#四启动服务)
- [五、配置手册](#五配置手册)
  - [5.1 配置文件结构](#51-配置文件结构)
  - [5.2 database — 数据库配置](#52-database--数据库配置)
  - [5.3 llm — 大语言模型配置](#53-llm--大语言模型配置)
  - [5.4 embedding — 向量嵌入配置](#54-embedding--向量嵌入配置)
  - [5.5 rerank — 重排序配置](#55-rerank--重排序配置)
  - [5.6 memory — 记忆提取配置](#56-memory--记忆提取配置)
  - [5.7 compaction — 上下文压缩配置](#57-compaction--上下文压缩配置)
  - [5.8 chunking — 分块配置](#58-chunking--分块配置)
  - [5.9 search — 混合搜索配置](#59-search--混合搜索配置)
- [六、使用流程](#六使用流程)
  - [6.1 核心概念](#61-核心概念)
  - [6.2 完整使用流程](#62-完整使用流程)
- [七、API 参考](#七api-参考)
  - [7.1 健康检查](#71-健康检查)
  - [7.2 用户管理](#72-用户管理)
  - [7.3 会话管理](#73-会话管理)
  - [7.4 消息管理](#74-消息管理)
  - [7.5 记忆管理](#75-记忆管理)
  - [7.6 记忆搜索](#76-记忆搜索)
  - [7.7 上下文构建](#77-上下文构建)
  - [7.8 记忆摄入管线 (Memorize)](#78-记忆摄入管线-memorize)
- [八、端到端使用示例](#八端到端使用示例)
  - [8.1 场景一：对话式记忆管理](#81-场景一对话式记忆管理)
  - [8.2 场景二：Memorize 管线记忆摄入](#82-场景二memorize-管线记忆摄入)
- [九、记忆体系详解](#九记忆体系详解)
  - [9.1 三层记忆模型](#91-三层记忆模型)
  - [9.2 Memorize 管线抽取的记忆类型](#92-memorize-管线抽取的记忆类型)
  - [9.3 渐进式压缩机制](#93-渐进式压缩机制)
  - [9.4 混合搜索机制](#94-混合搜索机制)
- [十、开发指南](#十开发指南)
  - [10.1 项目结构](#101-项目结构)
  - [10.2 代码规范](#102-代码规范)
  - [10.3 运行测试](#103-运行测试)
  - [10.4 数据库模型一览](#104-数据库模型一览)

---

## 一、项目简介

Replica 为 AI 应用提供**长期记忆能力**。它管理对话上下文、自动提取和压缩记忆，并通过混合搜索在需要时高效召回相关信息。

核心能力：

- **对话管理** — 用户、会话、消息的完整生命周期管理
- **多层记忆体系** — Evergreen 长期记忆 / Daily 短期记忆 / 情节记忆 / 事件日志 / 前瞻预测 / 用户画像
- **混合记忆搜索** — 向量相似度 + 全文检索 + 时间衰减 + MMR 多样性重排
- **渐进式压缩** — 软阈值触发记忆提取，硬阈值触发消息摘要压缩
- **上下文组装** — 自动组合长期记忆、相关记忆和近期消息，为 LLM 构建完整上下文

---

## 二、系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    FastAPI HTTP Server                   │
│                   (replica.main:app)                     │
├──────────┬──────────┬──────────┬──────────┬──────────────┤
│ /v1/users│/v1/sess- │/v1/sess- │/v1/memory│/v1/memories  │
│          │ ions     │ ions/msg │ /search  │ (memorize)   │
│          │          │          │ /context │              │
│          │          │          │ /build   │              │
└────┬─────┴────┬─────┴────┬─────┴────┬─────┴──────┬───────┘
     │          │          │          │            │
     ▼          ▼          ▼          ▼            ▼
  ┌──────────────────────────────────────────────────────┐
  │                  Service Layer                        │
  │  memory_service  │ context_service │ compaction_svc   │
  │  embedding_svc   │ memorize_svc (MemorizePipeline)   │
  └────────────────────────┬─────────────────────────────┘
                           │
     ┌─────────────────────┼───────────────────────┐
     ▼                     ▼                       ▼
  ┌──────┐          ┌────────────┐          ┌────────────┐
  │ LLM  │          │ Embedding  │          │  Reranker  │
  │Server│          │  Server    │          │  Server    │
  │:19000│          │  :19001    │          │  :19002    │
  └──────┘          └────────────┘          └────────────┘
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
| Reranker 模型 | vLLM / OpenAI 兼容 API（可选） |
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

数据库连接信息（默认值）：

| 参数 | 值 |
|------|-----|
| Host | localhost |
| Port | 5432 |
| User | postgres |
| Password | password |
| Database | replica |
| 连接字符串 | `postgresql+asyncpg://postgres:password@localhost:5432/replica` |

### 3.3 模型服务部署

Replica 需要三个模型服务（Reranker 可选），均使用 OpenAI 兼容 API 协议。下面命令参考
`feat/qwen3.5-122b-a10b-fp8`、`feat/qwen3-embedding-4b`、`feat/qwen3-reranker-4b`
三个分支中的部署参数整理而成。推荐显式设置 `--served-model-name`，这样客户端配置可以使用稳定的服务名，而不依赖本地权重目录名。

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

用途：记忆提取、对话摘要、边界检测、画像生成等智能处理。

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

用途：文本向量化，用于向量相似度搜索。

**Reranker 服务**（默认端口 19002，可选）：

```bash
vllm serve weights/Qwen3-Reranker-4B \
  --port 19002 \
  --served-model-name Qwen3-Reranker-4B \
  --tensor-parallel-size 1 \
  --max-model-len 8192 \
  --dtype auto \
  --gpu-memory-utilization 0.4 \
  --trust-remote-code
```

用途：搜索结果精排，提升检索质量。Qwen3-Reranker 使用 chat/completions + logprobs 方式进行相关性评分。

> **提示**：如果启动命令中设置了 `--served-model-name`，则 `config/settings.yaml` 中的
> `llm.model`、`embedding.model`、`rerank.model` 也应分别填写
> `Qwen3.5-122B-A10B-FP8`、`Qwen3-Embedding-4B`、`Qwen3-Reranker-4B`。

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

> **注意**：`alembic.ini` 中的 `sqlalchemy.url` 需与 `config/settings.yaml` 中的 `database.url` 保持一致。应用启动时会自动执行 `CREATE EXTENSION IF NOT EXISTS vector` 确保 pgvector 扩展已启用。

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

启动后，访问以下地址验证：

| 地址 | 说明 |
|------|------|
| `http://localhost:8000/health` | 健康检查，返回 `{"status": "ok"}` |
| `http://localhost:8000/docs` | Swagger UI 交互式 API 文档 |
| `http://localhost:8000/redoc` | ReDoc 风格 API 文档 |

---

## 五、配置手册

所有配置集中在 `config/settings.yaml` 文件中。配置通过 Pydantic Settings 加载，支持 `REPLICA_` 前缀的环境变量覆盖。

### 5.1 配置文件结构

```yaml
database:       # 数据库连接
llm:            # 大语言模型
embedding:      # 向量嵌入
rerank:         # 重排序
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

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | string | `postgresql+asyncpg://postgres:password@localhost:5432/replica` | 异步 PostgreSQL 连接字符串，必须使用 `asyncpg` 驱动 |

### 5.3 llm — 大语言模型配置

```yaml
llm:
  provider: "vllm"
  base_url: "http://localhost:19000/v1"
  api_key: "EMPTY"
  model: "Qwen3.5-122B-A10B-FP8"
  temperature: 0.3
  max_tokens: 60000
  timeout: 600
  max_retries: 5
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | string | `"vllm"` | LLM 提供商，可选 `vllm` / `openai` / `openrouter` |
| `base_url` | string | `"http://localhost:8001/v1"` | LLM 服务的 API 基础 URL |
| `api_key` | string | `""` | API 密钥。vLLM 本地部署可留空或设为 `"EMPTY"` |
| `model` | string | `"Qwen/Qwen3-4B"` | 模型名称 |
| `temperature` | float | `0.3` | 生成温度。越低越确定，越高越有创意。记忆提取推荐 0.2~0.4 |
| `max_tokens` | int | `16384` | 单次生成最大 token 数 |
| `timeout` | int | `600` | 请求超时时间（秒）。大模型推理较慢，建议设为 300~600 |
| `max_retries` | int | `5` | 请求失败最大重试次数。遇到 429 速率限制时会指数退避重试 |

**Provider 说明**：

| provider | 说明 |
|----------|------|
| `vllm` | vLLM 本地部署，使用 OpenAI 兼容协议 |
| `openai` | OpenAI 官方 API，协议与 vLLM 相同 |
| `openrouter` | OpenRouter 聚合服务，自动设置 `base_url` 为 `https://openrouter.ai/api/v1` |

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
| `provider` | string | `"vllm"` | 嵌入提供商，可选 `vllm` / `openai` |
| `base_url` | string | `"http://localhost:8002/v1"` | 嵌入服务 API 基础 URL |
| `api_key` | string | `""` | API 密钥 |
| `model` | string | `"Qwen/Qwen3-Embedding-4B"` | 嵌入模型名称 |
| `dimensions` | int | `1024` | 向量维度。必须与模型输出维度一致，否则数据库报错。Qwen3-Embedding-4B 支持的维度范围取决于部署参数 |
| `timeout` | int | `30` | 请求超时时间（秒） |
| `max_retries` | int | `3` | 失败重试次数 |
| `batch_size` | int | `10` | 批量嵌入时每批的文本数量。过大可能导致 GPU OOM |

> **重要**：`dimensions` 值决定了 pgvector 中向量列的维度。如果修改此值，需要重新建表并重新嵌入所有已有数据。

### 5.5 rerank — 重排序配置

```yaml
rerank:
  provider: "vllm"
  base_url: "http://localhost:19002/v1"
  api_key: ""
  model: "Qwen3-Reranker-4B"
  timeout: 30
  max_retries: 3
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | string | `"vllm"` | 重排序提供商，可选 `vllm` / `openai` |
| `base_url` | string | `"http://localhost:8003/v1"` | 重排序服务 API 基础 URL |
| `api_key` | string | `""` | API 密钥 |
| `model` | string | `"Qwen/Qwen3-Reranker-4B"` | 重排序模型名称 |
| `timeout` | int | `30` | 请求超时（秒） |
| `max_retries` | int | `3` | 失败重试次数 |

**Qwen3-Reranker 工作原理**：不使用 `/v1/rerank` 端点，而是通过 `chat/completions` 发送 query-document 对，模型输出 "yes"/"no" 判断相关性，通过 logprobs 计算精确的相关性分数。

### 5.6 memory — 记忆提取配置

```yaml
memory:
  language: "en"
  boundary_max_tokens: 8192
  boundary_max_messages: 50
  cluster_similarity_threshold: 0.3
  cluster_max_time_gap_days: 7
  profile_min_memcells: 1
  profile_min_confidence: 0.6
  profile_life_max_items: 25
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `language` | string | `"en"` | 提示词语言，可选 `en`（英文） / `zh`（中文）。影响 LLM 抽取时使用的 prompt 模板 |
| `boundary_max_tokens` | int | `8192` | 边界检测窗口最大 token 数。超过此值触发强制切分 |
| `boundary_max_messages` | int | `50` | 边界检测窗口最大消息条数 |
| `cluster_similarity_threshold` | float | `0.3` | MemCell 聚类相似度阈值。值越低聚类越宽松，越多 MemCell 会被归为同一话题簇 |
| `cluster_max_time_gap_days` | int | `7` | 聚类最大时间跨度（天）。超过此间隔的 MemCell 不会被归为同一簇 |
| `profile_min_memcells` | int | `1` | 触发画像提取的最小 MemCell 数量 |
| `profile_min_confidence` | float | `0.6` | 画像属性最低置信度。低于此值的属性不会被保留 |
| `profile_life_max_items` | int | `25` | 画像中每个维度的最大条目数 |

### 5.7 compaction — 上下文压缩配置

```yaml
compaction:
  soft_threshold_tokens: 12000
  hard_threshold_tokens: 16000
  keep_recent_tokens: 4000
  session_end_extract_messages: 15
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `soft_threshold_tokens` | int | `12000` | 软阈值（token 数）。会话 token 数超过此值时触发**记忆提取**（memory flush），将重要信息保存为 MemoryNote |
| `hard_threshold_tokens` | int | `16000` | 硬阈值（token 数）。超过此值触发**硬压缩**（compaction），将旧消息摘要为 compaction_summary 并标记为已压缩 |
| `keep_recent_tokens` | int | `4000` | 硬压缩时保留的最近消息 token 数。确保近期对话不被压缩 |
| `session_end_extract_messages` | int | `15` | 会话归档时提取的最近消息条数，用于生成会话结束的记忆笔记 |

**压缩流程**：

```
                          token_count 增长
                               │
              ┌────────────────┼────────────────┐
              │                │                │
         < 12000          12000~16000        > 16000
         正常状态         触发 memory_flush   触发 hard compaction
                        (提取记忆笔记)      (摘要旧消息 + 软删除)
```

### 5.8 chunking — 分块配置

```yaml
chunking:
  chunk_size_tokens: 400
  chunk_overlap_tokens: 80
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `chunk_size_tokens` | int | `400` | 每个文本块的 token 数。影响搜索粒度——过大则检索不够精确，过小则上下文不足 |
| `chunk_overlap_tokens` | int | `80` | 相邻块的重叠 token 数。重叠可以防止关键信息被切断。推荐值为 chunk_size 的 15%~25% |

分块使用 `tiktoken` 的 `cl100k_base` 编码器进行 token 级别的精确切分。

### 5.9 search — 混合搜索配置

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

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vector_weight` | float | `0.7` | 向量相似度得分的权重。`vector_weight + text_weight` 应等于 1.0 |
| `text_weight` | float | `0.3` | 全文检索得分的权重 |
| `temporal_decay_half_life_days` | int | `30` | 时间衰减半衰期（天）。30 天前的记忆得分降为一半。设为 0 禁用时间衰减 |
| `mmr_enabled` | bool | `true` | 是否启用 MMR（Maximal Marginal Relevance）多样性重排 |
| `mmr_lambda` | float | `0.7` | MMR 平衡参数。1.0 = 纯相关性，0.0 = 纯多样性。推荐 0.5~0.8 |
| `default_top_k` | int | `10` | 默认返回的搜索结果数量 |
| `rrf_k` | int | `60` | RRF (Reciprocal Rank Fusion) 融合参数。值越大，排名靠后的结果权重越大 |

**混合搜索流程**：

```
查询 ──┬──> 向量搜索 (pgvector cosine) ──┐
       │                                 ├──> 分数归一化 ──> 加权合并 ──> 时间衰减 ──> MMR 重排 ──> Top-K
       └──> 全文检索 (PostgreSQL ts_rank) ┘
```

---

## 六、使用流程

### 6.1 核心概念

| 概念 | 说明 |
|------|------|
| **User** | 用户实体，通过 `external_id` 关联外部系统 |
| **Session** | 一次对话会话，属于某个 User。状态可为 `active`（进行中）/ `archived`（已归档）/ `deleted`（已删除） |
| **Message** | 会话中的单条消息，角色为 `user` / `assistant` / `system` / `tool`。类型可为 `message`（普通消息）/ `compaction_summary`（压缩摘要）/ `memory_flush`（记忆刷写） |
| **MemoryNote** | 记忆笔记，从对话中提取的知识。类型为 `evergreen`（长期记忆）或 `daily`（短期记忆） |
| **MemoryChunk** | 记忆分块，MemoryNote 经分块后存储，包含向量嵌入，用于向量搜索 |
| **MemCell** | Memorize 管线中的原子记忆单元，由边界检测切分 |
| **EpisodicMemory** | 情节记忆，从 MemCell 中提取的叙事性记忆 |
| **EventLogRecord** | 事件日志，从 MemCell 中提取的原子事实 |
| **ForesightRecord** | 前瞻记忆，从 MemCell 中推断的未来预测 |
| **UserProfile** | 用户画像，从多个 MemCell 中聚合的用户特征 |

### 6.2 完整使用流程

Replica 提供两条记忆管理路径：

**路径 A：对话式记忆管理**（传统 CRUD）

```
创建用户 → 创建会话 → 发送消息 → [自动压缩] → 归档会话 → 搜索记忆 → 构建上下文
```

适用场景：需要完整对话管理、渐进式压缩的应用。

**路径 B：Memorize 管线记忆摄入**

```
准备原始对话数据 → POST /v1/memories → 自动提取全部记忆类型
```

适用场景：批量导入历史对话、与外部系统集成。

---

## 七、API 参考

所有业务 API 均在 `/v1` 前缀下。

### 7.1 健康检查

#### `GET /health`

检查服务是否正常运行。

**响应**：

```json
{"status": "ok"}
```

---

### 7.2 用户管理

#### `POST /v1/users` — 创建用户

**请求体**：

```json
{
  "external_id": "user-abc-123",
  "metadata": {
    "name": "张三",
    "email": "zhangsan@example.com"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `external_id` | string | 是 | 外部系统用户标识 |
| `metadata` | object \| null | 否 | 任意 JSON 元数据 |

**响应** (201)：

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "external_id": "user-abc-123",
  "metadata": {"name": "张三", "email": "zhangsan@example.com"},
  "created_at": "2026-03-28T10:00:00Z"
}
```

#### `GET /v1/users/{user_id}` — 获取用户信息

**路径参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `user_id` | UUID | 用户 ID（Replica 内部 ID，非 external_id） |

**响应** (200)：同创建用户的响应格式。

**错误** (404)：`"User not found"`

---

### 7.3 会话管理

#### `POST /v1/users/{user_id}/sessions` — 创建会话

**路径参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `user_id` | UUID | 用户 ID |

**请求体**：

```json
{
  "metadata": {"topic": "技术讨论"}
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `metadata` | object \| null | 否 | 会话元数据 |

**响应** (201)：

```json
{
  "id": "660e8400-e29b-41d4-a716-446655440000",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "active",
  "token_count": 0,
  "compaction_count": 0,
  "created_at": "2026-03-28T10:01:00Z"
}
```

#### `GET /v1/users/{user_id}/sessions` — 获取用户会话列表

按创建时间倒序返回该用户的所有会话。

**响应** (200)：`SessionOut` 数组。

#### `POST /v1/sessions/{session_id}/archive` — 归档会话

将会话状态设为 `archived`。

**路径参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | UUID | 会话 ID |

**响应** (200)：更新后的会话信息。

---

### 7.4 消息管理

#### `POST /v1/sessions/{session_id}/messages` — 发送消息

**路径参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | UUID | 会话 ID |

**请求体**：

```json
{
  "role": "user",
  "content": "你好，我叫 Alice，我住在上海。",
  "parent_id": null,
  "message_type": "message"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `role` | string | 是 | — | 消息角色：`user` / `assistant` / `system` / `tool` |
| `content` | string | 是 | — | 消息内容 |
| `parent_id` | UUID \| null | 否 | `null` | 父消息 ID，用于表示消息树结构 |
| `message_type` | string | 否 | `"message"` | 消息类型：`message` / `compaction_summary` / `memory_flush` |

**响应** (201)：

```json
{
  "id": "770e8400-e29b-41d4-a716-446655440000",
  "session_id": "660e8400-e29b-41d4-a716-446655440000",
  "parent_id": null,
  "role": "user",
  "content": "你好，我叫 Alice，我住在上海。",
  "token_count": 15,
  "message_type": "message",
  "created_at": "2026-03-28T10:02:00Z"
}
```

> 每次发送消息，系统会自动计算 token 数并更新会话的 `token_count`。

#### `GET /v1/sessions/{session_id}/messages` — 获取会话消息

**查询参数**：

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|------|------|--------|------|------|
| `limit` | int | 50 | 1~200 | 返回消息数量 |
| `offset` | int | 0 | >= 0 | 偏移量 |

**响应** (200)：`MessageOut` 数组（按时间正序），仅返回未被压缩的消息（`is_compacted=false`）。

---

### 7.5 记忆管理

#### `POST /v1/users/{user_id}/memory` — 手动创建记忆

**请求体**：

```json
{
  "content": "用户 Alice 是一名软件工程师，住在上海，喜欢周末爬山。",
  "note_type": "evergreen"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `content` | string | 是 | — | 记忆内容 |
| `note_type` | string | 否 | `"evergreen"` | 记忆类型：`evergreen`（长期）/ `daily`（短期） |

**响应** (201)：

```json
{
  "id": "880e8400-e29b-41d4-a716-446655440000",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "session_id": null,
  "note_type": "evergreen",
  "content": "用户 Alice 是一名软件工程师，住在上海，喜欢周末爬山。",
  "source": "manual",
  "created_at": "2026-03-28T10:05:00Z"
}
```

#### `GET /v1/users/{user_id}/memory` — 获取用户记忆列表

按创建时间倒序返回该用户的所有 MemoryNote。

#### `DELETE /v1/memory/{note_id}` — 删除记忆

**响应** (204)：无内容。

---

### 7.6 记忆搜索

#### `POST /v1/memory/search` — 混合记忆搜索

**请求体**：

```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "query": "Alice 住在哪里？",
  "top_k": 5,
  "note_type": null
}
```

| 字段 | 类型 | 必填 | 默认值 | 范围 | 说明 |
|------|------|------|--------|------|------|
| `user_id` | UUID | 是 | — | — | 用户 ID |
| `query` | string | 是 | — | — | 搜索查询 |
| `top_k` | int | 否 | 10 | 1~100 | 返回结果数 |
| `note_type` | string \| null | 否 | `null` | `evergreen` / `daily` / `null` | 过滤记忆类型。`null` 表示搜索所有类型 |

**响应** (200)：

```json
[
  {
    "chunk_text": "Alice 是一名软件工程师，住在上海",
    "note_id": "880e8400-e29b-41d4-a716-446655440000",
    "score": 0.87,
    "created_at": "2026-03-28T10:05:00Z"
  }
]
```

搜索流程：查询嵌入 → 向量搜索 + 全文检索 → 分数加权合并 → 时间衰减 → MMR 重排 → 返回 Top-K。

---

### 7.7 上下文构建

#### `POST /v1/context/build` — 构建 AI 上下文

将长期记忆、相关记忆和近期消息组装为完整的 LLM 上下文。

**请求体**：

```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "session_id": "660e8400-e29b-41d4-a716-446655440000",
  "query": "介绍一下这个用户"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | UUID | 是 | 用户 ID |
| `session_id` | UUID | 是 | 会话 ID |
| `query` | string \| null | 否 | 搜索查询。提供时会触发混合搜索召回相关记忆；不提供则只返回 Evergreen 记忆和近期消息 |

**响应** (200)：

```json
{
  "evergreen_memories": [
    {
      "id": "...",
      "user_id": "...",
      "session_id": null,
      "note_type": "evergreen",
      "content": "用户 Alice 是一名软件工程师...",
      "source": "manual",
      "created_at": "..."
    }
  ],
  "relevant_memories": [
    {
      "chunk_text": "Alice 上周爬了黄山...",
      "note_id": "...",
      "score": 0.82,
      "created_at": "..."
    }
  ],
  "recent_messages": [
    {
      "id": "...",
      "session_id": "...",
      "parent_id": null,
      "role": "user",
      "content": "今天天气怎么样？",
      "token_count": 8,
      "message_type": "message",
      "created_at": "..."
    }
  ]
}
```

上下文组成部分：

| 层 | 来源 | 说明 |
|----|------|------|
| **Evergreen Memories** | 该用户所有 `note_type=evergreen` 的 MemoryNote | 长期持久知识，不受时间衰减影响 |
| **Relevant Memories** | 混合搜索结果 | 与当前 query 相关的记忆片段 |
| **Recent Messages** | 当前会话中未压缩的消息 | 最新对话上下文 |

---

### 7.8 记忆摄入管线 (Memorize)

#### `POST /v1/memories` — 记忆摄入

通过 Memorize 管线处理原始对话数据，自动提取多种记忆类型。

**请求体**：

```json
{
  "new_raw_data_list": [
    {
      "role": "user",
      "content": "我最近在学习 Rust 编程语言，感觉很有挑战性。"
    },
    {
      "role": "assistant",
      "content": "Rust 确实有一定的学习曲线，尤其是所有权系统。"
    },
    {
      "role": "user",
      "content": "对，不过我觉得内存安全的理念很棒。我计划下个月用 Rust 重写我的一个 Python 项目。"
    }
  ],
  "history_raw_data_list": [],
  "user_id_list": ["user-001"],
  "group_id": null,
  "group_name": null,
  "scene": "assistant"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `new_raw_data_list` | list[dict] | 是 | — | 新的原始对话数据。每个 dict 的格式由具体的 extractor 解析 |
| `history_raw_data_list` | list[dict] \| null | 否 | `null` | 历史对话数据，为边界检测提供上下文 |
| `user_id_list` | list[string] \| null | 否 | `null` | 参与对话的用户 ID 列表 |
| `group_id` | string \| null | 否 | `null` | 群组 ID（群聊场景） |
| `group_name` | string \| null | 否 | `null` | 群组名称 |
| `scene` | string | 否 | `"assistant"` | 场景类型：`assistant`（助手对话）/ `group_chat`（群聊） |

**响应** (201)：

```json
{
  "memory_count": 5,
  "status": "ok"
}
```

**管线执行流程**：

```
原始数据
  │
  ▼
Step 1: 边界检测 (MemCellExtractor)
  │     分析对话内容，判断是否达到话题边界
  │     若未达到边界 → 返回 memory_count=0，等待更多消息
  │
  ▼
Step 2: 创建 MemCell
  │     将边界内的消息打包为一个原子记忆单元
  │
  ▼
Step 3: 并行提取记忆
  ├──> 3a: 情节记忆 (EpisodeExtractor)
  │         生成叙事性的情节描述和标题
  │
  ├──> 3b: 事件日志 (EventLogExtractor)
  │         提取原子事实列表，每个事实独立存储
  │
  ├──> 3c: 前瞻预测 (ForesightExtractor)
  │         基于对话推断未来可能发生的事件
  │
  ├──> 3d: 用户画像 (ProfileExtractor)
  │         提取/更新用户特征（技能、性格、兴趣等）
  │
  └──> 3e: 群组画像 (GroupProfileExtractor, 仅群聊)
            提取群组话题和角色分布
```

---

## 八、端到端使用示例

### 8.1 场景一：对话式记忆管理

以下示例使用 `curl` 演示完整的对话→记忆→检索流程。将 `localhost:8000` 替换为你的实际服务地址。

**第 1 步：创建用户**

```bash
curl -s -X POST http://localhost:8000/v1/users \
  -H "Content-Type: application/json" \
  -d '{
    "external_id": "alice-001",
    "metadata": {"name": "Alice"}
  }' | python -m json.tool
```

记录返回的 `id` 字段，假设为 `USER_ID`。

**第 2 步：创建会话**

```bash
curl -s -X POST http://localhost:8000/v1/users/${USER_ID}/sessions \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"topic": "自我介绍"}}' | python -m json.tool
```

记录返回的 `id` 字段，假设为 `SESSION_ID`。

**第 3 步：发送多轮对话**

```bash
# 用户消息 1
curl -s -X POST http://localhost:8000/v1/sessions/${SESSION_ID}/messages \
  -H "Content-Type: application/json" \
  -d '{"role": "user", "content": "你好！我叫 Alice，我是一名软件工程师，住在上海。"}'

# 助手回复 1
curl -s -X POST http://localhost:8000/v1/sessions/${SESSION_ID}/messages \
  -H "Content-Type: application/json" \
  -d '{"role": "assistant", "content": "你好 Alice！很高兴认识你。上海是个很棒的城市！"}'

# 用户消息 2
curl -s -X POST http://localhost:8000/v1/sessions/${SESSION_ID}/messages \
  -H "Content-Type: application/json" \
  -d '{"role": "user", "content": "我平时喜欢爬山，上周刚去了黄山。我还养了一只叫 Mimi 的猫。"}'

# 助手回复 2
curl -s -X POST http://localhost:8000/v1/sessions/${SESSION_ID}/messages \
  -H "Content-Type: application/json" \
  -d '{"role": "assistant", "content": "黄山的风景一定很美！Mimi 是什么品种的猫呢？"}'
```

**第 4 步：手动创建长期记忆**

```bash
curl -s -X POST http://localhost:8000/v1/users/${USER_ID}/memory \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Alice 是一名住在上海的软件工程师，喜欢爬山，养了一只叫 Mimi 的猫。",
    "note_type": "evergreen"
  }' | python -m json.tool
```

**第 5 步：搜索记忆**

```bash
curl -s -X POST http://localhost:8000/v1/memory/search \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "'${USER_ID}'",
    "query": "Alice 的宠物叫什么？",
    "top_k": 5
  }' | python -m json.tool
```

**第 6 步：构建上下文**

```bash
curl -s -X POST http://localhost:8000/v1/context/build \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "'${USER_ID}'",
    "session_id": "'${SESSION_ID}'",
    "query": "用户有什么爱好？"
  }' | python -m json.tool
```

**第 7 步：归档会话**

```bash
curl -s -X POST http://localhost:8000/v1/sessions/${SESSION_ID}/archive | python -m json.tool
```

### 8.2 场景二：Memorize 管线记忆摄入

适用于批量导入已有对话数据或与外部系统集成。

```bash
curl -s -X POST http://localhost:8000/v1/memories \
  -H "Content-Type: application/json" \
  -d '{
    "new_raw_data_list": [
      {"role": "user", "content": "我最近在研究机器学习，特别是 Transformer 架构。"},
      {"role": "assistant", "content": "Transformer 是当前 NLP 的基础架构，你有什么具体问题吗？"},
      {"role": "user", "content": "我想了解自注意力机制的计算复杂度，以及如何优化。"},
      {"role": "assistant", "content": "标准自注意力的时间复杂度是 O(n²d)。常见的优化方法有线性注意力、FlashAttention 等。"},
      {"role": "user", "content": "我计划下个月在公司做一个关于 FlashAttention 的技术分享。"}
    ],
    "user_id_list": ["alice-001"],
    "scene": "assistant"
  }' | python -m json.tool
```

这一次调用将自动执行：
1. 边界检测 → 生成 MemCell
2. 提取情节记忆（"Alice 在研究 Transformer 和 FlashAttention"）
3. 提取事件日志（原子事实：Alice 在研究 ML、计划做技术分享等）
4. 前瞻预测（下个月 Alice 可能会做 FlashAttention 分享）

---

## 九、记忆体系详解

### 9.1 三层记忆模型

通过 MemoryNote 和 MemoryChunk 实现的传统记忆层：

| 层级 | NoteType | 特点 | 来源 |
|------|----------|------|------|
| **Evergreen 记忆** | `evergreen` | 长期持久，不受时间衰减影响 | 手动创建（`source=manual`） |
| **Daily 记忆** | `daily` | 会话级短期记忆，随时间衰减 | 自动提取（`source=auto_flush` / `session_end` / `compaction`） |
| **记忆分块** | — | MemoryNote 的分块表示，包含向量嵌入 | 自动生成 |

### 9.2 Memorize 管线抽取的记忆类型

通过 `/v1/memories` 端点触发的高级记忆类型：

| 类型 | 数据表 | 说明 |
|------|--------|------|
| **MemCell** | `memcells` | 原子记忆单元，包含原始对话和摘要 |
| **情节记忆** | `episodic_memories` | 叙事性记忆，包含标题、情节描述、参与者 |
| **事件日志** | `event_log_records` | 原子事实列表，每条事实独立存储和索引 |
| **前瞻预测** | `foresight_records` | 基于对话推断的未来事件，含时间范围和证据 |
| **用户画像** | `user_profiles` | 多维用户特征（技能、性格、兴趣、目标等） |
| **群组画像** | `group_profiles` | 群组话题和角色分布（仅群聊场景） |

### 9.3 渐进式压缩机制

```
会话进行中
    │
    │  每条消息自动计算 token 数
    │  累加到 session.token_count
    │
    ├── token_count < soft_threshold (12000)
    │   └── 正常状态，不做处理
    │
    ├── soft_threshold <= token_count < hard_threshold
    │   └── 触发 memory_flush
    │       ├── 提取最近 N 条消息的要点
    │       ├── 创建 MemoryNote (type=daily, source=auto_flush)
    │       └── 对 MemoryNote 分块并嵌入向量
    │
    └── token_count >= hard_threshold (16000)
        └── 触发 hard compaction
            ├── 保留最近 keep_recent_tokens (4000) 的消息
            ├── 将旧消息摘要为 compaction_summary
            ├── 标记旧消息 is_compacted=true
            ├── 插入摘要消息 (type=compaction_summary)
            └── 重新计算 session.token_count
```

### 9.4 混合搜索机制

搜索算法详细流程：

1. **查询嵌入**：将查询文本通过 Embedding 模型转为向量
2. **向量搜索**：通过 pgvector 的余弦距离搜索，返回 `top_k × 3` 个候选
3. **全文检索**：通过 PostgreSQL `ts_rank` 全文检索，返回 `top_k × 3` 个候选
4. **分数归一化**：将向量分数和全文分数分别归一化到 [0, 1]
5. **加权合并**：`score = vector_weight × vector_score + text_weight × text_score`
6. **时间衰减**：`score × exp(-λ × age_days)`，其中 `λ = ln(2) / half_life_days`
7. **MMR 重排**：`MMR = λ × relevance - (1-λ) × max_similarity_to_selected`，平衡相关性与多样性
8. **截取 Top-K**：返回最终结果

---

## 十、开发指南

### 10.1 项目结构

```
replica/
├── config/
│   └── settings.yaml               # 配置文件
├── src/replica/
│   ├── main.py                      # FastAPI 入口
│   ├── config.py                    # 配置加载 (Pydantic Settings)
│   ├── db/
│   │   └── database.py              # 异步数据库连接
│   ├── models/                      # SQLAlchemy ORM 模型 (17+ 张表)
│   │   ├── user.py                  # users 表
│   │   ├── session.py               # sessions 表
│   │   ├── message.py               # messages 表
│   │   ├── memory_note.py           # memory_notes 表
│   │   ├── memory_chunk.py          # memory_chunks 表 (含向量列)
│   │   ├── memcell.py               # memcells 表
│   │   ├── episodic_memory.py       # episodic_memories 表
│   │   ├── event_log.py             # event_log_records 表
│   │   ├── foresight.py             # foresight_records 表
│   │   ├── user_profile.py          # user_profiles 表
│   │   ├── group_profile.py         # group_profiles 表
│   │   ├── entity.py                # entities 表
│   │   ├── relationship.py          # relationships 表
│   │   ├── cluster_state.py         # cluster_states 表
│   │   ├── conversation_meta.py     # conversation_metas 表
│   │   ├── conversation_status.py   # conversation_statuses 表
│   │   └── behavior_history.py      # behavior_histories 表
│   ├── api/                         # API 路由
│   │   ├── schemas.py               # Pydantic 请求/响应模型
│   │   ├── users.py                 # 用户管理 API
│   │   ├── sessions.py              # 会话管理 API
│   │   ├── messages.py              # 消息管理 API
│   │   ├── memory.py                # 记忆搜索与上下文 API
│   │   └── memorize.py              # Memorize 管线 API
│   ├── services/                    # 业务逻辑
│   │   ├── memory_service.py        # 混合记忆搜索
│   │   ├── context_service.py       # 上下文组装
│   │   ├── compaction_service.py    # 压缩与记忆刷写
│   │   ├── embedding_service.py     # 分词与分块工具
│   │   └── memorize_service.py      # Memorize 管线编排
│   ├── extractors/                  # 记忆提取器
│   │   ├── __init__.py              # 数据类型定义
│   │   ├── memcell_extractor.py     # 边界检测 → MemCell
│   │   ├── episode_extractor.py     # 情节记忆提取
│   │   ├── event_log_extractor.py   # 事件日志提取
│   │   ├── foresight_extractor.py   # 前瞻预测提取
│   │   ├── profile_extractor.py     # 用户画像提取
│   │   ├── group_profile_extractor.py # 群组画像提取
│   │   └── cluster_manager.py       # MemCell 聚类管理
│   ├── providers/                   # 外部服务适配
│   │   ├── llm_provider.py          # LLM 提供商 (vllm/openai/openrouter)
│   │   ├── embedding_provider.py    # 嵌入提供商 (vllm/openai)
│   │   └── rerank_provider.py       # 重排序提供商 (vllm/openai)
│   └── prompts/                     # 提示词模板
│       ├── en/                      # 英文提示词
│       └── zh/                      # 中文提示词
├── tests/                           # 测试
├── alembic/                         # 数据库迁移
├── docs/                            # 文档
└── pyproject.toml                   # 项目配置
```

### 10.2 代码规范

```bash
# 格式化代码
uv run ruff format

# 代码检查
uv run ruff check

# 代码检查并自动修复
uv run ruff check --fix
```

关键规范：
- 行宽限制 120 字符
- 使用内置类型注解（`list[str]` 而非 `List[str]`）
- 路径操作使用 `pathlib`
- 不使用环境变量语法（`os.getenv` / `os.environ`）
- 不生成不必要的 `__init__.py`
- 测试用例使用 `if __name__ == "__main__":` 模式

### 10.3 运行测试

```bash
# 运行全部测试
uv run pytest

# 运行指定测试文件
uv run pytest tests/test_schemas.py

# 运行测试并显示详细输出
uv run pytest -v

# 运行测试并显示 print 输出
uv run pytest -s
```

测试配置：`asyncio_mode = "auto"`，异步测试函数自动识别。

### 10.4 数据库模型一览

| 表名 | 模型类 | 说明 |
|------|--------|------|
| `users` | `User` | 用户表。`external_id` 关联外部系统，`metadata` 为 JSONB |
| `sessions` | `Session` | 会话表。`status` (active/archived/deleted)，`token_count` 追踪上下文大小 |
| `messages` | `Message` | 消息表。`role` (user/assistant/system/tool)，`is_compacted` 标记是否已压缩 |
| `memory_notes` | `MemoryNote` | 记忆笔记。`note_type` (evergreen/daily)，`source` (auto_flush/session_end/manual/compaction) |
| `memory_chunks` | `MemoryChunk` | 记忆分块。包含 `embedding` 向量列和 `chunk_text` 全文 |
| `memcells` | `MemCell` | 原子记忆单元。Memorize 管线的基本单位 |
| `episodic_memories` | `EpisodicMemory` | 情节记忆。包含 `title`、`episode`、`summary` |
| `event_log_records` | `EventLogRecord` | 事件日志。每条 `atomic_fact` 独立存储 |
| `foresight_records` | `ForesightRecord` | 前瞻预测。含 `content`、`evidence`、时间范围 |
| `user_profiles` | `UserProfile` | 用户画像。多维度特征（技能、性格、兴趣等） |
| `group_profiles` | `GroupProfile` | 群组画像。话题和角色分布 |
| `entities` | `Entity` | 实体 |
| `relationships` | `Relationship` | 实体关系 |
| `cluster_states` | `ClusterState` | MemCell 聚类状态 |
| `conversation_metas` | `ConversationMeta` | 对话元数据 |
| `conversation_statuses` | `ConversationStatus` | 对话状态 |
| `behavior_histories` | `BehaviorHistory` | 行为历史 |
