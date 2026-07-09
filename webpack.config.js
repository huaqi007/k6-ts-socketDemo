const path = require('path');

/**
 * webpack.config.js — 将 TypeScript 源码打包为 k6 可执行的 CommonJS 单文件
 * ============================================================================
 * 说明：
 *   - k6 运行的是「打包后的 JS」，不是 TS 源码；k6 自身不认识 import/模块系统。
 *   - ts-loader 负责 TS → JS 编译，webpack 负责把多文件依赖打成单文件 bundle。
 *   - k6 内置模块（k6、k6/ws、k6/http、k6/crypto、k6/data、k6/metrics）由
 *     k6 运行时在执行期注入，因此用 externals 排除，绝不能让 webpack 打进去。
 *
 * 每个 entry = 一个可独立 `k6 run` 的场景脚本。
 */
module.exports = {
  mode: 'production',
  entry: {
    // ── 需求 1：WS 连通性 + 深度订阅 + bids/asks 解析 ──
    '01-ws-connect': './src/scenarios/01-ws-connect.ts',
    '02-ws-subscribe': './src/scenarios/02-ws-subscribe.ts',
    // ── 需求 2：断线重连框架（while(true) + 指数退避 + jitter）──
    '03-ws-reconnect': './src/scenarios/03-ws-reconnect.ts',
    // ── 需求 3：500 VU ramping-vus 阶梯并发订阅 ──
    '04-ws-500vu': './src/scenarios/04-ws-500vu.ts',
    // ── 需求 4：Binance 风格 HMAC-SHA256 签名下单 ──
    '05-signed-order': './src/scenarios/05-signed-order.ts',
    // ── 需求 5：WS 行情 + 签名下单全链路混合场景 ──
    'mixed-scenario': './src/scenarios/mixed-scenario.ts',
    // CI 冒烟场景（短时低压，复用同一套 exec 函数）
    'smoke-scenario': './src/scenarios/smoke-scenario.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  target: 'node',
  stats: 'errors-only',
  // k6 内置模块不需要 webpack 打包（运行时注入）
  externals: /^k6(\/.*)?$/,
};
