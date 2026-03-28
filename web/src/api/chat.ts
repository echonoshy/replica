export interface ChatStreamCallbacks {
  onToken: (token: string) => void
  onDone: (messageId: string) => void
  onError: (error: string) => void
}

export async function chatStream(
  sessionId: string,
  content: string,
  useMemory: boolean,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal,
) {
  const resp = await fetch(`/v1/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, use_memory: useMemory }),
    signal,
  })

  if (!resp.ok) {
    callbacks.onError(`HTTP ${resp.status}`)
    return
  }

  const reader = resp.body?.getReader()
  if (!reader) {
    callbacks.onError('No response body')
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const jsonStr = line.slice(6)
      try {
        const data = JSON.parse(jsonStr)
        if (data.token) {
          callbacks.onToken(data.token)
        } else if (data.done) {
          callbacks.onDone(data.message_id)
        } else if (data.error) {
          callbacks.onError(data.error)
        }
      } catch {
        // skip malformed
      }
    }
  }
}
