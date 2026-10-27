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

async function ngrokHost() {
  try {
    const response = await fetch(process.env.NGROK_API_URL || 'http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(1000),
    })
    if (!response.ok) return null
    const { tunnels = [] } = await response.json()
    const tunnel = tunnels.find((candidate) => {
      if (candidate.proto !== 'https') return false
      const address = String(candidate.config?.addr || '')
      const target = /^https?:\/\//i.test(address) ? address : `http://${address}`
      try {
        const parsed = new URL(target)
        return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === 5173
      } catch {
        return address.endsWith(':5173') || address === '5173'
      }
    })
    return tunnel ? new URL(tunnel.public_url).hostname : null
  } catch {
    return null
  }
}

export default defineConfig(async () => {
  const activeNgrokHost = await ngrokHost()
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      allowedHosts: [
        'emmaline-nasopharyngeal-variously.ngrok-free.dev',
        ...(activeNgrokHost ? [activeNgrokHost] : []),
      ],
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
  }
})
