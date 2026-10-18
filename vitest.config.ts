import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Tests run inside workerd, so D1, KV, Queues and Web Crypto behave as they do in production.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.toml' },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
