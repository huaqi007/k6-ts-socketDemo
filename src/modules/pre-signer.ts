/**
 * pre-signer.ts — Binance 风格 HMAC-SHA256 签名下单模块
 * ============================================================================
 * 对照 k6-ts-workDemo/src/modules/pre-signer.ts 的思路实现，但做了两点关键升级：
 *
 *   1. 签名算法对齐真实 Binance：
 *        signature = HMAC_SHA256(secret, totalParams)
 *        totalParams = 排好序拼接的 query string（含 timestamp / recvWindow）
 *        最终请求：POST /api/v3/order?<totalParams>&signature=<sig>
 *        请求头：  X-MBX-APIKEY: <apiKey>
 *
 *   2. 「模板预加载 + 运行期实时签名」分层：
 *        - 昂贵且可复用的「订单参数模板」用 SharedArray 只解析一次、全 VU 共享；
 *        - timestamp 与 signature 在每次请求时实时计算（Date.now()），
 *          保证时间戳新鲜、落在服务端 recvWindow 内，避免被 -1021 拒绝。
 *      （workDemo 是纯预签名 + 时间戳偏移；行情下单对时效更敏感，故改为实时签名）
 *
 * 为什么用 SharedArray 装模板？
 *   k6 中每个 VU 是独立 JS 虚拟机，普通 import 会让每个 VU 都解析一遍 JSON。
 *   SharedArray 把数据放共享内存，500 VU 也只解析一次，显著省内存。
 */

import { SharedArray } from 'k6/data';
import crypto from 'k6/crypto';
import { getApiKey, getApiSecret } from '../config/env';
import { metrics } from '../lib/metrics';

// ============================================================================
// 类型
// ============================================================================

/** 订单参数模板（静态部分，来自 orders.json） */
export interface OrderTemplate {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  quantity: number;
  price: number;
}

/** 一次签名后可直接发送的请求材料 */
export interface SignedRequest {
  url: string;                        // 含 query + signature 的完整下单 URL
  headers: Record<string, string>;    // 含 X-MBX-APIKEY
  symbol: string;
}

// ============================================================================
// 订单模板 SharedArray（init context 只解析一次，全 VU 共享）
// ============================================================================
export const orderTemplates = new SharedArray<OrderTemplate>('orderTemplates', () => {
  // 路径支持环境变量覆盖，适配容器 / K8s ConfigMap 挂载
  const DATA_PATH = __ENV.DATA_PATH || './data';
  return JSON.parse(open(`${DATA_PATH}/orders.json`)) as OrderTemplate[];
});

// ============================================================================
// 交易对 → 模板下标索引（O(1) 按币种取单，配合加权随机）
// ============================================================================
export const templatesBySymbol: Record<string, number[]> = (() => {
  const map: Record<string, number[]> = {};
  for (let i = 0; i < orderTemplates.length; i++) {
    const sym = orderTemplates[i].symbol;
    if (!map[sym]) map[sym] = [];
    map[sym].push(i);
  }
  return map;
})();

// ============================================================================
// 核心：把订单模板签名成可发送的请求
// ============================================================================

/**
 * 依据 Binance 规则对订单模板签名。
 *
 * 步骤：
 *   1. 组装全部签名参数（业务参数 + timestamp + recvWindow）；
 *   2. ✅ 按「参数名字母序」拼接成 query string —— 对齐真实 Binance 的签名约定，
 *      使本地签名可直接迁移到真实交易所（mock 对原始 query 重算，二者始终一致）；
 *   3. signature = HMAC_SHA256(secret, query)（十六进制）；
 *   4. 把 signature 追加到 query 末尾，拼成完整下单 URL；
 *   5. apiKey 放请求头（明文），secret 绝不出现在请求中。
 *
 * HMAC 计算包在 try-catch 中：secret 为空 / 参数异常时不会终止整个 VU 迭代，
 * 而是记录 script_errors 并返回 null，交由调用方安全跳过本次下单。
 *
 * @param tpl        订单参数模板
 * @param baseUrl    REST 基地址
 * @param recvWindow 服务端可接受的时间戳偏差窗口（毫秒），默认 5000
 * @returns 可发送的签名请求；签名失败时返回 null
 */
export function signOrder(tpl: OrderTemplate, baseUrl: string, recvWindow = 5000): SignedRequest | null {
  const apiKey = getApiKey();
  const secret = getApiSecret();

  // 汇总所有参与签名的参数（值统一转成字符串拼接）
  const params: Record<string, string | number> = {
    symbol: tpl.symbol,
    side: tpl.side,
    type: tpl.type,
    timeInForce: tpl.timeInForce,
    quantity: tpl.quantity,
    price: tpl.price,
    recvWindow,
    timestamp: Date.now(),
  };

  // ✅ 按参数名字母序排序后拼接：price → quantity → recvWindow → side
  //    → symbol → timeInForce → timestamp → type（与真实 Binance 约定一致）
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');

  // HMAC-SHA256 签名（k6/crypto 运行时提供）；异常时安全降级
  let signature: string;
  try {
    signature = crypto.hmac('sha256', secret, query, 'hex') as string;
  } catch (e) {
    metrics.scriptErrors.add(1);
    console.error(`[signOrder] HMAC 计算失败，跳过本次下单: ${e}`);
    return null;
  }

  return {
    url: `${baseUrl}/api/v3/order?${query}&signature=${signature}`,
    headers: { 'X-MBX-APIKEY': apiKey },
    symbol: tpl.symbol,
  };
}

/**
 * 随机取一条订单模板（无权重，简单均匀）。
 */
export function randomTemplate(): OrderTemplate {
  return orderTemplates[Math.floor(Math.random() * orderTemplates.length)];
}

/**
 * 按交易对取一条随机模板；找不到则回退为全局随机。
 * 用于配合加权随机 symbol，模拟真实成交量分布。
 */
export function templateBySymbol(symbol: string): OrderTemplate {
  const idxs = templatesBySymbol[symbol];
  if (!idxs || idxs.length === 0) return randomTemplate();
  return orderTemplates[idxs[Math.floor(Math.random() * idxs.length)]];
}
