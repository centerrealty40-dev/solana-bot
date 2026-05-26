import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
  },
  esbuild: {
    target: 'es2022',
  },
});
