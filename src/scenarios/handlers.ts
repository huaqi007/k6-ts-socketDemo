/**
 * handlers.ts — 全链路混合场景的执行函数（被 mixed / smoke 两个入口共享）
 * ============================================================================
 * 把「WS 行情订阅」与「签名下单」两条链路的单次执行逻辑抽成 exec 函数，
 * 让 mixed-scenario（完整压测）与 smoke-scenario（CI 冒烟）复用同一套代码，
 * 只在各自的 options 里配置不同的执行器 / 时长 / 速率。
 */

import ws from 'k6/ws';
import http from 'k6/http';
import { check } from 'k6';
import { getWsUrl, getBaseUrl } from '../config/env';
import { metrics } from '../lib/metrics';
import { registerDepthHandlers } from '../modules/ws-client';
import { randomTemplate, signOrder } from '../modules/pre-signer';

const WS_URL = getWsUrl();
const BASE_URL = getBaseUrl();
const CHANNELS = ['btcusdt@depth', 'ethusdt@depth', 'solusdt@depth', 'bnbusdt@depth'];

// ============================================================================
// 链路 A：WS 行情订阅（长连接，单次迭代维持一段时间）
// ============================================================================
export function wsMarketData(): void {
  const channel = CHANNELS[__VU % CHANNELS.length];

  metrics.wsConnecting.add(1);
  const res = ws.connect(WS_URL, (socket: any) => {
    registerDepthHandlers(socket, {
      url: WS_URL,
      symbols: [channel],
      sessionMs: 15000, // 单连接维持 15s
      pingMs: 10000,
    });
  });

  metrics.wsConnectRate.add(!!(res && res.status === 101));
}

// ============================================================================
// 链路 B：Binance 风格签名下单（短请求，高频到达）
// ============================================================================
export function signedOrder(): void {
  const tpl = randomTemplate();
  const signed = signOrder(tpl, BASE_URL);
  if (!signed) {
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

  check(res, { 'order status 200': (r) => r.status === 200 });
}
