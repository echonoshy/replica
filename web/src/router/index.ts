import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: () => import('../views/Dashboard.vue'),
    },
    {
      path: '/playground',
      name: 'playground',
      component: () => import('../views/Playground.vue'),
    },
    {
      path: '/memory',
      name: 'memory',
      component: () => import('../views/MemoryExplorer.vue'),
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: () => import('../views/Sessions.vue'),
    },
    {
      path: '/database',
      name: 'database',
      component: () => import('../views/DatabaseExplorer.vue'),
    },
  ],
})

export default router
