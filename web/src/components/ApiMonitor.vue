<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import { Trash2 } from 'lucide-vue-next'

const app = useAppStore()

const recentLogs = computed(() => app.apiLogs.filter((l) => l.status !== undefined).slice(0, 20))

function statusClass(status?: number) {
  if (!status) return 'status-err'
  if (status < 300) return 'status-ok'
  if (status < 500) return 'status-warn'
  return 'status-err'
}

function methodClass(method: string) {
  const m = method.toUpperCase()
  if (m === 'POST') return 'method-post'
  if (m === 'DELETE') return 'method-delete'
  return 'method-get'
}
</script>

<template>
  <div class="api-monitor">
    <div class="monitor-header">
      <span class="monitor-title">API Monitor</span>
      <button class="btn btn-ghost btn-sm" @click="app.clearApiLogs">
        <Trash2 :size="14" />
      </button>
    </div>
    <div class="monitor-body">
      <div v-if="recentLogs.length === 0" class="empty-state">
        等待 API 请求…
      </div>
      <div v-for="log in recentLogs" :key="log.id" class="log-entry">
        <div class="log-header">
          <span :class="['log-method', methodClass(log.method)]">{{ log.method }}</span>
          <span class="log-url mono">{{ log.url }}</span>
          <span :class="['log-status', statusClass(log.status)]">{{ log.status }}</span>
          <span class="log-duration">{{ log.duration }}ms</span>
        </div>
        <details v-if="log.requestBody" class="log-detail">
          <summary>Request Body</summary>
          <pre class="log-json">{{ JSON.stringify(log.requestBody, null, 2) }}</pre>
        </details>
        <details v-if="log.responseBody" class="log-detail">
          <summary>Response</summary>
          <pre class="log-json">{{ JSON.stringify(log.responseBody, null, 2) }}</pre>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.api-monitor {
  background: var(--bg-card);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.monitor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-primary);
}

.monitor-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.monitor-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.empty-state {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.log-entry {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  margin-bottom: 4px;
}

.log-entry:hover {
  background: var(--bg-hover);
}

.log-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.log-method {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  min-width: 50px;
  text-align: center;
}

.method-get { background: var(--info-muted); color: var(--info); }
.method-post { background: var(--success-muted); color: var(--success); }
.method-delete { background: var(--error-muted); color: var(--error); }

.log-url {
  flex: 1;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-status {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 11px;
}

.status-ok { color: var(--success); }
.status-warn { color: var(--warning); }
.status-err { color: var(--error); }

.log-duration {
  color: var(--text-tertiary);
  font-size: 11px;
  font-family: var(--font-mono);
  min-width: 50px;
  text-align: right;
}

.log-detail {
  margin-top: 6px;
}

.log-detail summary {
  font-size: 11px;
  color: var(--text-tertiary);
  cursor: pointer;
  user-select: none;
}

.log-json {
  margin-top: 4px;
  background: var(--bg-primary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--accent);
  overflow-x: auto;
  max-height: 200px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
