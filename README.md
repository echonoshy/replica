# Replica

面向个人与多部门 Agent 的可审计、可溯源、带版本演化的长期记忆服务（Memory Layer for AI）。

上传文档或进行日常对话后，Replica 通过离线编译与「做梦整理（Dreaming）」持续维护结构化的 Markdown Wiki 快照；调用方通过 HTTP 或 Web 工作台检索已发布记忆与未入梦原话，获得带精确出处 `[src:doc_id#loc]` 的上下文与回答。

> [!NOTE]
> 旧版 Python 实现已完整归档至 [`legacy/v0-deprecated`](https://github.com/echonoshy/replica/tree/legacy/v0-deprecated) 分支（及历史标签 `v0.1.0`–`v0.3.0`）。当前 `master` 分支为基于四层记忆模型、Markdown Wiki 编译管线与离线 Dreaming 架构的新一代实现。

## 快速启动

需要 Node.js 22.13+（22 LTS 或 24+）和 pnpm 10。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

在 [环境配置示例](.env.example) 中填写 OpenAI 兼容网关地址、API Key 以及快、强模型名，然后运行 `pnpm dev`。Web 工作台默认在 [127.0.0.1:5173](http://127.0.0.1:5173)，Swagger UI 默认在 [127.0.0.1:8787/docs](http://127.0.0.1:8787/docs)，接口定义可从 [openapi.json](http://127.0.0.1:8787/openapi.json) 获取。

```sh
pnpm build
pnpm start
```

构建后，`pnpm start` 在同一端口提供 API 和 Web 控制台。服务默认监听环回地址，通过 `namespace` 与 `space_id` 隔离记忆空间。配置独立的 `LLM_STRONG_BASE_URL` 时请同时填写对应的 `LLM_STRONG_API_KEY`。模型网关需提供 OpenAI 兼容的 `/chat/completions`，JSON 模式或原生工具调用不可用时会自动降级到文本 JSON 并继续做结构校验。

SQLite 使用 `better-sqlite3`。若 macOS 从源码构建时本机 SDK 与链接器不匹配，可用 `SDKROOT="$(xcrun --sdk macosx --show-sdk-path)" pnpm install --frozen-lockfile` 指定当前 Xcode SDK。

### 火山方舟 Agent Plan

在 `.env` 的 `LLM_API_KEY` 中填入 Agent Plan 专属密钥，并设置以下网关和模型（见 [方舟 Agent Plan 接入文档](https://docs.volcengine.com/docs/ark/agent-plan-personal-other-tools?lang=zh)）：

```dotenv
LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
LLM_FAST_MODEL=doubao-seed-2.1-lite
LLM_STRONG_MODEL=doubao-seed-2.1-pro
```

接入该网关时，服务会为这两档豆包 Seed 2.1 模型关闭深度思考，以缩短结构化抽取与工具调用耗时。

## 核心能力与调用示例

### 1. 摄取文档或对话（Ingest）

首次写入需要提供 `purpose`（可在控制台随时编辑，新编译作业会自动读取更新后的用途）。空间标识使用小写字母、数字、连字符或下划线。

```sh
curl -sS http://127.0.0.1:8787/v1/memories/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "namespace": "finance",
    "space_id": "deal_alpha",
    "purpose": "保留复盘安排、负责人和准备材料",
    "mode": "async",
    "idempotency_key": "review-01",
    "items": [
      {"filename": "review.md", "doc_date": "2026-11-22", "content": "张明负责下次复盘，请准备预算表。"}
    ]
  }'
```

批量上传支持 multipart 的重复 `files` 字段（`doc_dates` 为以文件名为键的可选日期映射）。单文件上限 20 MiB，单批最多 20 份、合计 48 MiB，支持 Markdown、TXT、JSON 对话、DOCX 与带文本层的 PDF（扫描件会标记 `SCANNED_PDF_NO_TEXT_LAYER` 并跳过抽取）。

```sh
curl -sS http://127.0.0.1:8787/v1/memories/ingest \
  -F 'namespace=finance' -F 'space_id=deal_alpha' \
  -F 'files=@tests/fixtures/review.md' \
  -F 'files=@tests/fixtures/travel_policy.pdf' \
  -F 'doc_dates={"review.md":"2026-11-22"}'
```

异步请求返回 HTTP 202，可通过 `GET /v1/memories/jobs/{job_id}` 查询阶段、去重、警告、用量及目标版本；`mode: "sync"` 会等待至 `published` 或 `failed` 返回 HTTP 200（超过 `SYNC_WAIT_MS` 则返回 202 并在后台继续执行）。

### 2. 检索记忆（Retrieve）

```sh
curl -sS http://127.0.0.1:8787/v1/memories/retrieve \
  -H 'Content-Type: application/json' \
  -d '{
    "namespace": "finance",
    "space_id": "deal_alpha",
    "query": "谁负责下次复盘，需要准备什么？",
    "return_mode": "both",
    "verify_raw_sources": true,
    "max_tokens": 1200
  }'
```

支持通过 `snapshot_version` 指定历史快照。上下文与答案中的 `[src:doc_id#loc]` 可精确回查至 PDF 页码、文本段落或对话轮次。`max_tokens` 按 `o200k_base` 严格预算控制索引摘录、Wiki 上下文、答案与原文切片总长度。

### 3. 做梦整理与记忆撤回（Dream & Forget）

- **离线做梦整理**：`POST /v1/memories/dream` 或通过 Web 工作台 / 后台 `DreamScheduler` 自动触发，支持合并重叠事实（`merge_claims`）、将已完成的一次性旧安排归档至审计页（`archive_claim`），以及对已入梦会话追加新轮次时的纯增量轮次抽取。
- **记忆撤回 / 遗忘**：`POST /v1/memories/forget` 支持按 `doc_ids` 从当前活跃快照中确定性撤回对应事实（零 LLM 调用），删除已入梦聊天会话时也会自动触发撤回并发布干净的新版本快照。

```sh
curl -sS http://127.0.0.1:8787/v1/memories/forget \
  -H 'Content-Type: application/json' \
  -d '{
    "namespace": "finance",
    "space_id": "deal_alpha",
    "mode": "sync",
    "doc_ids": ["doc_example"]
  }'
```

## 架构与存储设计

- **四层记忆落盘**：`raw/` 按 SHA-256 不可变保存原始文件与锚点化文本；`staging/{job_id}/notes/` 保存并行 Analyzer 的抽取笔记；`snapshots/v{N}/` 保存不可变 Markdown Wiki 快照（含 `_index.md`、`entities/`、`topics/`、`timeline.md`、`conflicts.md` 与 `_claims.json`）；SQLite 同时维护元数据、`wiki_fts` 与 `chat_turns_fts` 双路全文索引。
- **确定性归并 + 单写者门禁**：并行抽取新文档后，由确定性编译器按日期与显式修订裁决冲突，再由持有空间写锁的 Organizer 结合 L2 笔记进行编排与梦境合并/归档；Linter 严格校验 `200 行 / 25,600 字节` 索引上限、断链、孤岛页与出处完整性后，在 SQLite 事务内原子切换版本指针。
- **双路召回与主动提醒**：对话模式并发融合「薄 Wiki 长期认知」与「历史原话直搜（覆盖尚未入梦的新对话与细碎细节）」；内置 Proactive 插件支持免打扰时段、频控与基于时间线的主动提醒。

## 验收测试

```sh
pnpm typecheck
pnpm test
pnpm build
```

Vitest 使用临时 SQLite 数据目录、真实 PDF/DOCX 夹具与本地 OpenAI 兼容模拟网关，无需真实模型密钥即可完整验证混合摄取、时间冲突、梦境合并/归档、增量追聊入梦、自动定时入梦、百页索引导航、零模型调用记忆撤回与版本回滚。

## 参考

- 四层记忆与离线 Dreaming：[Anthropic Engineering — The Components of Agent Memory](https://www.anthropic.com/research/components-of-agent-memory)
- 并行抽取与单写者流程：[Claude Cookbook — Dreaming with a Dynamic Workflow](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_dreaming_with_a_dynamic_workflow.ipynb)
- 知识 Wiki 的蒸馏与出处：[Claude Quickstarts — Knowledge Wiki](https://github.com/anthropics/claude-quickstarts/blob/main/managed-agents/knowledge-wiki/README.md)
