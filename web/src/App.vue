<script setup lang="ts">
import { onMounted } from 'vue'
import { useAppStore } from './stores/app'
import { onApiLog } from './api/client'

const app = useAppStore()

onMounted(() => {
  onApiLog((log) => app.addApiLog(log))
})
</script>

<template>
  <router-view />
</template>
