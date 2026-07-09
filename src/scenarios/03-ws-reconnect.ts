/**
 * 03-ws-reconnect.ts — 需求 2：断线重连框架
 * ============================================================================
 * 演示 while(true) + ws.connect + 指数退避 + jitter 的重连主循环。
 *
 * 单个 VU 的一次迭代内会经历：
 *   连接 → 订阅深度 → 8s 后主动断开 → 退避（含 jitter）→ 重连 …（重复 3 次）
 *
 * 退避序列（base=500ms）：约 500ms → 1s → 2s（各带 ±25% 抖动）。
 * 主循环逻辑集中在 ws-client.ts 的 connectWithReconnect()，此处只配置参数。
 */

import { connectWithReconnect } from '../modules/ws-client';
import { getWsUrl } from '../config/env';

export const options = {
  vus: 10,
  duration: '30s',
  // 单次迭代含多次重连（含退避），给足优雅停止时间以便干净收尾
  gracefulStop: '20s',
};

const WS_URL = getWsUrl();

export default function (): void {
  connectWithReconnect({
    url: WS_URL,
    symbols: ['btcusdt@depth'],
    maxReconnects: 3,     // 每次迭代重连 3 次后结束
    sessionMs: 5000,      // 每条连接维持 5s 后主动断开
    baseDelayMs: 500,     // 退避基准
    maxDelayMs: 30000,    // 退避上限
    pingMs: 5000,         // 5s 一次心跳
  });
}
