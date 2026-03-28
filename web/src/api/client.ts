import axios from 'axios'

const client = axios.create({
  baseURL: '',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

export interface ApiLog {
  id: string
  method: string
  url: string
  requestBody?: unknown
  responseBody?: unknown
  status?: number
  duration?: number
  timestamp: number
  error?: string
}

type ApiLogCallback = (log: ApiLog) => void

let logCallback: ApiLogCallback | null = null
let logIdCounter = 0

export function onApiLog(cb: ApiLogCallback) {
  logCallback = cb
}

client.interceptors.request.use((config) => {
  const id = `req-${++logIdCounter}`
  ;(config as any)._logId = id
  ;(config as any)._startTime = Date.now()

  if (logCallback) {
    logCallback({
      id,
      method: (config.method ?? 'GET').toUpperCase(),
      url: config.url ?? '',
      requestBody: config.data,
      timestamp: Date.now(),
    })
  }
  return config
})

client.interceptors.response.use(
  (response) => {
    if (logCallback) {
      const config = response.config as any
      logCallback({
        id: config._logId,
        method: (config.method ?? 'GET').toUpperCase(),
        url: config.url ?? '',
        requestBody: config.data ? JSON.parse(config.data) : undefined,
        responseBody: response.data,
        status: response.status,
        duration: Date.now() - config._startTime,
        timestamp: Date.now(),
      })
    }
    return response
  },
  (error) => {
    if (logCallback && error.config) {
      const config = error.config as any
      logCallback({
        id: config._logId,
        method: (config.method ?? 'GET').toUpperCase(),
        url: config.url ?? '',
        requestBody: config.data ? JSON.parse(config.data) : undefined,
        responseBody: error.response?.data,
        status: error.response?.status,
        duration: Date.now() - config._startTime,
        timestamp: Date.now(),
        error: error.message,
      })
    }
    return Promise.reject(error)
  },
)

export default client
