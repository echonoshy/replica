import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 8780,
    proxy: {
      '/v1': {
        target: 'http://localhost:8790',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8790',
        changeOrigin: true,
      },
    },
  },
})
