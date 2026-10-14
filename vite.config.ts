import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// Served from the root of bridge.zenon.foo (public/CNAME), so
// base stays '/'. A Pages project site under /<repo>/ sets VITE_BASE.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [vue(), tailwindcss()],
  build: {
    target: 'es2022',
    sourcemap: false,
    // Keep small local fonts as files so production respects font-src 'self'.
    assetsInlineLimit: 0,
  },
  server: { port: 5190 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8', reporter: ['text', 'json-summary', 'html'],
      include: ['src/core/**/*.ts', 'src/state/operations.ts', 'src/state/reconcile.ts', 'src/znn/client.ts', 'src/znn/validation.ts'],
      exclude: ['src/core/dialog.ts'], // Focus/inertness is qualified in the real browser suite.
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
})
