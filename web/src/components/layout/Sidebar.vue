<script setup lang="ts">
import { useRoute } from 'vue-router'
import {
  LayoutDashboard,
  MessageSquareCode,
  Brain,
  MessagesSquare,
  Database,
} from 'lucide-vue-next'

const route = useRoute()

const navItems = [
  { path: '/', name: 'Dashboard', icon: LayoutDashboard },
  { path: '/playground', name: 'Playground', icon: MessageSquareCode },
  { path: '/memory', name: 'Memory', icon: Brain },
  { path: '/sessions', name: 'Sessions', icon: MessagesSquare },
  { path: '/database', name: 'Database', icon: Database },
]
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-brand">
      <div class="brand-icon">R</div>
      <div class="brand-text">
        <span class="brand-name">Replica</span>
        <span class="brand-sub">Memory Console</span>
      </div>
    </div>

    <nav class="sidebar-nav">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        :class="['nav-item', { active: route.path === item.path }]"
      >
        <component :is="item.icon" :size="18" :stroke-width="1.8" />
        <span>{{ item.name }}</span>
      </router-link>
    </nav>

    <div class="sidebar-footer">
      <div class="version-badge">v0.1.0</div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 220px;
  min-width: 220px;
  height: 100vh;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  padding: 16px 0;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px 20px;
  border-bottom: 1px solid var(--border-primary);
  margin-bottom: 12px;
}

.brand-icon {
  width: 34px;
  height: 34px;
  background: var(--accent);
  color: var(--text-inverse);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 16px;
}

.brand-text {
  display: flex;
  flex-direction: column;
}

.brand-name {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.2;
  color: var(--text-primary);
}

.brand-sub {
  font-size: 11px;
  color: var(--text-tertiary);
}

.sidebar-nav {
  flex: 1;
  padding: 0 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s ease;
  text-decoration: none;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--accent-muted);
  color: var(--accent);
}

.sidebar-footer {
  padding: 12px 20px 0;
  border-top: 1px solid var(--border-primary);
}

.version-badge {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}
</style>
