import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      reportsDirectory: './coverage',
      // 阈值暂不设限，随测试覆盖率提升逐步提高
      // thresholds: { statements: 70, branches: 60, functions: 70, lines: 70 },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    retry: 1,
    passWithNoTests: false,
  },
})
