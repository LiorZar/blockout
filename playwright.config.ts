// Modified for the fork's HTTP MCP server in 2026; see MODIFICATIONS.md.
import { defineConfig } from '@playwright/test'

// Every spec spreads process.env into the app: run its HTTP MCP server on a
// free port, never the default 17480 a real Blockout may be holding.
process.env.BLOCKOUT_MCP_PORT ??= '0'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
