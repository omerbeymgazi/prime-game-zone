import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiProxy = {
  target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:5000',
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (proxyRequest, request) => {
      const originHost = request.headers.origin?.match(/^https?:\/\/([^/]+)$/)?.[1]
      if (originHost && originHost === request.headers.host) {
        proxyRequest.setHeader('origin', 'http://localhost:5173')
      }
    })
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: ['emmaline-nasopharyngeal-variously.ngrok-free.dev'],
    proxy: {
      '/api': apiProxy,
    },
  },
  preview: {
    host: true,
    port: 5173,
    proxy: {
      '/api': apiProxy,
    },
  },
})
