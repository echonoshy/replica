import client from './client'

export interface Session {
  id: string
  user_id: string
  status: 'active' | 'deleted'
  token_count: number
  compaction_count: number
  created_at: string
  last_extraction_at?: string | null
}

export function createSession(userId: string, metadata?: Record<string, unknown>) {
  return client.post<Session>(`/v1/users/${userId}/sessions`, { metadata })
}

export function getSessions(userId: string) {
  return client.get<Session[]>(`/v1/users/${userId}/sessions`)
}

export function getSession(sessionId: string) {
  return client.get<Session>(`/v1/sessions/${sessionId}`)
}

export function deleteSession(sessionId: string) {
  return client.delete(`/v1/sessions/${sessionId}`)
}

export function extractMemory(sessionId: string) {
  return client.post<{ memory_count: number }>(
    `/v1/sessions/${sessionId}/extract-memory`,
    {},
    { timeout: 300000 }
  )
}

export function compactSession(sessionId: string) {
  return client.post<{ task_id: string; status: string; message: string }>(
    `/v1/sessions/${sessionId}/compact`,
  )
}

export function getTaskStatus(taskId: string) {
  return client.get<{
    task_id: string
    task_type: string
    session_id: string | null
    status: 'pending' | 'processing' | 'completed' | 'failed'
    created_at: string
    started_at: string | null
    completed_at: string | null
    result: {
      compacted_count: number
      summary_count: number
      token_reduction: number
      compression_ratio: string
      old_token_count: number
      new_token_count: number
    } | null
    error: string | null
  }>(`/v1/tasks/${taskId}`)
}

export function getCompactionConfig() {
  return client.get<{ hard_threshold_tokens: number; keep_recent_tokens: number }>(
    '/v1/config/compaction',
  )
}
