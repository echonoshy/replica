import { create } from 'zustand'
import type {
  User,
  Session,
  Message,
  EvergreenMemory,
  ChatContext,
  ApiLog,
} from '@/types'

interface AppState {
  // State
  apiLogs: ApiLog[]
  users: User[]
  currentUser: User | null
  sessions: Session[]
  currentSession: Session | null
  messages: Message[]
  evergreen: EvergreenMemory[]
  chatContext: ChatContext | null

  // Computed
  hasUser: () => boolean
  hasSession: () => boolean

  // Actions
  setUsers: (users: User[]) => void
  setCurrentUser: (user: User | null) => void
  setSessions: (sessions: Session[]) => void
  setCurrentSession: (session: Session | null) => void
  updateCurrentSession: (session: Session) => void
  updateSessionTokenCount: (count: number) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  loadMessages: (sessionId: string, includeCompacted: boolean) => Promise<void>
  setEvergreen: (evergreen: EvergreenMemory[]) => void
  setChatContext: (context: ChatContext | null) => void
  addApiLog: (log: ApiLog) => void
  clearApiLogs: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  apiLogs: [],
  users: [],
  currentUser: null,
  sessions: [],
  currentSession: null,
  messages: [],
  evergreen: [],
  chatContext: null,

  // Computed properties
  hasUser: () => get().currentUser !== null,
  hasSession: () => get().currentSession !== null,

  // Actions
  setUsers: (users) => set({ users }),

  setCurrentUser: (user) =>
    set({
      currentUser: user,
      sessions: [],
      currentSession: null,
      messages: [],
      evergreen: [],
      chatContext: null,
    }),

  setSessions: (sessions) => set({ sessions }),

  setCurrentSession: (session) =>
    set({
      currentSession: session,
      messages: [],
      chatContext: null,
    }),

  updateCurrentSession: (session) =>
    set((state) => ({
      currentSession: session,
      sessions: state.sessions.map((s) => (s.id === session.id ? session : s)),
    })),

  updateSessionTokenCount: (count) => {
    const { currentSession } = get()
    if (currentSession) {
      set({
        currentSession: { ...currentSession, token_count: count },
      })
    }
  },

  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  loadMessages: async (sessionId, includeCompacted) => {
    const { getMessages } = await import('@/api/messages')
    const { data } = await getMessages(sessionId, 200, 0, includeCompacted)
    set({ messages: data })
  },

  setEvergreen: (evergreen) => set({ evergreen }),

  setChatContext: (chatContext) => set({ chatContext }),

  addApiLog: (log) =>
    set((state) => {
      const logs = state.apiLogs
      const existingIndex = logs.findIndex((l) => l.id === log.id)
      if (existingIndex >= 0) {
        const updated = [...logs]
        updated[existingIndex] = log
        return { apiLogs: updated }
      }
      const newLogs = [log, ...logs].slice(0, 50)
      return { apiLogs: newLogs }
    }),

  clearApiLogs: () => set({ apiLogs: [] }),
}))
