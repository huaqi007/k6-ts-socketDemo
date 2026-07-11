import { test, expect } from '@playwright/test';

/**
 * WebSocket 深度订阅功能测试（真实浏览器 WebSocket）
 * ============================================================================
 * 用 Playwright 的 Chromium 页面上下文，通过浏览器原生 WebSocket 连接靶机，
 * 断言：订阅确认 → 深度快照结构有效（bids/asks 非空）→ 增量序列号连续（pu==上一帧u）。
 * 与 k6 的 WS 压测（并发/延迟视角）互补——这里验证「协议与数据正确性」。
 */
test.describe('WebSocket 深度行情', () => {
  test('订阅后收到有效深度快照且序列号连续', async ({ page }) => {
    const result = await page.evaluate(async () => {
      return await new Promise<any>((resolve) => {
        const socket = new WebSocket('ws://localhost:8080/ws');
        const depth: any[] = [];
        let subscribed = false;

        const timer = setTimeout(() => {
          try { socket.close(); } catch (_) {}
          resolve({ subscribed, depth });
        }, 6000);

        socket.onopen = () => {
          socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['btcusdt@depth'], id: 1 }));
        };
        socket.onmessage = (e: MessageEvent) => {
          const m = JSON.parse(e.data as string);
          if (m.method === 'SUBSCRIBED') {
            subscribed = true;
            return;
          }
          if (m.e === 'depthUpdate') {
            depth.push(m);
            if (depth.length >= 3) {
              clearTimeout(timer);
              try { socket.close(); } catch (_) {}
              resolve({ subscribed, depth });
            }
          }
        };
      });
    });

    // 收到订阅确认
    expect(result.subscribed).toBe(true);
    // 至少 3 帧深度
    expect(result.depth.length).toBeGreaterThanOrEqual(3);

    // 首帧深度结构有效
    const first = result.depth[0];
    expect(first.s).toBe('BTCUSDT');
    expect(Array.isArray(first.bids)).toBe(true);
    expect(first.bids.length).toBeGreaterThan(0);
    expect(first.asks.length).toBeGreaterThan(0);

    // 增量序列号连续：后一帧 pu 应等于前一帧 u
    expect(result.depth[1].pu).toBe(result.depth[0].u);
    expect(result.depth[2].pu).toBe(result.depth[1].u);
  });
});
