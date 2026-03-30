<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { marked } from 'marked'
import { useAppStore } from '../stores/app'
import { chatStream } from '../api/chat'
import { memorizeSession, getSessions } from '../api/sessions'
import { getEvergreenMemories } from '../api/memory'
import TokenProgress from './TokenProgress.vue'
import {
  Send,
  Square,
  Bot,
  User as UserIcon,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Loader2,
  Copy,
  Check,
} from 'lucide-vue-next'

const store = useAppStore()

const msgInput = ref('')
const sending = ref(false)
const streamingText = ref('')
const abortCtrl = ref<AbortController | null>(null)
const useMemory = ref(true)
const memorizing = ref(false)
const memorizeResult = ref<string | null>(null)
const chatContainer = ref<HTMLElement>()
const copiedSessionId = ref(false)

marked.setOptions({ breaks: true, gfm: true })

function renderMd(content: string): string {
  return marked.parse(content) as string
}

const sessionActive = computed(() => store.currentSession?.status === 'active')

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

async function copySessionId() {
  if (!store.currentSession) return
  const text = store.currentSession.id
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      fallbackCopy(text)
    }
    copiedSessionId.value = true
    setTimeout(() => { copiedSessionId.value = false }, 1500)
  } catch {
    if (fallbackCopy(text)) {
      copiedSessionId.value = true
      setTimeout(() => { copiedSessionId.value = false }, 1500)
    }
  }
}

async function handleSend() {
  if (!store.currentSession || !msgInput.value.trim() || sending.value) return
  const content = msgInput.value.trim()
  msgInput.value = ''
  sending.value = true

  store.addMessage({
    id: 'temp-user-' + Date.now(),
    session_id: store.currentSession.id,
    parent_id: null,
    role: 'user',
    content,
    token_count: 0,
    message_type: 'message',
    created_at: new Date().toISOString(),
  })
  scrollToBottom()

  streamingText.value = ''
  const ctrl = new AbortController()
  abortCtrl.value = ctrl

  await chatStream(store.currentSession.id, content, useMemory.value, {
    onToken: (token) => {
      streamingText.value += token
      scrollToBottom()
    },
    onContext: (ctx) => {
      store.setChatContext(ctx)
    },
    onDone: async (messageId, tokenCount) => {
      store.addMessage({
        id: messageId || 'temp-ai-' + Date.now(),
        session_id: store.currentSession!.id,
        parent_id: null,
        role: 'assistant',
        content: streamingText.value,
        token_count: 0,
        message_type: 'message',
        created_at: new Date().toISOString(),
      })
      streamingText.value = ''
      sending.value = false
      abortCtrl.value = null
      if (tokenCount !== undefined) {
        store.updateSessionTokenCount(tokenCount)
      }
    },
    onError: (err) => {
      streamingText.value += `\n[错误: ${err}]`
      sending.value = false
      abortCtrl.value = null
    },
  }, ctrl.signal)
}

function handleStop() {
  abortCtrl.value?.abort()
  if (streamingText.value) {
    store.addMessage({
      id: 'temp-stopped-' + Date.now(),
      session_id: store.currentSession!.id,
      parent_id: null,
      role: 'assistant',
      content: streamingText.value + '\n[已中止]',
      token_count: 0,
      message_type: 'message',
      created_at: new Date().toISOString(),
    })
    streamingText.value = ''
  }
  sending.value = false
  abortCtrl.value = null
}

async function handleMemorize() {
  if (!store.currentSession || memorizing.value) return
  memorizing.value = true
  memorizeResult.value = null
  try {
    const { data } = await memorizeSession(store.currentSession.id)
    memorizeResult.value = `提取完成，生成 ${data.memory_count} 条知识`
    if (store.currentUser) {
      const { data: eg } = await getEvergreenMemories(store.currentUser.id)
      store.setEvergreen(eg)
    }
  } catch (e: any) {
    memorizeResult.value = `提取失败: ${e.response?.data?.detail ?? e.message}`
  } finally {
    memorizing.value = false
    setTimeout(() => { memorizeResult.value = null }, 5000)
  }
}

async function scrollToBottom() {
  await nextTick()
  if (chatContainer.value) {
    chatContainer.value.scrollTop = chatContainer.value.scrollHeight
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

watch(() => store.messages, () => {
  scrollToBottom()
}, { deep: true })
</script>

<template>
  <div class="chat-panel">
    <!-- No session placeholder -->
    <div v-if="!store.hasSession" class="empty-state">
      <div class="empty-icon">
        <Bot :size="48" />
      </div>
      <h2 v-if="store.hasUser">选择或创建会话开始对话</h2>
      <h2 v-else>选择或创建用户</h2>
      <p v-if="!store.hasUser">在左侧栏选择已有用户，或创建新用户开始使用</p>
      <p v-else>在左侧栏点击已有会话，或点击 + 创建新会话</p>
    </div>

    <!-- Chat content -->
    <template v-else>
      <!-- Token bar -->
      <div v-if="store.currentSession" class="token-bar">
        <div class="token-bar-inner">
          <TokenProgress :current="store.currentSession.token_count" />
          <button class="session-id-btn" @click="copySessionId" title="复制 Session ID">
            <span class="mono">{{ store.currentSession.id.slice(0, 12) }}...</span>
            <Check v-if="copiedSessionId" :size="12" class="copied-icon" />
            <Copy v-else :size="12" />
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div ref="chatContainer" class="messages-container">
        <div v-if="store.messages.length === 0 && !streamingText" class="chat-empty">
          <Bot :size="32" class="chat-empty-icon" />
          <p>输入消息，开始对话</p>
        </div>

        <div
          v-for="msg in store.messages"
          :key="msg.id"
          :class="['message', `message-${msg.role}`]"
        >
          <div class="msg-avatar">
            <Bot v-if="msg.role === 'assistant'" :size="16" />
            <UserIcon v-else-if="msg.role === 'user'" :size="16" />
            <span v-else class="avatar-letter">S</span>
          </div>
          <div class="msg-body">
            <div class="msg-header">
              <span class="msg-role">{{ msg.role === 'user' ? '用户' : msg.role === 'assistant' ? 'AI' : msg.role }}</span>
              <span
                v-if="msg.message_type !== 'message'"
                :class="['badge', msg.message_type === 'compaction_summary' ? 'badge-error' : 'badge-info']"
              >
                {{ msg.message_type }}
              </span>
            </div>
            <div
              v-if="msg.role === 'assistant'"
              class="msg-content markdown-body"
              v-html="renderMd(msg.content)"
            />
            <div v-else class="msg-content">{{ msg.content }}</div>
          </div>
        </div>

        <!-- Streaming -->
        <div v-if="streamingText" class="message message-assistant">
          <div class="msg-avatar streaming-avatar">
            <Bot :size="16" />
          </div>
          <div class="msg-body">
            <div class="msg-header">
              <span class="msg-role">AI</span>
              <span class="badge badge-accent">生成中...</span>
            </div>
            <div class="msg-content markdown-body" v-html="renderMd(streamingText)" />
            <span class="cursor-blink">▍</span>
          </div>
        </div>
      </div>

      <!-- Toolbar -->
      <div class="toolbar">
        <div class="toolbar-left">
          <button
            :class="['tool-btn', { active: useMemory }]"
            @click="useMemory = !useMemory"
            title="记忆注入"
          >
            <component :is="useMemory ? ToggleRight : ToggleLeft" :size="15" />
            <span>记忆 {{ useMemory ? 'ON' : 'OFF' }}</span>
          </button>
        </div>
        <div class="toolbar-right">
          <button
            v-if="sessionActive"
            class="tool-btn"
            :disabled="memorizing || store.messages.length === 0"
            @click="handleMemorize"
            title="将当前对话提取为知识"
          >
            <Loader2 v-if="memorizing" :size="14" class="spin" />
            <Sparkles v-else :size="14" />
            <span>提取记忆</span>
          </button>
        </div>
      </div>

      <!-- Memorize result toast -->
      <div v-if="memorizeResult" class="memorize-toast">
        {{ memorizeResult }}
      </div>

      <!-- Input area -->
      <div class="input-area">
        <textarea
          v-model="msgInput"
          class="chat-textarea"
          placeholder="输入消息，按 Enter 发送..."
          :disabled="!sessionActive"
          @keydown="onKeydown"
        />
        <button
          v-if="sending"
          class="send-btn stop"
          @click="handleStop"
        >
          <Square :size="16" />
        </button>
        <button
          v-else
          class="send-btn"
          :disabled="!sessionActive || !msgInput.trim()"
          @click="handleSend"
        >
          <Send :size="16" />
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 0;
  background: var(--bg-primary);
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-tertiary);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}

.empty-state h2 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-secondary);
}

.empty-state p {
  font-size: 14px;
}

.token-bar {
  padding: 0 24px;
  border-bottom: 1px solid var(--border-subtle);
}

.token-bar-inner {
  display: flex;
  align-items: center;
  gap: 12px;
}

.session-id-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-tertiary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.session-id-btn:hover {
  border-color: var(--border-primary);
  color: var(--text-secondary);
}

.copied-icon {
  color: var(--success);
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--text-tertiary);
}

.chat-empty-icon {
  opacity: 0.3;
}

.message {
  display: flex;
  gap: 12px;
  padding: 14px 0;
}

.message + .message {
  border-top: 1px solid var(--border-subtle);
}

.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.message-user .msg-avatar {
  background: var(--accent-muted);
  color: var(--accent);
}

.message-assistant .msg-avatar {
  background: var(--info-muted);
  color: var(--info);
}

.message-system .msg-avatar {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.avatar-letter {
  font-size: 12px;
  font-weight: 600;
}

.streaming-avatar {
  animation: pulse-glow 1.5s ease-in-out infinite;
}

@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(74, 127, 191, 0.3); }
  50% { box-shadow: 0 0 8px 2px rgba(74, 127, 191, 0.3); }
}

.msg-body {
  flex: 1;
  min-width: 0;
}

.msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.msg-role {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.msg-content {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
  word-break: break-word;
}

.msg-content:not(.markdown-body) {
  white-space: pre-wrap;
}

.cursor-blink {
  animation: blink 0.8s step-end infinite;
  color: var(--accent);
  font-size: 14px;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* Markdown styles */
:deep(.markdown-body) {
  font-size: 14px;
  line-height: 1.7;
}

:deep(.markdown-body p) {
  margin-bottom: 8px;
}

:deep(.markdown-body p:last-child) {
  margin-bottom: 0;
}

:deep(.markdown-body code) {
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 13px;
}

:deep(.markdown-body pre) {
  background: var(--bg-tertiary);
  padding: 12px 16px;
  border-radius: var(--radius-md);
  overflow-x: auto;
  margin: 8px 0;
}

:deep(.markdown-body pre code) {
  background: none;
  padding: 0;
  font-size: 12px;
}

:deep(.markdown-body ul),
:deep(.markdown-body ol) {
  padding-left: 20px;
  margin: 8px 0;
}

:deep(.markdown-body li) {
  margin-bottom: 4px;
}

:deep(.markdown-body blockquote) {
  border-left: 3px solid var(--border-primary);
  padding-left: 12px;
  color: var(--text-secondary);
  margin: 8px 0;
}

:deep(.markdown-body h1),
:deep(.markdown-body h2),
:deep(.markdown-body h3) {
  margin: 12px 0 6px;
  font-weight: 600;
}

:deep(.markdown-body h1) { font-size: 18px; }
:deep(.markdown-body h2) { font-size: 16px; }
:deep(.markdown-body h3) { font-size: 15px; }

:deep(.markdown-body table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
}

:deep(.markdown-body th),
:deep(.markdown-body td) {
  border: 1px solid var(--border-primary);
  padding: 6px 10px;
  font-size: 13px;
}

:deep(.markdown-body th) {
  background: var(--bg-tertiary);
  font-weight: 600;
}

/* Toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 24px;
  border-top: 1px solid var(--border-subtle);
}

.toolbar-left,
.toolbar-right {
  display: flex;
  gap: 4px;
}

.tool-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  background: none;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.tool-btn:hover {
  background: var(--bg-hover);
  border-color: var(--text-tertiary);
}

.tool-btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-muted);
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.memorize-toast {
  padding: 6px 24px;
  font-size: 12px;
  color: var(--success);
  background: var(--success-muted);
  text-align: center;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Input */
.input-area {
  display: flex;
  gap: 8px;
  padding: 12px 24px 16px;
  align-items: flex-end;
  border-top: 1px solid var(--border-primary);
  background: var(--bg-secondary);
}

.chat-textarea {
  flex: 1;
  resize: none;
  min-height: 44px;
  max-height: 150px;
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  font-size: 14px;
  font-family: var(--font-sans);
  outline: none;
  transition: border-color 0.15s;
}

.chat-textarea:focus {
  border-color: var(--border-focus);
}

.chat-textarea::placeholder {
  color: var(--text-tertiary);
}

.chat-textarea:disabled {
  opacity: 0.5;
}

.send-btn {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-lg);
  border: none;
  background: var(--accent);
  color: var(--text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}

.send-btn:hover {
  background: var(--accent-hover);
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.send-btn.stop {
  background: var(--error);
}

.send-btn.stop:hover {
  background: #c82333;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
