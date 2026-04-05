# Replica API 接口文档

## 基础信息

- **Base URL**: `http://localhost:8000`
- **API 版本**: v1
- **所有接口前缀**: `/v1`（除健康检查外）

## 目录

- [健康检查](#健康检查)
- [用户管理](#用户管理)
- [会话管理](#会话管理)
- [消息管理](#消息管理)
- [记忆管理](#记忆管理)
- [知识库](#知识库)
- [记忆摄入](#记忆摄入)
- [聊天接口](#聊天接口)
- [管理接口](#管理接口)
- [配置接口](#配置接口)

---

## 健康检查

### GET /health

检查服务健康状态。

**响应**
```json
{
  "status": "ok"
}
```

---

## 用户管理

### GET /v1/users

列出所有用户。

**响应**: `UserOut[]`
```json
[
  {
    "id": "uuid",
    "external_id": "string",
    "name": "string | null",
    "metadata": {},
    "created_at": "datetime"
  }
]
```

### POST /v1/users

创建新用户。

**请求体**: `UserCreate`
```json
{
  "external_id": "string",
  "name": "string | null",
  "metadata": {}
}
```

**响应**: `UserOut` (201)

### GET /v1/users/{user_id}

获取单个用户信息。

**路径参数**
- `user_id`: UUID

**响应**: `UserOut`

### DELETE /v1/users/{user_id}

删除用户及其所有关联数据（会话、消息、记忆、知识）。

**路径参数**
- `user_id`: UUID

**响应**: 204 No Content

---

## 会话管理

### POST /v1/users/{user_id}/sessions

为用户创建新会话。

**路径参数**
- `user_id`: UUID

**请求体**: `SessionCreate`
```json
{
  "metadata": {}
}
```

**响应**: `SessionOut` (201)
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "status": "active | inactive",
  "token_count": 0,
  "compaction_count": 0,
  "created_at": "datetime",
  "has_unextracted_messages": false
}
```

### GET /v1/users/{user_id}/sessions

列出用户的所有会话。

**路径参数**
- `user_id`: UUID

**响应**: `SessionOut[]`

### GET /v1/sessions/{session_id}

获取单个会话信息。

**路径参数**
- `session_id`: UUID

**响应**: `SessionOut`

### DELETE /v1/sessions/{session_id}

删除会话及其所有消息。

**路径参数**
- `session_id`: UUID

**响应**: 204 No Content

### POST /v1/sessions/{session_id}/extract-memory

手动触发会话的记忆提取。

**路径参数**
- `session_id`: UUID

**响应**: `MemorizeResponse`
```json
{
  "memory_count": 10,
  "status": "ok"
}
```

**说明**: 从会话中提取 MemCell → Episodes → EventLogs → Foresights。

### POST /v1/sessions/{session_id}/compact

手动触发会话的语义压缩（异步任务）。

**路径参数**
- `session_id`: UUID

**响应**: `CompactionTaskResponse`
```json
{
  "task_id": "string",
  "status": "processing",
  "message": "Compaction started. Use GET /tasks/{task_id} to check status."
}
```

**说明**: 返回任务 ID，使用 `GET /v1/tasks/{task_id}` 查询进度。

### GET /v1/tasks/{task_id}

查询异步任务状态（压缩、提取等）。

**路径参数**
- `task_id`: string

**响应**: `TaskStatusResponse`
```json
{
  "task_id": "string",
  "task_type": "semantic_compaction | extraction",
  "session_id": "string | null",
  "status": "pending | processing | completed | failed",
  "created_at": "datetime",
  "started_at": "datetime | null",
  "completed_at": "datetime | null",
  "result": {},
  "error": "string | null"
}
```

---

## 消息管理

### POST /v1/sessions/{session_id}/messages

在会话中创建新消息。

**路径参数**
- `session_id`: UUID

**请求体**: `MessageCreate`
```json
{
  "role": "user | assistant | system",
  "content": "string",
  "parent_id": "uuid | null",
  "message_type": "message | summary"
}
```

**响应**: `MessageOut` (201)
```json
{
  "id": "uuid",
  "session_id": "uuid",
  "parent_id": "uuid | null",
  "role": "user | assistant | system",
  "content": "string",
  "token_count": 100,
  "message_type": "message | summary",
  "is_compacted": false,
  "created_at": "datetime"
}
```

**说明**: 
- 自动计算 token 数量
- 更新会话的 token_count
- 触发自动压缩检查

### GET /v1/sessions/{session_id}/messages

列出会话的消息。

**路径参数**
- `session_id`: UUID

**查询参数**
- `limit`: int (1-200, 默认 50)
- `offset`: int (默认 0)
- `include_compacted`: bool (默认 false) - 是否包含已压缩的消息

**响应**: `MessageOut[]`

---

## 记忆管理

### GET /v1/users/{user_id}/evergreen

列出用户的长期记忆（Evergreen Memory）。

**路径参数**
- `user_id`: UUID

**响应**: `EvergreenMemoryOut[]`
```json
[
  {
    "id": "uuid",
    "user_id": "uuid",
    "category": "fact | preference | goal | relationship",
    "content": "string",
    "source": "manual | auto_extracted",
    "confidence": 0.95,
    "created_at": "datetime",
    "updated_at": "datetime"
  }
]
```

### POST /v1/users/{user_id}/evergreen

手动创建长期记忆。

**路径参数**
- `user_id`: UUID

**请求体**: `EvergreenMemoryCreate`
```json
{
  "content": "string",
  "category": "fact | preference | goal | relationship"
}
```

**响应**: `EvergreenMemoryOut` (201)

### DELETE /v1/evergreen/{memory_id}

删除长期记忆。

**路径参数**
- `memory_id`: UUID

**响应**: 204 No Content

---

## 知识库

### POST /v1/knowledge/search

语义搜索知识库。

**请求体**: `KnowledgeSearchRequest`
```json
{
  "user_id": "uuid",
  "query": "string",
  "top_k": 10,
  "entry_type": "memcell | episode | event_log | foresight | null"
}
```

**响应**: `KnowledgeSearchResult[]`
```json
[
  {
    "id": "uuid",
    "entry_type": "memcell | episode | event_log | foresight",
    "title": "string | null",
    "content": "string",
    "score": 0.85,
    "created_at": "datetime"
  }
]
```

**说明**: 使用向量相似度搜索，返回最相关的知识条目。

### GET /v1/users/{user_id}/knowledge

列出用户的知识条目。

**路径参数**
- `user_id`: UUID

**查询参数**
- `entry_type`: EntryType (可选) - 过滤条目类型
- `limit`: int (1-200, 默认 50)
- `offset`: int (默认 0)

**响应**: `KnowledgeEntryOut[]`
```json
[
  {
    "id": "uuid",
    "user_id": "string",
    "entry_type": "memcell | episode | event_log | foresight",
    "title": "string | null",
    "content": "string",
    "metadata": {},
    "participants": ["user1", "user2"],
    "created_at": "datetime"
  }
]
```

### GET /v1/users/{user_id}/knowledge/count

统计用户的知识条目数量。

**路径参数**
- `user_id`: UUID

**响应**
```json
{
  "total": 100,
  "by_type": {
    "memcell": 50,
    "episode": 30,
    "event_log": 15,
    "foresight": 5
  }
}
```

### DELETE /v1/knowledge/{knowledge_id}

删除知识条目。

**路径参数**
- `knowledge_id`: UUID

**响应**: 204 No Content

### POST /v1/context/build

构建上下文（整合长期记忆、相关知识、近期消息）。

**请求体**: `ContextBuildRequest`
```json
{
  "user_id": "uuid",
  "session_id": "uuid",
  "query": "string | null"
}
```

**响应**: `ContextBuildResponse`
```json
{
  "evergreen_memories": [],
  "relevant_knowledge": [],
  "recent_messages": []
}
```

**说明**: 用于构建 LLM 上下文，整合三层记忆。

---

## 记忆摄入

### POST /v1/memories

从原始数据中提取记忆（MemCell → Episodes → EventLogs → Foresights）。

**请求体**: `MemorizeRequest`
```json
{
  "new_raw_data_list": [
    {
      "role": "user",
      "content": "string",
      "timestamp": "datetime"
    }
  ],
  "history_raw_data_list": [],
  "user_id_list": ["user1", "user2"]
}
```

**响应**: `MemorizeResponse` (201)
```json
{
  "memory_count": 10,
  "status": "ok"
}
```

**说明**: 
- 批量处理原始对话数据
- 自动提取四层记忆结构
- 生成向量嵌入并存储到知识库

---

## 聊天接口

### POST /v1/sessions/{session_id}/chat

流式聊天接口（Server-Sent Events）。

**路径参数**
- `session_id`: UUID

**请求体**: `ChatRequest`
```json
{
  "content": "string",
  "use_memory": true
}
```

**响应**: `text/event-stream`

**事件流格式**:

1. **Token 流**
```
data: {"token": "你"}
data: {"token": "好"}
```

2. **上下文信息**
```
data: {
  "context": {
    "evergreen": [
      {
        "id": "uuid",
        "content": "string",
        "category": "fact"
      }
    ],
    "knowledge": [
      {
        "id": "uuid",
        "content": "string",
        "entry_type": "episode",
        "score": 0.85,
        "title": "string"
      }
    ]
  }
}
```

3. **完成信号**
```
data: {
  "done": true,
  "message_id": "uuid",
  "token_count": 1500
}
```

4. **错误**
```
data: {"error": "error message"}
```

**说明**:
- 自动保存用户消息和助手回复
- 整合三层记忆（Evergreen + Knowledge + Session）
- 自动触发压缩检查
- 支持禁用记忆（`use_memory: false`）

---

## 管理接口

### GET /v1/admin/tables

列出数据库中的所有表及行数。

**响应**
```json
{
  "tables": [
    {
      "name": "users",
      "row_count": 100
    },
    {
      "name": "sessions",
      "row_count": 500
    }
  ]
}
```

### GET /v1/admin/tables/{table_name}

获取表数据（带分页和过滤）。

**路径参数**
- `table_name`: string

**查询参数**
- `limit`: int (1-500, 默认 50)
- `offset`: int (默认 0)
- `filter_field`: string (可选) - 过滤字段名
- `filter_op`: string (可选) - 过滤操作符: `eq`, `contains`, `gt`, `lt`, `gte`, `lte`
- `filter_value`: string (可选) - 过滤值

**响应**
```json
{
  "table_name": "users",
  "columns": [
    {
      "name": "id",
      "data_type": "uuid",
      "udt_name": "uuid"
    }
  ],
  "rows": [
    {
      "id": "uuid",
      "name": "string"
    }
  ],
  "total": 100,
  "limit": 50,
  "offset": 0
}
```

**说明**:
- 自动截断向量字段显示（前 60 字符 + 维度信息）
- 支持字段过滤
- 返回列元数据

---

## 配置接口

### GET /v1/config/compaction

获取当前压缩配置。

**响应**: `CompactionConfigOut`
```json
{
  "hard_threshold_tokens": 8000,
  "keep_recent_tokens": 2000
}
```

**说明**:
- `hard_threshold_tokens`: 触发压缩的 token 阈值
- `keep_recent_tokens`: 压缩时保留的最近消息 token 数

---

## 数据模型

### 枚举类型

**MessageRole**
- `user`: 用户消息
- `assistant`: 助手消息
- `system`: 系统消息

**MessageType**
- `message`: 普通消息
- `summary`: 摘要消息

**SessionStatus**
- `active`: 活跃会话
- `inactive`: 非活跃会话

**EvergreenCategory**
- `fact`: 事实
- `preference`: 偏好
- `goal`: 目标
- `relationship`: 关系

**EvergreenSource**
- `manual`: 手动创建
- `auto_extracted`: 自动提取

**EntryType**
- `memcell`: 记忆单元（原子级对话片段）
- `episode`: 情节（多轮对话主题）
- `event_log`: 事件日志（关键事件）
- `foresight`: 前瞻（未来计划/意图）

**ExtractionStatus**
- `pending`: 待提取
- `extracted`: 已提取
- `failed`: 提取失败

---

## 错误响应

所有接口在出错时返回标准 HTTP 错误码：

**404 Not Found**
```json
{
  "detail": "User not found"
}
```

**400 Bad Request**
```json
{
  "detail": "Invalid filter operator: invalid_op"
}
```

**500 Internal Server Error**
```json
{
  "detail": "Internal server error"
}
```

---

## 使用示例

### 完整对话流程

1. **创建用户**
```bash
curl -X POST http://localhost:8000/v1/users \
  -H "Content-Type: application/json" \
  -d '{"external_id": "user123", "name": "张三"}'
```

2. **创建会话**
```bash
curl -X POST http://localhost:8000/v1/users/{user_id}/sessions \
  -H "Content-Type: application/json" \
  -d '{}'
```

3. **流式聊天**
```bash
curl -X POST http://localhost:8000/v1/sessions/{session_id}/chat \
  -H "Content-Type: application/json" \
  -d '{"content": "你好，我是张三", "use_memory": true}'
```

4. **手动提取记忆**
```bash
curl -X POST http://localhost:8000/v1/sessions/{session_id}/extract-memory
```

5. **搜索知识库**
```bash
curl -X POST http://localhost:8000/v1/knowledge/search \
  -H "Content-Type: application/json" \
  -d '{"user_id": "uuid", "query": "张三的信息", "top_k": 5}'
```

6. **查看长期记忆**
```bash
curl http://localhost:8000/v1/users/{user_id}/evergreen
```

---

## 注意事项

1. **自动压缩**: 创建消息时会自动检查是否需要压缩，超过阈值会触发语义压缩
2. **向量搜索**: 知识搜索使用 pgvector 进行语义相似度匹配
3. **异步任务**: 压缩操作是异步的，需要通过 task_id 查询状态
4. **记忆层次**: 系统维护三层记忆结构（Evergreen → Knowledge → Session）
5. **Token 计数**: 使用 tiktoken 自动计算 token 数量
