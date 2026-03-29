import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '../api/users'
import type { Session } from '../api/sessions'
import type { EvergreenMemory } from '../api/memory'
import type { Message } from '../api/messages'
import type { ApiLog } from '../api/client'

export interface ChatContext {
  evergreen: { id: string; content: string; category: string }[]
  knowledge: { id: string; content: string; entry_type: string; score: number; title: string | null }[]
}

export const useAppStore = defineStore('app', () => {
  const apiLogs = ref<ApiLog[]>([])

  const users = ref<User[]>([])
  const currentUser = ref<User | null>(null)
  const sessions = ref<Session[]>([])
  const currentSession = ref<Session | null>(null)
  const messages = ref<Message[]>([])
  const evergreen = ref<EvergreenMemory[]>([])
  const chatContext = ref<ChatContext | null>(null)

  const hasUser = computed(() => currentUser.value !== null)
  const hasSession = computed(() => currentSession.value !== null)

  function setUsers(list: User[]) {
    users.value = list
  }

  function setCurrentUser(user: User | null) {
    currentUser.value = user
    sessions.value = []
    currentSession.value = null
    messages.value = []
    evergreen.value = []
    chatContext.value = null
  }

  function setSessions(list: Session[]) {
    sessions.value = list
  }

  function setCurrentSession(session: Session | null) {
    currentSession.value = session
    messages.value = []
    chatContext.value = null
  }

  function updateSessionTokenCount(count: number) {
    if (currentSession.value) {
      currentSession.value = { ...currentSession.value, token_count: count }
    }
  }

  function setMessages(list: Message[]) {
    messages.value = list
  }

  function addMessage(msg: Message) {
    messages.value = [...messages.value, msg]
  }

  function setEvergreen(list: EvergreenMemory[]) {
    evergreen.value = list
  }

  function setChatContext(ctx: ChatContext | null) {
    chatContext.value = ctx
  }

  function addApiLog(log: ApiLog) {
    const idx = apiLogs.value.findIndex((l) => l.id === log.id)
    if (idx >= 0) {
      apiLogs.value[idx] = log
    } else {
      apiLogs.value.unshift(log)
    }
    if (apiLogs.value.length > 50) {
      apiLogs.value = apiLogs.value.slice(0, 50)
    }
  }

  function clearApiLogs() {
    apiLogs.value = []
  }

  return {
    apiLogs,
    users,
    currentUser,
    sessions,
    currentSession,
    messages,
    evergreen,
    chatContext,
    hasUser,
    hasSession,
    setUsers,
    setCurrentUser,
    setSessions,
    setCurrentSession,
    updateSessionTokenCount,
    setMessages,
    addMessage,
    setEvergreen,
    setChatContext,
    addApiLog,
    clearApiLogs,
  }
})
