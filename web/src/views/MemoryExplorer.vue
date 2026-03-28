<script setup lang="ts">
import { ref, watch } from 'vue'
import { getUser, type User } from '../api/users'
import { getMemories, createMemory, deleteMemory, searchMemory, type MemoryNote, type SearchResult } from '../api/memory'
import { memorize, type MemorizeRequest } from '../api/memorize'
import JsonViewer from '../components/JsonViewer.vue'
import {
  Search,
  Plus,
  Trash2,
  Upload,
  Brain,
  RefreshCw,
} from 'lucide-vue-next'

const userIdInput = ref('')
const user = ref<User | null>(null)
const memories = ref<MemoryNote[]>([])
const loading = ref(false)
const error = ref('')

const newContent = ref('')
const newType = ref<'evergreen' | 'daily'>('evergreen')

const searchQuery = ref('')
const searchResults = ref<SearchResult[]>([])
const searching = ref(false)

const showMemorize = ref(false)
const memorizeRaw = ref(`[
  {"role": "user", "content": "我最近在学习 Rust 编程语言。"},
  {"role": "assistant", "content": "Rust 的所有权系统确实很独特。"},
  {"role": "user", "content": "我计划用 Rust 重写我的 Python 项目。"}
]`)
const memorizeUserIds = ref('')
const memorizeResult = ref<{ memory_count: number; status: string } | null>(null)
const memorizing = ref(false)

async function loadUser() {
  if (!userIdInput.value.trim()) return
  error.value = ''
  loading.value = true
  try {
    const { data } = await getUser(userIdInput.value.trim())
    user.value = data
    await loadMemories()
  } catch (e: any) {
    error.value = e.response?.data?.detail ?? '用户未找到'
    user.value = null
    memories.value = []
  } finally {
    loading.value = false
  }
}

async function loadMemories() {
  if (!user.value) return
  const { data } = await getMemories(user.value.id)
  memories.value = data
}

async function handleCreate() {
  if (!user.value || !newContent.value.trim()) return
  await createMemory(user.value.id, newContent.value.trim(), newType.value)
  newContent.value = ''
  await loadMemories()
}

async function handleDelete(noteId: string) {
  await deleteMemory(noteId)
  await loadMemories()
}

async function handleSearch() {
  if (!user.value || !searchQuery.value.trim()) return
  searching.value = true
  try {
    const { data } = await searchMemory(user.value.id, searchQuery.value.trim())
    searchResults.value = data
  } finally {
    searching.value = false
  }
}

async function handleMemorize() {
  memorizing.value = true
  memorizeResult.value = null
  try {
    const rawData = JSON.parse(memorizeRaw.value)
    const req: MemorizeRequest = {
      new_raw_data_list: rawData,
      user_id_list: memorizeUserIds.value.trim() ? memorizeUserIds.value.split(',').map((s) => s.trim()) : undefined,
      scene: 'assistant',
    }
    const { data } = await memorize(req)
    memorizeResult.value = data
  } catch (e: any) {
    error.value = e.message ?? '解析失败'
  } finally {
    memorizing.value = false
  }
}

watch(user, () => {
  searchResults.value = []
})
</script>

<template>
  <div class="memory-explorer">
    <header class="page-header">
      <div>
        <h1 class="page-title">Memory Explorer</h1>
        <p class="page-desc">浏览、搜索和管理用户记忆</p>
      </div>
    </header>

    <!-- User Selector -->
    <div class="user-bar card">
      <Brain :size="18" class="bar-icon" />
      <input
        v-model="userIdInput"
        class="input"
        placeholder="输入 User ID…"
        @keydown.enter="loadUser"
      />
      <button class="btn btn-primary btn-sm" :disabled="loading" @click="loadUser">
        加载用户
      </button>
    </div>

    <div v-if="error" class="error-msg">{{ error }}</div>

    <template v-if="user">
      <div class="user-info card">
        <div class="info-row">
          <span class="info-label">User ID</span>
          <span class="mono">{{ user.id }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">External ID</span>
          <span class="mono">{{ user.external_id }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Metadata</span>
          <span class="mono">{{ JSON.stringify(user.metadata) }}</span>
        </div>
      </div>

      <div class="explorer-grid">
        <!-- Left: Memory List -->
        <div class="mem-list-panel">
          <div class="panel-header">
            <h3>记忆列表 ({{ memories.length }})</h3>
            <button class="btn btn-ghost btn-sm" @click="loadMemories">
              <RefreshCw :size="14" />
            </button>
          </div>

          <!-- Create memory -->
          <div class="create-form">
            <div class="form-row">
              <select v-model="newType" class="input" style="width: 120px">
                <option value="evergreen">Evergreen</option>
                <option value="daily">Daily</option>
              </select>
              <input v-model="newContent" class="input" placeholder="添加新记忆…" @keydown.enter="handleCreate" />
              <button class="btn btn-primary btn-sm" :disabled="!newContent.trim()" @click="handleCreate">
                <Plus :size="14" />
              </button>
            </div>
          </div>

          <div class="mem-cards">
            <div v-if="memories.length === 0" class="empty-state">暂无记忆</div>
            <div v-for="note in memories" :key="note.id" class="mem-card card">
              <div class="mem-card-header">
                <span :class="['badge', note.note_type === 'evergreen' ? 'badge-accent' : 'badge-info']">
                  {{ note.note_type }}
                </span>
                <span class="badge badge-success" style="font-size:10px">{{ note.source }}</span>
                <button class="btn btn-ghost btn-sm" @click="handleDelete(note.id)">
                  <Trash2 :size="13" />
                </button>
              </div>
              <p class="mem-card-content">{{ note.content }}</p>
              <div class="mem-card-meta mono">
                {{ note.id.slice(0, 8) }}… · {{ new Date(note.created_at).toLocaleString() }}
              </div>
            </div>
          </div>
        </div>

        <!-- Right: Search + Memorize -->
        <div class="search-panel">
          <div class="panel-header">
            <h3>混合记忆搜索</h3>
          </div>
          <div class="search-bar">
            <input
              v-model="searchQuery"
              class="input"
              placeholder="输入搜索查询…"
              @keydown.enter="handleSearch"
            />
            <button class="btn btn-primary btn-sm" :disabled="!searchQuery.trim() || searching" @click="handleSearch">
              <Search :size="14" /> 搜索
            </button>
          </div>

          <div class="search-results">
            <div v-if="searchResults.length === 0" class="empty-state">
              输入查询进行混合记忆搜索
            </div>
            <div v-for="(r, i) in searchResults" :key="i" class="search-hit card">
              <div class="hit-header">
                <span class="badge badge-accent">Score: {{ r.score.toFixed(4) }}</span>
                <span class="mono" style="font-size:10px; color:var(--text-tertiary)">
                  {{ r.note_id.slice(0, 8) }}…
                </span>
              </div>
              <p class="hit-text">{{ r.chunk_text }}</p>
              <p class="hit-time mono">{{ new Date(r.created_at).toLocaleString() }}</p>
            </div>
          </div>

          <!-- Memorize Pipeline -->
          <div class="memorize-section">
            <button class="btn btn-secondary btn-sm" @click="showMemorize = !showMemorize">
              <Upload :size="14" /> Memorize 管线
            </button>

            <div v-if="showMemorize" class="memorize-form card">
              <div class="form-group">
                <label>原始对话 JSON</label>
                <textarea v-model="memorizeRaw" class="input memorize-textarea" />
              </div>
              <div class="form-group">
                <label>User ID 列表（逗号分隔）</label>
                <input v-model="memorizeUserIds" class="input" placeholder="user-001, user-002" />
              </div>
              <button
                class="btn btn-primary btn-sm"
                :disabled="memorizing"
                @click="handleMemorize"
              >
                {{ memorizing ? '处理中…' : '执行 Memorize' }}
              </button>
              <JsonViewer v-if="memorizeResult" :data="memorizeResult" max-height="150px" />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.memory-explorer {
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

.user-info {
  margin-bottom: 20px;
  padding: 14px 18px;
}

.info-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  font-size: 13px;
}

.info-label {
  color: var(--text-tertiary);
  min-width: 100px;
}

.error-msg {
  color: var(--error);
  font-size: 13px;
  padding: 8px 0;
}

.explorer-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-header h3 {
  font-size: 14px;
  font-weight: 600;
}

.create-form {
  margin-bottom: 12px;
}

.form-row {
  display: flex;
  gap: 8px;
}

.mem-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 500px;
  overflow-y: auto;
}

.mem-card {
  padding: 12px 14px;
}

.mem-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.mem-card-header .btn {
  margin-left: auto;
}

.mem-card-content {
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 6px;
}

.mem-card-meta {
  font-size: 10px;
  color: var(--text-tertiary);
}

.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 400px;
  overflow-y: auto;
  margin-bottom: 16px;
}

.search-hit {
  padding: 12px;
}

.hit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.hit-text {
  font-size: 13px;
  line-height: 1.6;
}

.hit-time {
  font-size: 10px;
  color: var(--text-tertiary);
  margin-top: 4px;
}

.memorize-section {
  margin-top: 8px;
}

.memorize-form {
  margin-top: 10px;
  padding: 14px;
}

.form-group {
  margin-bottom: 10px;
}

.form-group label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.memorize-textarea {
  min-height: 120px;
  font-family: var(--font-mono);
  font-size: 12px;
  resize: vertical;
}

.empty-state {
  padding: 30px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
</style>
