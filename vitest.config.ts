import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Task 1 lands no model tests yet; later tasks add test/*.test.ts.
    passWithNoTests: true,
  },
})
