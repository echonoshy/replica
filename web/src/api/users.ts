import client from './client'

export interface User {
  id: string
  external_id: string
  metadata: Record<string, unknown> | null
  created_at: string
}

export function createUser(external_id: string, metadata?: Record<string, unknown>) {
  return client.post<User>('/v1/users', { external_id, metadata })
}

export function getUser(userId: string) {
  return client.get<User>(`/v1/users/${userId}`)
}
