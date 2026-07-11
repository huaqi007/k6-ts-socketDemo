import { defineConfig } from '@playwright/test';

/**
 * playwright.config.ts — E2E / API 功能测试（与 k6 压测互补）
 * ============================================================================
 * k6 负责「性能/负载」，Playwright 负责「功能正确性」——两者打同一个 mock-server。
 *
 * webServer 自动拉起两个靶机实例：
 *   - 8080：正常靶机（健康检查 / 签名下单 / WS 深度订阅）
 *   - 8081：限流靶机（MOCK_ORDER_RPS=5），专供 429 限流用例
 * 测试结束自动回收，CI 无需手动管理进程。
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'node scripts/mock-server.js',
      url: 'http://localhost:8080/api/v1/health',
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
    },
    {
      command: 'node scripts/mock-server.js',
      url: 'http://localhost:8081/api/v1/health',
      reuseExistingServer: !process.env.CI,
      env: { PORT: '8081', MOCK_ORDER_RPS: '5' },
      stdout: 'ignore',
    },
  ],
});
