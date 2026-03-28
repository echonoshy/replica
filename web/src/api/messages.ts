import client from './client'

export interface Message {
  id: string
  session_id: string
  parent_id: string | null
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  token_count: number
  message_type: 'message' | 'compaction_summary' | 'memory_flush'
  created_at: string
}

export function sendMessage(
  sessionId: string,
  role: string,
  content: string,
  messageType: string = 'message',
) {
  return client.post<Message>(`/v1/sessions/${sessionId}/messages`, {
    role,
    content,
    message_type: messageType,
  })
}

export function getMessages(sessionId: string, limit = 50, offset = 0) {
  return client.get<Message[]>(`/v1/sessions/${sessionId}/messages`, {
    params: { limit, offset },
  })
}
