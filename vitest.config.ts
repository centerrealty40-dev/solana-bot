import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    setupFiles: ['tests/setup.ts'],
  },
  esbuild: {
    target: 'es2022',
  },
});
