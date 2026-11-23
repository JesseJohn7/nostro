import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@nostro-labs/store-conformance': fileURLToPath(new URL('../store-conformance/src/index.ts', import.meta.url)),
      '@nostro-labs/nostro': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      'nostro-testkit': fileURLToPath(new URL('../testkit/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
})
