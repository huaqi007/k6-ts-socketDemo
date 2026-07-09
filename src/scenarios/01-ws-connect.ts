/**
 * 01-ws-connect.ts — 需求 1（a）：WS 连通性验证
 * ============================================================================
 * 最小闭环：连上 mock 服务器 → 校验握手 status===101 → 立即关闭。
 * 用于确认靶机 WS 端点可达、握手正常，是后续所有 WS 场景的前置冒烟。
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { getWsUrl } from '../config/env';
import { metrics } from '../lib/metrics';

export const options = {
  vus: 5,
  duration: '10s',
};

const WS_URL = getWsUrl();

export default function (): void {
  metrics.wsConnecting.add(1);

  const res = ws.connect(WS_URL, (socket: any) => {
    socket.on('open', () => {
      metrics.wsConnected.add(1);
      console.log(`[VU ${__VU}] connected`);
      socket.close(); // 连上即关，仅验证通路
    });
    socket.on('error', (e: any) => {
      metrics.wsErrors.add(1);
      console.error(`[VU ${__VU}] error: ${e.error ? e.error() : e}`);
    });
  });

  const ok = !!(res && res.status === 101);
  metrics.wsConnectRate.add(ok);
  check(res, { 'ws handshake 101': () => ok });

  sleep(0.2); // 迭代间 pacing，避免短时爆量压伤单线程 mock 靶机
}
