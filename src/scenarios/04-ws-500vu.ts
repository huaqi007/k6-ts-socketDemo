/**
 * 04-ws-500vu.ts — 需求 3：500 VU 同时订阅行情（ramping-vus 阶梯加压）
 * ============================================================================
 * 用 ramping-vus 执行器把并发 WS 订阅数从 0 阶梯拉升到 500，再回落，
 * 观察靶机在高并发长连接下的深度推送吞吐与稳定性。
 *
 * 阶梯设计：
 *   0   → 100   (30s)  预热
 *   100 → 500   (1m)   爬坡到目标
 *   500 → 500   (1m)   平台期（峰值持续压测）
 *   500 → 0     (30s)  优雅回落
 *
 * 每个 VU 建立一条连接、订阅深度、持续接收快照，靠 sessionMs 控制单连接时长。
 * gracefulRampDown 给正在收行情的连接留出关闭时间，避免瞬间断链。
 */

import ws from 'k6/ws';
import { getWsUrl } from '../config/env';
import { metrics } from '../lib/metrics';
import { registerDepthHandlers } from '../modules/ws-client';

export const options = {
  scenarios: {
    ws_ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { target: 100, duration: '30s' }, // 预热
        { target: 500, duration: '1m' },  // 爬坡到 500
        { target: 500, duration: '1m' },  // 峰值平台
        { target: 0, duration: '30s' },   // 优雅回落
      ],
      gracefulRampDown: '15s',
    },
  },
};

const WS_URL = getWsUrl();

// 让不同 VU 订阅不同交易对，模拟真实的多品种行情分布
const CHANNELS = ['btcusdt@depth', 'ethusdt@depth', 'solusdt@depth', 'bnbusdt@depth'];

export default function (): void {
  const channel = CHANNELS[__VU % CHANNELS.length];

  metrics.wsConnecting.add(1);
  const res = ws.connect(WS_URL, (socket: any) => {
    registerDepthHandlers(socket, {
      url: WS_URL,
      symbols: [channel],
      sessionMs: 20000, // 每条连接维持 20s，随后关闭由执行器再拉起新 VU
      pingMs: 10000,
    });
  });

  metrics.wsConnectRate.add(!!(res && res.status === 101));
}
