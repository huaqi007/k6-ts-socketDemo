// ============================================================================
// mock-server.js — 压测靶机（纯 Node.js 内置模块，无需 npm install）
// ============================================================================
// 启动：node scripts/mock-server.js
//
// 提供两条链路的靶机能力：
//   1) WebSocket 行情：ws://localhost:8080/ws
//        - 收 {method:'SUBSCRIBE', params:['btcusdt@depth'], id}
//        - 回 {method:'SUBSCRIBED', ...} 后按 100ms 周期推送深度快照
//        - 深度快照结构：{ e:'depthUpdate', s:SYMBOL, bids:[[price,qty]...], asks:[...] }
//        - 支持 ping/pong 心跳（客户端 ping → 服务端 pong；服务端 30s 主动 ping）
//
//   2) Binance 风格签名下单（HMAC-SHA256 校验）：
//        POST /api/v3/order?<queryString>&signature=<sig>
//        Header: X-MBX-APIKEY: <apiKey>
//        - 服务端用 apiKey 找到对应 secret，对「signature 之前的原始 query」做
//          HMAC-SHA256，与客户端传入 signature 比对，一致才受理下单
//        - 校验失败返回 Binance 风格错误码（-1022 / -2015 / -1021）
//
//   3) 健康检查：GET /api/v1/health
// ============================================================================
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
// 注入错误率（0~1），用于演示客户端指数退避重试；默认 0 便于验证成功率
const ERR_RATE = parseFloat(process.env.MOCK_ERR_RATE || '0');
// 下单接口每秒许可数（令牌桶容量与补充速率）。0 = 不限流（默认，兼容既有下单测试）
const ORDER_RPS = parseInt(process.env.MOCK_ORDER_RPS || '0', 10);
// 增量深度流序列缺口注入率（0~1）：制造 U 与上次 u 不连续，用于验证客户端能检出丢包。0 = 关闭（默认）
const SEQ_GAP_RATE = parseFloat(process.env.MOCK_SEQ_GAP_RATE || '0');

// apiKey → secret 映射（与 src/config/env.ts 默认值保持一致）
const API_CREDENTIALS = {
  'test-api-key': 'test-api-secret',
};

// 各交易对参考价（用于生成合理的深度快照）
const BASE_PRICES = { BTCUSDT: 65000, ETHUSDT: 3400, SOLUSDT: 140, BNBUSDT: 300 };

// ============================================================================
// 工具函数
// ============================================================================

/** 生成 5 档买卖盘深度：bids 价格递减、asks 价格递增，qty 随机 */
function randomDepth(base) {
  const bids = [];
  const asks = [];
  for (let i = 0; i < 5; i++) {
    const bidPrice = (base * (1 - (i + 1) * 0.001 + Math.random() * 0.0005)).toFixed(2);
    const askPrice = (base * (1 + (i + 1) * 0.001 + Math.random() * 0.0005)).toFixed(2);
    bids.push([bidPrice, (Math.random() * 2 + 0.1).toFixed(4)]);
    asks.push([askPrice, (Math.random() * 2 + 0.1).toFixed(4)]);
  }
  return { bids, asks };
}

/** HMAC-SHA256 十六进制签名 */
function hmacSha256(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ============================================================================
// 下单限流：令牌桶（对齐 Binance IP 权重限流的行为模型）
// ============================================================================
// Binance 超过速率上限时返回 HTTP 429（code -1003），并带 Retry-After 头告知
// 客户端应等待多少秒再重试；持续超限会升级为 HTTP 418（临时封禁）。
// 这里用「按 IP 的令牌桶」近似：容量 = 每秒补充 = ORDER_RPS。
const rateBuckets = new Map(); // ip -> { tokens, lastRefill, strikes }

/**
 * 尝试为某 IP 取一个令牌。
 * @returns { allowed:true } | { allowed:false, retryAfter:秒, banned:bool }
 */
function takeToken(ip) {
  if (ORDER_RPS <= 0) return { allowed: true }; // 未开启限流
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b) {
    b = { tokens: ORDER_RPS, lastRefill: now, strikes: 0 };
    rateBuckets.set(ip, b);
  }
  // 按经过时间线性补充令牌，上限为容量
  const elapsedSec = (now - b.lastRefill) / 1000;
  b.tokens = Math.min(ORDER_RPS, b.tokens + elapsedSec * ORDER_RPS);
  b.lastRefill = now;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    b.strikes = 0;
    return { allowed: true };
  }
  // 令牌不足：计算需等待多久才能攒够 1 个令牌
  const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / ORDER_RPS));
  b.strikes += 1;
  // 连续 20 次超限 → 升级为 418 临时封禁（对齐 Binance 行为）
  const banned = b.strikes >= 20;
  return { allowed: false, retryAfter, banned };
}

// ============================================================================
// HTTP 路由
// ============================================================================
function handleHTTP(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // ── 健康检查 ──
  if (req.method === 'GET' && req.url === '/api/v1/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // ── Binance 风格签名下单 ──
  if (req.method === 'POST' && req.url.startsWith('/api/v3/order')) {
    return handleSignedOrder(req, res);
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}

/**
 * 校验并处理签名下单请求
 * Binance 的签名规则：signature = HMAC_SHA256(secret, totalParams)
 *   totalParams = 请求 URL 中「signature 参数之前」的完整 query string
 * 因此服务端只需按 '&signature=' 切割，对前半段重算 HMAC 即可验签。
 */
function handleSignedOrder(req, res) {
  // 0) 限流检查（在业务处理前，行为对齐 Binance IP 权重限流）
  const ip = req.socket.remoteAddress || 'unknown';
  const gate = takeToken(ip);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    if (gate.banned) {
      res.writeHead(418);
      return res.end(JSON.stringify({ code: -1003, msg: "Way too many requests; IP banned until further notice." }));
    }
    res.writeHead(429);
    return res.end(JSON.stringify({ code: -1003, msg: "Too many requests; current request has been rejected." }));
  }

  // 1) 校验 API Key
  const apiKey = req.headers['x-mbx-apikey'];
  const secret = apiKey && API_CREDENTIALS[apiKey];
  if (!secret) {
    res.writeHead(401);
    return res.end(JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }));
  }

  // 2) 拆分 query 与 signature
  const qIdx = req.url.indexOf('?');
  const rawQuery = qIdx >= 0 ? req.url.slice(qIdx + 1) : '';
  const marker = '&signature=';
  const sigPos = rawQuery.indexOf(marker);
  if (sigPos < 0) {
    res.writeHead(400);
    return res.end(JSON.stringify({ code: -1102, msg: "Mandatory parameter 'signature' was not sent." }));
  }
  const payload = rawQuery.slice(0, sigPos);          // 参与签名的原文
  const providedSig = rawQuery.slice(sigPos + marker.length);

  // 3) 重算 HMAC 并比对
  const expectedSig = hmacSha256(secret, payload);
  if (expectedSig !== providedSig) {
    res.writeHead(401);
    return res.end(JSON.stringify({ code: -1022, msg: 'Signature for this request is not valid.' }));
  }

  // 4) 校验时间戳 recvWindow（防重放）
  const params = new URLSearchParams(payload);
  const timestamp = parseInt(params.get('timestamp') || '0', 10);
  const recvWindow = parseInt(params.get('recvWindow') || '5000', 10);
  const now = Date.now();
  if (timestamp < now - recvWindow || timestamp > now + 1000) {
    res.writeHead(400);
    return res.end(JSON.stringify({ code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' }));
  }

  // 5) 注入随机故障（演示重试）
  if (ERR_RATE > 0 && Math.random() < ERR_RATE) {
    res.writeHead(500);
    return res.end(JSON.stringify({ code: -1000, msg: 'An unknown error occurred while processing the request.' }));
  }

  // 6) 受理下单
  res.writeHead(200);
  res.end(JSON.stringify({
    orderId: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    symbol: params.get('symbol'),
    side: params.get('side'),
    type: params.get('type'),
    price: params.get('price'),
    origQty: params.get('quantity'),
    status: 'NEW',
    transactTime: now,
  }));
}

// ============================================================================
// WebSocket 实现（RFC 6455 最小子集，纯 Node.js 内置模块）
// ============================================================================
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 编码一个 FIN=1 的 WebSocket 帧（服务端发出的帧不加掩码） */
function encodeFrame(opcode, payload) {
  const bytes = Buffer.from(payload, 'utf-8');
  const len = bytes.length;
  const head = [0x80 | opcode]; // FIN=1 + opcode
  if (len < 126) {
    head.push(len);
  } else if (len < 65536) {
    head.push(126, (len >> 8) & 0xff, len & 0xff);
  } else {
    head.push(127);
    for (let i = 7; i >= 0; i--) head.push((len >> (i * 8)) & 0xff);
  }
  return Buffer.concat([Buffer.from(head), bytes]);
}

/** 解码一个 WebSocket 帧（客户端发来的帧必带掩码，需异或还原） */
function decodeFrame(data) {
  if (data.length < 2) return null;
  const opcode = data[0] & 0x0f;
  const masked = (data[1] & 0x80) !== 0;
  let payloadLen = data[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    offset += 2;
    payloadLen = (data[2] << 8) | data[3];
  } else if (payloadLen === 127) {
    offset += 8;
    payloadLen = data.length - offset; // 仅支持小帧
  }
  if (data.length < offset + payloadLen) return null;
  let maskKey = null;
  if (masked) {
    maskKey = data.slice(offset, offset + 4);
    offset += 4;
  }
  const payload = data.slice(offset, offset + payloadLen);
  if (masked && maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }
  return { opcode, payload: payload.toString('utf-8'), length: offset + payloadLen };
}

/** WebSocket 握手：计算 Sec-WebSocket-Accept 并回 101 */
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return false;
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  return true;
}

/** 单个 WS 连接的状态与深度推送 */
class WSConnection {
  constructor(socket, id) {
    this.socket = socket;
    this.id = id;
    this.subscriptions = new Set();
    this.buffer = Buffer.alloc(0);
    this.pushTimer = null;
    this.alive = true;
    // 按交易对维护的深度更新序列号（模拟 Binance 增量深度流的 lastUpdateId）
    this.seq = new Map();
  }

  send(msg) {
    try {
      this.socket.write(encodeFrame(OP_TEXT, msg));
    } catch (_) {
      /* socket 已关闭 */
    }
  }

  startPush() {
    // 每 100ms 为每个订阅推送一次深度快照
    this.pushTimer = setInterval(() => {
      if (!this.alive || this.subscriptions.size === 0) return;
      for (const sub of this.subscriptions) {
        const symbol = sub.replace('@depth', '').toUpperCase();
        const base = BASE_PRICES[symbol] || 100;
        const { bids, asks } = randomDepth(base);

        // 生成 Binance 风格的增量深度序列号：
        //   U  = 本次更新的首个 update id
        //   u  = 本次更新的末个 update id
        //   pu = 上一帧的末个 update id（客户端据 pu==上一帧u 判断是否连续）
        const prevU = this.seq.get(symbol) || 0;
        const firstId = prevU + 1;
        const finalId = firstId + Math.floor(Math.random() * 3);
        this.seq.set(symbol, finalId);

        // 按概率「丢帧」（默认关闭）：序列号已前进但本帧不发送，
        // 使下一帧的 pu 与客户端记录的上一帧 u 不一致 → 客户端应检出缺口。
        if (SEQ_GAP_RATE > 0 && Math.random() < SEQ_GAP_RATE) {
          continue;
        }

        this.send(JSON.stringify({
          e: 'depthUpdate',       // 事件类型（对齐 Binance 命名）
          E: Date.now(),          // 事件时间
          s: symbol,              // 交易对
          channel: sub,           // 原始频道名
          U: firstId,             // 本次更新首个 id
          u: finalId,             // 本次更新末个 id
          pu: prevU,              // 上一帧末个 id（连续性校验用）
          bids,                   // 买盘 5 档 [价格, 数量]
          asks,                   // 卖盘 5 档 [价格, 数量]
        }));
      }
    }, 100);
  }

  handleFrame(frame) {
    if (!frame) return;
    switch (frame.opcode) {
      case OP_TEXT: {
        try {
          const msg = JSON.parse(frame.payload);
          if (msg.method === 'SUBSCRIBE' && Array.isArray(msg.params)) {
            msg.params.forEach((p) => this.subscriptions.add(p));
            this.send(JSON.stringify({ method: 'SUBSCRIBED', params: [...this.subscriptions], id: msg.id }));
            console.log(`[WS:${this.id}] => subscribed: ${[...this.subscriptions].join(', ')}`);
          } else if (msg.method === 'GET_SNAPSHOT' && msg.symbol) {
            // 返回当前订单簿全量快照 + 对应 lastUpdateId，
            // 供客户端按 Binance「快照 + 增量」流程构建本地订单簿
            const symbol = String(msg.symbol).toUpperCase();
            const base = BASE_PRICES[symbol] || 100;
            const { bids, asks } = randomDepth(base);
            const lastUpdateId = this.seq.get(symbol) || 0;
            this.send(JSON.stringify({ method: 'SNAPSHOT', symbol, lastUpdateId, bids, asks }));
          }
        } catch (_) {
          /* 忽略非 JSON */
        }
        break;
      }
      case OP_PING:
        this.socket.write(encodeFrame(OP_PONG, frame.payload));
        break;
      case OP_CLOSE:
        this.alive = false;
        break;
      default:
        break; // OP_PONG 等忽略
    }
  }
}

const wsConnections = new Map();
let wsIdCounter = 0;

function handleWSUpgrade(req, socket) {
  if (req.url !== '/ws') return;
  if (!wsHandshake(req, socket)) {
    socket.destroy();
    return;
  }

  const id = ++wsIdCounter;
  const conn = new WSConnection(socket, id);
  wsConnections.set(id, conn);
  conn.startPush();

  // 服务端 30s 主动 ping 一次（心跳保活）
  const pingTimer = setInterval(() => {
    if (!conn.alive) return;
    try {
      socket.write(encodeFrame(OP_PING, 'heartbeat'));
    } catch (_) {}
  }, 30000);

  socket.on('data', (chunk) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    // 循环解析（处理粘包 / 半包）
    while (conn.buffer.length >= 2) {
      const frame = decodeFrame(conn.buffer);
      if (!frame) break;
      conn.handleFrame(frame);
      conn.buffer = conn.buffer.slice(frame.length);
      if (!conn.alive) break;
    }
  });

  socket.on('close', () => {
    clearInterval(pingTimer);
    clearInterval(conn.pushTimer);
    wsConnections.delete(id);
  });

  socket.on('error', () => {
    clearInterval(pingTimer);
    clearInterval(conn.pushTimer);
    socket.destroy();
    wsConnections.delete(id);
  });
}

// ============================================================================
// 启动
// ============================================================================
const server = http.createServer(handleHTTP);
server.on('upgrade', handleWSUpgrade);

// 提高并发上限（500 VU 同时握手时不被拒）
server.maxConnections = 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock server running: http://0.0.0.0:${PORT}`);
  console.log(`  WebSocket depth:  ws://localhost:${PORT}/ws`);
  console.log(`  Signed order:     POST http://localhost:${PORT}/api/v3/order`);
  console.log(`  Health:           GET  http://localhost:${PORT}/api/v1/health`);
  console.log(`  Inject error rate: ${ERR_RATE}`);
  console.log(`  Order rate limit:  ${ORDER_RPS > 0 ? ORDER_RPS + ' rps/IP (429 + Retry-After)' : 'disabled'}`);
  console.log(`  Depth seq gap rate: ${SEQ_GAP_RATE}`);
});
