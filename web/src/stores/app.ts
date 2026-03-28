import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ApiLog } from '../api/client'

export const useAppStore = defineStore('app', () => {
  const apiLogs = ref<ApiLog[]>([])
  const currentUserId = ref<string | null>(null)
  const currentSessionId = ref<string | null>(null)

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
    currentUserId,
    currentSessionId,
    addApiLog,
    clearApiLogs,
  }
})
