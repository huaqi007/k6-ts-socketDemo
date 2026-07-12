# k6-ts-socketDemo — WebSocket 行情压测 + 签名下单全链路

[![CI](https://github.com/huaqi007/k6-ts-socketDemo/actions/workflows/ci.yml/badge.svg)](https://github.com/huaqi007/k6-ts-socketDemo/actions/workflows/ci.yml)

> TypeScript + Webpack + k6 | WS 深度订阅 · 断线重连 · 500 VU 阶梯 · Binance HMAC-SHA256 签名下单 · 全链路混合场景

一套围绕「加密货币交易所」的性能压测工程：既压 **WebSocket 实时行情**（高并发长连接 + 深度订阅 + 断线重连），又压 **REST 签名下单**（Binance 风格 HMAC-SHA256 验签），并把两条链路合成 **全链路混合场景**。

---

## 1. 功能与需求对照

| # | 需求 | 实现位置 | 验证结论 |
|---|------|----------|----------|
| 1 | WS 连接 mock、订阅深度、解析 bids/asks（含靶机） | `scripts/mock-server.js`、`src/scenarios/01-ws-connect.ts`、`02-ws-subscribe.ts` | 100% 握手成功；深度 bids/asks 解析校验 100% 通过 |
| 2 | 断线重连框架（while(true)+ws.connect+指数退避+jitter） | `src/modules/ws-client.ts` → `connectWithReconnect()` | 退避 500→1000→2000ms，各带 ±25% jitter，实测吻合 |
| 3 | 500 VU 同时订阅（ramping-vus 阶梯） | `src/scenarios/04-ws-500vu.ts` | 峰值 500 VU，61 万条深度快照 100% 有效 |
| 4 | Binance 风格 HMAC-SHA256 签名下单 | `src/modules/pre-signer.ts`、`src/scenarios/05-signed-order.ts` | 4199 单 100% 受理；篡改签名/错误 Key/过期时间戳均被正确拒绝 |
| 5 | WS 行情 + 签名下单全链路混合 | `src/scenarios/handlers.ts`、`mixed-scenario.ts` | 峰值 530 VU，131 万 checks 100% 通过 |
| 6 | TypeScript + Webpack 打包 | `webpack.config.js`、`tsconfig.json` | 9 个 entry 全部编译打包成功 |
| 7 | REST 限流（429/Retry-After）客户端退避 | `src/scenarios/06-rate-limit.ts`、`scripts/mock-server.js`（令牌桶） | 突发触发 429（-1003）+ 418 封禁；遵守 Retry-After 重试后最终成功率 100% |
| 8 | 订单簿增量同步一致性（U/u/pu 序列连续性） | `src/scenarios/07-orderbook-sync.ts`、`scripts/mock-server.js`（增量深度流） | 快照+增量无缝衔接，连续率 100%；注入丢帧时正确检出缺口（连续率降至 ~90%） |

---

## 2. 技术栈与数据流

```
TypeScript (ES2015 严格模式)
  → ts-loader → Webpack 5 → CommonJS 单文件 bundle (dist/*.js)
  → k6 运行时执行

k6 内置模块（k6、k6/ws、k6/http、k6/crypto、k6/data、k6/metrics）
  由 k6 运行时注入 → webpack externals 排除，绝不打进 bundle
```

**为什么要 webpack？** k6 运行的是打包后的 JS，自身不识别 TS 与模块系统。ts-loader 负责 TS→JS，webpack 负责把多文件依赖合成单文件，交给 k6 执行。

---

## 3. 项目结构

```
k6-ts-socketDemo/
├── scripts/
│   ├── mock-server.js         # 压测靶机：WS 深度推送 + Binance 签名验签 + 健康检查
│   └── gen-orders.js          # 生成订单模板数据 orders.json
├── src/
│   ├── config/
│   │   └── env.ts             # WS_URL / BASE_URL / API_KEY / API_SECRET（可环境变量覆盖）
│   ├── data/
│   │   └── orders.json        # 200 条订单参数模板
│   ├── lib/
│   │   ├── metrics.ts         # 自定义 k6 指标（Counter/Trend/Rate）
│   │   └── summary.ts         # handleSummary：终端摘要 + summary.html/json 报告
│   ├── modules/
│   │   ├── ws-client.ts       # 🔴 WS 框架：订阅/解析/退避/事件处理/断线重连主循环
│   │   └── pre-signer.ts      # 🔴 Binance HMAC-SHA256 签名（SharedArray 模板 + 实时签名）
│   ├── scenarios/
│   │   ├── 01-ws-connect.ts   # 需求1a：连通性冒烟
│   │   ├── 02-ws-subscribe.ts # 需求1b：订阅深度 + 解析 bids/asks
│   │   ├── 03-ws-reconnect.ts # 需求2：断线重连框架
│   │   ├── 04-ws-500vu.ts     # 需求3：500 VU ramping-vus
│   │   ├── 05-signed-order.ts # 需求4：签名下单
│   │   ├── 06-rate-limit.ts   # 需求7：REST 限流(429/Retry-After)客户端退避
│   │   ├── 07-orderbook-sync.ts # 需求8：订单簿增量同步一致性(U/u/pu 连续性)
│   │   ├── handlers.ts        # 需求5：混合场景共享 exec 函数
│   │   ├── mixed-scenario.ts  # 🔴 主入口：WS + 下单全链路
│   │   └── smoke-scenario.ts  # CI 冒烟（短时低压）
│   └── types/k6-globals.d.ts  # console 等运行时全局声明
├── tests/                     # Playwright 功能 / E2E 测试（与 k6 压测互补）
│   ├── helpers/sign.ts        # Binance HMAC-SHA256 签名助手（与 k6 口径一致）
│   ├── health.spec.ts         # 健康检查
│   ├── signed-order.spec.ts   # 签名下单 1 正 + 4 负
│   ├── rate-limit.spec.ts     # 429 限流 + Retry-After + -1003
│   └── ws-depth.spec.ts       # 浏览器 WebSocket 深度订阅 + 序列连续性
├── playwright.config.ts       # Playwright 配置（webServer 自启正常/限流两个靶机）
├── Dockerfile                 # 多阶段：npm build + 装 k6，mock/k6 服务复用
├── docker-compose.yml         # 一键起环境（mock/mock-rl/k6/e2e）
├── webpack.config.js
├── tsconfig.json
└── package.json
```

---

## 4. 靶机（mock-server.js）设计原理

纯 Node.js 内置模块实现（无需 npm install），提供两条链路的被测端：

### 4.1 WebSocket 行情（RFC 6455 最小子集）
- **握手**：校验 `Sec-WebSocket-Key`，用魔术字符串 `258EAFA5-...` 做 SHA1+Base64 得到 `Sec-WebSocket-Accept`，回 `101 Switching Protocols`。
- **帧编解码**：手写 `encodeFrame/decodeFrame`，支持 FIN、opcode、掩码位；客户端→服务端的帧必带掩码需异或还原；处理粘包/半包（循环按帧长切割 buffer）。
- **订阅**：收到 `{method:'SUBSCRIBE', params:['btcusdt@depth'], id}` → 回 `SUBSCRIBED` 确认 → 每 100ms 推送一次深度快照。
- **深度快照**：`{e:'depthUpdate', s:SYMBOL, bids:[[price,qty]×5], asks:[[price,qty]×5]}`（对齐 Binance 命名）。
- **心跳**：客户端 ping → 服务端 pong；服务端每 30s 主动 ping。

### 4.2 Binance 风格签名下单（真正做验签）
```
POST /api/v3/order?<queryString>&signature=<sig>
Header: X-MBX-APIKEY: <apiKey>
```
校验流程与真实 Binance 一致：
1. `X-MBX-APIKEY` 找不到对应 secret → `401 {code:-2015}`
2. 缺少 `signature` 参数 → `400 {code:-1102}`
3. 对「`&signature=` 之前的原始 query」重算 `HMAC_SHA256(secret, query)`，与传入不符 → `401 {code:-1022}`
4. `timestamp` 超出 `[now-recvWindow, now+1000]` → `400 {code:-1021}`（防重放）
5. 全部通过 → `200 {orderId, status:'NEW', ...}`

> `MOCK_ERR_RATE` 环境变量可注入随机 500，用于演示客户端重试。
> `MOCK_ORDER_RPS` 环境变量可开启下单接口令牌桶限流（按 IP，每秒许可数）：超限返回 `429 {code:-1003}` 并带 `Retry-After` 头，连续 20 次超限升级为 `418` 临时封禁——用于验证客户端的限流退避处理。
> `MOCK_SEQ_GAP_RATE` 环境变量可按概率「丢帧」（序列号已前进但不发送），使下一帧 `pu` 与客户端上一帧 `u` 不一致——用于验证订单簿同步脚本能检出丢包缺口。

---

## 5. 核心原理逐条拆解

### 5.1 需求 1 — 深度订阅与 bids/asks 解析
`ws.connect` 建连 → `open` 里发订阅 → `message` 里 `parseDepth()` 安全解析：

```ts
export function parseDepth(raw: string): DepthSnapshot | null {
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data.bids) && Array.isArray(data.asks)) {
      return { symbol: data.s, bids: data.bids, asks: data.asks };
    }
    return null;              // SUBSCRIBED 确认帧等非深度报文，跳过
  } catch (_) { return null; } // 解析失败不崩 VU
}
```
用 `check()` 校验 bids/asks 非空、价格可解析，并用 `ws_first_msg_ms` 记录「open→首帧深度」延迟（实测 ~100ms，与服务端推送周期一致）。

### 5.2 需求 2 — 断线重连框架（本项目重点）

**关键认知**：k6 的 `ws.connect` 是**同步阻塞**——调用后一直阻塞到该连接关闭才返回。
因此重连必须写成 **`ws.connect` 之外的 while 循环**；绝不能在 socket 回调里递归 connect（会嵌套阻塞、VU 永不释放）。

```ts
export function connectWithReconnect(opts): void {
  let reconnectCount = 0;
  const startedAt = Date.now();
  while (true) {                                   // ★ 重连主循环
    metrics.wsConnecting.add(1);
    ws.connect(opts.url, (socket) => {             // 阻塞运行本次会话
      registerDepthHandlers(socket, opts);         // sessionMs 到点主动 close
    });
    if (reconnectCount >= opts.maxReconnects) break;         // 退出保险①：次数上限
    if (Date.now() - startedAt >= opts.maxTotalMs) break;    // 退出保险②：总时长上限
    reconnectCount++;
    metrics.wsReconnects.add(1);
    const delay = computeBackoffMs(reconnectCount); // 指数退避 + jitter
    sleep(delay / 1000);
  }
}
```

> **双重退出保险**：`maxReconnects`（次数）+ `maxTotalMs`（总时长）。退避封顶到 30s 后，若重连次数设得大，单靠次数上限单次迭代可能耗时过长、VU 迟迟不释放；总时长上限兜底避免 VU 长期占用。

**指数退避 + jitter**：
```ts
function computeBackoffMs(attempt, base=500, max=30000) {
  const exponential = base * 2 ** (attempt - 1);   // 500 → 1000 → 2000 ...
  const jitter = 0.75 + Math.random() * 0.5;        // ±25%
  return Math.min(exponential * jitter, max);
}
```
- **指数**：快速拉开重连间隔，避免持续冲击刚恢复的服务端。
- **jitter**：打散大量 VU 的重连时刻，防「惊群效应 / thundering herd」——否则 500 个 VU 同时断线会同时重连，再次压垮服务。

实测退避区间：`383–617 / 790–1245 / 1536–2500 ms`，与 `500/1000/2000 × [0.75,1.25]` 完全吻合。

### 5.3 需求 3 — 500 VU ramping-vus 阶梯加压

```ts
executor: 'ramping-vus', startVUs: 0,
stages: [
  { target: 100, duration: '30s' },  // 预热
  { target: 500, duration: '1m'  },  // 爬坡到 500
  { target: 500, duration: '1m'  },  // 峰值平台
  { target: 0,   duration: '30s' },  // 优雅回落
],
gracefulRampDown: '15s',
```
- **ramping-vus vs constant-vus**：阶梯升压能观察系统在不同并发下的「拐点」，比一次拉满更贴近真实增长。
- **gracefulRampDown**：回落时给正在收行情的连接留时间关闭，避免瞬间断链造成误差。
- 不同 VU 订阅不同交易对（`__VU % channels`），模拟多品种行情分布。

### 5.4 需求 4 — Binance 风格 HMAC-SHA256 签名

**签名规则**：`signature = HMAC_SHA256(secret, totalParams)`，`totalParams` 为**按参数名字母序**拼接的 query string（对齐真实 Binance 约定，可直接迁移到真实交易所）。

```ts
const params = { symbol, side, type, timeInForce, quantity, price, recvWindow, timestamp };
// 字母序：price → quantity → recvWindow → side → symbol → timeInForce → timestamp → type
const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
let signature: string;
try { signature = crypto.hmac('sha256', secret, query, 'hex'); }
catch (e) { metrics.scriptErrors.add(1); return null; } // HMAC 异常不崩 VU
// POST /api/v3/order?<query>&signature=<signature>   Header: X-MBX-APIKEY
```

**「模板预加载 + 运行期实时签名」分层**（对照 workDemo 的 pre-signer.ts 升级）：
- 昂贵且可复用的「订单参数模板」用 **SharedArray** 只解析一次、全 VU 共享内存（500 VU 也只解析一份）。
- `timestamp` 与 `signature` 在**每次请求时实时计算**，保证时间戳新鲜、落在服务端 `recvWindow` 内，避免被 `-1021` 拒绝。
- secret 只用于本地 HMAC 计算，**绝不出现在请求中**；apiKey 明文放请求头。

**负向验证**（证明验签真实生效）：篡改签名→`-1022`、错误 Key→`-2015`、过期时间戳→`-1021`，均被靶机正确拒绝。

### 5.5 需求 5 — 全链路混合场景

两条链路在同一 k6 进程内并发，共享 exec 函数（`handlers.ts`），只在 options 里配不同执行器：

```ts
scenarios: {
  ws_marketdata: { executor: 'ramping-vus',          ...→500VU, exec: 'wsMarketData' },
  order_flow:    { executor: 'ramping-arrival-rate',  ...→150RPS, exec: 'signedOrder' },
}
```
- **ramping-vus**（行情）关注「并发连接数」；**ramping-arrival-rate**（下单）关注「到达率 RPS」，两者建模维度不同、更贴近真实。
- 两链路竞争同一份 CPU/网络/靶机资源，能真实反映系统在混合负载下的表现。

**交叉影响可观测性**（区别于「两场景分开跑」的核心价值）：
- k6 自动给每条指标打 `{scenario}` 标签，可在 Prometheus/Grafana 按场景切片对比同一时间窗内两条链路。
- `ws_msg_gap_ms`（相邻深度帧间隔）是关键「交叉劣化」信号：服务端固定每 100ms 推一次，若下单高峰抢占资源拖慢 WS 收帧，该间隔会抬高。
- `mixed-scenario` 配了 **thresholds 同时对两条链路设门禁**（连接率/有效率/首帧延迟/帧间隔/下单成功率/下单延迟），任一条劣化即失败。
- 实测：530 VU + 150 RPS 混合负载下 `ws_msg_gap_ms` p95 = **102ms**（≈100ms 推送周期），两条链路未互相拖垮，6 项门禁全绿。

---

## 6. 快速开始

```bash
# 1. 安装依赖
npm install

# 2.（可选）重新生成订单模板
npm run gen:orders

# 3. 编译打包 TS → dist/*.js
npm run build

# 4. 启动靶机（单独终端）
npm run mock

# 5. 分场景运行
npm run test:connect     # 需求1a：连通性
npm run test:subscribe   # 需求1b：订阅深度 + 解析 bids/asks
npm run test:reconnect   # 需求2：断线重连（看退避日志）
npm run test:500vu       # 需求3：500 VU 阶梯（约 3 分钟）
npm run test:order       # 需求4：签名下单
npm run test:mixed       # 需求5：全链路混合（约 3.5 分钟）
npm run test:smoke       # 快速冒烟（约 35 秒）
# ↑ mixed / smoke 结束后会在当前目录生成 summary.html（可视化报告）与 summary.json

# 需求7：REST 限流(429)客户端退避测试（需以限流模式启动靶机）
npm run mock:ratelimit   # 另一终端：MOCK_ORDER_RPS=50 启动带限流的靶机
npm run test:ratelimit   # 突发发压触发 429，客户端遵守 Retry-After 重试

# 需求8：订单簿增量同步一致性
npm run mock             # 正常靶机 → 连续率应为 100%
npm run test:orderbook
npm run mock:seqgap      # 或以丢帧模式启动（MOCK_SEQ_GAP_RATE=0.1）验证缺口检出

# 环境变量覆盖示例
k6 run -e WS_URL=ws://host:8080/ws -e BASE_URL=http://host:8080 dist/mixed-scenario.js
```

---

## 6.1 持续集成（GitHub Actions）

`.github/workflows/ci.yml` 在每次 push / PR 时自动执行完整流水线，保证提交始终可编译、可运行：

```
typecheck (tsc --noEmit)  →  build (webpack)  →  install k6
   →  启动 mock-server 并等待健康检查  →  运行 smoke 场景  →  关闭靶机
```

- **typecheck**：严格模式类型校验，编译期拦截错误；
- **build**：验证 9 个 entry 全部打包成功；
- **smoke**：真实拉起靶机跑 WS 订阅 + 签名下单双链路冒烟（约 35s），端到端验证通路。

CI 跑完会把 `summary.html` / `summary.json` 作为工件（artifact）上传，可在 Actions 运行页面下载查阅。

CI 另有独立的 **Playwright E2E** job：安装 chromium → 自动拉起靶机 → 跑功能用例 → 上传 `playwright-report` 工件。

本地一键复现 CI 流程：

```bash
npm run typecheck && npm run build \
  && npm run mock & \
  sleep 2 && npm run test:smoke
```

---

## 6.2 功能 / E2E 测试（Playwright）

k6 负责「性能/负载」，Playwright 负责「功能正确性」——两者打同一个 mock-server，互补覆盖。

```bash
npm run test:e2e          # 运行全部 E2E 用例（webServer 自动拉起 8080 正常 + 8081 限流两个靶机）
npm run test:e2e:report   # 查看上次运行的 HTML 报告
```

| 用例文件 | 覆盖点 |
|---|---|
| `tests/health.spec.ts` | 健康检查 200 / `{status:ok}` |
| `tests/signed-order.spec.ts` | 签名下单 1 正 + 4 负（-1022 篡改 / -2015 错 Key / -1102 缺签名 / -1021 过期） |
| `tests/rate-limit.spec.ts` | 突发请求触发 429/418 + `Retry-After` + code `-1003` |
| `tests/ws-depth.spec.ts` | 真实浏览器 WebSocket 订阅深度，校验 bids/asks 有效性与 `pu==上一帧u` 序列连续性 |

> `tests/helpers/sign.ts` 复用与 k6 一致的 Binance HMAC-SHA256 签名规则，保证两套测试对靶机的验签口径统一。

---

## 6.3 Docker 一键环境

不装 Node / k6 / 浏览器，用 Docker 一条命令拉起完整压测环境。镜像多阶段构建（`npm run build` 打包 + 装 k6 二进制），`mock` / `k6` 等服务复用同一镜像。

```bash
# 拉起靶机（8080 正常 / 8081 限流），后台常驻
docker compose up -d mock mock-rl

# 跑默认 smoke 压测（打 mock:8080）
docker compose run --rm k6
# 跑指定场景
docker compose run --rm k6 k6 run dist/04-ws-500vu.js
# 跑限流场景（自带 50rps 内网限流靶机，验证退避重试）
docker compose run --rm k6-ratelimit
# 跑 Playwright 功能测试（自包含，含 chromium）
docker compose --profile e2e run --rm e2e

# 停止并清理
docker compose down
```

也提供 npm 快捷脚本：`npm run docker:up` / `docker:k6` / `docker:e2e` / `docker:down`。

| 服务 | 作用 |
|---|---|
| `mock` | 正常靶机（8080）：健康检查 / WS 深度 / 签名下单 |
| `mock-rl` | 限流靶机（8081，`MOCK_ORDER_RPS=5`）：供 Playwright 触发 429 |
| `mock-rl-k6` | 限流靶机（8082，`MOCK_ORDER_RPS=50`，仅内网）：供 k6 退避重试场景 |
| `k6` / `k6-ratelimit` | k6 执行器，跑压测场景 |
| `e2e` | Playwright 功能测试（`--profile e2e` 启用） |

> k6 镜像在构建期用 `dpkg --print-architecture` 探测架构下载对应 k6 二进制，amd64 / arm64 均原生运行。

---

## 7. 自定义指标说明

| 指标 | 类型 | 含义 |
|------|------|------|
| `ws_connect_attempts` / `ws_connect_success` / `ws_connect_rate` | Counter/Rate | 连接尝试 / 成功 / 成功率 |
| `ws_depth_messages` / `ws_depth_valid_rate` | Counter/Rate | 深度快照条数 / bids-asks 有效率 |
| `ws_first_msg_ms` | Trend | open→首帧深度延迟（p90/p95/p99） |
| `ws_msg_gap_ms` | Trend | 相邻深度帧间隔（背压/资源争抢信号，混合场景交叉劣化用） |
| `ws_reconnects` | Counter | 断线重连触发次数 |
| `orders_placed` / `order_errors` / `order_success_rate` | Counter/Rate | 下单成功 / 失败 / 成功率 |
| `order_latency_ms` | Trend | 下单 HTTP 延迟分布 |
| `order_sign_rejects` | Counter | 签名被拒（401/-1022）次数 |
| `order_rate_limited` / `order_rate_limit_banned` | Counter | 命中 429 限流 / 升级 418 封禁次数 |
| `order_retry_after_ms` | Trend | 服务端 Retry-After 建议等待时长分布 |
| `order_eventual_success_rate` | Rate | 含退避重试后的「最终成功率」（限流健壮性核心指标） |
| `ob_sync_success` / `ob_events_applied` | Counter | 完成快照+增量同步次数 / 应用的增量事件数 |
| `ob_seq_gaps` / `ob_continuity_rate` | Counter/Rate | 序列缺口检出次数 / 增量事件连续率 |
| `script_errors` | Counter | 脚本级异常（JSON 解析等） |

---

## 8. 实测结果汇总（本地 mock，macOS/arm64，k6 v2.0.0）

| 场景 | 关键指标 | 结果 |
|------|----------|------|
| 01 连通性 | ws handshake 101 | 100%（250/250） |
| 02 订阅深度 | has bids/asks，首帧延迟 | 100%（3558/3558），~101ms |
| 03 断线重连 | 退避序列 / 帧间隔 | 380–616 / 775–1199 / 1582–2491 ms（指数+jitter 吻合）；`ws_msg_gap` ~101ms |
| 04 500 VU | 峰值 VU / 深度有效率 | 500 VU / 610,970 条 100% 有效 |
| 05 签名下单 | 受理率（字母序签名） | 100%（4200/4200）；负向用例全部正确拒绝 |
| mixed 全链路 | 峰值 VU / checks / 6 项门禁 | 530 VU / 1,314,744 checks 100% / 21,000 单 100% / thresholds 全绿（`ws_msg_gap` p95=102ms） |

---

## 9. 代码评审优化记录（v2）

| 级别 | 问题 | 修复 |
|------|------|------|
| 🔴 中 | 签名字段非字母序，无法直连真实 Binance | `signOrder` 改为 `Object.keys().sort()` 字母序拼接，与真实 Binance 约定一致 |
| 🟡 轻 | `parseDepth` 空字符串 symbol 误落 `UNKNOWN` | 显式挑「首个非空字符串」，空串/缺失才回退 |
| 🟡 轻 | `crypto.hmac` 无 try-catch，异常终止 VU | 包 try-catch，失败记 `script_errors` 并返回 null，调用方安全跳过 |
| 🟡 轻 | 重连仅有次数上限，无总时长上限 | 新增 `maxTotalMs`，次数 + 总时长双重退出保险 |
| 🔵 观测 | 混合场景缺交叉影响指标 | 新增 `ws_msg_gap_ms` 帧间隔 Trend + `{scenario}` 标签 + 两链路联合 thresholds |

---

## 10. 常见问题（FAQ）

- **为什么 01 场景加了 `sleep(0.2)`？** 无 pacing 时 5 VU 会以 ~5800 conn/s 疯狂建连-关闭，压垮单线程 mock 导致握手失败；加 pacing 才反映真实连通性。
- **为什么下单是运行期实时签名而非纯预签名？** Binance `recvWindow` 对时间戳敏感，预签名的时间戳在压测中会过期被 `-1021` 拒绝；实时签名保证新鲜。
- **签名字段顺序有讲究吗？** 有。本项目按参数名字母序拼接，与真实 Binance 约定一致；mock 对收到的原始 query 逐字重算 HMAC，故内部始终一致、又可无缝迁移真实交易所。
- **`ws.connect` 能在回调里递归重连吗？** 不能。它是阻塞式的，递归会嵌套阻塞、VU 永不释放；必须用外层 while 循环重连。
