<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { getUser, type User } from '../api/users'
import { getSessions, deleteSession, type Session } from '../api/sessions'
import { getMessages, type Message } from '../api/messages'
import { getTables, getTableData, type TableInfo, type ColumnInfo } from '../api/admin'
import {
  getUserKnowledge,
  getUserKnowledgeCount,
  deleteKnowledgeEntry,
  type KnowledgeEntry,
  type KnowledgeCountResponse,
} from '../api/memory'
import TokenProgress from '../components/TokenProgress.vue'
import {
  ArrowLeft,
  MessagesSquare,
  Database,
  RefreshCw,
  Trash2,
  ChevronRight,
  Copy,
  Check,
  ChevronLeft,
  Bot,
  User as UserIcon,
  Clock,
  Table2,
  Loader2,
  Brain,
} from 'lucide-vue-next'

const router = useRouter()
const activeTab = ref<'sessions' | 'knowledge' | 'database'>('sessions')

// --- Sessions tab ---
const userIdInput = ref('')
const user = ref<User | null>(null)
const sessions = ref<Session[]>([])
const selectedSession = ref<Session | null>(null)
const sessMessages = ref<Message[]>([])
const sessLoading = ref(false)
const sessError = ref('')
const showCompacted = ref(false)

async function loadUser() {
  if (!userIdInput.value.trim()) return
  sessError.value = ''
  sessLoading.value = true
  try {
    const { data } = await getUser(userIdInput.value.trim())
    user.value = data
    await loadSessions()
  } catch {
    sessError.value = '用户未找到'
    user.value = null
    sessions.value = []
  } finally {
    sessLoading.value = false
  }
}

async function loadSessions() {
  if (!user.value) return
  const { data } = await getSessions(user.value.id)
  sessions.value = data
}

async function selectSession(session: Session) {
  selectedSession.value = session
  await reloadMessages()
}

async function reloadMessages() {
  if (!selectedSession.value) return
  const { data } = await getMessages(selectedSession.value.id, 500, 0, showCompacted.value)
  sessMessages.value = data
}

async function toggleCompacted() {
  showCompacted.value = !showCompacted.value
  await reloadMessages()
}

const copiedId = ref<string | null>(null)

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

async function copyId(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      fallbackCopy(text)
    }
    copiedId.value = text
    setTimeout(() => { copiedId.value = null }, 1500)
  } catch {
    if (fallbackCopy(text)) {
      copiedId.value = text
      setTimeout(() => { copiedId.value = null }, 1500)
    }
  }
}

async function handleDeleteSession(session: Session) {
  if (!confirm('确定删除此会话及所有消息？')) return
  await deleteSession(session.id)
  sessions.value = sessions.value.filter((s) => s.id !== session.id)
  if (selectedSession.value?.id === session.id) {
    selectedSession.value = null
    sessMessages.value = []
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

// --- Knowledge tab ---
const knUserIdInput = ref('')
const knUser = ref<User | null>(null)
const knEntries = ref<KnowledgeEntry[]>([])
const knCounts = ref<KnowledgeCountResponse | null>(null)
const knFilter = ref('')
const knPage = ref(1)
const knPageSize = ref(50)
const knLoading = ref(false)
const knError = ref('')
const knExpandedId = ref<string | null>(null)

const entryTypeLabels: Record<string, string> = {
  episode: '情节',
  event: '事件',
  foresight: '预见',
}

async function loadKnUser() {
  if (!knUserIdInput.value.trim()) return
  knError.value = ''
  knLoading.value = true
  try {
    const { data } = await getUser(knUserIdInput.value.trim())
    knUser.value = data
    await Promise.all([loadKnEntries(), loadKnCounts()])
  } catch {
    knError.value = '用户未找到'
    knUser.value = null
    knEntries.value = []
    knCounts.value = null
  } finally {
    knLoading.value = false
  }
}

async function loadKnEntries() {
  if (!knUser.value) return
  knLoading.value = true
  try {
    const offset = (knPage.value - 1) * knPageSize.value
    const { data } = await getUserKnowledge(
      knUser.value.id,
      knPageSize.value,
      offset,
      knFilter.value || undefined,
    )
    knEntries.value = data
  } finally {
    knLoading.value = false
  }
}

async function loadKnCounts() {
  if (!knUser.value) return
  const { data } = await getUserKnowledgeCount(knUser.value.id)
  knCounts.value = data
}

function setKnFilter(type: string) {
  knFilter.value = type
  knPage.value = 1
  loadKnEntries()
}

function knPrevPage() {
  if (knPage.value > 1) {
    knPage.value--
    loadKnEntries()
  }
}

function knNextPage() {
  if (knEntries.value.length === knPageSize.value) {
    knPage.value++
    loadKnEntries()
  }
}

async function handleDeleteKnowledge(id: string) {
  if (!confirm('确定删除此知识条目？')) return
  await deleteKnowledgeEntry(id)
  knEntries.value = knEntries.value.filter((e) => e.id !== id)
  await loadKnCounts()
}

function toggleKnExpand(id: string) {
  knExpandedId.value = knExpandedId.value === id ? null : id
}

// --- Database tab ---
const tables = ref<TableInfo[]>([])
const selectedTable = ref('')
const columns = ref<ColumnInfo[]>([])
const rows = ref<Record<string, unknown>[]>([])
const total = ref(0)
const pageSize = ref(50)
const currentPage = ref(1)
const dbLoading = ref(false)
const loadingTables = ref(false)
const dbError = ref('')

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

async function loadTables() {
  loadingTables.value = true
  dbError.value = ''
  try {
    const { data } = await getTables()
    tables.value = data.tables
  } catch {
    dbError.value = '无法加载表列表'
  } finally {
    loadingTables.value = false
  }
}

async function selectTable(name: string) {
  selectedTable.value = name
  currentPage.value = 1
  await loadData()
}

async function loadData() {
  if (!selectedTable.value) return
  dbLoading.value = true
  dbError.value = ''
  try {
    const offset = (currentPage.value - 1) * pageSize.value
    const { data } = await getTableData(selectedTable.value, pageSize.value, offset)
    columns.value = data.columns
    rows.value = data.rows
    total.value = data.total
  } catch {
    dbError.value = '无法加载表数据'
  } finally {
    dbLoading.value = false
  }
}

function prevPage() {
  if (currentPage.value > 1) {
    currentPage.value--
    loadData()
  }
}

function nextPage() {
  if (currentPage.value < totalPages.value) {
    currentPage.value++
    loadData()
  }
}

function isVectorCol(col: ColumnInfo) {
  return col.udt_name === 'vector'
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '∅'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function cellClass(col: ColumnInfo): string {
  if (isVectorCol(col)) return 'cell-vector'
  if (col.data_type === 'uuid') return 'cell-uuid'
  if (['integer', 'bigint', 'numeric', 'real', 'double precision'].includes(col.data_type)) return 'cell-number'
  if (col.data_type.includes('timestamp')) return 'cell-time'
  return ''
}

onMounted(() => {
  if (activeTab.value === 'database') {
    loadTables()
  }
})
</script>

<template>
  <div class="admin-page">
    <header class="admin-header">
      <button class="btn btn-ghost btn-sm" @click="router.push('/')">
        <ArrowLeft :size="16" /> 返回聊天
      </button>
      <h1 class="admin-title">管理后台</h1>
      <div class="tab-bar">
        <button
          :class="['tab-btn', { active: activeTab === 'sessions' }]"
          @click="activeTab = 'sessions'"
        >
          <MessagesSquare :size="15" /> Sessions
        </button>
        <button
          :class="['tab-btn', { active: activeTab === 'knowledge' }]"
          @click="activeTab = 'knowledge'"
        >
          <Brain :size="15" /> Knowledge
        </button>
        <button
          :class="['tab-btn', { active: activeTab === 'database' }]"
          @click="activeTab = 'database'; loadTables()"
        >
          <Database :size="15" /> Database
        </button>
      </div>
    </header>

    <!-- Sessions Tab -->
    <div v-if="activeTab === 'sessions'" class="tab-content">
      <div class="user-bar card">
        <MessagesSquare :size="18" class="bar-icon" />
        <input
          v-model="userIdInput"
          class="input"
          placeholder="输入 User ID…"
          @keydown.enter="loadUser"
        />
        <button class="btn btn-primary btn-sm" :disabled="sessLoading" @click="loadUser">
          加载会话
        </button>
      </div>

      <div v-if="sessError" class="error-msg">{{ sessError }}</div>

      <template v-if="user">
        <div class="sessions-layout">
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
                <button class="copy-inline" @click.stop="copyId(s.id)" :title="'复制: ' + s.id">
                  <Check v-if="copiedId === s.id" :size="11" style="color:var(--success)" />
                  <Copy v-else :size="11" />
                </button>
              </div>
              <div class="session-item-stats">
                <span class="stat"><Clock :size="12" /> {{ new Date(s.created_at).toLocaleString() }}</span>
                <span class="stat mono">{{ s.token_count.toLocaleString() }} tokens</span>
                <span v-if="s.compaction_count > 0" class="stat mono">{{ s.compaction_count }}x compacted</span>
              </div>
              <div class="session-item-actions">
                <button class="btn btn-ghost btn-sm" style="color:var(--error)" @click.stop="handleDeleteSession(s)">
                  <Trash2 :size="13" /> 删除
                </button>
              </div>
            </div>
          </div>
          <div class="message-panel">
            <template v-if="selectedSession">
              <div class="panel-header">
                <h3><ChevronRight :size="16" /> 消息时间线</h3>
                <button
                  :class="['compact-toggle', { active: showCompacted }]"
                  @click="toggleCompacted"
                  title="显示/隐藏已压缩消息"
                >
                  显示已压缩 {{ showCompacted ? 'ON' : 'OFF' }}
                </button>
                <span class="mono" style="font-size:12px; color:var(--text-tertiary)">{{ sessMessages.length }} 条消息</span>
              </div>
              <TokenProgress :current="selectedSession.token_count" />
              <div class="message-timeline">
                <div
                  v-for="msg in sessMessages"
                  :key="msg.id"
                  :class="['timeline-msg', `msg-${msg.role}`, msgTypeClass(msg.message_type), { 'msg-compacted': msg.is_compacted }]"
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
                      <span v-if="msg.is_compacted" class="badge badge-error" style="font-size:10px">已压缩</span>
                      <span class="msg-time mono">{{ new Date(msg.created_at).toLocaleTimeString() }}</span>
                      <span class="msg-tokens mono">{{ msg.token_count }} tok</span>
                    </div>
                    <div class="msg-content">{{ msg.content }}</div>
                  </div>
                </div>
              </div>
            </template>
            <div v-else class="empty-state">选择一个会话查看消息</div>
          </div>
        </div>
      </template>
    </div>

    <!-- Knowledge Tab -->
    <div v-if="activeTab === 'knowledge'" class="tab-content">
      <div class="user-bar card">
        <Brain :size="18" class="bar-icon" />
        <input
          v-model="knUserIdInput"
          class="input"
          placeholder="输入 User ID…"
          @keydown.enter="loadKnUser"
        />
        <button class="btn btn-primary btn-sm" :disabled="knLoading" @click="loadKnUser">
          加载知识
        </button>
      </div>

      <div v-if="knError" class="error-msg">{{ knError }}</div>

      <template v-if="knUser">
        <div class="kn-header">
          <div class="kn-user-info">
            <span class="kn-user-label">用户:</span>
            <span class="kn-user-name">{{ knUser.name || knUser.external_id }}</span>
            <span class="mono kn-user-id">{{ knUser.id.slice(0, 8) }}…</span>
          </div>
          <div v-if="knCounts" class="kn-type-filters">
            <button
              :class="['kn-filter-btn', { active: knFilter === '' }]"
              @click="setKnFilter('')"
            >
              全部 <span class="kn-filter-count">{{ knCounts.total }}</span>
            </button>
            <button
              v-for="(count, type) in knCounts.by_type"
              :key="type"
              :class="['kn-filter-btn', { active: knFilter === type }]"
              @click="setKnFilter(type)"
            >
              {{ entryTypeLabels[type] || type }} <span class="kn-filter-count">{{ count }}</span>
            </button>
          </div>
          <button class="btn btn-ghost btn-sm" @click="loadKnEntries(); loadKnCounts()">
            <RefreshCw :size="14" />
          </button>
        </div>

        <div v-if="knLoading" class="loading-state"><Loader2 :size="24" class="spin" /><span>加载中…</span></div>

        <div v-else class="kn-list">
          <div v-if="knEntries.length === 0" class="empty-state" style="padding:40px">暂无知识条目</div>
          <div
            v-for="entry in knEntries"
            :key="entry.id"
            class="kn-entry card"
          >
            <div class="kn-entry-header" @click="toggleKnExpand(entry.id)">
              <span
                :class="['badge', entry.entry_type === 'episode' ? 'badge-info' : entry.entry_type === 'event' ? 'badge-success' : 'badge-accent']"
              >
                {{ entryTypeLabels[entry.entry_type] || entry.entry_type }}
              </span>
              <span v-if="entry.title" class="kn-entry-title">{{ entry.title }}</span>
              <span class="kn-entry-time mono">{{ new Date(entry.created_at).toLocaleString() }}</span>
              <button class="copy-inline" @click.stop="copyId(entry.id)" :title="'复制 ID: ' + entry.id">
                <Check v-if="copiedId === entry.id" :size="11" style="color:var(--success)" />
                <Copy v-else :size="11" />
              </button>
              <button class="btn btn-ghost btn-sm" style="color:var(--error);padding:2px 4px" @click.stop="handleDeleteKnowledge(entry.id)">
                <Trash2 :size="13" />
              </button>
            </div>
            <div :class="['kn-entry-content', { expanded: knExpandedId === entry.id }]">
              {{ entry.content }}
            </div>
            <div v-if="knExpandedId === entry.id && entry.participants?.length" class="kn-entry-meta">
              <span class="kn-meta-label">参与者:</span>
              <span v-for="p in entry.participants" :key="p" class="badge badge-accent" style="font-size:10px">{{ p }}</span>
            </div>
          </div>
        </div>

        <div v-if="knEntries.length > 0" class="pagination">
          <button class="btn btn-ghost btn-sm" :disabled="knPage <= 1" @click="knPrevPage">
            <ChevronLeft :size="16" />
          </button>
          <span class="page-info mono">第 {{ knPage }} 页</span>
          <button class="btn btn-ghost btn-sm" :disabled="knEntries.length < knPageSize" @click="knNextPage">
            <ChevronRight :size="16" />
          </button>
        </div>
      </template>
    </div>

    <!-- Database Tab -->
    <div v-if="activeTab === 'database'" class="tab-content">
      <div v-if="dbError" class="error-msg">{{ dbError }}</div>
      <div class="db-layout">
        <div class="table-list-panel">
          <div class="panel-title-row">
            <Database :size="16" />
            <span>数据表</span>
            <Loader2 v-if="loadingTables" :size="14" class="spin" />
            <button class="btn btn-ghost btn-sm" style="margin-left:auto" @click="loadTables">
              <RefreshCw :size="14" />
            </button>
          </div>
          <div class="table-list">
            <div
              v-for="t in tables"
              :key="t.name"
              :class="['table-item', { selected: selectedTable === t.name }]"
              @click="selectTable(t.name)"
            >
              <Table2 :size="14" class="table-icon" />
              <span class="table-name">{{ t.name }}</span>
              <span class="table-count mono">{{ t.row_count }}</span>
            </div>
            <div v-if="tables.length === 0 && !loadingTables" class="empty-hint">暂无表数据</div>
          </div>
        </div>
        <div class="data-panel">
          <template v-if="selectedTable">
            <div class="data-header">
              <h3 class="data-title mono">{{ selectedTable }}</h3>
              <div class="data-stats">
                <span class="badge badge-accent">{{ total }} 行</span>
                <span class="badge badge-info">{{ columns.length }} 列</span>
              </div>
            </div>
            <div v-if="dbLoading" class="loading-state"><Loader2 :size="24" class="spin" /><span>加载中…</span></div>
            <div v-else class="table-wrapper">
              <table class="data-table">
                <thead>
                  <tr>
                    <th v-for="col in columns" :key="col.name" :class="{ 'col-vector': isVectorCol(col) }">
                      <div class="th-content">
                        <span class="th-name">{{ col.name }}</span>
                        <span class="th-type">{{ isVectorCol(col) ? 'vector' : col.data_type }}</span>
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in rows" :key="i">
                    <td v-for="col in columns" :key="col.name" :class="cellClass(col)" :title="formatCell(row[col.name])">
                      {{ formatCell(row[col.name]) }}
                    </td>
                  </tr>
                  <tr v-if="rows.length === 0">
                    <td :colspan="columns.length" class="empty-cell">表中暂无数据</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="total > 0" class="pagination">
              <button class="btn btn-ghost btn-sm" :disabled="currentPage <= 1" @click="prevPage">
                <ChevronLeft :size="16" />
              </button>
              <span class="page-info mono">{{ currentPage }} / {{ totalPages }}</span>
              <button class="btn btn-ghost btn-sm" :disabled="currentPage >= totalPages" @click="nextPage">
                <ChevronRight :size="16" />
              </button>
              <span class="row-info">显示 {{ (currentPage - 1) * pageSize + 1 }}–{{ Math.min(currentPage * pageSize, total) }}，共 {{ total }} 条</span>
            </div>
          </template>
          <div v-else class="empty-state"><Database :size="40" class="empty-icon" /><p>选择一张表查看数据</p></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.admin-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-primary);
  background: var(--bg-secondary);
}

.admin-title {
  font-size: 18px;
  font-weight: 700;
}

.tab-bar {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: none;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.tab-btn:hover { background: var(--bg-hover); }
.tab-btn.active { background: var(--accent-muted); color: var(--accent); border-color: var(--accent); }

.tab-content {
  flex: 1;
  overflow: auto;
  padding: 20px 24px;
}

.user-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 12px;
}

.bar-icon { color: var(--accent); flex-shrink: 0; }
.error-msg { color: var(--error); font-size: 13px; padding: 8px 0; }

.sessions-layout { display: grid; grid-template-columns: 380px 1fr; gap: 20px; }

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-header h3 { display: flex; align-items: center; gap: 4px; font-size: 14px; font-weight: 600; }

.session-item { padding: 12px 14px; margin-bottom: 8px; cursor: pointer; transition: all 0.15s; }
.session-item:hover { border-color: var(--text-tertiary); }
.session-item.selected { border-color: var(--accent); background: var(--accent-muted); }

.session-item-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.session-id { font-size: 12px; color: var(--text-tertiary); }

.session-item-stats { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 4px; }
.stat { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-tertiary); }
.session-item-actions { margin-top: 4px; }
.copy-inline { display:inline-flex; align-items:center; background:none; border:none; color:var(--text-tertiary); cursor:pointer; padding:2px; border-radius:3px; }
.copy-inline:hover { color:var(--text-primary); background:var(--bg-hover); }

.message-timeline { max-height: calc(100vh - 320px); overflow-y: auto; padding: 8px 0; }

.timeline-msg { display: flex; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); margin-bottom: 4px; transition: background 0.1s; }
.timeline-msg:hover { background: var(--bg-hover); }
.timeline-msg.msg-compaction { background: var(--error-muted); border-left: 3px solid var(--error); }
.timeline-msg.msg-flush { background: var(--accent-muted); border-left: 3px solid var(--accent); }

.msg-avatar {
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  font-size: 11px; font-weight: 600;
}

.msg-user .msg-avatar { background: var(--accent-muted); color: var(--accent); }
.msg-assistant .msg-avatar { background: var(--info-muted); color: var(--info); }
.msg-system .msg-avatar, .msg-tool .msg-avatar { background: var(--bg-hover); color: var(--text-tertiary); }

.msg-body { flex: 1; min-width: 0; }
.msg-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.msg-role { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.msg-time { font-size: 10px; color: var(--text-tertiary); margin-left: auto; }
.msg-tokens { font-size: 10px; color: var(--text-tertiary); }
.msg-content { font-size: 13px; line-height: 1.6; color: var(--text-primary); word-break: break-word; }

/* Database Tab */
.db-layout { display: flex; gap: 20px; height: calc(100vh - 120px); }

.table-list-panel { width: 260px; min-width: 260px; display: flex; flex-direction: column; }
.panel-title-row { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text-secondary); margin-bottom: 12px; }

.table-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.table-item { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: var(--radius-md); cursor: pointer; transition: all 0.15s; border: 1px solid transparent; }
.table-item:hover { background: var(--bg-hover); }
.table-item.selected { background: var(--accent-muted); border-color: var(--accent); }
.table-icon { color: var(--text-tertiary); flex-shrink: 0; }
.table-item.selected .table-icon { color: var(--accent); }
.table-name { flex: 1; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-count { font-size: 11px; color: var(--text-tertiary); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 100px; }

.data-panel { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.data-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.data-title { font-size: 16px; font-weight: 600; }
.data-stats { display: flex; gap: 8px; }

.loading-state { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 60px; color: var(--text-tertiary); font-size: 14px; }

.table-wrapper { flex: 1; overflow: auto; border: 1px solid var(--border-primary); border-radius: var(--radius-lg); background: var(--bg-card); }
.data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.data-table th { position: sticky; top: 0; background: var(--bg-tertiary); padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border-primary); white-space: nowrap; z-index: 1; }
.th-content { display: flex; flex-direction: column; gap: 2px; }
.th-name { font-weight: 600; font-size: 12px; color: var(--text-primary); }
.th-type { font-size: 10px; font-family: var(--font-mono); color: var(--text-tertiary); }
.col-vector .th-name { color: var(--info); }
.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-primary); }
.data-table tbody tr:hover { background: var(--bg-hover); }
.cell-uuid { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }
.cell-number { font-family: var(--font-mono); text-align: right; }
.cell-time { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }
.cell-vector { font-family: var(--font-mono); font-size: 10px; color: var(--info); max-width: 200px; }
.empty-cell { text-align: center; color: var(--text-tertiary); padding: 40px 20px !important; }

.pagination { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 8px 0; }
.page-info { font-size: 13px; color: var(--text-secondary); }
.row-info { font-size: 12px; color: var(--text-tertiary); margin-left: auto; }

.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; color: var(--text-tertiary); font-size: 14px; padding: 60px 20px; }
.empty-icon { opacity: 0.3; }
.empty-hint { padding: 20px; text-align: center; color: var(--text-tertiary); font-size: 13px; }

/* Compacted toggle */
.compact-toggle {
  padding: 3px 8px; border: 1px solid var(--border-primary); border-radius: var(--radius-md);
  background: none; color: var(--text-tertiary); font-size: 11px; font-weight: 500; cursor: pointer; transition: all 0.15s;
}
.compact-toggle:hover { background: var(--bg-hover); }
.compact-toggle.active { background: var(--error-muted); color: var(--error); border-color: var(--error); }

.msg-compacted { opacity: 0.55; border-left: 2px solid var(--error); }

/* Knowledge Tab */
.kn-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.kn-user-info { display: flex; align-items: center; gap: 6px; }
.kn-user-label { font-size: 13px; color: var(--text-tertiary); }
.kn-user-name { font-size: 14px; font-weight: 600; }
.kn-user-id { font-size: 11px; color: var(--text-tertiary); }
.kn-type-filters { display: flex; gap: 4px; margin-left: auto; }
.kn-filter-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 10px; border: 1px solid var(--border-primary); border-radius: var(--radius-md);
  background: none; color: var(--text-secondary); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s;
}
.kn-filter-btn:hover { background: var(--bg-hover); }
.kn-filter-btn.active { background: var(--accent-muted); color: var(--accent); border-color: var(--accent); }
.kn-filter-count { font-size: 11px; font-family: var(--font-mono); color: var(--text-tertiary); background: var(--bg-tertiary); padding: 0 5px; border-radius: 100px; }
.kn-filter-btn.active .kn-filter-count { background: var(--accent); color: var(--text-inverse); }

.kn-list { display: flex; flex-direction: column; gap: 8px; max-height: calc(100vh - 280px); overflow-y: auto; }
.kn-entry { padding: 12px 16px; cursor: pointer; transition: all 0.15s; }
.kn-entry:hover { border-color: var(--text-tertiary); }
.kn-entry-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.kn-entry-title { font-size: 13px; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kn-entry-time { font-size: 11px; color: var(--text-tertiary); flex-shrink: 0; }
.kn-entry-content {
  font-size: 13px; line-height: 1.6; color: var(--text-primary); word-break: break-word;
  max-height: 60px; overflow: hidden; position: relative; transition: max-height 0.3s;
}
.kn-entry-content::after {
  content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 24px;
  background: linear-gradient(transparent, var(--bg-card)); pointer-events: none;
}
.kn-entry-content.expanded { max-height: none; }
.kn-entry-content.expanded::after { display: none; }
.kn-entry-meta { display: flex; align-items: center; gap: 4px; margin-top: 6px; }
.kn-meta-label { font-size: 11px; color: var(--text-tertiary); }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
