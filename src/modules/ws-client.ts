/**
 * ws-client.ts — WebSocket 行情客户端框架（连接 / 订阅 / 解析 / 断线重连）
 * ============================================================================
 * 汇聚 WS 行情链路的所有可复用能力，供各场景脚本调用：
 *
 *   - buildSubscribe()        组装深度订阅报文
 *   - parseDepth()            安全解析深度快照，提取 bids/asks
 *   - computeBackoffMs()      指数退避 + jitter 计算
 *   - registerDepthHandlers() 给 socket 挂上 open/message/ping/close/error 处理
 *   - connectWithReconnect()  断线重连主循环（while(true) + ws.connect + 退避）
 *
 * ⚠️ k6 的 ws.connect 是「同步阻塞」的：调用后会一直阻塞到该连接关闭才返回。
 *    因此重连必须写成「ws.connect 之外的 while 循环」——每次循环重建一条连接；
 *    绝不能在 socket 回调里递归调用 connect（会嵌套阻塞、VU 永不释放）。
 */

import ws from 'k6/ws';
import { sleep, check } from 'k6';
import { metrics } from '../lib/metrics';

// ============================================================================
// 类型
// ============================================================================

/** 解析后的深度快照 */
export interface DepthSnapshot {
  symbol: string;
  bids: Array<[string, string]>; // [价格, 数量]
  asks: Array<[string, string]>;
}

/** 重连主循环配置 */
export interface ReconnectOptions {
  url: string;                 // WS 地址
  symbols: string[];           // 订阅的频道，如 ['btcusdt@depth']
  maxReconnects?: number;      // 最大重连次数（超出后结束本次迭代）
  sessionMs?: number;          // 单条连接保持时长（到点主动关闭，触发重连）
  baseDelayMs?: number;        // 退避基准延迟
  maxDelayMs?: number;         // 退避上限
  pingMs?: number;             // 客户端主动 ping 周期
}

// ============================================================================
// 报文组装 & 解析
// ============================================================================

/** 组装 Binance 风格订阅报文 */
export function buildSubscribe(symbols: string[], id: number): string {
  return JSON.stringify({ method: 'SUBSCRIBE', params: symbols, id });
}

/**
 * 安全解析深度快照。
 * 返回 null 表示不是深度报文（如 SUBSCRIBED 确认帧）或解析失败。
 */
export function parseDepth(raw: string): DepthSnapshot | null {
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data.bids) && Array.isArray(data.asks)) {
      return { symbol: data.s || data.symbol || 'UNKNOWN', bids: data.bids, asks: data.asks };
    }
    return null;
  } catch (_) {
    metrics.scriptErrors.add(1);
    return null;
  }
}

// ============================================================================
// 指数退避 + jitter
// ============================================================================

/**
 * 计算第 attempt 次重连的等待时间（毫秒）。
 * 公式：min(base × 2^(attempt-1) × [0.75~1.25], max)
 *   - 指数增长：快速拉开重连间隔，避免对刚恢复的服务端造成冲击；
 *   - ±25% jitter：打散大量 VU 的重连时刻，防止「惊群 / thundering herd」。
 *
 * @param attempt 第几次重连（1-based）
 */
export function computeBackoffMs(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const jitterFactor = 0.75 + Math.random() * 0.5; // [0.75, 1.25)
  return Math.min(exponential * jitterFactor, maxMs);
}

// ============================================================================
// 事件处理挂载
// ============================================================================

/**
 * 给 socket 挂上完整的深度行情处理逻辑：
 *   open    → 发送订阅 + 起 ping 定时 + 起会话超时（到点关闭以触发重连）
 *   message → 解析 bids/asks、记录首帧延迟与消息数、check 数据有效性
 *   ping/pong、close、error → 记录指标与日志
 *
 * @param socket k6 ws socket
 * @param opts   重连配置（此处只用到 symbols/sessionMs/pingMs）
 */
export function registerDepthHandlers(socket: any, opts: ReconnectOptions): void {
  const symbols = opts.symbols;
  const sessionMs = opts.sessionMs ?? 15000;
  const pingMs = opts.pingMs ?? 10000;

  // 记录 open 时刻，用于计算「首帧深度」到达延迟
  let openedAt = 0;
  let firstMsgSeen = false;

  socket.on('open', () => {
    openedAt = Date.now();
    metrics.wsConnected.add(1);
    metrics.wsConnectRate.add(true);

    // 发送深度订阅
    socket.send(buildSubscribe(symbols, __VU));

    // 客户端主动心跳
    socket.setInterval(() => socket.ping(), pingMs);

    // 会话到点主动关闭 → ws.connect 返回 → 外层 while 触发重连
    socket.setTimeout(() => socket.close(), sessionMs);
  });

  socket.on('message', (raw: string) => {
    const depth = parseDepth(raw);
    if (!depth) return; // SUBSCRIBED 确认帧等，跳过

    metrics.wsMessages.add(1);

    // 首帧深度延迟（open → 第一条深度）
    if (!firstMsgSeen && openedAt > 0) {
      firstMsgSeen = true;
      metrics.wsFirstMsgLatency.add(Date.now() - openedAt);
    }

    // 业务校验：bids/asks 非空
    const valid = depth.bids.length > 0 && depth.asks.length > 0;
    metrics.wsDepthValidRate.add(valid);
    check(depth, {
      'depth has bids': (d) => d.bids.length > 0,
      'depth has asks': (d) => d.asks.length > 0,
    });
  });

  socket.on('ping', () => {
    // k6 会自动回 pong；这里仅用于可观测
  });

  socket.on('error', (e: any) => {
    metrics.wsErrors.add(1);
    // e.error() 在正常关闭时也可能触发，过滤掉主动 close 噪声
    if (e && e.error && !String(e.error()).includes('close')) {
      console.error(`[VU ${__VU}] ws error: ${e.error()}`);
    }
  });
}

// ============================================================================
// 断线重连主循环（需求 2 核心）
// ============================================================================

/**
 * 断线重连框架：while(true) + ws.connect + 指数退避 + jitter。
 *
 * 生命周期（单个 VU 的一次迭代内）：
 *   1. 发起连接（记录尝试次数 → 指标）；
 *   2. ws.connect 阻塞运行本次会话（内部会在 sessionMs 后主动关闭）；
 *   3. 连接关闭返回后，若未达 maxReconnects：计算退避延迟、sleep、重连；
 *   4. 达到 maxReconnects：跳出循环，结束本次迭代（由 k6 执行器决定是否再拉起）。
 *
 * @param opts 重连配置
 */
export function connectWithReconnect(opts: ReconnectOptions): void {
  const maxReconnects = opts.maxReconnects ?? 5;
  const baseMs = opts.baseDelayMs ?? 500;
  const maxMs = opts.maxDelayMs ?? 30000;

  let reconnectCount = 0;

  // ★ 断线重连主循环
  while (true) {
    metrics.wsConnecting.add(1);

    // 阻塞式建立连接并运行本次会话；关闭后返回握手响应
    const res = ws.connect(opts.url, (socket: any) => {
      registerDepthHandlers(socket, opts);
    });

    // 握手失败（如靶机未启动）：记录失败率
    if (!res || res.status !== 101) {
      metrics.wsConnectRate.add(false);
    }

    // 是否继续重连
    if (reconnectCount >= maxReconnects) break;
    reconnectCount++;
    metrics.wsReconnects.add(1);

    const delayMs = computeBackoffMs(reconnectCount, baseMs, maxMs);
    console.log(
      `[VU ${__VU}] 连接关闭，第 ${reconnectCount}/${maxReconnects} 次重连，退避 ${Math.round(delayMs)}ms`
    );
    sleep(delayMs / 1000); // k6 sleep 单位是秒
  }
}
