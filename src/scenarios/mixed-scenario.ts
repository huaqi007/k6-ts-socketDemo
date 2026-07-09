/**
 * mixed-scenario.ts — 需求 5：WS 行情 + 签名下单全链路混合场景（完整版）
 * ============================================================================
 * 模拟真实交易所流量：大量用户同时盯着盘口 + 间歇下单，两条链路并发运行。
 *
 * 场景组合：
 *   ws_marketdata  — ramping-vus 阶梯到 500 VU（深度订阅长连接）
 *   order_flow      — ramping-arrival-rate 50→150 RPS（签名下单）
 *
 * 这两条链路在同一个 k6 进程中同时运行，互相竞争 CPU/网络/靶机资源，
 * 能更真实地反映「系统在全链路混合负载下的表现」。
 */

export { wsMarketData, signedOrder } from './handlers';

export const options = {
  scenarios: {
    ws_marketdata: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { target: 200, duration: '30s' },
        { target: 500, duration: '1m' },
        { target: 500, duration: '1m' },
        { target: 0, duration: '30s' },
      ],
      gracefulRampDown: '15s',
      exec: 'wsMarketData',
    },
    order_flow: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 30,
      maxVUs: 150,
      stages: [
        { target: 100, duration: '30s' },
        { target: 150, duration: '1m' },
        { target: 150, duration: '1m' },
        { target: 0, duration: '30s' },
      ],
      exec: 'signedOrder',
    },
  },
};
