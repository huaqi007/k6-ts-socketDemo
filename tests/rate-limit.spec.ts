import { test, expect } from '@playwright/test';
import { signOrderQuery, apiKey, SAMPLE_ORDER } from './helpers/sign';

/**
 * 限流功能测试：打限流靶机（8081, MOCK_ORDER_RPS=5），并发突发请求，
 * 断言超限响应符合 Binance 约定：HTTP 429/418 + Retry-After 头 + code -1003。
 * 与 k6 的 06-rate-limit（退避重试的性能视角）互补。
 */
const RL_BASE = 'http://localhost:8081';

test.describe('REST 限流', () => {
  test('突发请求触发 429 + Retry-After + code -1003', async ({ request }) => {
    // 并发发送远超 5rps 上限的请求
    const responses = await Promise.all(
      Array.from({ length: 30 }).map(() => {
        const { query, signature } = signOrderQuery(SAMPLE_ORDER);
        return request.post(`${RL_BASE}/api/v3/order?${query}&signature=${signature}`, {
          headers: { 'X-MBX-APIKEY': apiKey },
        });
      })
    );

    const limited = responses.filter((r) => r.status() === 429 || r.status() === 418);
    // 必须真的触发限流
    expect(limited.length).toBeGreaterThan(0);

    // 校验首个被限流响应的头与错误码
    const r = limited[0];
    expect(r.headers()['retry-after']).toBeDefined();
    expect(Number(r.headers()['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await r.json()).code).toBe(-1003);

    // 未被限流的请求应正常成交（证明限流只拦截超额部分）
    const ok = responses.filter((r) => r.status() === 200);
    expect(ok.length).toBeGreaterThan(0);
  });
});
