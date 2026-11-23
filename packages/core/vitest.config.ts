import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The shared suites import `nostro`; point them at this package's source
    // so tests, conformance suites and coverage all see one copy of every class.
    alias: {
      '@nostro-labs/store-conformance': fileURLToPath(new URL('../store-conformance/src/index.ts', import.meta.url)),
      'nostro-testkit': fileURLToPath(new URL('../testkit/src/index.ts', import.meta.url)),
      '@nostro-labs/nostro': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
        // Every downstream amount and record passes through these; hold them high.
        'src/money/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/model/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/store/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
})
