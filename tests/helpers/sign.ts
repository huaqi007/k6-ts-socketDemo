/**
 * sign.ts — Binance 风格 HMAC-SHA256 签名助手（Node crypto，供 E2E 下单用例复用）
 * ============================================================================
 * 与 src/modules/pre-signer.ts 的签名规则完全一致：
 *   signature = HMAC_SHA256(secret, 按参数名字母序拼接的 query string)
 * 使 Playwright 功能测试与 k6 压测使用相同的签名约定，靶机验签统一。
 */
import crypto from 'crypto';

export const apiKey = process.env.API_KEY || 'test-api-key';
const apiSecret = process.env.API_SECRET || 'test-api-secret';

export interface OrderParams {
  symbol: string;
  side: string;
  type: string;
  timeInForce: string;
  quantity: number;
  price: number;
}

export interface SignOpts {
  recvWindow?: number;
  timestamp?: number;
  secret?: string;
}

/** 生成排序后的 query 及其签名 */
export function signOrderQuery(p: OrderParams, opts: SignOpts = {}): { query: string; signature: string } {
  const params: Record<string, string | number> = {
    symbol: p.symbol,
    side: p.side,
    type: p.type,
    timeInForce: p.timeInForce,
    quantity: p.quantity,
    price: p.price,
    recvWindow: opts.recvWindow ?? 5000,
    timestamp: opts.timestamp ?? Date.now(),
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const signature = crypto.createHmac('sha256', opts.secret ?? apiSecret).update(query).digest('hex');
  return { query, signature };
}

export const SAMPLE_ORDER: OrderParams = {
  symbol: 'BTCUSDT',
  side: 'BUY',
  type: 'LIMIT',
  timeInForce: 'GTC',
  quantity: 0.01,
  price: 65000,
};
