<p align="center">
  <img src="web/public/favicon.svg" width="100" />
</p>

<h1 align="center">R E P L I C A</h1>

<p align="center">
  <b>Memory layer for AI.</b><br/>
  Give your AI the ability to <i>remember</i>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-beta-E8A23E?style=flat-square" alt="Status" />
  <img src="https://img.shields.io/badge/python-≥3.13-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Vue_3-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white" alt="Vue 3" />
  <img src="https://img.shields.io/badge/license-MIT-0D0D0D?style=flat-square" alt="License" />
</p>

---

Replica 为 AI 应用提供长期记忆能力 —— 管理对话上下文、自动提取与压缩记忆，并通过混合检索在需要时高效召回相关信息。

```
User ←→ Web UI ←→ Replica API ←→ LLM / Embedding
                        ↕
              PostgreSQL + pgvector
```

## 核心特性

- **自动记忆提取** - 从对话中智能提取 Episode、Event、Foresight 三类记忆
- **混合检索** - 向量检索 + 全文检索 + RRF 融合，精准召回相关信息
- **时间衰减** - 基于指数衰减模型，优先展示新鲜内容
- **MMR 多样性重排** - 避免返回重复相似的结果，提升检索质量
- **上下文压缩** - 自动压缩长对话历史，保持上下文在 token 限制内
- **用户画像** - 自动构建和更新用户兴趣、偏好、技能等画像信息
- **Web UI** - 开箱即用的聊天界面，支持实时对话和记忆管理

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

## 核心概念

### 记忆类型

| 类型 | 说明 | 示例 |
|------|------|------|
| **Episode** | 对话片段摘要 | "用户询问了 Python 异步编程的最佳实践" |
| **Event** | 具体事件记录 | "用户提到明天下午 3 点有会议" |
| **Foresight** | 未来计划或意图 | "用户计划下周学习 Rust" |
| **UserProfile** | 用户画像 | 兴趣、技能、偏好等长期特征 |

### 检索策略

1. **向量检索** - 基于语义相似度的向量搜索（pgvector）
2. **全文检索** - PostgreSQL 全文搜索（tsvector + GIN 索引）
3. **RRF 融合** - Reciprocal Rank Fusion 融合两种检索结果
4. **时间衰减** - 根据记忆创建时间应用指数衰减权重
5. **MMR 重排** - Maximal Marginal Relevance 增加结果多样性

## API 示例

### 记忆化对话

```python
import httpx

async with httpx.AsyncClient() as client:
    # 发送对话消息，自动提取记忆
    response = await client.post(
        "http://localhost:8790/v1/memorize",
        json={
            "user_id": "user_123",
            "messages": [
                {"role": "user", "content": "我明天要去北京出差"},
                {"role": "assistant", "content": "好的，祝您旅途愉快！"}
            ]
        }
    )
    print(response.json())
```

### 检索记忆

```python
# 搜索相关记忆
response = await client.post(
    "http://localhost:8790/v1/knowledge/search",
    json={
        "user_id": "user_123",
        "query": "我的出差计划",
        "top_k": 10
    }
)
memories = response.json()
```

## Development

```bash
uv run ruff format          # 格式化
uv run ruff check --fix     # Lint
uv run pytest               # 测试
```

## 文档

- [完整使用指南](docs/guide.md) - 详细的配置说明和使用教程
- [API 文档](http://localhost:8790/docs) - Swagger 交互式 API 文档

## License

MIT
