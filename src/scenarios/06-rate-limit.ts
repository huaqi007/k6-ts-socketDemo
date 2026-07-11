/**
 * 06-rate-limit.ts — REST 限流（429 / Retry-After）测试
 * ============================================================================
 * 交易所对下单接口有严格的 IP 速率限制，超限会返回 HTTP 429（Binance code -1003）
 * 并在 `Retry-After` 头告知客户端应等待多少秒；持续超限升级为 HTTP 418 临时封禁。
 *
 * 本场景验证「客户端在被限流时的正确退避行为」——这是交易所测试的高频考点：
 *   1. 以远超服务端上限的到达率发压，主动触发 429；
 *   2. 命中 429 时读取 `Retry-After`，据此 sleep 后重试（最多 N 次）；
 *   3. 记录：限流命中数、Retry-After 分布、重试后的「最终成功率」。
 *
 * ⚠️ 需以限流模式启动靶机：
 *     MOCK_ORDER_RPS=50 node scripts/mock-server.js
 * 然后：
 *     npm run test:ratelimit
 *
 * thresholds 断言「即使被限流，遵守 Retry-After 重试后最终仍应基本成功」，
 * 从而证明客户端的限流处理逻辑是健壮的。
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { getBaseUrl } from '../config/env';
import { metrics } from '../lib/metrics';
import { randomTemplate, signOrder } from '../modules/pre-signer';

export const options = {
  scenarios: {
    // 「突发高于限额、均值低于限额」的真实流量模型：
    // 先冲高触发 429，再回落到限额以下，让积压请求在低负载期靠退避重试成交。
    burst_orders: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { target: 120, duration: '2s' },  // 冲高，稳定超过 50rps 上限 → 触发 429
        { target: 20, duration: '3s' },   // 快速回落到限额以下
        { target: 20, duration: '20s' },  // 低负载期：积压请求遵守 Retry-After 重试后成交
      ],
    },
  },
  thresholds: {
    // 1) 限流必须真的被触发，否则该负向用例没有意义
    order_rate_limited: ['count>0'],
    // 2) 客户端 100% 正确识别 429/418：读到 Retry-After 且错误码为 -1003
    checks: ['rate>0.99'],
    // 3) 突发过后遵守退避重试，最终成功率应保持高位（证明客户端限流处理健壮）
    order_eventual_success_rate: ['rate>0.9'],
  },
};

const BASE_URL = getBaseUrl();
const MAX_RETRIES = 5;

export default function (): void {
  const tpl = randomTemplate();

  let attempt = 0;
  let success = false;

  while (attempt <= MAX_RETRIES) {
    // 每次尝试都重新签名：timestamp 必须新鲜，避免 recvWindow 过期
    const signed = signOrder(tpl, BASE_URL);
    if (!signed) {
      metrics.orderErrors.add(1);
      metrics.orderSuccessRate.add(false);
      break;
    }

    const res = http.post(signed.url, null, {
      headers: signed.headers,
      tags: { name: 'signed_order_rl' },
    });
    metrics.orderLatency.add(res.timings.duration);

    if (res.status === 200) {
      success = true;
      metrics.ordersPlaced.add(1);
      metrics.orderSuccessRate.add(true);
      break;
    }

    if (res.status === 429 || res.status === 418) {
      // 命中限流：读取 Retry-After（秒），遵守其建议退避后重试
      metrics.orderSuccessRate.add(false);
      metrics.rateLimited.add(1);
      if (res.status === 418) metrics.rateLimitBanned.add(1);

      const retryAfterSec = parseInt(String(res.headers['Retry-After'] || '1'), 10) || 1;
      metrics.retryAfterMs.add(retryAfterSec * 1000);

      check(res, {
        'has Retry-After header': (r) => !!r.headers['Retry-After'],
        'rate-limit code -1003': (r) => {
          try {
            return (r.json() as any).code === -1003;
          } catch (_) {
            return false;
          }
        },
      });

      attempt++;
      if (attempt > MAX_RETRIES) break;
      sleep(retryAfterSec); // ★ 遵守服务端建议的退避时长
      continue;
    }

    // 其它错误（签名/时间戳等）：不重试
    metrics.orderErrors.add(1);
    metrics.orderSuccessRate.add(false);
    break;
  }

  // 「最终成功率」：一次业务下单在允许重试后是否最终成交
  metrics.orderEventualSuccessRate.add(success);
}
