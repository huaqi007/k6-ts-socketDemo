/**
 * 05-signed-order.ts — 需求 4：Binance 风格 HMAC-SHA256 签名下单
 * ============================================================================
 * 每次迭代：取一条订单模板 → 实时签名（timestamp + HMAC-SHA256）→ POST 下单。
 * 校验服务端验签结果：
 *   - 200            → 下单成功，签名有效
 *   - 401 / -1022    → 签名无效（验证靶机确实在校验签名）
 *   - 400 / -1021    → 时间戳超出 recvWindow
 *
 * ramping-arrival-rate 保证「到达率」稳定（RPS 阶梯上升），
 * 比固定 VU 更贴近真实下单流量模型。
 */

import http from 'k6/http';
import { check } from 'k6';
import { getBaseUrl } from '../config/env';
import { metrics } from '../lib/metrics';
import { randomTemplate, signOrder } from '../modules/pre-signer';

export const options = {
  scenarios: {
    order_flow: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 30,
      maxVUs: 200,
      stages: [
        { target: 50, duration: '20s' },
        { target: 100, duration: '20s' },
        { target: 100, duration: '20s' },
      ],
    },
  },
};

const BASE_URL = getBaseUrl();

export default function (): void {
  // 1) 取模板 → 2) 实时签名 → 3) 下单
  const tpl = randomTemplate();
  const signed = signOrder(tpl, BASE_URL);
  if (!signed) {
    // 签名失败（如 secret 异常）：安全跳过，不终止 VU
    metrics.orderErrors.add(1);
    metrics.orderSuccessRate.add(false);
    return;
  }

  const res = http.post(signed.url, null, {
    headers: signed.headers,
    tags: { name: 'signed_order' },
  });

  metrics.orderLatency.add(res.timings.duration);

  const success = res.status === 200;
  metrics.orderSuccessRate.add(success);

  if (success) {
    metrics.ordersPlaced.add(1);
  } else {
    metrics.orderErrors.add(1);
    if (res.status === 401) metrics.signRejects.add(1);
  }

  check(res, {
    'order status 200': (r) => r.status === 200,
    'has orderId': (r) => {
      try {
        return r.status === 200 && typeof (r.json() as any).orderId !== 'undefined';
      } catch (_) {
        return false;
      }
    },
  });
}
