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
  content: string,
  category: string = 'fact',
) {
  return client.post<EvergreenMemory>(`/v1/users/${userId}/evergreen`, {
    content,
    category,
  })
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

export function searchKnowledge(
  userId: string,
  query: string,
  topK = 10,
  entryType?: string,
) {
  return client.post<KnowledgeSearchResult[]>('/v1/knowledge/search', {
    user_id: userId,
    query,
    top_k: topK,
    entry_type: entryType ?? null,
  })
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
