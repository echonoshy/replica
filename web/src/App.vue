<script setup lang="ts">
import { onMounted } from 'vue'
import Sidebar from './components/layout/Sidebar.vue'
import { useAppStore } from './stores/app'
import { onApiLog } from './api/client'

const app = useAppStore()

onMounted(() => {
  onApiLog((log) => app.addApiLog(log))
})
</script>

<template>
  <Sidebar />
  <main class="main-content">
    <router-view />
  </main>
</template>

<style scoped>
.main-content {
  flex: 1;
  overflow-y: auto;
  height: 100vh;
}
</style>
