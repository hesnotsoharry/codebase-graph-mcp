import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false,
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 20000,
    teardownTimeout: 5000,
  },
});
