import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [
      ['tests/unit/renderer/**', 'jsdom'],
      ['tests/unit/overlay/**', 'jsdom'],
    ],
    setupFiles: ['tests/unit/setup.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
