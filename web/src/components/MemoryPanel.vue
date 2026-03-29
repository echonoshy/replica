<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAppStore } from '../stores/app'
import {
  getEvergreenMemories,
  createEvergreenMemory,
  deleteEvergreenMemory,
  searchKnowledge,
  type KnowledgeSearchResult,
} from '../api/memory'
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Search,
  Sparkles,
  RefreshCw,
} from 'lucide-vue-next'

const store = useAppStore()

const expandedSections = ref({ evergreen: true, context: true, knowledge: true })

const newContent = ref('')
const newCategory = ref<'fact' | 'preference' | 'relationship' | 'goal'>('fact')
const addingMemory = ref(false)

const searchQuery = ref('')
const searchEntryType = ref('')
const searchResults = ref<KnowledgeSearchResult[]>([])
const searching = ref(false)

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

function toggleSection(key: keyof typeof expandedSections.value) {
  expandedSections.value[key] = !expandedSections.value[key]
}

async function refreshEvergreen() {
  if (!store.currentUser) return
  const { data } = await getEvergreenMemories(store.currentUser.id)
  store.setEvergreen(data)
}

async function handleAddEvergreen() {
  if (!store.currentUser || !newContent.value.trim() || addingMemory.value) return
  addingMemory.value = true
  try {
    await createEvergreenMemory(store.currentUser.id, newContent.value.trim(), newCategory.value)
    newContent.value = ''
    await refreshEvergreen()
  } finally {
    addingMemory.value = false
  }
}

async function handleDeleteEvergreen(memoryId: string) {
  await deleteEvergreenMemory(memoryId)
  await refreshEvergreen()
}

async function handleSearch() {
  if (!store.currentUser || !searchQuery.value.trim() || searching.value) return
  searching.value = true
  try {
    const { data } = await searchKnowledge(
      store.currentUser.id,
      searchQuery.value.trim(),
      10,
      searchEntryType.value || undefined,
    )
    searchResults.value = data
  } finally {
    searching.value = false
  }
}

const contextEvergreen = computed(() => store.chatContext?.evergreen ?? [])
const contextKnowledge = computed(() => store.chatContext?.knowledge ?? [])

function isEvergreenUsed(id: string): boolean {
  return contextEvergreen.value.some((e) => e.id === id)
}

watch(() => store.currentUser, () => {
  searchResults.value = []
})
</script>

<template>
  <aside class="memory-panel">
    <div class="panel-title">
      <Sparkles :size="16" />
      <span>记忆面板</span>
    </div>

    <div v-if="!store.hasUser" class="panel-empty">
      选择用户后查看记忆
    </div>

    <div v-else class="panel-content">
      <!-- Layer 1: Evergreen -->
      <div class="section">
        <div class="section-header" @click="toggleSection('evergreen')">
          <component :is="expandedSections.evergreen ? ChevronDown : ChevronRight" :size="14" />
          <span class="layer-dot" style="background: #D97757" />
          <span class="section-label">Layer 1 · Evergreen</span>
          <span class="section-count">{{ store.evergreen.length }}</span>
          <button class="btn-icon" @click.stop="refreshEvergreen" title="刷新">
            <RefreshCw :size="12" />
          </button>
        </div>

        <div v-if="expandedSections.evergreen" class="section-body">
          <div class="eg-add-form">
            <div class="eg-add-row">
              <select v-model="newCategory" class="eg-select">
                <option value="fact">事实</option>
                <option value="preference">偏好</option>
                <option value="relationship">关系</option>
                <option value="goal">目标</option>
              </select>
              <input
                v-model="newContent"
                class="eg-input"
                placeholder="添加长期记忆..."
                @keydown.enter="handleAddEvergreen"
              />
              <button
                class="btn-icon add"
                :disabled="!newContent.trim() || addingMemory"
                @click="handleAddEvergreen"
              >
                <Plus :size="14" />
              </button>
            </div>
          </div>

          <div class="eg-list">
            <div v-if="store.evergreen.length === 0" class="section-empty">暂无长期记忆</div>
            <div
              v-for="mem in store.evergreen"
              :key="mem.id"
              :class="['eg-item', { used: isEvergreenUsed(mem.id) }]"
            >
              <div class="eg-item-header">
                <span class="badge badge-accent" style="font-size:10px">
                  {{ categoryLabels[mem.category] || mem.category }}
                </span>
                <span v-if="isEvergreenUsed(mem.id)" class="used-indicator" title="本轮对话已注入">已注入</span>
                <button class="btn-icon delete" @click="handleDeleteEvergreen(mem.id)">
                  <Trash2 :size="12" />
                </button>
              </div>
              <p class="eg-item-content">{{ mem.content }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Layer 2: Session Context -->
      <div class="section">
        <div class="section-header" @click="toggleSection('context')">
          <component :is="expandedSections.context ? ChevronDown : ChevronRight" :size="14" />
          <span class="layer-dot" style="background: #1A7F64" />
          <span class="section-label">Layer 2 · 会话上下文</span>
        </div>

        <div v-if="expandedSections.context" class="section-body">
          <template v-if="store.currentSession">
            <div class="ctx-stats">
              <div class="ctx-stat">
                <span class="ctx-stat-label">Token 用量</span>
                <span class="ctx-stat-value mono">{{ store.currentSession.token_count.toLocaleString() }}</span>
              </div>
              <div class="ctx-stat">
                <span class="ctx-stat-label">压缩次数</span>
                <span class="ctx-stat-value mono">{{ store.currentSession.compaction_count }}</span>
              </div>
              <div class="ctx-stat">
                <span class="ctx-stat-label">消息数</span>
                <span class="ctx-stat-value mono">{{ store.messages.length }}</span>
              </div>
            </div>
          </template>
          <div v-else class="section-empty">未选择会话</div>
        </div>
      </div>

      <!-- Layer 3: Knowledge -->
      <div class="section">
        <div class="section-header" @click="toggleSection('knowledge')">
          <component :is="expandedSections.knowledge ? ChevronDown : ChevronRight" :size="14" />
          <span class="layer-dot" style="background: #4A7FBF" />
          <span class="section-label">Layer 3 · 知识库</span>
        </div>

        <div v-if="expandedSections.knowledge" class="section-body">
          <!-- Context Knowledge from chat -->
          <div v-if="contextKnowledge.length > 0" class="kb-context">
            <div class="kb-context-title">本轮检索结果</div>
            <div v-for="k in contextKnowledge" :key="k.id" class="kb-item context-item">
              <div class="kb-item-header">
                <span class="badge badge-accent" style="font-size:10px">{{ k.score }}</span>
                <span
                  :class="['badge', k.entry_type === 'episode' ? 'badge-info' : k.entry_type === 'event' ? 'badge-success' : 'badge-accent']"
                  style="font-size:10px"
                >
                  {{ entryTypeLabels[k.entry_type] || k.entry_type }}
                </span>
              </div>
              <p class="kb-item-content">{{ k.content }}</p>
            </div>
          </div>

          <!-- Manual search -->
          <div class="kb-search">
            <div class="kb-search-row">
              <input
                v-model="searchQuery"
                class="eg-input"
                placeholder="搜索知识库..."
                @keydown.enter="handleSearch"
              />
              <select v-model="searchEntryType" class="eg-select" style="width:70px">
                <option value="">全部</option>
                <option value="episode">情节</option>
                <option value="event">事件</option>
                <option value="foresight">预见</option>
              </select>
              <button
                class="btn-icon"
                :disabled="!searchQuery.trim() || searching"
                @click="handleSearch"
              >
                <Search :size="14" />
              </button>
            </div>
          </div>

          <div class="kb-results">
            <div v-for="r in searchResults" :key="r.id" class="kb-item">
              <div class="kb-item-header">
                <span class="badge badge-accent" style="font-size:10px">{{ r.score.toFixed(3) }}</span>
                <span
                  :class="['badge', r.entry_type === 'episode' ? 'badge-info' : r.entry_type === 'event' ? 'badge-success' : 'badge-accent']"
                  style="font-size:10px"
                >
                  {{ entryTypeLabels[r.entry_type] || r.entry_type }}
                </span>
                <span v-if="r.title" class="kb-item-title">{{ r.title }}</span>
              </div>
              <p class="kb-item-content">{{ r.content }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.memory-panel {
  height: 100vh;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 16px 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-primary);
}

.panel-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.section {
  border-bottom: 1px solid var(--border-subtle);
}

.section:last-child {
  border-bottom: none;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
}

.section-header:hover {
  background: var(--bg-hover);
}

.layer-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.section-label {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.section-count {
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 100px;
  font-family: var(--font-mono);
}

.section-body {
  padding: 0 14px 12px;
}

.section-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 12px 0;
}

/* Evergreen */
.eg-add-form {
  margin-bottom: 8px;
}

.eg-add-row {
  display: flex;
  gap: 4px;
}

.eg-select {
  padding: 4px 6px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  font-size: 11px;
  background: var(--bg-input);
  color: var(--text-primary);
  outline: none;
  width: 60px;
}

.eg-input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  font-size: 12px;
  background: var(--bg-input);
  color: var(--text-primary);
  outline: none;
  min-width: 0;
}

.eg-input:focus {
  border-color: var(--border-focus);
}

.eg-input::placeholder {
  color: var(--text-tertiary);
}

.btn-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-primary);
  background: var(--bg-input);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.1s;
  flex-shrink: 0;
}

.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-icon:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.btn-icon.add {
  border-color: var(--accent);
  color: var(--accent);
}

.btn-icon.add:hover {
  background: var(--accent-muted);
}

.btn-icon.delete {
  border: none;
  width: 22px;
  height: 22px;
  color: var(--text-tertiary);
}

.btn-icon.delete:hover {
  color: var(--error);
  background: var(--error-muted);
}

.eg-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
}

.eg-item {
  padding: 8px 10px;
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}

.eg-item.used {
  border-color: var(--accent);
  background: var(--accent-muted);
}

.eg-item-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

.eg-item-header .btn-icon {
  margin-left: auto;
}

.used-indicator {
  font-size: 10px;
  color: var(--accent);
  font-weight: 500;
}

.eg-item-content {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
}

/* Context stats */
.ctx-stats {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ctx-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
}

.ctx-stat-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.ctx-stat-value {
  font-size: 13px;
  font-weight: 600;
}

/* Knowledge */
.kb-context {
  margin-bottom: 10px;
}

.kb-context-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}

.kb-search {
  margin-bottom: 8px;
}

.kb-search-row {
  display: flex;
  gap: 4px;
}

.kb-results {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
}

.kb-item {
  padding: 8px 10px;
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}

.kb-item.context-item {
  border-color: var(--info);
  border-left: 3px solid var(--info);
}

.kb-item-header {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.kb-item-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

.kb-item-content {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
}
</style>
