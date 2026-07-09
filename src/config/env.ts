/**
 * env.ts — 运行时环境配置（支持环境变量覆盖）
 * ============================================================================
 * 所有地址、密钥统一从这里读取，方便本地 / Docker / K8s 多环境切换：
 *   k6 run -e WS_URL=ws://host:8080/ws -e BASE_URL=http://host:8080 script.js
 */

/** HTTP REST 基地址（健康检查 / 下单） */
export function getBaseUrl(): string {
  return __ENV.BASE_URL || 'http://localhost:8080';
}

/** WebSocket 行情地址 */
export function getWsUrl(): string {
  return __ENV.WS_URL || 'ws://localhost:8080/ws';
}

/**
 * Binance 风格 API 凭证
 *   - apiKey  → 明文放请求头 X-MBX-APIKEY
 *   - secret  → 仅用于本地 HMAC 计算，绝不出现在请求中
 * 测试默认值与 mock-server.js 中的校验值保持一致。
 */
export function getApiKey(): string {
  return __ENV.API_KEY || 'test-api-key';
}

export function getApiSecret(): string {
  return __ENV.API_SECRET || 'test-api-secret';
}
