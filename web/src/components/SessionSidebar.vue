<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAppStore } from '../stores/app'
import { listUsers, createUser, getUser, deleteUser } from '../api/users'
import { getSessions, createSession, getSession, deleteSession } from '../api/sessions'
import { getEvergreenMemories } from '../api/memory'
import { getMessages } from '../api/messages'
import {
  Plus,
  Search,
  Settings,
  Clock,
  MessageSquare,
  ChevronDown,
  LogIn,
  Copy,
  Check,
  Trash2,
} from 'lucide-vue-next'

const store = useAppStore()

const showCreateUser = ref(false)
const newExternalId = ref('')
const newUserName = ref('')
const creatingUser = ref(false)
const userSearchId = ref('')
const searchingUser = ref(false)
const searchError = ref('')
const creatingSession = ref(false)
const copiedId = ref<string | null>(null)

onMounted(async () => {
  await loadUsers()
})

async function loadUsers() {
  try {
    const { data } = await listUsers()
    store.setUsers(data)
  } catch {
    // silent
  }
}

async function selectUser(user: typeof store.currentUser) {
  if (!user) return
  store.setCurrentUser(user)
  await loadUserData(user.id)
}

async function loadUserData(userId: string) {
  const [sessionsRes, evergreenRes] = await Promise.all([
    getSessions(userId),
    getEvergreenMemories(userId),
  ])
  store.setSessions(sessionsRes.data)
  store.setEvergreen(evergreenRes.data)
}

async function handleCreateUser() {
  if (!newExternalId.value.trim() || creatingUser.value) return
  creatingUser.value = true
  try {
    const { data } = await createUser(
      newExternalId.value.trim(),
      newUserName.value.trim() || undefined,
    )
    store.setUsers([data, ...store.users])
    await selectUser(data)
    newExternalId.value = ''
    newUserName.value = ''
    showCreateUser.value = false
  } finally {
    creatingUser.value = false
  }
}

async function handleSearch() {
  const id = userSearchId.value.trim()
  if (!id) return
  searchError.value = ''
  searchingUser.value = true
  try {
    const { data: session } = await getSession(id)
    const { data: user } = await getUser(session.user_id)
    if (!store.users.find((u) => u.id === user.id)) {
      store.setUsers([user, ...store.users])
    }
    store.setCurrentUser(user)
    await loadUserData(user.id)
    await handleSelectSession(session)
    userSearchId.value = ''
    return
  } catch {
    // not a session id, try user id
  }
  try {
    const { data } = await getUser(id)
    if (!store.users.find((u) => u.id === data.id)) {
      store.setUsers([data, ...store.users])
    }
    await selectUser(data)
    userSearchId.value = ''
  } catch {
    searchError.value = 'ID 未找到'
  } finally {
    searchingUser.value = false
  }
}

async function handleSelectSession(session: typeof store.currentSession) {
  if (!session) return
  store.setCurrentSession(session)
  try {
    const { data } = await getMessages(session.id, 200)
    store.setMessages(data)
  } catch {
    // silent
  }
}

async function handleCreateSession() {
  if (!store.currentUser || creatingSession.value) return
  creatingSession.value = true
  try {
    const { data } = await createSession(store.currentUser.id)
    store.setSessions([data, ...store.sessions])
    store.setCurrentSession(data)
    store.setMessages([])
  } finally {
    creatingSession.value = false
  }
}

async function handleDeleteSession(sessionId: string, event: Event) {
  event.stopPropagation()
  if (!confirm('确定删除此会话及所有消息？')) return
  try {
    await deleteSession(sessionId)
    store.setSessions(store.sessions.filter((s) => s.id !== sessionId))
    if (store.currentSession?.id === sessionId) {
      store.setCurrentSession(null)
    }
  } catch {
    // silent
  }
}

async function handleDeleteUser() {
  if (!store.currentUser) return
  if (!confirm(`确定删除用户 ${store.currentUser.name || store.currentUser.external_id} 及所有关联数据？`)) return
  try {
    await deleteUser(store.currentUser.id)
    store.setUsers(store.users.filter((u) => u.id !== store.currentUser!.id))
    store.setCurrentUser(null)
  } catch {
    // silent
  }
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text)
  copiedId.value = text
  setTimeout(() => {
    copiedId.value = null
  }, 1500)
}

function displayName(user: typeof store.currentUser): string {
  if (!user) return 'U'
  return user.name || user.external_id
}

function formatTime(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-brand">
      <div class="brand-icon">R</div>
      <div class="brand-text">
        <span class="brand-name">Replica</span>
        <span class="brand-sub">Memory for AI</span>
      </div>
    </div>

    <!-- Search / Quick Access -->
    <div class="search-section">
      <div class="search-bar">
        <Search :size="14" class="search-icon" />
        <input
          v-model="userSearchId"
          class="search-input"
          placeholder="输入 User / Session ID..."
          @keydown.enter="handleSearch"
        />
      </div>
      <div v-if="searchError" class="search-error">{{ searchError }}</div>
    </div>

    <!-- User Selector -->
    <div class="user-section">
      <div v-if="store.currentUser" class="current-user">
        <div class="user-avatar">{{ displayName(store.currentUser)[0]?.toUpperCase() ?? 'U' }}</div>
        <div class="user-info">
          <div class="user-name">{{ displayName(store.currentUser) }}</div>
          <div class="user-id-row">
            <span class="user-id mono" :title="store.currentUser.id">{{ store.currentUser.id.slice(0, 8) }}...</span>
            <button
              class="copy-btn"
              @click.stop="copyToClipboard(store.currentUser!.id)"
              title="复制 User ID"
            >
              <Check v-if="copiedId === store.currentUser.id" :size="10" class="copied" />
              <Copy v-else :size="10" />
            </button>
          </div>
        </div>
        <select
          class="user-select"
          :value="store.currentUser.id"
          @change="(e) => {
            const id = (e.target as HTMLSelectElement).value
            if (id === '__create__') {
              showCreateUser = true
              return
            }
            if (id === '__delete__') {
              handleDeleteUser()
              return
            }
            const u = store.users.find(u => u.id === id)
            if (u) selectUser(u)
          }"
        >
          <option v-for="u in store.users" :key="u.id" :value="u.id">
            {{ u.name || u.external_id }}
          </option>
          <option value="__create__">+ 创建新用户</option>
          <option value="__delete__">🗑 删除当前用户</option>
        </select>
        <ChevronDown :size="14" class="user-chevron" />
      </div>
      <div v-else class="no-user">
        <p class="no-user-hint">选择或创建用户开始</p>
        <div class="user-actions">
          <button
            v-if="store.users.length > 0"
            class="btn btn-secondary btn-sm"
            style="flex:1"
            @click="selectUser(store.users[0])"
          >
            <LogIn :size="13" /> 选择最近用户
          </button>
          <button
            class="btn btn-primary btn-sm"
            style="flex:1"
            @click="showCreateUser = true"
          >
            <Plus :size="13" /> 创建用户
          </button>
        </div>
      </div>
    </div>

    <!-- Create User Form (inline) -->
    <div v-if="showCreateUser" class="create-form">
      <input
        v-model="newUserName"
        class="input"
        placeholder="用户名称 (如 小明)"
        @keydown.enter="$event.preventDefault()"
      />
      <input
        v-model="newExternalId"
        class="input"
        placeholder="External ID (如 alice-001)"
        @keydown.enter="handleCreateUser"
      />
      <div class="create-actions">
        <button class="btn btn-ghost btn-sm" @click="showCreateUser = false">取消</button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="!newExternalId.trim() || creatingUser"
          @click="handleCreateUser"
        >
          创建
        </button>
      </div>
    </div>

    <!-- Sessions List -->
    <div v-if="store.hasUser" class="sessions-section">
      <div class="sessions-header">
        <span class="sessions-title">会话</span>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="creatingSession"
          @click="handleCreateSession"
        >
          <Plus :size="14" />
        </button>
      </div>

      <div class="sessions-list">
        <div
          v-for="s in store.sessions"
          :key="s.id"
          :class="['session-item', { active: store.currentSession?.id === s.id }]"
          @click="handleSelectSession(s)"
        >
          <div class="session-item-top">
            <MessageSquare :size="14" class="session-icon" />
            <span class="session-id mono">{{ s.id.slice(0, 8) }}...</span>
            <button
              class="copy-btn"
              @click.stop="copyToClipboard(s.id)"
              :title="'复制 Session ID: ' + s.id"
            >
              <Check v-if="copiedId === s.id" :size="10" class="copied" />
              <Copy v-else :size="10" />
            </button>
            <span
              v-if="s.status !== 'active'"
              class="badge badge-info"
              style="font-size:10px; padding:1px 5px"
            >
              {{ s.status }}
            </span>
            <button
              class="delete-btn"
              @click="handleDeleteSession(s.id, $event)"
              title="删除会话"
            >
              <Trash2 :size="12" />
            </button>
          </div>
          <div class="session-meta">
            <span><Clock :size="11" /> {{ formatTime(s.created_at) }}</span>
            <span class="mono">{{ s.token_count.toLocaleString() }} tok</span>
          </div>
        </div>
        <div v-if="store.sessions.length === 0" class="empty-hint">
          暂无会话，点击 + 创建
        </div>
      </div>
    </div>

    <div class="sidebar-footer">
      <router-link to="/admin" class="admin-link">
        <Settings :size="14" />
        <span>管理后台</span>
      </router-link>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  min-width: 260px;
  height: 100vh;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 16px 12px;
}

.brand-icon {
  width: 32px;
  height: 32px;
  background: var(--accent);
  color: var(--text-inverse);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 15px;
  flex-shrink: 0;
}

.brand-text {
  display: flex;
  flex-direction: column;
}

.brand-name {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.2;
}

.brand-sub {
  font-size: 11px;
  color: var(--text-tertiary);
}

.search-section {
  padding: 0 12px 8px;
}

.search-bar {
  position: relative;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
}

.search-input {
  width: 100%;
  padding: 7px 10px 7px 30px;
  background: var(--bg-tertiary);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s;
}

.search-input:focus {
  border-color: var(--border-focus);
  background: var(--bg-input);
}

.search-input::placeholder {
  color: var(--text-tertiary);
}

.search-error {
  font-size: 11px;
  color: var(--error);
  padding: 4px 4px 0;
}

.user-section {
  padding: 0 12px 8px;
}

.current-user {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  cursor: pointer;
  position: relative;
}

.user-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--text-inverse);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 12px;
  flex-shrink: 0;
}

.user-info {
  flex: 1;
  min-width: 0;
}

.user-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-id-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.user-id {
  font-size: 10px;
  color: var(--text-tertiary);
}

.copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.1s;
  flex-shrink: 0;
  position: relative;
  z-index: 2;
}

.copy-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.copy-btn .copied {
  color: var(--success);
}

.user-select {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  font-size: 13px;
}

.user-chevron {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.no-user {
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
}

.no-user-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
  margin-bottom: 10px;
}

.user-actions {
  display: flex;
  gap: 6px;
}

.create-form {
  padding: 0 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.create-form .input {
  font-size: 12px;
  padding: 6px 10px;
}

.create-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.sessions-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0 12px;
}

.sessions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0 8px;
}

.sessions-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
}

.sessions-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-item {
  padding: 8px 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.1s;
}

.session-item:hover {
  background: var(--bg-hover);
}

.session-item.active {
  background: var(--accent-muted);
}

.session-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.session-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.session-item.active .session-icon {
  color: var(--accent);
}

.session-id {
  font-size: 12px;
  color: var(--text-secondary);
  flex: 1;
}

.delete-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 3px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.1s;
  opacity: 0;
  flex-shrink: 0;
}

.session-item:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  background: var(--error-muted);
  color: var(--error);
}

.session-meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--text-tertiary);
  padding-left: 20px;
}

.session-meta span {
  display: flex;
  align-items: center;
  gap: 3px;
}

.empty-hint {
  padding: 20px 10px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 12px;
}

.sidebar-footer {
  padding: 10px 12px;
  border-top: 1px solid var(--border-primary);
}

.admin-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-md);
  font-size: 13px;
  color: var(--text-secondary);
  transition: all 0.1s;
}

.admin-link:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
