import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 15,
        branches: 15,
        functions: 40,
        lines: 15,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    retry: 1,
    passWithNoTests: false,
  },
})
