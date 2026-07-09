/**
 * 02-ws-subscribe.ts — 需求 1（b）：订阅深度 + 解析 bids/asks
 * ============================================================================
 * 连上后订阅 btcusdt@depth，持续接收深度快照，解析并校验 bids/asks 非空。
 * 复用 ws-client 中的订阅报文组装、深度解析、事件处理逻辑。
 */

import ws from 'k6/ws';
import { check } from 'k6';
import { getWsUrl } from '../config/env';
import { metrics } from '../lib/metrics';
import { buildSubscribe, parseDepth } from '../modules/ws-client';

export const options = {
  vus: 5,
  duration: '15s',
};

const WS_URL = getWsUrl();
const SYMBOLS = ['btcusdt@depth'];

export default function (): void {
  metrics.wsConnecting.add(1);

  const res = ws.connect(WS_URL, (socket: any) => {
    let openedAt = 0;
    let firstSeen = false;

    socket.on('open', () => {
      openedAt = Date.now();
      metrics.wsConnected.add(1);
      metrics.wsConnectRate.add(true);

      // 发送深度订阅
      socket.send(buildSubscribe(SYMBOLS, __VU));

      // 每 10s ping 一次，保活
      socket.setInterval(() => socket.ping(), 10000);
      // 12s 后主动断开，结束本次迭代
      socket.setTimeout(() => socket.close(), 12000);
    });

    socket.on('message', (raw: string) => {
      const depth = parseDepth(raw);
      if (!depth) return; // 跳过 SUBSCRIBED 确认帧

      metrics.wsMessages.add(1);
      if (!firstSeen && openedAt > 0) {
        firstSeen = true;
        metrics.wsFirstMsgLatency.add(Date.now() - openedAt);
      }

      const valid = depth.bids.length > 0 && depth.asks.length > 0;
      metrics.wsDepthValidRate.add(valid);
      check(depth, {
        'has bids': (d) => d.bids.length > 0,
        'has asks': (d) => d.asks.length > 0,
        'bid price parseable': (d) => !isNaN(parseFloat(d.bids[0][0])),
      });
    });

    socket.on('error', (e: any) => metrics.wsErrors.add(1));
  });

  metrics.wsConnectRate.add(!!(res && res.status === 101));
}
