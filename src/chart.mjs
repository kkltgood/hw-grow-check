/**
 * 把 7 天积分序列画成一张 PNG，供邮件内嵌（cid）。
 *
 * 为什么不用内联 SVG：Gmail / QQ 邮箱会剥掉 <svg>，Outlook 根本不支持；
 * 只有 PNG 在各家客户端里都能稳定显示。渲染用项目本来就有的 Playwright，
 * 不额外引依赖——每天一封邮件多花 3~4 秒，可以接受。
 */
import { launchBrowser } from "./browser.mjs";

const W = 520;
const H = 190;
const PAD = { top: 26, right: 18, bottom: 30, left: 46 };

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 把区间取整到「好看」的刻度（1/2/5 × 10^n），避免出现 457、533 这种刻度 */
function niceScale(minV, maxV, targetTicks = 4) {
  if (maxV === minV) {
    minV -= 5;
    maxV += 5;
  }
  const raw = (maxV - minV) / Math.max(1, targetTicks - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const min = Math.floor(minV / step) * step;
  let max = Math.ceil(maxV / step) * step;
  if (max === maxV) max += step; // 顶点贴着上沿会显得挤，留一格余量
  const ticks = [];
  for (let v = min; v <= max + step * 0.001; v += step) ticks.push(Math.round(v));
  return { min, max: max === min ? min + step : max, ticks };}

function buildSvg(series) {
  const known = series.filter((p) => p.points != null);
  if (!known.length) return null;

  const values = known.map((p) => p.points);
  const { min, max, ticks } = niceScale(Math.min(...values), Math.max(...values));

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const stepX = series.length > 1 ? plotW / (series.length - 1) : 0;

  const x = (i) => PAD.left + i * stepX;
  const y = (v) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;

  // 横向网格 + 左侧刻度（用取整后的刻度值）
  const gridLines = ticks.map((v) => {
    const yy = y(v);
    return `<line x1="${PAD.left}" y1="${yy.toFixed(1)}" x2="${W - PAD.right}" y2="${yy.toFixed(1)}" stroke="#eef2f7" stroke-width="1"/>
      <text x="${PAD.left - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="#9aa6b2">${v}</text>`;
  });

  // 积分是累计值：没有记录的那天不会有变化，沿用前一天的值画平线。
  // 首个记录之前的日子无法推断，留空（不画）。
  let lastKnown = null;
  const filled = series.map((p) => {
    if (p.points != null) {
      lastKnown = p.points;
      return { ...p, value: p.points, measured: true };
    }
    return lastKnown == null
      ? { ...p, value: null, measured: false }
      : { ...p, value: lastKnown, measured: false };
  });

  // 线段：连续有值的点连成一条；只有首个记录之前会断开
  const segs = [];
  let cur = [];
  filled.forEach((p, i) => {
    if (p.value == null) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
    } else {
      cur.push([x(i), y(p.value)]);
    }
  });
  if (cur.length > 1) segs.push(cur);

  const paths = segs
    .map(
      (seg) =>
        `<polyline points="${seg.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join("");

  // 点：有记录的画实心并标数值；推断出来的画小空心点，不标数值，避免把推测说成事实
  const dots = filled
    .map((p, i) => {
      if (p.value == null) return "";
      const px = x(i);
      const py = y(p.value);
      if (!p.measured) {
        // 当天没有在本机签到：积分沿用前一日，照样标数字，但用灰点和浅灰字区分开
        const lx = Math.min(Math.max(px, PAD.left + 14), W - PAD.right - 14);
        return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
        <text x="${lx.toFixed(1)}" y="${(py - 9).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="400" fill="#9aa6b2">${p.value}</text>`;
      }
      const lx = Math.min(Math.max(px, PAD.left + 14), W - PAD.right - 14);
      return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" fill="#fff" stroke="#16a34a" stroke-width="2"/>
        <text x="${lx.toFixed(1)}" y="${(py - 9).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="#0f172a">${p.value}</text>`;
    })
    .join("");

  // 横轴日期
  const xLabels = series
    .map(
      (p, i) =>
        `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#9aa6b2">${esc(p.md)}</text>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    ${gridLines.join("")}
    ${paths}
    ${dots}
    ${xLabels}
  </svg>`;
}

/** 返回 PNG Buffer；数据不足或无数据时返回 null */
export async function renderPointsChart(series) {
  const svg = buildSvg(series);
  if (!svg) return null;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#fff}
    #chart{width:${W}px;height:${H}px}
  </style></head><body><div id="chart">${svg}</div></body></html>`;

  // 复用项目的启动逻辑：找不到 Playwright 自带 Chromium 时自动回退系统 Chrome
  const browser = await launchBrowser({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "load" });
    const el = await page.$("#chart");
    return await el.screenshot({ type: "png" });
  } finally {
    await browser.close().catch(() => {});
  }
}
