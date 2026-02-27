import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'node22',
    lib: {
      entry: 'src/index.tsx',
      formats: ['es'],
      fileName: 'index'
    },
    rollupOptions: {
      external: [
        'hono',
        '@hono/node-server',
        '@hono/node-server/serve-static',
        'pg',
        /^node:/ // Node.js標準モジュールをすべて除外
      ]
    }
  }
})