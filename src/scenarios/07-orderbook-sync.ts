/**
 * 07-orderbook-sync.ts — 订单簿增量同步一致性校验（Binance diff-depth 流）
 * ============================================================================
 * 交易所行情最核心的正确性问题：客户端能否用「REST/快照 + WebSocket 增量」
 * 无缝、无丢包地构建出与服务端一致的本地订单簿。这是交易所 QA 的经典考点。
 *
 * 校验的是 Binance 官方「How to manage a local order book correctly」流程：
 *   1. 订阅增量深度流（depthUpdate，带序列号 U/u/pu），先缓冲事件；
 *   2. 拉取一份订单簿快照，得到 lastUpdateId；
 *   3. 丢弃所有 u <= lastUpdateId 的过期缓冲事件；
 *   4. 首个应用的事件必须满足 U <= lastUpdateId+1 <= u（衔接上快照）；
 *   5. 之后每个事件必须与上一个连续：pu == 上一事件的 u，否则说明丢包/乱序。
 *
 * 序列号字段：
 *   U  = 本次更新首个 update id
 *   u  = 本次更新末个 update id
 *   pu = 上一帧末个 update id
 *
 * 负向验证：以缺口注入模式启动靶机可制造不连续，验证本脚本能检出丢包：
 *   MOCK_SEQ_GAP_RATE=0.1 node scripts/mock-server.js
 * 此时 ob_seq_gaps > 0、ob_continuity_rate 明显下降。
 */

import ws from 'k6/ws';
import { check } from 'k6';
import { getWsUrl } from '../config/env';
import { metrics } from '../lib/metrics';
import { buildSubscribe } from '../modules/ws-client';

export const options = {
  vus: 20,
  duration: '20s',
  gracefulStop: '10s',
  thresholds: {
    // 至少完成一次同步，否则用例无意义
    ob_sync_success: ['count>0'],
    // 默认（无缺口注入）下，增量序列应 100% 连续
    ob_continuity_rate: ['rate>0.99'],
  },
};

const WS_URL = getWsUrl();
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const SESSION_MS = 8000;

interface DepthEvent {
  U: number;
  u: number;
  pu: number;
}

export default function (): void {
  const symbol = SYMBOLS[__VU % SYMBOLS.length];
  const channel = `${symbol.toLowerCase()}@depth`;

  // 本地订单簿同步状态
  let lastUpdateId = -1; // 来自快照；-1 表示尚未同步
  let lastU = -1;        // 上一个已应用事件的 u
  let synced = false;
  const buffered: DepthEvent[] = [];

  // 应用一个增量事件并校验序列连续性
  function applyEvent(ev: DepthEvent): void {
    if (ev.u <= lastUpdateId) return; // 丢弃快照之前的旧事件

    let contiguous: boolean;
    if (lastU === -1) {
      // 首个应用事件必须衔接快照：U <= lastUpdateId+1 <= u
      contiguous = ev.U <= lastUpdateId + 1 && lastUpdateId + 1 <= ev.u;
    } else {
      // 后续事件必须与上一个连续：pu == 上一事件的 u
      contiguous = ev.pu === lastU;
    }

    metrics.obContinuityRate.add(contiguous);
    if (!contiguous) {
      metrics.obSeqGaps.add(1);
      console.warn(`[VU ${__VU}] ${symbol} 序列缺口: pu=${ev.pu} 期望 ${lastU} (U=${ev.U}, u=${ev.u})`);
    }

    lastU = ev.u;
    metrics.obEventsApplied.add(1);
  }

  ws.connect(WS_URL, (socket: any) => {
    socket.on('open', () => {
      // 1) 订阅增量深度流，先缓冲
      socket.send(buildSubscribe([channel], __VU));
      // 2) 缓冲一小段后拉取快照（模拟真实同步流程的时序）
      socket.setTimeout(() => {
        socket.send(JSON.stringify({ method: 'GET_SNAPSHOT', symbol }));
      }, 500);
      // 会话到点关闭
      socket.setTimeout(() => socket.close(), SESSION_MS);
    });

    socket.on('message', (raw: string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        metrics.scriptErrors.add(1);
        return;
      }

      // 收到快照：确定 lastUpdateId，冲刷缓冲区，进入已同步态
      if (msg.method === 'SNAPSHOT') {
        lastUpdateId = msg.lastUpdateId;
        for (const ev of buffered) applyEvent(ev);
        buffered.length = 0;
        synced = true;
        metrics.obSynced.add(1);
        check(msg, { 'snapshot has lastUpdateId': (m: any) => typeof m.lastUpdateId === 'number' });
        return;
      }

      // 增量事件
      if (msg.e === 'depthUpdate' && typeof msg.u === 'number') {
        const ev: DepthEvent = { U: msg.U, u: msg.u, pu: msg.pu };
        if (!synced) buffered.push(ev);
        else applyEvent(ev);
      }
    });

    socket.on('error', (e: any) => {
      metrics.wsErrors.add(1);
      if (e && e.error && !String(e.error()).includes('close')) {
        console.error(`[VU ${__VU}] ws error: ${e.error()}`);
      }
    });
  });
}
