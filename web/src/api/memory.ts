import client from './client'

export interface MemoryNote {
  id: string
  user_id: string
  session_id: string | null
  note_type: 'evergreen' | 'daily'
  content: string
  source: string
  created_at: string
}

export interface SearchResult {
  chunk_text: string
  note_id: string
  score: number
  created_at: string
}

export interface ContextResponse {
  evergreen_memories: MemoryNote[]
  relevant_memories: SearchResult[]
  recent_messages: unknown[]
}

export function createMemory(userId: string, content: string, noteType: string = 'evergreen') {
  return client.post<MemoryNote>(`/v1/users/${userId}/memory`, {
    content,
    note_type: noteType,
  })
}

export function getMemories(userId: string) {
  return client.get<MemoryNote[]>(`/v1/users/${userId}/memory`)
}

export function deleteMemory(noteId: string) {
  return client.delete(`/v1/memory/${noteId}`)
}

export function searchMemory(userId: string, query: string, topK = 5, noteType?: string) {
  return client.post<SearchResult[]>('/v1/memory/search', {
    user_id: userId,
    query,
    top_k: topK,
    note_type: noteType ?? null,
  })
}

export function buildContext(userId: string, sessionId: string, query?: string) {
  return client.post<ContextResponse>('/v1/context/build', {
    user_id: userId,
    session_id: sessionId,
    query: query ?? null,
  })
}
