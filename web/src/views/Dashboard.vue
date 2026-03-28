<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { checkHealth } from '../api/health'
import {
  Activity,
  Users,
  MessageSquare,
  Brain,
  ArrowRight,
} from 'lucide-vue-next'
import { useRouter } from 'vue-router'

const router = useRouter()
const healthy = ref<boolean | null>(null)
const loading = ref(true)

onMounted(async () => {
  try {
    const { data } = await checkHealth()
    healthy.value = data.status === 'ok'
  } catch {
    healthy.value = false
  } finally {
    loading.value = false
  }
})

const features = [
  {
    title: 'Playground',
    desc: '交互式端到端演示：创建用户 → 对话 → 记忆提取 → 搜索 → 上下文构建',
    icon: MessageSquare,
    route: '/playground',
    color: 'var(--accent)',
  },
  {
    title: 'Memory Explorer',
    desc: '浏览和管理用户记忆，测试混合搜索，查看记忆分块和向量得分',
    icon: Brain,
    route: '/memory',
    color: 'var(--info)',
  },
  {
    title: 'Sessions',
    desc: '查看会话列表和消息时间线，监控 Token 用量和压缩状态',
    icon: Users,
    route: '/sessions',
    color: 'var(--success)',
  },
]
</script>

<template>
  <div class="dashboard">
    <header class="page-header">
      <div>
        <h1 class="page-title">Replica Console</h1>
        <p class="page-desc">AI 记忆管理服务 — 测试与演示控制台</p>
      </div>
      <div class="health-status">
        <div v-if="loading" class="health-dot loading" />
        <div v-else-if="healthy" class="health-dot online" />
        <div v-else class="health-dot offline" />
        <span class="health-text">
          {{ loading ? '检查中...' : healthy ? '服务在线' : '服务离线' }}
        </span>
      </div>
    </header>

    <section class="arch-section card">
      <h2 class="section-title">
        <Activity :size="18" />
        系统架构
      </h2>
      <pre class="arch-diagram mono">┌─────────────────────────────────────────────────────────┐
│                    FastAPI HTTP Server                   │
│                   (replica.main:app)                     │
├──────────┬──────────┬──────────┬──────────┬──────────────┤
│ /v1/users│/v1/sess- │/v1/sess- │/v1/memory│/v1/memories  │
│          │ ions     │ ions/msg │ /search  │ (memorize)   │
│          │          │          │ /context │              │
│          │          │          │ /build   │              │
└────┬─────┴────┬─────┴────┬─────┴────┬─────┴──────┬───────┘
     │          │          │          │            │
     ▼          ▼          ▼          ▼            ▼
  ┌──────────────────────────────────────────────────────┐
  │                  Service Layer                        │
  │  memory_service │ context_service │ compaction_svc    │
  │  embedding_svc  │ memorize_svc (MemorizePipeline)    │
  └────────────────────────┬─────────────────────────────┘
                           │
     ┌─────────────────────┼───────────────────────┐
     ▼                     ▼                       ▼
  ┌──────┐          ┌────────────┐          ┌────────────┐
  │ LLM  │          │ Embedding  │          │  Reranker  │
  │Server│          │  Server    │          │  Server    │
  └──────┘          └────────────┘          └────────────┘
                           │
                           ▼
              ┌──────────────────────┐
              │  PostgreSQL + pgvec  │
              └──────────────────────┘</pre>
    </section>

    <section class="features-grid">
      <div
        v-for="f in features"
        :key="f.route"
        class="feature-card card"
        @click="router.push(f.route)"
      >
        <div class="feature-icon" :style="{ color: f.color }">
          <component :is="f.icon" :size="24" />
        </div>
        <h3 class="feature-title">{{ f.title }}</h3>
        <p class="feature-desc">{{ f.desc }}</p>
        <div class="feature-link">
          进入 <ArrowRight :size="14" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dashboard {
  padding: 32px 40px;
  max-width: 1100px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 32px;
}

.page-title {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 4px;
}

.page-desc {
  color: var(--text-secondary);
  font-size: 14px;
}

.health-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
}

.health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.health-dot.online {
  background: var(--success);
  box-shadow: 0 0 6px var(--success);
}

.health-dot.offline {
  background: var(--error);
  box-shadow: 0 0 6px var(--error);
}

.health-dot.loading {
  background: var(--warning);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.health-text {
  font-size: 13px;
  color: var(--text-secondary);
}

.arch-section {
  margin-bottom: 32px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-secondary);
}

.arch-diagram {
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.4;
  overflow-x: auto;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.feature-card {
  cursor: pointer;
  transition: all 0.2s ease;
  border-color: var(--border-primary);
}

.feature-card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.feature-icon {
  margin-bottom: 12px;
}

.feature-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}

.feature-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 16px;
}

.feature-link {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
}
</style>
