import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // 显式声明项目根，避免 outDir 超出根目录时 Vite 复制源码
  root: __dirname,
  server: {
    proxy: {
      '/sessions': {
        target: 'http://localhost:3282',
        ws: true,
        changeOrigin: true,
      },
      '/todos': {
        target: 'http://localhost:3282',
        changeOrigin: true,
      },
      '/crons': {
        target: 'http://localhost:3282',
        changeOrigin: true,
      },
      '/skills': {
        target: 'http://localhost:3282',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3282',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3282',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, '../dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    // 生产构建时移除所有 console.* 调用，开发环境保留 debug 日志
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false,
        drop_debugger: false,
      },
    },
  },
})
