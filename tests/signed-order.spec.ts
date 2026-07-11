import { test, expect } from '@playwright/test';
import { signOrderQuery, apiKey, SAMPLE_ORDER } from './helpers/sign';

/**
 * 签名下单功能测试：一条正向 + 四条负向，覆盖验签的完整判定分支。
 * 与 k6 的 05-signed-order 压测互补——这里断言「行为正确性」，那里断言「性能」。
 */
test.describe('签名下单验签', () => {
  test('有效签名 → 200 + orderId + status NEW', async ({ request }) => {
    const { query, signature } = signOrderQuery(SAMPLE_ORDER);
    const res = await request.post(`/api/v3/order?${query}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.orderId).toBeDefined();
    expect(body.symbol).toBe('BTCUSDT');
    expect(body.status).toBe('NEW');
  });

  test('篡改签名 → 401 / code -1022', async ({ request }) => {
    const { query } = signOrderQuery(SAMPLE_ORDER);
    const res = await request.post(`/api/v3/order?${query}&signature=deadbeefdeadbeef`, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).code).toBe(-1022);
  });

  test('错误 API Key → 401 / code -2015', async ({ request }) => {
    const { query, signature } = signOrderQuery(SAMPLE_ORDER);
    const res = await request.post(`/api/v3/order?${query}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': 'wrong-api-key' },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).code).toBe(-2015);
  });

  test('缺少 signature → 400 / code -1102', async ({ request }) => {
    const { query } = signOrderQuery(SAMPLE_ORDER);
    const res = await request.post(`/api/v3/order?${query}`, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe(-1102);
  });

  test('过期时间戳（超出 recvWindow）→ 400 / code -1021', async ({ request }) => {
    const { query, signature } = signOrderQuery(SAMPLE_ORDER, { timestamp: Date.now() - 60_000 });
    const res = await request.post(`/api/v3/order?${query}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe(-1021);
  });
});
