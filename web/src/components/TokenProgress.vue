<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  current: number
  softThreshold?: number
  hardThreshold?: number
}>()

const soft = computed(() => props.softThreshold ?? 12000)
const hard = computed(() => props.hardThreshold ?? 16000)
const max = computed(() => hard.value * 1.2)
const pct = computed(() => Math.min((props.current / max.value) * 100, 100))
const softPct = computed(() => (soft.value / max.value) * 100)
const hardPct = computed(() => (hard.value / max.value) * 100)

const barColor = computed(() => {
  if (props.current >= hard.value) return 'var(--error)'
  if (props.current >= soft.value) return 'var(--warning)'
  return 'var(--success)'
})

const statusText = computed(() => {
  if (props.current >= hard.value) return 'Hard Compaction'
  if (props.current >= soft.value) return 'Soft Compaction'
  return 'Normal'
})
</script>

<template>
  <div class="token-progress">
    <div class="progress-header">
      <span class="progress-label">Token 用量</span>
      <span class="progress-value mono">{{ current.toLocaleString() }}</span>
    </div>
    <div class="progress-track">
      <div class="progress-bar" :style="{ width: pct + '%', background: barColor }" />
      <div class="threshold-mark soft" :style="{ left: softPct + '%' }" title="Soft Threshold">
        <span class="threshold-label">{{ soft.toLocaleString() }}</span>
      </div>
      <div class="threshold-mark hard" :style="{ left: hardPct + '%' }" title="Hard Threshold">
        <span class="threshold-label">{{ hard.toLocaleString() }}</span>
      </div>
    </div>
    <div class="progress-footer">
      <span :class="['status-text', { warning: current >= soft, danger: current >= hard }]">
        {{ statusText }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.token-progress {
  padding: 12px 0;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.progress-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.progress-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.progress-track {
  position: relative;
  height: 6px;
  background: var(--bg-primary);
  border-radius: 3px;
  overflow: visible;
}

.progress-bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease, background 0.3s ease;
}

.threshold-mark {
  position: absolute;
  top: -4px;
  width: 1px;
  height: 14px;
  transform: translateX(-50%);
}

.threshold-mark.soft {
  background: var(--warning);
  opacity: 0.6;
}

.threshold-mark.hard {
  background: var(--error);
  opacity: 0.6;
}

.threshold-label {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 9px;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  white-space: nowrap;
}

.progress-footer {
  margin-top: 12px;
}

.status-text {
  font-size: 11px;
  font-weight: 500;
  color: var(--success);
}
.status-text.warning { color: var(--warning); }
.status-text.danger { color: var(--error); }
</style>
