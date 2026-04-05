<p align="center">
  <span style="font-size: 100px">👾</span>
</p>

<h1 align="center">R E P L I C A</h1>

<p align="center">
  <b>AI 的记忆层</b><br/>
  让你的 AI 拥有<i>记忆</i>能力
</p>

<p align="center">
  <img src="https://img.shields.io/badge/状态-测试版-E8A23E?style=flat-square" alt="Status" />
  <img src="https://img.shields.io/badge/python-≥3.13-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/PostgreSQL-pgvector-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/许可证-MIT-0D0D0D?style=flat-square" alt="License" />
</p>

<p align="center">
  <a href="README.md">English</a> | <b>简体中文</b>
</p>

---

## 🧠 什么是 Replica？

你是否希望 AI 能记住你讨厌香菜？或者你对猫过敏？又或者你提到过的奶奶的秘制食谱？

**Replica** 是一个记忆管理服务，为 AI 应用提供长期记忆的超能力。就像给你的 AI 装上一个真正能用的大脑。

```
┌─────────────────────────────────────────────────┐
│  "还记得我上个月跟你说的东京之行吗？"            │
│                                                 │
│  → Replica 搜索 10,000+ 条记忆                 │
│  → 找到："用户在 2026 年 3 月访问了东京"        │
│  → 50ms 内返回相关上下文                        │
└─────────────────────────────────────────────────┘
```

### 为什么需要 Replica？

- 🤖 **AI 会忘记一切** - 没有记忆，每次对话都从零开始
- 💾 **上下文窗口很贵** - 把所有东西塞进 prompt 既昂贵又有限制
- 🔍 **RAG 还不够** - 你需要结构化的记忆提取，而不仅仅是向量搜索
- 🧩 **记忆很复杂** - 事实、事件、计划、偏好……它们都不一样

Replica 自动处理这一切。

---

## ✨ 功能特性

### 🎯 智能记忆提取

Replica 不只是存储文本。它**理解**对话并提取结构化记忆：

- **情节记忆（Episode）** - "用户讨论了 Python 异步编程最佳实践"
- **事件记忆（Event）** - "用户明天下午 3 点有会议"
- **前瞻记忆（Foresight）** - "用户计划下周学习 Rust"
- **用户画像（Profile）** - 兴趣、技能、偏好、目标

### 🔎 真正有效的混合搜索

忘掉简单的向量搜索吧。Replica 结合了：

- **向量搜索** - 通过 pgvector 进行语义相似度搜索
- **全文搜索** - PostgreSQL 强大的文本搜索
- **RRF 融合** - Reciprocal Rank Fusion 融合两种检索结果
- **时间衰减** - 最近的记忆排名更高（因为它们更重要）
- **MMR 重排** - Maximal Marginal Relevance 增加结果多样性

### 🗜️ 自动上下文压缩

对话太长？没问题。Replica 自动：

- 实时跟踪 token 数量
- 达到限制时压缩旧消息
- 保持最近的上下文新鲜且相关
- 在压缩前提取重要信息

### 🎨 精美的 Web 界面

与 AI 聊天，实时观察记忆的创建：

<p align="center">
  <img src="assets/chat.png" width="800" alt="聊天界面" />
  <br/>
  <em>实时流式聊天，带记忆上下文</em>
</p>

<p align="center">
  <img src="assets/admin.png" width="800" alt="管理界面" />
  <br/>
  <em>数据库浏览器，用于调试和检查</em>
</p>

---

## 🚀 快速开始

### 前置要求

| 组件 | 要求 |
|------|------|
| Python | ≥ 3.13 |
| PostgreSQL | 17 + pgvector |
| 包管理器 | [uv](https://docs.astral.sh/uv/) |
| Node 运行时 | [Bun](https://bun.sh/)（推荐）或 Node.js |
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

### 2. 安装与迁移

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
  dimensions: 2560
```

> 💡 完整配置参考：[`config/settings.yaml`](config/settings.yaml) | 详细指南：[`docs/guide.md`](docs/guide.md)

### 4. 启动服务

**后端 API**（端口 `8000`）：

```bash
uv run uvicorn replica.main:app --host 0.0.0.0 --port 8000 --reload
```

**前端界面**（端口 `5173`）：

```bash
cd web
bun install
bun run dev
```

然后访问：

| 地址 | 说明 |
|------|------|
| `http://localhost:5173` | 🎨 Web 界面 |
| `http://localhost:8000/docs` | 📚 Swagger API 文档 |
| `http://localhost:8000/health` | ❤️ 健康检查 |

---

## 🎮 工作原理

### 记忆生命周期

```
1. 用户与 AI 聊天
   ↓
2. Replica 存储消息
   ↓
3. 当对话达到自然边界时...
   ↓
4. 提取结构化记忆：
   • 情节（发生了什么）
   • 事件（具体事实）
   • 前瞻（未来计划）
   • 用户画像更新
   ↓
5. 生成向量嵌入
   ↓
6. 存储到知识库
   ↓
7. 下次用户提问时...
   ↓
8. 混合搜索检索相关记忆
   ↓
9. 注入到 AI 上下文
   ↓
10. AI 带着完整记忆上下文回复
```

### 记忆类型详解

| 类型 | 存储内容 | 示例 |
|------|----------|------|
| **Episode（情节）** | 对话摘要 | "用户询问了 Python 中的 async/await 模式并讨论了事件循环" |
| **Event（事件）** | 具体事实 | "用户的生日是 3 月 15 日" |
| **Foresight（前瞻）** | 未来意图 | "用户想在下个月构建一个网页爬虫" |
| **Evergreen（长期）** | 长期事实 | "用户是住在上海的软件工程师" |

---

## 💻 API 示例

### 创建用户和会话

```python
import httpx

async with httpx.AsyncClient() as client:
    # 创建用户
    user = await client.post(
        "http://localhost:8000/v1/users",
        json={"external_id": "alice", "name": "Alice"}
    )
    user_id = user.json()["id"]
    
    # 创建会话
    session = await client.post(
        f"http://localhost:8000/v1/users/{user_id}/sessions",
        json={}
    )
    session_id = session.json()["id"]
```

### 带记忆的流式聊天

```python
# 流式聊天（Server-Sent Events）
async with client.stream(
    "POST",
    f"http://localhost:8000/v1/sessions/{session_id}/chat",
    json={"content": "我之前跟你说的旅行计划是什么？", "use_memory": True}
) as response:
    async for line in response.aiter_lines():
        if line.startswith("data: "):
            data = json.loads(line[6:])
            if "token" in data:
                print(data["token"], end="", flush=True)
            elif "context" in data:
                print("\n\n📚 检索到的记忆：", data["context"])
```

### 从原始数据提取记忆

```python
# 批量记忆提取
response = await client.post(
    "http://localhost:8000/v1/memories",
    json={
        "new_raw_data_list": [
            {"role": "user", "content": "我计划下个月去东京旅行"},
            {"role": "assistant", "content": "听起来很棒！你以前去过吗？"},
            {"role": "user", "content": "没有，第一次。我想去涩谷，还想尝尝正宗的拉面。"}
        ],
        "user_id_list": ["alice"]
    }
)
print(f"提取了 {response.json()['memory_count']} 条记忆")
```

### 搜索知识库

```python
# 语义搜索
results = await client.post(
    "http://localhost:8000/v1/knowledge/search",
    json={
        "user_id": user_id,
        "query": "旅行计划",
        "top_k": 5
    }
)

for memory in results.json():
    print(f"[{memory['entry_type']}] {memory['content']} (得分: {memory['score']:.2f})")
```

---

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                   Web 界面 (React 19)                    │
│                    localhost:5173                        │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP / SSE
┌────────────────────────▼────────────────────────────────┐
│                  FastAPI 后端                            │
│                   localhost:8000                         │
│  ┌──────────┬──────────┬──────────┬──────────────────┐ │
│  │  用户    │  会话    │  消息    │  记忆/知识库     │ │
│  │  API     │  API     │  API     │      API         │ │
│  └────┬─────┴────┬─────┴────┬─────┴────┬─────────────┘ │
│       │          │          │          │                │
│  ┌────▼──────────▼──────────▼──────────▼─────────────┐ │
│  │                  服务层                            │ │
│  │  • 记忆服务      • 压缩服务                        │ │
│  │  • 提取服务      • 嵌入服务                        │ │
│  └────┬───────────────────────────────────────┬──────┘ │
└───────┼───────────────────────────────────────┼────────┘
        │                                       │
   ┌────▼────┐                           ┌─────▼──────┐
   │   LLM   │                           │  Embedding │
   │  服务   │                           │    服务    │
   │  :19000 │                           │   :19001   │
   └─────────┘                           └────────────┘
        │                                       │
        └───────────────┬───────────────────────┘
                        │
              ┌─────────▼──────────┐
              │  PostgreSQL 17     │
              │  + pgvector        │
              │   localhost:5432   │
              └────────────────────┘
```

---

## 🛠️ 开发

```bash
# 格式化代码
uv run ruff format

# 代码检查与修复
uv run ruff check --fix

# 运行测试
uv run pytest

# 运行测试并生成覆盖率报告
uv run pytest --cov=replica
```

---

## 📚 文档

- **[完整指南](docs/guide.md)** - 配置、概念和使用方法
- **[API 参考](docs/api.md)** - 完整的 API 文档
- **[Swagger UI](http://localhost:8000/docs)** - 交互式 API 浏览器

---

## 🤔 常见问题

**问：为什么不直接用 RAG？**  
答：RAG 适合文档，但对话需要结构化的记忆提取。Replica 能理解事实、事件和计划之间的区别。

**问：可以用 OpenAI 代替 vLLM 吗？**  
答：可以！在配置中设置 `provider: "openai"` 并提供你的 API 密钥。

**问：运行成本是多少？**  
答：如果用 vLLM 自托管，只有 GPU 成本。如果用 OpenAI API，取决于使用量（嵌入很便宜，LLM 调用会累积）。

**问：可以在生产环境使用吗？**  
答：Replica 处于测试阶段。它能工作，但可能有破坏性更新。请固定版本并充分测试。

**问：支持多用户吗？**  
答：支持！每个用户都有隔离的记忆和会话。

---

## 🗺️ 路线图

- [ ] 多模态记忆（图像、音频）
- [ ] 记忆整合（合并相似记忆）
- [ ] 记忆衰减（遗忘旧的无关信息）
- [ ] 基于图的记忆关系
- [ ] 记忆导出/导入
- [ ] 多语言支持（目前支持英文/中文）

---

## 🙏 致谢

构建于：
- [FastAPI](https://fastapi.tiangolo.com/) - 现代 Python Web 框架
- [pgvector](https://github.com/pgvector/pgvector) - Postgres 向量相似度搜索
- [React 19](https://react.dev/) - 用于构建用户界面的 JavaScript 库
- [Bun](https://bun.sh/) - 快速的一体化 JavaScript 运行时
- [vLLM](https://github.com/vllm-project/vllm) - 快速 LLM 推理
- [Qwen](https://github.com/QwenLM/Qwen) - 强大的开源大语言模型

---

## 📄 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)

---

<p align="center">
  由厌倦了健忘 AI 的开发者用 ❤️ 制作
</p>

<p align="center">
  <a href="https://github.com/echonoshy/replica">⭐ 在 GitHub 上给个星标</a>
</p>
