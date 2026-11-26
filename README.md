# Replica

面向个人与多部门 Agent 的可审计、可溯源、带版本演化的长期记忆服务（Memory Layer for AI）。

上传文档或进行日常对话后，Replica 通过离线编译与「做梦整理（Dreaming）」持续维护结构化的 Markdown Wiki 快照；调用方通过 HTTP 或 Web 工作台检索已发布记忆与未入梦原话，获得带精确出处 `[src:doc_id#loc]` / `[chat:session_id#tN]` 的上下文与回答，并支持克制的主动轻提醒（Proactive Whisper）。

> [!NOTE]
> 旧版 Python 实现已完整归档至 [`legacy/v0-deprecated`](https://github.com/echonoshy/replica/tree/legacy/v0-deprecated) 分支（及历史标签 `v0.1.0`–`v0.3.0`）。当前分支为基于四层记忆模型、Markdown Wiki 编译管线、离线 Dreaming 与主动轻提醒引擎的新一代实现。
> 完整方案架构说明见 [docs/memory-architecture-report.md](docs/memory-architecture-report.md)。

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

支持通过 `snapshot_version` 指定历史快照，或通过 `as_of_date` 进行历史时间切面查询；支持 `fast` / `multi_hop` / `agentic` 检索策略与 `external_safe` 对外隐私隔离。上下文与答案中的 `[src:doc_id#loc]` 可精确回查至 PDF 页码、文本段落或对话轮次。`max_tokens` 按 `o200k_base` 严格预算控制索引摘录、Wiki 上下文、答案与原文切片总长度。

### 3. 做梦整理、记忆管控与撤回（Dream / Controls / Forget）

- **离线做梦整理**：`POST /v1/memories/dream` 或通过 Web 工作台 / 后台 `DreamScheduler` 自动触发，支持合并同名实体与重叠事实（`merge_subjects` / `merge_claims`）、回查原文纠错（`correct_claim`）、归档已完成/过期旧安排（`archive_claim` / `archive_event`）、消化即时热记忆，以及对已入梦会话追加新轮次时的纯增量抽取。
- **实时记忆管控**：支持即时热记忆（“记住/忘掉”当场生效）、实体别名映射、三档遗忘衰减（红线永驻 / 长期稳定 / 短期工作态）、五档隐私分区以及手动编辑/置顶/归档恢复。
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

### 4. 主动轻提醒（Proactive Whisper）

内置 Proactive 插件，基于时间线、有效期、同日冲突、前瞻意图（Intentions）、巡检侦察兵（Scout）与外部事件 L1 快筛生成克制的轻提醒；配备每日限额、冷却期、免打扰时段、严格紧急校验、跟进深度限制与状态并发围栏，并在 Web 收件箱提供零污染的「模拟时间 / 模拟事件」Dry-Run 预览。

## 架构与存储设计

- **四层记忆体系**：常驻核心红线卡（Core Profile Card）+ 即时热记忆（Hot Memory）+ 不可变 Markdown Wiki 快照（`snapshots/v{N}/`，含 `_index.md`、`entities/`、`topics/`、`timeline.md`、`rules.md`、`conflicts.md` 与 `_claims.json`）+ SHA-256 去重的原始档案与锚点文本（`raw/`）。
- **确定性归并 + 单写者门禁**：并行抽取新文档后，由确定性编译器按日期与显式修订裁决冲突，再由持有空间写锁的 Organizer 编排整理；Linter 严格校验 `200 行 / 25,600 字节` 索引上限、断链、孤岛页与出处完整性后，在 SQLite 事务内原子切换版本指针并重建 FTS5 / 向量索引。
- **双通道召回 + 流式对话**：前台路由自动分诊、补全指代与拆题，并发融合「长期 Wiki（目录 + FTS5 + 语义向量）」与「历史原话直搜」，支持长对话自动压缩、SSE 流式输出、基线对照与出处二次核验。

## 验收测试

```sh
pnpm typecheck
pnpm test
pnpm build
```

Vitest 使用临时 SQLite 数据目录、实际 PDF/DOCX 文件及本地 OpenAI 兼容夹具，无需真实模型密钥即可重复验证全链路能力。

## 参考

- 四层记忆和离线整理：[Anthropic Engineering](https://www.anthropic.com/research/components-of-agent-memory)
- 并行抽取与单写者流程：[Claude Cookbook](https://github.com/anthropics/claude-cookbooks/blob/main/managed_agents/CMA_dreaming_with_a_dynamic_workflow.ipynb)
- 知识 Wiki 的蒸馏与出处：[Claude Quickstarts Knowledge Wiki](https://github.com/anthropics/claude-quickstarts/blob/main/managed_agents/knowledge-wiki/README.md)
