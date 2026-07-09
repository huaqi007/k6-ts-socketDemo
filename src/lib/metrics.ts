import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * metrics.ts — 自定义 k6 指标定义
 * ============================================================================
 * k6 指标三种基本类型：
 *   Counter : 只增不减的累加计数器（消息数、下单数、重连次数）
 *   Trend   : 统计分布（min/avg/max/p90/p95/p99，适合延迟 / 首帧时间）
 *   Rate    : 布尔比率（成功率、签名校验通过率）
 *
 * 命名统一 snake_case，便于在 Prometheus / Grafana 中按前缀过滤：
 *   ws_*     → WebSocket 行情链路
 *   order_*  → 签名下单链路
 */
export const metrics = {
  // ── WebSocket 行情链路 ──
  wsConnecting: new Counter('ws_connect_attempts'),   // 发起连接次数（含重连）
  wsConnected: new Counter('ws_connect_success'),     // 握手成功（status 101）次数
  wsConnectRate: new Rate('ws_connect_rate'),         // 连接成功率
  wsMessages: new Counter('ws_depth_messages'),       // 收到的深度快照总条数
  wsFirstMsgLatency: new Trend('ws_first_msg_ms', true), // 从 open 到首帧深度的耗时
  wsDepthValidRate: new Rate('ws_depth_valid_rate'),  // 深度报文含有效 bids/asks 的比率
  wsReconnects: new Counter('ws_reconnects'),         // 断线重连触发次数
  wsErrors: new Counter('ws_errors'),                 // socket error 事件次数

  // ── 签名下单链路 ──
  ordersPlaced: new Counter('orders_placed'),         // 成功下单数
  orderErrors: new Counter('order_errors'),           // 下单失败数（含签名被拒）
  orderLatency: new Trend('order_latency_ms', true),  // 下单 HTTP 延迟
  signRejects: new Counter('order_sign_rejects'),     // 签名校验失败（HTTP 401/-1022）次数
  orderSuccessRate: new Rate('order_success_rate'),   // 下单成功率

  // ── 可观测性 ──
  scriptErrors: new Counter('script_errors'),         // 脚本级异常（JSON 解析等）
};
