<script setup lang="ts">
import { ref, watch } from 'vue'
import { getUser, type User } from '../api/users'
import {
  getEvergreenMemories,
  createEvergreenMemory,
  deleteEvergreenMemory,
  searchKnowledge,
  buildContext,
  type EvergreenMemory,
  type KnowledgeSearchResult,
  type ContextResponse,
} from '../api/memory'
import { getSessions, type Session } from '../api/sessions'
import { memorize, type MemorizeRequest } from '../api/memorize'
import JsonViewer from '../components/JsonViewer.vue'
import {
  Search,
  Plus,
  Trash2,
  Upload,
  Brain,
  RefreshCw,
  Layers,
  BookOpen,
  Sparkles,
} from 'lucide-vue-next'

const userIdInput = ref('')
const user = ref<User | null>(null)
const loading = ref(false)
const error = ref('')

// Layer 1: Evergreen
const evergreenMemories = ref<EvergreenMemory[]>([])
const newContent = ref('')
const newCategory = ref<'fact' | 'preference' | 'relationship' | 'goal'>('fact')

// Layer 3: Knowledge Search
const searchQuery = ref('')
const searchEntryType = ref<string>('')
const searchResults = ref<KnowledgeSearchResult[]>([])
const searching = ref(false)

// Context Build
const sessions = ref<Session[]>([])
const selectedSessionId = ref('')
const contextQuery = ref('')
const contextResult = ref<ContextResponse | null>(null)
const buildingCtx = ref(false)
const showContext = ref(false)

// Memorize Pipeline
const showMemorize = ref(false)
const memorizeRaw = ref(`[
  {"role": "user", "content": "我最近在学习 Rust 编程语言。"},
  {"role": "assistant", "content": "Rust 的所有权系统确实很独特。"},
  {"role": "user", "content": "我计划用 Rust 重写我的 Python 项目。"}
]`)
const memorizeUserIds = ref('')
const memorizeResult = ref<{ memory_count: number; status: string } | null>(null)
const memorizing = ref(false)

const categoryLabels: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  relationship: '关系',
  goal: '目标',
}

const entryTypeLabels: Record<string, string> = {
  episode: '情节',
  event: '事件',
  foresight: '预见',
}

async function loadUser() {
  if (!userIdInput.value.trim()) return
  error.value = ''
  loading.value = true
  try {
    const { data } = await getUser(userIdInput.value.trim())
    user.value = data
    await Promise.all([loadEvergreen(), loadSessions()])
  } catch (e: any) {
    error.value = e.response?.data?.detail ?? '用户未找到'
    user.value = null
    evergreenMemories.value = []
  } finally {
    loading.value = false
  }
}

async function loadEvergreen() {
  if (!user.value) return
  const { data } = await getEvergreenMemories(user.value.id)
  evergreenMemories.value = data
}

async function loadSessions() {
  if (!user.value) return
  const { data } = await getSessions(user.value.id)
  sessions.value = data.filter((s) => s.status === 'active')
  if (sessions.value.length > 0 && !selectedSessionId.value) {
    selectedSessionId.value = sessions.value[0].id
  }
}

async function handleCreateEvergreen() {
  if (!user.value || !newContent.value.trim()) return
  await createEvergreenMemory(user.value.id, newContent.value.trim(), newCategory.value)
  newContent.value = ''
  await loadEvergreen()
}

async function handleDeleteEvergreen(memoryId: string) {
  await deleteEvergreenMemory(memoryId)
  await loadEvergreen()
}

async function handleSearch() {
  if (!user.value || !searchQuery.value.trim()) return
  searching.value = true
  try {
    const { data } = await searchKnowledge(
      user.value.id,
      searchQuery.value.trim(),
      10,
      searchEntryType.value || undefined,
    )
    searchResults.value = data
  } finally {
    searching.value = false
  }
}

async function handleBuildContext() {
  if (!user.value || !selectedSessionId.value) return
  buildingCtx.value = true
  try {
    const { data } = await buildContext(
      user.value.id,
      selectedSessionId.value,
      contextQuery.value || undefined,
    )
    contextResult.value = data
    showContext.value = true
  } finally {
    buildingCtx.value = false
  }
}

async function handleMemorize() {
  memorizing.value = true
  memorizeResult.value = null
  try {
    const rawData = JSON.parse(memorizeRaw.value)
    const req: MemorizeRequest = {
      new_raw_data_list: rawData,
      user_id_list: memorizeUserIds.value.trim()
        ? memorizeUserIds.value.split(',').map((s) => s.trim())
        : undefined,
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
  contextResult.value = null
  showContext.value = false
})
</script>

<template>
  <div class="memory-explorer">
    <header class="page-header">
      <div>
        <h1 class="page-title">Memory Explorer</h1>
        <p class="page-desc">三层记忆架构 — 可视化管理与检索</p>
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
      </div>

      <!-- Three-Layer Architecture Visualization -->
      <div class="arch-hint">
        <div class="layer-tag layer-1">Layer 1 · Evergreen</div>
        <div class="layer-tag layer-2">Layer 2 · Session Context</div>
        <div class="layer-tag layer-3">Layer 3 · Knowledge Base</div>
      </div>

      <div class="explorer-grid">
        <!-- Left: Evergreen Memory (Layer 1) -->
        <div class="panel-container">
          <div class="panel-badge layer-1-bg">Layer 1</div>
          <div class="panel-header">
            <h3><Sparkles :size="15" /> 长期记忆 ({{ evergreenMemories.length }})</h3>
            <button class="btn btn-ghost btn-sm" @click="loadEvergreen">
              <RefreshCw :size="14" />
            </button>
          </div>
          <p class="panel-desc">始终注入 LLM 上下文的持久事实</p>

          <!-- Create evergreen -->
          <div class="create-form">
            <div class="form-row">
              <select v-model="newCategory" class="input" style="width: 100px">
                <option value="fact">事实</option>
                <option value="preference">偏好</option>
                <option value="relationship">关系</option>
                <option value="goal">目标</option>
              </select>
              <input
                v-model="newContent"
                class="input"
                placeholder="添加新的长期记忆…"
                @keydown.enter="handleCreateEvergreen"
              />
              <button
                class="btn btn-primary btn-sm"
                :disabled="!newContent.trim()"
                @click="handleCreateEvergreen"
              >
                <Plus :size="14" />
              </button>
            </div>
          </div>

          <div class="mem-cards">
            <div v-if="evergreenMemories.length === 0" class="empty-state">
              暂无长期记忆
            </div>
            <div v-for="mem in evergreenMemories" :key="mem.id" class="mem-card card">
              <div class="mem-card-header">
                <span class="badge badge-accent">
                  {{ categoryLabels[mem.category] || mem.category }}
                </span>
                <span class="badge badge-success" style="font-size: 10px">
                  {{ mem.source }}
                </span>
                <span
                  v-if="mem.confidence < 1"
                  class="badge badge-info"
                  style="font-size: 10px"
                >
                  {{ (mem.confidence * 100).toFixed(0) }}%
                </span>
                <button class="btn btn-ghost btn-sm" @click="handleDeleteEvergreen(mem.id)">
                  <Trash2 :size="13" />
                </button>
              </div>
              <p class="mem-card-content">{{ mem.content }}</p>
              <div class="mem-card-meta mono">
                {{ mem.id.slice(0, 8) }}… · {{ new Date(mem.updated_at).toLocaleString() }}
              </div>
            </div>
          </div>
        </div>

        <!-- Right: Knowledge Search (Layer 3) + Tools -->
        <div class="panel-container">
          <div class="panel-badge layer-3-bg">Layer 3</div>
          <div class="panel-header">
            <h3><BookOpen :size="15" /> 知识库检索</h3>
          </div>
          <p class="panel-desc">从历史对话中提取的结构化知识</p>

          <div class="search-bar">
            <input
              v-model="searchQuery"
              class="input"
              placeholder="输入搜索查询…"
              @keydown.enter="handleSearch"
            />
            <select v-model="searchEntryType" class="input" style="width: 100px">
              <option value="">全部</option>
              <option value="episode">情节</option>
              <option value="event">事件</option>
              <option value="foresight">预见</option>
            </select>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!searchQuery.trim() || searching"
              @click="handleSearch"
            >
              <Search :size="14" /> 搜索
            </button>
          </div>

          <div class="search-results">
            <div v-if="searchResults.length === 0" class="empty-state">
              输入查询进行知识库混合搜索（向量 + 全文 + 时间衰减 + MMR）
            </div>
            <div v-for="r in searchResults" :key="r.id" class="search-hit card">
              <div class="hit-header">
                <span class="badge badge-accent">{{ r.score.toFixed(4) }}</span>
                <span
                  :class="[
                    'badge',
                    r.entry_type === 'episode'
                      ? 'badge-info'
                      : r.entry_type === 'event'
                        ? 'badge-success'
                        : 'badge-accent',
                  ]"
                >
                  {{ entryTypeLabels[r.entry_type] || r.entry_type }}
                </span>
                <span
                  v-if="r.title"
                  class="hit-title"
                >
                  {{ r.title }}
                </span>
              </div>
              <p class="hit-text">{{ r.content }}</p>
              <p class="hit-time mono">
                {{ r.id.slice(0, 8) }}… · {{ new Date(r.created_at).toLocaleString() }}
              </p>
            </div>
          </div>

          <!-- Context Build -->
          <div class="tool-section">
            <button class="btn btn-secondary btn-sm" @click="showContext = !showContext">
              <Layers :size="14" /> 上下文构建
            </button>

            <div v-if="showContext" class="tool-form card">
              <div class="form-row">
                <select v-model="selectedSessionId" class="input" style="width: 200px">
                  <option value="" disabled>选择会话…</option>
                  <option v-for="s in sessions" :key="s.id" :value="s.id">
                    {{ s.id.slice(0, 8) }}… ({{ s.token_count }} tokens)
                  </option>
                </select>
                <input
                  v-model="contextQuery"
                  class="input"
                  placeholder="查询（可选）…"
                />
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="!selectedSessionId || buildingCtx"
                  @click="handleBuildContext"
                >
                  构建
                </button>
              </div>
              <div v-if="contextResult" class="context-result">
                <div class="ctx-layer">
                  <h4 class="ctx-section-title">
                    <span class="layer-dot layer-1-dot" />
                    Layer 1 · Evergreen ({{ contextResult.evergreen_memories.length }})
                  </h4>
                  <div v-for="m in contextResult.evergreen_memories" :key="m.id" class="ctx-item card">
                    <span class="badge badge-accent" style="margin-right: 6px">
                      {{ categoryLabels[m.category] || m.category }}
                    </span>
                    {{ m.content }}
                  </div>
                  <div v-if="contextResult.evergreen_memories.length === 0" class="ctx-empty">无</div>
                </div>

                <div class="ctx-layer">
                  <h4 class="ctx-section-title">
                    <span class="layer-dot layer-3-dot" />
                    Layer 3 · Knowledge ({{ contextResult.relevant_knowledge.length }})
                  </h4>
                  <div v-for="r in contextResult.relevant_knowledge" :key="r.id" class="ctx-item card">
                    <span class="badge badge-accent" style="margin-right: 6px">{{ r.score.toFixed(3) }}</span>
                    {{ r.content }}
                  </div>
                  <div v-if="contextResult.relevant_knowledge.length === 0" class="ctx-empty">无</div>
                </div>

                <div class="ctx-layer">
                  <h4 class="ctx-section-title">
                    <span class="layer-dot layer-2-dot" />
                    Layer 2 · Messages ({{ contextResult.recent_messages.length }})
                  </h4>
                  <JsonViewer :data="contextResult.recent_messages" max-height="200px" />
                </div>
              </div>
            </div>
          </div>

          <!-- Memorize Pipeline -->
          <div class="tool-section">
            <button class="btn btn-secondary btn-sm" @click="showMemorize = !showMemorize">
              <Upload :size="14" /> Memorize 管线
            </button>

            <div v-if="showMemorize" class="tool-form card">
              <div class="form-group">
                <label>原始对话 JSON（将提取为 Episode / Event / Foresight）</label>
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
  max-width: 1300px;
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
  margin-bottom: 16px;
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

/* Architecture hint */
.arch-hint {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.layer-tag {
  padding: 4px 12px;
  border-radius: 100px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.layer-1 {
  background: rgba(217, 119, 87, 0.12);
  color: #d97757;
}

.layer-2 {
  background: rgba(26, 127, 100, 0.12);
  color: #1a7f64;
}

.layer-3 {
  background: rgba(74, 127, 191, 0.12);
  color: #4a7fbf;
}

/* Grid */
.explorer-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.panel-container {
  position: relative;
}

.panel-badge {
  position: absolute;
  top: -8px;
  right: 16px;
  padding: 2px 10px;
  border-radius: 100px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  z-index: 1;
}

.layer-1-bg {
  background: #d97757;
  color: white;
}

.layer-3-bg {
  background: #4a7fbf;
  color: white;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.panel-header h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
}

.panel-desc {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 12px;
}

/* Create form */
.create-form {
  margin-bottom: 12px;
}

.form-row {
  display: flex;
  gap: 8px;
}

/* Memory cards */
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

/* Search */
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
  margin-bottom: 12px;
}

.search-hit {
  padding: 12px;
}

.hit-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.hit-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
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

/* Tool sections */
.tool-section {
  margin-top: 12px;
}

.tool-form {
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

/* Context result */
.context-result {
  margin-top: 12px;
}

.ctx-layer {
  margin-bottom: 12px;
}

.ctx-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.layer-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.layer-1-dot {
  background: #d97757;
}

.layer-2-dot {
  background: #1a7f64;
}

.layer-3-dot {
  background: #4a7fbf;
}

.ctx-item {
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 6px;
}

.ctx-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 6px 0;
}

.empty-state {
  padding: 30px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
</style>
