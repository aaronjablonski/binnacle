import { defineConfig } from 'vitest/config'

export default defineConfig({
  // mod/tsconfig.json extends the engine-generated types (gitignored), which CI does not have.
  tsconfig: 'tsconfig.vitest.json',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
