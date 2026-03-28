<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ data: unknown; maxHeight?: string }>()

const formatted = computed(() => {
  try {
    return JSON.stringify(props.data, null, 2)
  } catch {
    return String(props.data)
  }
})
</script>

<template>
  <pre
    class="json-viewer"
    :style="{ maxHeight: maxHeight ?? '400px' }"
  ><code>{{ formatted }}</code></pre>
</template>

<style scoped>
.json-viewer {
  background: var(--bg-primary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--accent);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
