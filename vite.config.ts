import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { dependencyNoticesPlugin } from './scripts/dependency-notices.ts'

// Served from the root of bridge.zenon.foo (public/CNAME), so
// base stays '/'. A Pages project site under /<repo>/ sets VITE_BASE.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [vue(), tailwindcss(), dependencyNoticesPlugin()],
  cacheDir: process.env.QUALIFICATION_CACHE_DIR || 'node_modules/.vite',
  envDir: process.env.QUALIFICATION_ENV_DIR,
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
      include: ['src/core/**/*.ts', 'src/state/{operations,reconcile,zenon,evm,bridge,activity}.ts', 'src/evm/**/*.ts', 'src/wallet/**/*.ts', 'src/znn/client.ts', 'src/znn/validation.ts', 'scripts/dependency-notices.ts'],
      reportsDirectory: process.env.QUALIFICATION_COVERAGE_DIR || 'coverage',
      exclude: ['src/core/dialog.ts'], // Focus/inertness is qualified in the real browser suite.
      thresholds: {
        lines: 80, functions: 80, statements: 80, branches: 70,
        'src/wallet/**': { lines: 90, functions: 90, statements: 90, branches: 70 },
        'src/evm/transactions.ts': { lines: 95, functions: 95, statements: 95, branches: 90 },
        'src/state/zenon.ts': { lines: 85, functions: 80, statements: 80, branches: 70 },
      },
    },
  },
})
