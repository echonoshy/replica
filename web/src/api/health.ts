import client from './client'

export function checkHealth() {
  return client.get<{ status: string }>('/health')
}
