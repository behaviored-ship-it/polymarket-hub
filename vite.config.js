import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, proxy /api/* to the same endpoints Vercel will serve in production.
// This lets the frontend use relative URLs (/api/gamma, /api/positions, /api/clob)
// in both environments — no per-env URL switching.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/gamma': {
        target: 'https://gamma-api.polymarket.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/gamma/, '/markets'),
      },
      '/api/clob': {
        target: 'https://clob.polymarket.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/clob/, '/book'),
      },
      '/api/positions': {
        target: 'https://polymarket-hub.vercel.app',
        changeOrigin: true,
      },
      '/api/heisenberg': {
        target: 'https://polymarket-hub.vercel.app',
        changeOrigin: true,
      },
    },
  },
})
