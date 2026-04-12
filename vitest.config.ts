import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      RESEND_API_KEY: 're_test_fake_key',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
