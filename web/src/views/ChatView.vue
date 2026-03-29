<script setup lang="ts">
import { ref } from 'vue'
import SessionSidebar from '../components/SessionSidebar.vue'
import ChatPanel from '../components/ChatPanel.vue'
import MemoryPanel from '../components/MemoryPanel.vue'

const memoryWidth = ref(360)
const isDragging = ref(false)

function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  isDragging.value = true
  const startX = e.clientX
  const startWidth = memoryWidth.value

  function onMouseMove(ev: MouseEvent) {
    const delta = startX - ev.clientX
    memoryWidth.value = Math.max(240, Math.min(800, startWidth + delta))
  }
  function onMouseUp() {
    isDragging.value = false
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}
</script>

<template>
  <div :class="['chat-layout', { dragging: isDragging }]">
    <SessionSidebar />
    <ChatPanel />
    <div class="resize-handle" @mousedown="onMouseDown">
      <div class="resize-line" />
    </div>
    <MemoryPanel :style="{ width: memoryWidth + 'px', minWidth: memoryWidth + 'px' }" />
  </div>
</template>

<style scoped>
.chat-layout {
  display: flex;
  height: 100vh;
  width: 100%;
}

.chat-layout.dragging {
  cursor: col-resize;
  user-select: none;
}

.resize-handle {
  width: 6px;
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
  transition: background 0.15s;
}

.resize-handle:hover,
.chat-layout.dragging .resize-handle {
  background: var(--accent-muted);
}

.resize-line {
  width: 2px;
  height: 32px;
  border-radius: 1px;
  background: var(--border-primary);
  transition: background 0.15s, height 0.15s;
}

.resize-handle:hover .resize-line,
.chat-layout.dragging .resize-line {
  background: var(--accent);
  height: 48px;
}
</style>
