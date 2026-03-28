<script setup lang="ts">
import { ref } from 'vue'
import { getUser, type User } from '../api/users'
import { getSessions, archiveSession, type Session } from '../api/sessions'
import { getMessages, type Message } from '../api/messages'
import TokenProgress from '../components/TokenProgress.vue'
import {
  MessagesSquare,
  RefreshCw,
  Archive,
  ChevronRight,
  Bot,
  User as UserIcon,
  Clock,
} from 'lucide-vue-next'

const userIdInput = ref('')
const user = ref<User | null>(null)
const sessions = ref<Session[]>([])
const selectedSession = ref<Session | null>(null)
const messages = ref<Message[]>([])
const loading = ref(false)
const error = ref('')

async function loadUser() {
  if (!userIdInput.value.trim()) return
  error.value = ''
  loading.value = true
  try {
    const { data } = await getUser(userIdInput.value.trim())
    user.value = data
    await loadSessions()
  } catch (e: any) {
    error.value = e.response?.data?.detail ?? '用户未找到'
    user.value = null
    sessions.value = []
  } finally {
    loading.value = false
  }
}

async function loadSessions() {
  if (!user.value) return
  const { data } = await getSessions(user.value.id)
  sessions.value = data
}

async function selectSession(session: Session) {
  selectedSession.value = session
  const { data } = await getMessages(session.id, 200)
  messages.value = data
}

async function handleArchive(session: Session) {
  await archiveSession(session.id)
  await loadSessions()
  if (selectedSession.value?.id === session.id) {
    selectedSession.value = null
    messages.value = []
  }
}

function statusBadge(status: string) {
  if (status === 'active') return 'badge-success'
  if (status === 'archived') return 'badge-info'
  return 'badge-error'
}

function msgTypeClass(type: string) {
  if (type === 'compaction_summary') return 'msg-compaction'
  if (type === 'memory_flush') return 'msg-flush'
  return ''
}
</script>

<template>
  <div class="sessions-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">Sessions</h1>
        <p class="page-desc">会话列表和消息时间线</p>
      </div>
    </header>

    <div class="user-bar card">
      <MessagesSquare :size="18" class="bar-icon" />
      <input
        v-model="userIdInput"
        class="input"
        placeholder="输入 User ID…"
        @keydown.enter="loadUser"
      />
      <button class="btn btn-primary btn-sm" :disabled="loading" @click="loadUser">
        加载会话
      </button>
    </div>

    <div v-if="error" class="error-msg">{{ error }}</div>

    <template v-if="user">
      <div class="sessions-layout">
        <!-- Left: Session List -->
        <div class="session-list-panel">
          <div class="panel-header">
            <h3>会话列表 ({{ sessions.length }})</h3>
            <button class="btn btn-ghost btn-sm" @click="loadSessions">
              <RefreshCw :size="14" />
            </button>
          </div>

          <div v-if="sessions.length === 0" class="empty-state">暂无会话</div>

          <div
            v-for="s in sessions"
            :key="s.id"
            :class="['session-item card', { selected: selectedSession?.id === s.id }]"
            @click="selectSession(s)"
          >
            <div class="session-item-header">
              <span :class="['badge', statusBadge(s.status)]">{{ s.status }}</span>
              <span class="session-id mono">{{ s.id.slice(0, 8) }}…</span>
            </div>
            <div class="session-item-stats">
              <span class="stat">
                <Clock :size="12" /> {{ new Date(s.created_at).toLocaleString() }}
              </span>
              <span class="stat mono">{{ s.token_count.toLocaleString() }} tokens</span>
              <span v-if="s.compaction_count > 0" class="stat mono">
                {{ s.compaction_count }}x compacted
              </span>
            </div>
            <div class="session-item-actions">
              <button
                v-if="s.status === 'active'"
                class="btn btn-ghost btn-sm"
                @click.stop="handleArchive(s)"
              >
                <Archive :size="13" /> 归档
              </button>
            </div>
          </div>
        </div>

        <!-- Right: Messages Timeline -->
        <div class="message-panel">
          <template v-if="selectedSession">
            <div class="panel-header">
              <h3>
                <ChevronRight :size="16" />
                消息时间线
              </h3>
              <span class="mono" style="font-size:12px; color:var(--text-tertiary)">
                {{ messages.length }} 条消息
              </span>
            </div>

            <TokenProgress
              :current="selectedSession.token_count"
            />

            <div class="message-timeline">
              <div
                v-for="msg in messages"
                :key="msg.id"
                :class="['timeline-msg', `msg-${msg.role}`, msgTypeClass(msg.message_type)]"
              >
                <div class="msg-avatar">
                  <Bot v-if="msg.role === 'assistant'" :size="16" />
                  <UserIcon v-else-if="msg.role === 'user'" :size="16" />
                  <span v-else class="msg-avatar-text">S</span>
                </div>
                <div class="msg-body">
                  <div class="msg-meta">
                    <span class="msg-role">{{ msg.role }}</span>
                    <span
                      v-if="msg.message_type !== 'message'"
                      :class="['badge', msg.message_type === 'compaction_summary' ? 'badge-error' : 'badge-accent']"
                    >
                      {{ msg.message_type }}
                    </span>
                    <span class="msg-time mono">
                      {{ new Date(msg.created_at).toLocaleTimeString() }}
                    </span>
                    <span class="msg-tokens mono">{{ msg.token_count }} tok</span>
                  </div>
                  <div class="msg-content">{{ msg.content }}</div>
                </div>
              </div>
            </div>
          </template>
          <div v-else class="empty-state">
            选择一个会话查看消息
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sessions-page {
  padding: 24px 28px;
  max-width: 1200px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 2px;
}

.page-desc {
  color: var(--text-secondary);
  font-size: 13px;
}

.user-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 12px;
}

.bar-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.error-msg {
  color: var(--error);
  font-size: 13px;
  padding: 8px 0;
}

.sessions-layout {
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 20px;
  margin-top: 12px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-header h3 {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;
}

.session-item {
  padding: 12px 14px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.session-item:hover {
  border-color: var(--text-tertiary);
}

.session-item.selected {
  border-color: var(--accent);
  background: var(--accent-muted);
}

.session-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.session-id {
  font-size: 12px;
  color: var(--text-tertiary);
}

.session-item-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 4px;
}

.stat {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.session-item-actions {
  margin-top: 4px;
}

.message-timeline {
  max-height: calc(100vh - 320px);
  overflow-y: auto;
  padding: 8px 0;
}

.timeline-msg {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  margin-bottom: 4px;
  transition: background 0.1s;
}

.timeline-msg:hover {
  background: var(--bg-hover);
}

.timeline-msg.msg-compaction {
  background: var(--error-muted);
  border-left: 3px solid var(--error);
}

.timeline-msg.msg-flush {
  background: var(--accent-muted);
  border-left: 3px solid var(--accent);
}

.msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
}

.msg-user .msg-avatar {
  background: var(--accent-muted);
  color: var(--accent);
}

.msg-assistant .msg-avatar {
  background: var(--info-muted);
  color: var(--info);
}

.msg-system .msg-avatar,
.msg-tool .msg-avatar {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.msg-body {
  flex: 1;
  min-width: 0;
}

.msg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.msg-role {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.msg-time {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-left: auto;
}

.msg-tokens {
  font-size: 10px;
  color: var(--text-tertiary);
}

.msg-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  word-break: break-word;
}

.empty-state {
  padding: 60px 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
</style>
