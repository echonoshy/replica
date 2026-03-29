import client from './client'

export interface Session {
  id: string
  user_id: string
  status: 'active' | 'archived' | 'deleted'
  token_count: number
  compaction_count: number
  created_at: string
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

export function archiveSession(sessionId: string) {
  return client.post<Session>(`/v1/sessions/${sessionId}/archive`)
}

export function memorizeSession(sessionId: string) {
  return client.post<{ memory_count: number; status: string }>(
    `/v1/sessions/${sessionId}/memorize`,
    {},
    { timeout: 300000 },
  )
}
