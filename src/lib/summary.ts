/**
 * summary.ts — 自包含的测试报告生成（handleSummary）
 * ============================================================================
 * k6 在测试结束时会调用导出的 handleSummary(data)，其返回值决定「输出到哪里」：
 *   - key 为 'stdout' → 打印到终端；
 *   - key 为文件名   → 写入该文件。
 *
 * 这里不依赖远程 jslib（k6-summary），而是自己根据 data.metrics 的结构生成：
 *   1. 终端文本摘要（阈值 pass/fail + 关键指标）；
 *   2. summary.json（完整原始数据，供 CI 存档 / 二次分析）；
 *   3. summary.html（带样式的可视化报告，供人工查阅 / CI 工件上传）。
 *
 * 好处：完全离线、确定性输出，CI 不受网络波动影响；同时展示对 k6 指标数据
 * 结构（type / values / thresholds）的理解。
 */

// k6 传入的 summary 数据（仅声明用到的字段）
interface MetricValues {
  count?: number;
  rate?: number;
  avg?: number;
  min?: number;
  max?: number;
  med?: number;
  'p(90)'?: number;
  'p(95)'?: number;
  'p(99)'?: number;
  value?: number;
}

interface Metric {
  type: 'counter' | 'gauge' | 'rate' | 'trend';
  contains?: string;
  values: MetricValues;
  thresholds?: Record<string, { ok: boolean }>;
}

interface SummaryData {
  metrics: Record<string, Metric>;
}

/** 把一个指标格式化成一行文本 */
function formatMetric(name: string, m: Metric): string {
  const v = m.values;
  switch (m.type) {
    case 'counter':
      return `${name}: count=${fmt(v.count)} rate=${fmt(v.rate)}/s`;
    case 'rate':
      return `${name}: ${pct(v.rate)}`;
    case 'gauge':
      return `${name}: ${fmt(v.value)}`;
    case 'trend':
      return `${name}: avg=${fmt(v.avg)} p(95)=${fmt(v['p(95)'])} max=${fmt(v.max)}`;
    default:
      return `${name}: ${JSON.stringify(v)}`;
  }
}

function fmt(n: number | undefined): string {
  if (n === undefined) return '-';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function pct(r: number | undefined): string {
  if (r === undefined) return '-';
  return `${(r * 100).toFixed(2)}%`;
}

/** 收集所有阈值判定结果 */
function collectThresholds(data: SummaryData): Array<{ metric: string; name: string; ok: boolean }> {
  const out: Array<{ metric: string; name: string; ok: boolean }> = [];
  for (const metric of Object.keys(data.metrics)) {
    const m = data.metrics[metric];
    if (!m.thresholds) continue;
    for (const name of Object.keys(m.thresholds)) {
      out.push({ metric, name, ok: m.thresholds[name].ok });
    }
  }
  return out;
}

/** 终端文本摘要 */
function textReport(data: SummaryData): string {
  const lines: string[] = ['', '=== 测试摘要 ===', ''];

  const thresholds = collectThresholds(data);
  if (thresholds.length > 0) {
    lines.push('阈值门禁:');
    for (const t of thresholds) {
      lines.push(`  ${t.ok ? '✓' : '✗'} ${t.metric} — ${t.name}`);
    }
    lines.push('');
  }

  lines.push('关键指标:');
  for (const name of Object.keys(data.metrics)) {
    lines.push(`  ${formatMetric(name, data.metrics[name])}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** HTML 可视化报告 */
function htmlReport(data: SummaryData): string {
  const thresholds = collectThresholds(data);
  const allOk = thresholds.every((t) => t.ok);

  const thRows = thresholds
    .map(
      (t) =>
        `<tr class="${t.ok ? 'ok' : 'fail'}"><td>${t.ok ? 'PASS' : 'FAIL'}</td><td>${esc(t.metric)}</td><td>${esc(t.name)}</td></tr>`
    )
    .join('');

  const mRows = Object.keys(data.metrics)
    .map((name) => {
      const m = data.metrics[name];
      return `<tr><td>${esc(name)}</td><td>${m.type}</td><td>${esc(formatMetric(name, m).replace(name + ': ', ''))}</td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>k6 测试报告</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:2rem;color:#1f2937;background:#f9fafb}
  h1{font-size:1.4rem}
  .badge{display:inline-block;padding:.25rem .75rem;border-radius:999px;color:#fff;font-weight:600}
  .badge.ok{background:#16a34a}.badge.fail{background:#dc2626}
  table{border-collapse:collapse;width:100%;margin:1rem 0;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  th,td{padding:.5rem .75rem;border-bottom:1px solid #e5e7eb;text-align:left;font-size:.9rem}
  th{background:#f3f4f6}
  tr.ok td:first-child{color:#16a34a;font-weight:600}
  tr.fail td:first-child{color:#dc2626;font-weight:600}
  code{background:#f3f4f6;padding:.1rem .3rem;border-radius:4px}
</style></head><body>
<h1>k6 测试报告 <span class="badge ${allOk ? 'ok' : 'fail'}">${allOk ? '全部阈值通过' : '存在阈值失败'}</span></h1>
<h2>阈值门禁 (${thresholds.length})</h2>
<table><thead><tr><th>结果</th><th>指标</th><th>条件</th></tr></thead><tbody>${thRows || '<tr><td colspan="3">无</td></tr>'}</tbody></table>
<h2>指标明细</h2>
<table><thead><tr><th>指标</th><th>类型</th><th>值</th></tr></thead><tbody>${mRows}</tbody></table>
</body></html>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/**
 * k6 结束时调用。返回值的 key 决定输出目标（stdout / 文件名）。
 */
export function handleSummary(data: SummaryData): Record<string, string> {
  return {
    stdout: textReport(data),
    'summary.json': JSON.stringify(data, null, 2),
    'summary.html': htmlReport(data),
  };
}
