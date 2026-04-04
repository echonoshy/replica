import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
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
