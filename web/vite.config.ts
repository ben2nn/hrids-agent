import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
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
    },
  },
  build: {
    outDir: 'dist',
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
