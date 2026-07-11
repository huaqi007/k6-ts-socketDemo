import { test, expect } from '@playwright/test';

test.describe('健康检查', () => {
  test('GET /api/v1/health → 200 {status:ok}', async ({ request }) => {
    const res = await request.get('/api/v1/health');
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });
});
