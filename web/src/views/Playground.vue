<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { createUser } from '../api/users'
import { createSession, archiveSession } from '../api/sessions'
import { sendMessage, getMessages, type Message } from '../api/messages'
import { createMemory, searchMemory, type SearchResult } from '../api/memory'
import { buildContext, type ContextResponse } from '../api/memory'
import ApiMonitor from '../components/ApiMonitor.vue'
import TokenProgress from '../components/TokenProgress.vue'
import JsonViewer from '../components/JsonViewer.vue'
import {
  UserPlus,
  MessageSquarePlus,
  Send,
  Search,
  Layers,
  Archive,
  BookPlus,
  ChevronRight,
  Bot,
  User as UserIcon,
} from 'lucide-vue-next'

const userId = ref('')
const sessionId = ref('')
const tokenCount = ref(0)
const messages = ref<Message[]>([])
const msgInput = ref('')
const msgRole = ref<'user' | 'assistant'>('user')
const sending = ref(false)

const searchQuery = ref('')
const searchResults = ref<SearchResult[]>([])
const searching = ref(false)

const contextQuery = ref('')
const contextResult = ref<ContextResponse | null>(null)
const buildingCtx = ref(false)

const memoryContent = ref('')
const memoryType = ref<'evergreen' | 'daily'>('evergreen')

const activeTab = ref<'monitor' | 'search' | 'context'>('monitor')
const chatContainer = ref<HTMLElement>()

const currentStep = computed(() => {
  if (!userId.value) return 0
  if (!sessionId.value) return 1
  return 2
})

async function handleCreateUser() {
  const extId = 'demo-' + Date.now().toString(36)
  const { data } = await createUser(extId, { name: 'Demo User', source: 'playground' })
  userId.value = data.id
}

async function handleCreateSession() {
  if (!userId.value) return
  const { data } = await createSession(userId.value, { topic: 'Playground Demo' })
  sessionId.value = data.id
  tokenCount.value = data.token_count
}

async function handleSend() {
  if (!sessionId.value || !msgInput.value.trim() || sending.value) return
  sending.value = true
  try {
    await sendMessage(sessionId.value, msgRole.value, msgInput.value.trim())
    msgInput.value = ''
    await refreshMessages()
  } finally {
    sending.value = false
  }
}

async function refreshMessages() {
  if (!sessionId.value) return
  const { data } = await getMessages(sessionId.value, 100)
  messages.value = data
  tokenCount.value = data.reduce((sum, m) => sum + m.token_count, 0)
  await nextTick()
  if (chatContainer.value) {
    chatContainer.value.scrollTop = chatContainer.value.scrollHeight
  }
}

async function handleCreateMemory() {
  if (!userId.value || !memoryContent.value.trim()) return
  await createMemory(userId.value, memoryContent.value.trim(), memoryType.value)
  memoryContent.value = ''
}

async function handleSearch() {
  if (!userId.value || !searchQuery.value.trim()) return
  searching.value = true
  try {
    const { data } = await searchMemory(userId.value, searchQuery.value.trim())
    searchResults.value = data
    activeTab.value = 'search'
  } finally {
    searching.value = false
  }
}

async function handleBuildContext() {
  if (!userId.value || !sessionId.value) return
  buildingCtx.value = true
  try {
    const { data } = await buildContext(userId.value, sessionId.value, contextQuery.value || undefined)
    contextResult.value = data
    activeTab.value = 'context'
  } finally {
    buildingCtx.value = false
  }
}

async function handleArchive() {
  if (!sessionId.value) return
  await archiveSession(sessionId.value)
  sessionId.value = ''
  messages.value = []
  tokenCount.value = 0
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <div class="playground">
    <div class="play-left">
      <header class="page-header">
        <h1 class="page-title">Playground</h1>
        <p class="page-desc">交互式端到端演示</p>
      </header>

      <!-- Step 0: Create User -->
      <div class="step-card card" :class="{ completed: currentStep > 0 }">
        <div class="step-header">
          <div class="step-num">1</div>
          <div class="step-info">
            <h3>创建用户</h3>
            <p v-if="userId" class="step-result mono">
              User ID: {{ userId.slice(0, 8) }}…
            </p>
          </div>
          <button v-if="!userId" class="btn btn-primary btn-sm" @click="handleCreateUser">
            <UserPlus :size="14" /> 创建
          </button>
          <span v-else class="badge badge-success">✓ 完成</span>
        </div>
      </div>

      <!-- Step 1: Create Session -->
      <div class="step-card card" :class="{ completed: currentStep > 1, disabled: currentStep < 1 }">
        <div class="step-header">
          <div class="step-num">2</div>
          <div class="step-info">
            <h3>创建会话</h3>
            <p v-if="sessionId" class="step-result mono">
              Session ID: {{ sessionId.slice(0, 8) }}…
            </p>
          </div>
          <button
            v-if="!sessionId"
            class="btn btn-primary btn-sm"
            :disabled="currentStep < 1"
            @click="handleCreateSession"
          >
            <MessageSquarePlus :size="14" /> 创建
          </button>
          <span v-else class="badge badge-success">✓ 活跃</span>
        </div>
      </div>

      <!-- Step 2: Chat -->
      <div class="chat-section card" :class="{ disabled: currentStep < 2 }">
        <div class="chat-head">
          <h3>
            <ChevronRight :size="16" /> 发送消息
          </h3>
          <TokenProgress v-if="sessionId" :current="tokenCount" />
        </div>

        <div ref="chatContainer" class="chat-messages">
          <div v-if="messages.length === 0" class="chat-empty">
            还没有消息，开始对话吧
          </div>
          <div
            v-for="msg in messages"
            :key="msg.id"
            :class="['chat-msg', `chat-msg-${msg.role}`]"
          >
            <div class="msg-avatar">
              <Bot v-if="msg.role === 'assistant'" :size="16" />
              <UserIcon v-else :size="16" />
            </div>
            <div class="msg-body">
              <div class="msg-meta">
                <span class="msg-role">{{ msg.role }}</span>
                <span v-if="msg.message_type !== 'message'" class="badge badge-info">
                  {{ msg.message_type }}
                </span>
                <span class="msg-tokens mono">{{ msg.token_count }} tokens</span>
              </div>
              <div class="msg-content">{{ msg.content }}</div>
            </div>
          </div>
        </div>

        <div class="chat-input-area">
          <select v-model="msgRole" class="input role-select">
            <option value="user">user</option>
            <option value="assistant">assistant</option>
          </select>
          <textarea
            v-model="msgInput"
            class="input chat-textarea"
            placeholder="输入消息内容…"
            :disabled="currentStep < 2"
            @keydown="onKeydown"
          />
          <button
            class="btn btn-primary"
            :disabled="currentStep < 2 || !msgInput.trim() || sending"
            @click="handleSend"
          >
            <Send :size="14" />
          </button>
        </div>
      </div>

      <!-- Actions -->
      <div class="actions-row">
        <div class="action-group card">
          <h4><BookPlus :size="14" /> 创建记忆</h4>
          <div class="action-form">
            <select v-model="memoryType" class="input" style="width: 120px">
              <option value="evergreen">Evergreen</option>
              <option value="daily">Daily</option>
            </select>
            <input
              v-model="memoryContent"
              class="input"
              placeholder="记忆内容…"
              :disabled="!userId"
            />
            <button
              class="btn btn-primary btn-sm"
              :disabled="!userId || !memoryContent.trim()"
              @click="handleCreateMemory"
            >
              添加
            </button>
          </div>
        </div>

        <div class="action-group card">
          <h4><Search :size="14" /> 搜索记忆</h4>
          <div class="action-form">
            <input
              v-model="searchQuery"
              class="input"
              placeholder="搜索查询…"
              :disabled="!userId"
              @keydown.enter="handleSearch"
            />
            <button
              class="btn btn-primary btn-sm"
              :disabled="!userId || !searchQuery.trim() || searching"
              @click="handleSearch"
            >
              搜索
            </button>
          </div>
        </div>

        <div class="action-group card">
          <h4><Layers :size="14" /> 构建上下文</h4>
          <div class="action-form">
            <input
              v-model="contextQuery"
              class="input"
              placeholder="上下文查询（可选）…"
              :disabled="!sessionId"
            />
            <button
              class="btn btn-primary btn-sm"
              :disabled="!sessionId || buildingCtx"
              @click="handleBuildContext"
            >
              构建
            </button>
          </div>
        </div>
      </div>

      <div v-if="sessionId" class="archive-bar">
        <button class="btn btn-danger btn-sm" @click="handleArchive">
          <Archive :size="14" /> 归档会话
        </button>
      </div>
    </div>

    <div class="play-right">
      <div class="tab-bar">
        <button
          :class="['tab-btn', { active: activeTab === 'monitor' }]"
          @click="activeTab = 'monitor'"
        >
          API Monitor
        </button>
        <button
          :class="['tab-btn', { active: activeTab === 'search' }]"
          @click="activeTab = 'search'"
        >
          搜索结果
        </button>
        <button
          :class="['tab-btn', { active: activeTab === 'context' }]"
          @click="activeTab = 'context'"
        >
          上下文
        </button>
      </div>

      <div class="tab-content">
        <ApiMonitor v-if="activeTab === 'monitor'" />

        <div v-else-if="activeTab === 'search'" class="result-panel">
          <div v-if="searchResults.length === 0" class="empty-state">
            暂无搜索结果
          </div>
          <div v-for="(r, i) in searchResults" :key="i" class="search-hit card">
            <div class="hit-header">
              <span class="badge badge-accent">Score: {{ r.score.toFixed(3) }}</span>
              <span class="mono" style="font-size:11px; color:var(--text-tertiary)">
                {{ r.note_id.slice(0, 8) }}…
              </span>
            </div>
            <p class="hit-text">{{ r.chunk_text }}</p>
          </div>
        </div>

        <div v-else-if="activeTab === 'context'" class="result-panel">
          <div v-if="!contextResult" class="empty-state">
            暂无上下文数据
          </div>
          <template v-else>
            <h4 class="ctx-section-title">Evergreen Memories ({{ contextResult.evergreen_memories.length }})</h4>
            <div v-for="m in contextResult.evergreen_memories" :key="m.id" class="ctx-item card">
              {{ m.content }}
            </div>

            <h4 class="ctx-section-title">Relevant Memories ({{ contextResult.relevant_memories.length }})</h4>
            <div v-for="(r, i) in contextResult.relevant_memories" :key="i" class="ctx-item card">
              <span class="badge badge-accent" style="margin-right:8px">{{ r.score.toFixed(3) }}</span>
              {{ r.chunk_text }}
            </div>

            <h4 class="ctx-section-title">Recent Messages ({{ contextResult.recent_messages.length }})</h4>
            <JsonViewer :data="contextResult.recent_messages" max-height="300px" />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.playground {
  display: flex;
  height: 100vh;
}

.play-left {
  flex: 1;
  padding: 24px 28px;
  overflow-y: auto;
  border-right: 1px solid var(--border-primary);
}

.play-right {
  width: 420px;
  min-width: 420px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
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

/* Steps */
.step-card {
  margin-bottom: 10px;
  padding: 14px 18px;
  transition: all 0.2s ease;
}

.step-card.disabled {
  opacity: 0.4;
  pointer-events: none;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 14px;
}

.step-num {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg-hover);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 13px;
  flex-shrink: 0;
}

.step-card.completed .step-num {
  background: var(--accent-muted);
  color: var(--accent);
}

.step-info {
  flex: 1;
}

.step-info h3 {
  font-size: 14px;
  font-weight: 600;
}

.step-result {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

/* Chat */
.chat-section {
  margin-bottom: 16px;
  padding: 16px;
}

.chat-section.disabled {
  opacity: 0.4;
  pointer-events: none;
}

.chat-head {
  margin-bottom: 12px;
}

.chat-head h3 {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.chat-messages {
  max-height: 350px;
  overflow-y: auto;
  margin-bottom: 12px;
  padding: 8px;
  background: var(--bg-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}

.chat-empty {
  padding: 40px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.chat-msg {
  display: flex;
  gap: 10px;
  padding: 8px 0;
}

.chat-msg + .chat-msg {
  border-top: 1px solid var(--border-subtle);
}

.msg-avatar {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.chat-msg-user .msg-avatar {
  background: var(--accent-muted);
  color: var(--accent);
}

.chat-msg-assistant .msg-avatar {
  background: var(--info-muted);
  color: var(--info);
}

.chat-msg-system .msg-avatar {
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

.msg-tokens {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-left: auto;
}

.msg-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  word-break: break-word;
}

.chat-input-area {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.role-select {
  width: 110px;
  flex-shrink: 0;
}

.chat-textarea {
  flex: 1;
  resize: none;
  min-height: 38px;
  max-height: 100px;
}

/* Actions */
.actions-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

.action-group {
  padding: 14px 16px;
}

.action-group h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--text-secondary);
}

.action-form {
  display: flex;
  gap: 8px;
  align-items: center;
}

.action-form .input {
  flex: 1;
}

.archive-bar {
  padding: 8px 0;
}

/* Right panel tabs */
.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border-primary);
  padding: 0 12px;
}

.tab-btn {
  padding: 10px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-tertiary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-btn:hover {
  color: var(--text-secondary);
}

.tab-btn.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.tab-content {
  flex: 1;
  overflow-y: auto;
}

.result-panel {
  padding: 12px;
}

.search-hit {
  margin-bottom: 8px;
  padding: 12px;
}

.hit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.hit-text {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.6;
}

.ctx-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 16px 0 8px;
}

.ctx-section-title:first-child {
  margin-top: 0;
}

.ctx-item {
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 6px;
}

.empty-state {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
</style>
