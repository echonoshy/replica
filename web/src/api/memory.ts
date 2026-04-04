import client from './client'

// ---------- Evergreen Memory (Layer 1) ----------

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

export function getEvergreenMemories(userId: string) {
  return client.get<EvergreenMemory[]>(`/v1/users/${userId}/evergreen`)
}

export function createEvergreenMemory(
  userId: string,
  data: { content: string; category: string }
) {
  return client.post<EvergreenMemory>(`/v1/users/${userId}/evergreen`, data)
}

export function deleteEvergreenMemory(memoryId: string) {
  return client.delete(`/v1/evergreen/${memoryId}`)
}

// ---------- Knowledge Search (Layer 3) ----------

export interface KnowledgeSearchResult {
  id: string
  entry_type: 'episode' | 'event' | 'foresight'
  title: string | null
  content: string
  score: number
  created_at: string
}

export function searchKnowledge(data: {
  user_id: string
  query: string
  top_k?: number
  entry_type?: string
}) {
  return client.post<KnowledgeSearchResult[]>('/v1/knowledge/search', data)
}

// ---------- Knowledge List (Admin) ----------

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

export interface KnowledgeCountResponse {
  total: number
  by_type: Record<string, number>
}

export function getUserKnowledge(
  userId: string,
  limit = 50,
  offset = 0,
  entryType?: string,
) {
  return client.get<KnowledgeEntry[]>(`/v1/users/${userId}/knowledge`, {
    params: { limit, offset, ...(entryType ? { entry_type: entryType } : {}) },
  })
}

export function getKnowledgeCount(userId: string) {
  return client.get<{ episode: number; event: number; foresight: number; total: number }>(
    `/v1/users/${userId}/knowledge/count`
  )
}

export function deleteKnowledgeEntry(knowledgeId: string) {
  return client.delete(`/v1/knowledge/${knowledgeId}`)
}

// ---------- Context Build ----------

export interface ContextResponse {
  evergreen_memories: EvergreenMemory[]
  relevant_knowledge: KnowledgeSearchResult[]
  recent_messages: unknown[]
}

export function buildContext(
  userId: string,
  sessionId: string,
  query?: string,
) {
  return client.post<ContextResponse>('/v1/context/build', {
    user_id: userId,
    session_id: sessionId,
    query: query ?? null,
  })
}
