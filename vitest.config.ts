import { defineConfig } from 'vitest/config'

// The tests run the simulations headless in Node: the 2D world, the peoples, the 3D powers.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
})
