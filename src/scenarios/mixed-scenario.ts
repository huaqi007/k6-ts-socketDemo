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
 *
 * 🔎 交叉影响可观测性（区别于两场景分开跑的核心价值）：
 *   - k6 会自动给每条指标打上 { scenario } 标签，可在 Prometheus/Grafana 里
 *     按场景切片，对比同一时间窗内 WS 与下单两条链路的表现。
 *   - ws_msg_gap_ms（相邻深度帧间隔）是关键的「交叉劣化」信号：服务端固定每
 *     100ms 推一次，若下单高峰抢占资源导致 WS 收帧被拖慢，该间隔会明显抬高。
 *   - 下方 thresholds 同时对两条链路设阈值：任一条在混合负载下劣化都会触发失败，
 *     从而量化「资源竞争是否伤害了另一条链路」。
 */

export { wsMarketData, signedOrder } from './handlers';

export const options = {
  // 同时对 WS 行情与签名下单两条链路设门禁，捕捉交叉劣化
  thresholds: {
    ws_connect_rate: ['rate>0.99'],       // WS 连接成功率
    ws_depth_valid_rate: ['rate>0.99'],   // 深度有效率
    ws_first_msg_ms: ['p(95)<1000'],      // 首帧深度延迟
    ws_msg_gap_ms: ['p(95)<500'],         // 相邻帧间隔（背压/资源争抢信号）
    order_success_rate: ['rate>0.99'],    // 下单成功率
    order_latency_ms: ['p(95)<300'],      // 下单延迟
  },
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
