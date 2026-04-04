// User types
export interface User {
  id: string
  external_id: string
  name: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

// Session types
export interface Session {
  id: string
  user_id: string
  status: 'active' | 'archived' | 'deleted'
  token_count: number
  compaction_count: number
  created_at: string
  ended_at?: string | null
}

export type SessionStatus = 'active' | 'archived' | 'deleted'

// Message types
export interface Message {
  id: string
  session_id: string
  parent_id: string | null
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  token_count: number
  message_type: 'message' | 'compaction_summary' | 'memory_flush'
  is_compacted: boolean
  created_at: string
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageType = 'message' | 'compaction_summary' | 'memory_flush'

// Evergreen Memory types
export interface EvergreenMemory {
  id: string
  user_id: string
  category: 'fact' | 'preference' | 'relationship' | 'goal'
  content: string
  source: 'manual' | 'profile_extract' | 'conversation_extract'
  confidence: number
  created_at: string
  updated_at: string
}

export type EvergreenCategory = 'fact' | 'preference' | 'relationship' | 'goal'
export type EvergreenSource = 'manual' | 'profile_extract' | 'conversation_extract'

// Knowledge Entry types
export interface KnowledgeEntry {
  id: string
  user_id: string | null
  group_id: string | null
  entry_type: 'episode' | 'event' | 'foresight'
  title: string | null
  content: string
  metadata: Record<string, unknown> | null
  participants: string[] | null
  created_at: string
}

export type EntryType = 'episode' | 'event' | 'foresight'

export interface KnowledgeSearchResult {
  id: string
  entry_type: EntryType
  title: string | null
  content: string
  score: number
  created_at: string
}

export interface KnowledgeCount {
  episode: number
  event: number
  foresight: number
  total: number
}

// Chat Context types
export interface ChatContext {
  evergreen: {
    id: string
    content: string
    category: string
  }[]
  knowledge: {
    id: string
    content: string
    entry_type: string
    score: number
    title: string | null
  }[]
}

// API Log types
export interface ApiLog {
  id: string
  method: string
  url: string
  requestBody?: unknown
  responseBody?: unknown
  status?: number
  duration?: number
  timestamp: number
  error?: string
}

// Admin types
export interface TableInfo {
  name: string
  row_count: number
}

export interface ColumnInfo {
  name: string
  type: string
}

export interface TableDataResponse {
  table_name: string
  columns: ColumnInfo[]
  rows: Record<string, unknown>[]
  total: number
  limit: number
  offset: number
}

// Context Response
export interface ContextResponse {
  evergreen_memories: EvergreenMemory[]
  relevant_knowledge: KnowledgeSearchResult[]
  recent_messages: unknown[]
}

// Memorize types
export interface MemorizeRequest {
  new_raw_data_list: { role: string; content: string }[]
  history_raw_data_list?: { role: string; content: string }[]
  user_id_list?: string[]
  group_id?: string | null
  group_name?: string | null
  scene?: string
}

export interface MemorizeResponse {
  memory_count: number
  status: string
}

// Chat Stream types
export interface ChatStreamCallbacks {
  onToken: (token: string) => void
  onContext: (ctx: ChatContext) => void
  onDone: (messageId: string, tokenCount?: number) => void
  onError: (error: string) => void
}
