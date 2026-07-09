// ============================================================================
// gen-orders.js — 生成预置订单模板数据 src/data/orders.json
// ============================================================================
// 运行：node scripts/gen-orders.js
// 产出：N 条「订单参数模板」（不含 timestamp / signature，那两项在 k6 运行期
//       每次请求时实时生成，保证时间戳新鲜、签名有效）。
// ============================================================================
const fs = require('fs');
const path = require('path');

// 交易对 + 参考价 + 精度（Binance 现货命名：无分隔符）
const SYMBOLS = [
  { symbol: 'BTCUSDT', price: 65000, pricePrec: 2, qtyPrec: 5, minQty: 0.001, weight: 0.4 },
  { symbol: 'ETHUSDT', price: 3400, pricePrec: 2, qtyPrec: 4, minQty: 0.01, weight: 0.3 },
  { symbol: 'SOLUSDT', price: 140, pricePrec: 3, qtyPrec: 2, minQty: 0.1, weight: 0.2 },
  { symbol: 'BNBUSDT', price: 300, pricePrec: 2, qtyPrec: 3, minQty: 0.01, weight: 0.1 },
];

const COUNT = 200;
const round = (n, p) => Math.round(n * 10 ** p) / 10 ** p;

// 按权重展开成抽样池
const pool = [];
SYMBOLS.forEach((s) => {
  for (let i = 0; i < Math.round(s.weight * 100); i++) pool.push(s);
});

const orders = [];
for (let i = 0; i < COUNT; i++) {
  const s = pool[Math.floor(Math.random() * pool.length)];
  const price = round(s.price * (0.98 + Math.random() * 0.04), s.pricePrec);
  const quantity = round(s.minQty + Math.random() * s.minQty * 20, s.qtyPrec);
  orders.push({
    symbol: s.symbol,
    side: Math.random() > 0.5 ? 'BUY' : 'SELL',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity,
    price,
  });
}

const outDir = path.resolve(__dirname, '../src/data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'orders.json'), JSON.stringify(orders));
console.log(`Generated ${orders.length} order templates -> src/data/orders.json`);
