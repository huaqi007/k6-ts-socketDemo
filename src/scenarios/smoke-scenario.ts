/**
 * smoke-scenario.ts — CI 冒烟场景（短时低压，验证全链路通路）
 * ============================================================================
 * 与 mixed-scenario.ts 复用同一套 exec 函数（handlers.ts），
 * 仅将并发与时长大幅缩小，让 CI 能在 ~1 分钟内验证 WS 连通 + 签名下单通路。
 */

export { wsMarketData, signedOrder } from './handlers';
export { handleSummary } from '../lib/summary';

export const options = {
  scenarios: {
    ws_marketdata: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { target: 20, duration: '10s' },
        { target: 20, duration: '10s' },
        { target: 0, duration: '5s' },
      ],
      gracefulRampDown: '5s',
      exec: 'wsMarketData',
    },
    order_flow: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 30,
      stages: [
        { target: 30, duration: '10s' },
        { target: 30, duration: '10s' },
        { target: 0, duration: '5s' },
      ],
      exec: 'signedOrder',
    },
  },
};
