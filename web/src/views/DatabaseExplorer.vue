<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { getTables, getTableData, type TableInfo, type ColumnInfo } from '../api/admin'
import {
  Database,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Table2,
  Loader2,
} from 'lucide-vue-next'

const tables = ref<TableInfo[]>([])
const selectedTable = ref('')
const columns = ref<ColumnInfo[]>([])
const rows = ref<Record<string, unknown>[]>([])
const total = ref(0)
const pageSize = ref(50)
const currentPage = ref(1)
const loading = ref(false)
const loadingTables = ref(false)
const error = ref('')

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

onMounted(async () => {
  await loadTables()
})

async function loadTables() {
  loadingTables.value = true
  error.value = ''
  try {
    const { data } = await getTables()
    tables.value = data.tables
  } catch (e: any) {
    error.value = e.response?.data?.detail ?? '无法加载表列表'
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
  loading.value = true
  error.value = ''
  try {
    const offset = (currentPage.value - 1) * pageSize.value
    const { data } = await getTableData(selectedTable.value, pageSize.value, offset)
    columns.value = data.columns
    rows.value = data.rows
    total.value = data.total
  } catch (e: any) {
    error.value = e.response?.data?.detail ?? '无法加载表数据'
  } finally {
    loading.value = false
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
</script>

<template>
  <div class="db-explorer">
    <header class="page-header">
      <div>
        <h1 class="page-title">Database Explorer</h1>
        <p class="page-desc">浏览 PostgreSQL / pgvector 表数据</p>
      </div>
      <button class="btn btn-secondary btn-sm" @click="loadTables">
        <RefreshCw :size="14" /> 刷新
      </button>
    </header>

    <div v-if="error" class="error-msg">{{ error }}</div>

    <div class="explorer-layout">
      <!-- Left: Table List -->
      <div class="table-list-panel">
        <div class="panel-title">
          <Database :size="16" />
          <span>数据表</span>
          <Loader2 v-if="loadingTables" :size="14" class="spin" />
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
          <div v-if="tables.length === 0 && !loadingTables" class="empty-hint">
            暂无表数据
          </div>
        </div>
      </div>

      <!-- Right: Table Data -->
      <div class="data-panel">
        <template v-if="selectedTable">
          <div class="data-header">
            <h3 class="data-title mono">{{ selectedTable }}</h3>
            <div class="data-stats">
              <span class="badge badge-accent">{{ total }} 行</span>
              <span class="badge badge-info">{{ columns.length }} 列</span>
            </div>
          </div>

          <div v-if="loading" class="loading-state">
            <Loader2 :size="24" class="spin" />
            <span>加载中…</span>
          </div>

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
                  <td
                    v-for="col in columns"
                    :key="col.name"
                    :class="cellClass(col)"
                    :title="formatCell(row[col.name])"
                  >
                    {{ formatCell(row[col.name]) }}
                  </td>
                </tr>
                <tr v-if="rows.length === 0">
                  <td :colspan="columns.length" class="empty-cell">表中暂无数据</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- Pagination -->
          <div v-if="total > 0" class="pagination">
            <button class="btn btn-ghost btn-sm" :disabled="currentPage <= 1" @click="prevPage">
              <ChevronLeft :size="16" />
            </button>
            <span class="page-info mono">
              {{ currentPage }} / {{ totalPages }}
            </span>
            <button class="btn btn-ghost btn-sm" :disabled="currentPage >= totalPages" @click="nextPage">
              <ChevronRight :size="16" />
            </button>
            <span class="row-info">
              显示 {{ (currentPage - 1) * pageSize + 1 }}–{{ Math.min(currentPage * pageSize, total) }}，共 {{ total }} 条
            </span>
          </div>
        </template>

        <div v-else class="empty-state">
          <Database :size="40" class="empty-icon" />
          <p>选择一张表查看数据</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.db-explorer {
  padding: 24px 28px;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
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

.error-msg {
  color: var(--error);
  font-size: 13px;
  padding: 8px 0;
}

.explorer-layout {
  display: flex;
  gap: 20px;
  flex: 1;
  min-height: 0;
}

.table-list-panel {
  width: 260px;
  min-width: 260px;
  display: flex;
  flex-direction: column;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.table-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.table-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid transparent;
}

.table-item:hover {
  background: var(--bg-hover);
}

.table-item.selected {
  background: var(--accent-muted);
  border-color: var(--accent);
}

.table-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.table-item.selected .table-icon {
  color: var(--accent);
}

.table-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-count {
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 100px;
}

.data-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.data-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.data-title {
  font-size: 16px;
  font-weight: 600;
}

.data-stats {
  display: flex;
  gap: 8px;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 60px;
  color: var(--text-tertiary);
  font-size: 14px;
}

.table-wrapper {
  flex: 1;
  overflow: auto;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  background: var(--bg-card);
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.data-table th {
  position: sticky;
  top: 0;
  background: var(--bg-tertiary);
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-primary);
  white-space: nowrap;
  z-index: 1;
}

.th-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.th-name {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-primary);
}

.th-type {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}

.col-vector .th-name {
  color: var(--info);
}

.data-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-primary);
}

.data-table tbody tr:hover {
  background: var(--bg-hover);
}

.cell-uuid {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
}

.cell-number {
  font-family: var(--font-mono);
  text-align: right;
}

.cell-time {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
}

.cell-vector {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--info);
  max-width: 200px;
}

.empty-cell {
  text-align: center;
  color: var(--text-tertiary);
  padding: 40px 20px !important;
}

.pagination {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 0;
}

.page-info {
  font-size: 13px;
  color: var(--text-secondary);
}

.row-info {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-left: auto;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 12px;
  color: var(--text-tertiary);
  font-size: 14px;
}

.empty-icon {
  opacity: 0.3;
}

.empty-hint {
  padding: 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
