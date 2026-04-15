import axios, { type InternalAxiosRequestConfig } from "axios";

const client = axios.create({
  baseURL: "",
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

export interface ApiLog {
  id: string;
  method: string;
  url: string;
  requestBody?: unknown;
  responseBody?: unknown;
  status?: number;
  duration?: number;
  timestamp: number;
  error?: string;
}

type ApiLogCallback = (log: ApiLog) => void;

let logCallback: ApiLogCallback | null = null;
let logIdCounter = 0;

export function onApiLog(cb: ApiLogCallback) {
  logCallback = cb;
}

export function registerApiLogListener(cb: ApiLogCallback) {
  logCallback = cb;
}

interface CustomAxiosRequestConfig extends InternalAxiosRequestConfig {
  _logId?: string;
  _startTime?: number;
}

client.interceptors.request.use((config: CustomAxiosRequestConfig) => {
  const id = `req-${++logIdCounter}`;
  config._logId = id;
  config._startTime = Date.now();

  if (logCallback) {
    logCallback({
      id,
      method: (config.method ?? "GET").toUpperCase(),
      url: config.url ?? "",
      requestBody: config.data,
      timestamp: Date.now(),
    });
  }
  return config;
});

client.interceptors.response.use(
  (response) => {
    if (logCallback) {
      const config = response.config as CustomAxiosRequestConfig;
      logCallback({
        id: config._logId ?? "",
        method: (config.method ?? "GET").toUpperCase(),
        url: config.url ?? "",
        requestBody: config.data ? JSON.parse(config.data as string) : undefined,
        responseBody: response.data,
        status: response.status,
        duration: config._startTime ? Date.now() - config._startTime : undefined,
        timestamp: Date.now(),
      });
    }
    return response;
  },
  (error) => {
    if (logCallback && error.config) {
      const config = error.config as CustomAxiosRequestConfig;
      logCallback({
        id: config._logId ?? "",
        method: (config.method ?? "GET").toUpperCase(),
        url: config.url ?? "",
        requestBody: config.data ? JSON.parse(config.data as string) : undefined,
        responseBody: error.response?.data,
        status: error.response?.status,
        duration: config._startTime ? Date.now() - config._startTime : undefined,
        timestamp: Date.now(),
        error: error.message,
      });
    }
    return Promise.reject(error);
  },
);

export default client;
