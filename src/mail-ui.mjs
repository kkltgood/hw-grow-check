/**
 * 邮件版式零件（结果邮件与日报共用）。
 *
 * 视觉对齐新站 grow.developer.huaweicloud.com：白底、近黑标题、浅灰卡片 +
 * 细边框 + 圆角、积分用琥珀色。这些值是从页面 computed style 和截图取色得到的，
 * 改动时只改这一个文件，两个邮件模板会自动跟着变。
 *
 * 全部 table + inline style：QQ 邮箱 / Gmail / Outlook 都会剥掉 <style> 和 flex，
 * 所以这里不用任何外部 CSS。
 */

export const T = {
  ink: "#191919", // 标题 / 主数字
  body: "#575D6C", // 正文
  muted: "#8A8F99", // 说明文字
  faint: "#A8ADB8", // 页脚
  line: "#F0F0F0", // 卡片边框
  hair: "#F5F5F5", // 行分割线
  card: "#FAFAFA", // 卡片底
  page: "#F4F5F7", // 邮件外底色
  amber: "#FF8800", // 积分强调色（取自新站）
  amberBg: "#FFF4E6",
  green: "#12B76A",
  greenBg: "#ECFDF3",
  red: "#F04438",
  redBg: "#FEF3F2",
  orange: "#F79009",
  orangeBg: "#FFFAEB",
};

export const FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";

export const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * 任务周期 → 展示名。顺序与官网 tab 一致：每日 → 每周 → 每月 → 一次性。
 * 新版接口的 cycle_type 取值是 DAILY / WEEKLY / MONTHLY / LIMIT。
 */
export const CYCLE = {
  DAILY: { label: "每日任务", order: 1 },
  WEEKLY: { label: "每周任务", order: 2 },
  MONTHLY: { label: "每月任务", order: 3 },
  LIMIT: { label: "一次性任务", order: 4 },
};

const ALIAS = { ONCE: "LIMIT", ONETIME: "LIMIT", ONE_TIME: "LIMIT", DAILY_TASK: "DAILY" };

function cycleMeta(cycle) {
  const key = ALIAS[String(cycle || "").toUpperCase()] || String(cycle || "").toUpperCase();
  return CYCLE[key] || { label: "其他任务", order: 9 };
}

/** 按周期分组；老 state.json 没有 cycle 字段时统一落到「其他任务」 */
export function groupByCycle(items = []) {
  const map = new Map();
  for (const m of items) {
    const meta = cycleMeta(m.cycle);
    const key = meta.label;
    if (!map.has(key)) map.set(key, { label: meta.label, order: meta.order, items: [], sum: 0 });
    const g = map.get(key);
    g.items.push(m);
    g.sum += Number(m.bonus) || 0;
  }
  return [...map.values()].sort((a, b) => a.order - b.order);
}

/**
 * 顶部彩条的三套配色。白色文字压在上面，所以取的是同色系里偏深的一档，
 * 保证 QQ 邮箱 / Gmail 里文字都还看得清。
 */
export const BAND = {
  ok: { from: "#17B26A", to: "#079455" },
  fail: { from: "#F04438", to: "#D92D20" },
  warn: { from: "#F79009", to: "#B54708" },
  neutral: { from: "#98A2B3", to: "#667085" },
};

/**
 * 顶部通栏：品牌行 + 状态标题（白字），可选副标题与右侧药丸。
 *
 * 渐变用 background-image 叠在 background-color 之上：Outlook 桌面版会丢掉渐变，
 * 但还有纯色兜底，不会出现白底白字的空白条。
 *
 * @param {{tone?: "ok"|"fail"|"warn"|"neutral", brand?: string, right?: string,
 *          title?: string, subtitle?: string, badge?: string}} o
 */
export function band({
  tone = "ok",
  brand = "华为云开发者成长中心",
  right = "",
  title = "",
  subtitle = "",
  badge = "",
} = {}) {
  const c = BAND[tone] || BAND.ok;
  return `<div style="background-color:${c.from};background-image:linear-gradient(135deg,${c.from},${c.to});
    padding:18px 26px 20px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr>
        <td style="color:rgba(255,255,255,.8);font-size:11px;letter-spacing:.6px">${esc(brand)}</td>
        <td align="right" style="color:rgba(255,255,255,.8);font-size:11px">${esc(right)}</td>
      </tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:10px">
      <tr>
        <td style="vertical-align:middle;padding-right:14px">
          <div style="color:#fff;font-size:21px;font-weight:600;line-height:1.35">${title}</div>
          ${
            subtitle
              ? `<div style="color:rgba(255,255,255,.84);font-size:12.5px;line-height:1.75;
                   margin-top:5px">${subtitle}</div>`
              : ""
          }
        </td>
        ${badge ? `<td align="right" style="vertical-align:middle;white-space:nowrap">${badge}</td>` : ""}
      </tr>
    </table>
  </div>`;
}

/** 彩条里的药丸：半透明白底，压在白字旁边不会抢注意力 */
export function bandPill(text) {
  return `<span style="display:inline-block;background:rgba(255,255,255,.18);
    border:1px solid rgba(255,255,255,.38);color:#fff;font-size:12px;font-weight:600;
    line-height:1;padding:7px 11px;border-radius:999px">${text}</span>`;
}

/** 数据块：主数字 + 注解 */
export function statCard(label, value, unit, note, accent = T.ink) {
  return `<div style="background:${T.card};border:1px solid ${T.line};border-radius:12px;padding:14px 16px">
    <div style="color:${T.muted};font-size:12px">${label}</div>
    <div style="color:${accent};font-size:28px;font-weight:700;line-height:1.25;margin-top:5px">
      ${value}<span style="font-size:13px;font-weight:400;color:${T.muted};margin-left:4px">${unit}</span>
    </div>
    <div style="color:${T.faint};font-size:11px;margin-top:3px">${note}</div>
  </div>`;
}

/** 两列数据块（邮件里用 table 模拟，不用 flex） */
export function statPair(left, right) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0">
    <tr>
      <td width="50%" style="padding-right:5px;vertical-align:top">${left}</td>
      <td width="50%" style="padding-left:5px;vertical-align:top">${right}</td>
    </tr>
  </table>`;
}

/** 键值行 */
export function row(k, v, color = T.ink) {
  return `<tr>
    <td style="padding:11px 0;border-bottom:1px solid ${T.hair};color:${T.muted};font-size:13px">${esc(k)}</td>
    <td align="right" style="padding:11px 0;border-bottom:1px solid ${T.hair};color:${color};
        font-size:13px;font-weight:600">${v}</td>
  </tr>`;
}

/** 小节标题：左边一行黑字，右边补充说明 */
export function sectionLabel(text, extra = "") {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:10px">
    <tr>
      <td style="color:${T.ink};font-size:13px;font-weight:600">${text}</td>
      <td align="right" style="color:${T.muted};font-size:12px">${extra}</td>
    </tr>
  </table>`;
}

/**
 * 一个任务：未完成是浅灰卡 + 橙色分数；已完成是白卡 + 绿勾 + 灰色标题。
 * 用「✓ / ○」而不是 emoji，邮件客户端里不会变成彩色方块。
 * 可选 m.progress：标题后的进度，`{ done, total }`。done 用琥珀色和分值呼应，
 * total 走浅灰，既有颜色区分又不和右侧的完成状态抢注意力。
 */
function taskCard(m) {
  const done = m.done === true;
  return `<div style="background:${done ? "#FFFFFF" : T.card};border:1px solid ${T.line};
    border-radius:10px;padding:10px 13px;margin-bottom:6px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <tr>
        <td width="16" style="vertical-align:top;padding-top:1px;font-size:12px;line-height:1.6;
            color:${done ? T.green : "#D5DAE1"}">${done ? "✓" : "○"}</td>
        <td style="color:${done ? T.muted : T.ink};font-size:13px;line-height:1.5;padding-right:10px">
          ${esc(m.title)}${
            m.progress
              ? `<span style="margin-left:8px;font-size:11.5px;font-weight:400;white-space:nowrap">
                   <span style="color:${T.green};font-weight:600">${esc(m.progress.done)}</span><span
                     style="color:${T.faint}"> / </span><span
                     style="color:${T.amber};font-weight:600">${esc(m.progress.total)}</span></span>`
              : ""
          }
        </td>
        <td align="right" style="white-space:nowrap;font-size:12px;font-weight:600">
          ${
            done
              ? `<span style="color:${T.green}">已完成</span>
                 <span style="color:${T.faint};font-weight:400">+${esc(m.bonus)}</span>`
              : `<span style="color:${T.amber}">+${esc(m.bonus)}</span>`
          }
        </td>
      </tr>
    </table>
  </div>`;
}

/**
 * 任务清单：先给一排分类药丸（和新站 全部/每日/每周/每月/一次性 的 tab 呼应），
 * 再按分类分组列卡片。每项都带完成状态，分组标题右边是「完成数/总数 · 待领分数」。
 *
 * @param {Array} items 每项需含 {title, bonus, cycle, done}
 * @param {{perGroup?: number, showHeader?: boolean}} opts
 *        perGroup   每组最多展示几条，超出折叠成「还有 N 项」
 *        showHeader 是否显示标题行（卡片里已有数字时可关掉，避免重复）
 */
export function tasksBlock(items = [], { perGroup = 6, showHeader = true } = {}) {
  if (!items.length) return "";
  const groups = groupByCycle(items);
  const doneAll = items.filter((m) => m.done === true);
  const leftPoints = items
    .filter((m) => m.done !== true)
    .reduce((a, m) => a + (Number(m.bonus) || 0), 0);

  const chips = groups
    .map((g) => {
      const done = g.items.filter((m) => m.done === true).length;
      return `<span style="display:inline-block;background:${T.hair};color:${T.body};font-size:12px;
        line-height:1;padding:7px 10px;border-radius:999px;margin:0 6px 6px 0">${g.label}
        <span style="color:${T.ink};font-weight:600">${done}/${g.items.length}</span></span>`;
    })
    .join("");

  const sections = groups
    .map((g) => {
      const shown = g.items.slice(0, perGroup);
      const done = g.items.filter((m) => m.done === true).length;
      const left = g.items
        .filter((m) => m.done !== true)
        .reduce((a, m) => a + (Number(m.bonus) || 0), 0);
      const more =
        g.items.length > shown.length
          ? `<div style="color:${T.faint};font-size:12px;padding:1px 2px 0">还有 ${
              g.items.length - shown.length
            } 项…</div>`
          : "";
      return `<div style="margin-top:14px">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px">
          <tr>
            <td style="color:${T.ink};font-size:12px;font-weight:600">${g.label}</td>
            <td align="right" style="color:${T.muted};font-size:11px">
              ${done}/${g.items.length} 完成${left ? ` · 待领 +${left}` : ""}
            </td>
          </tr>
        </table>
        ${shown.map(taskCard).join("")}${more}
      </div>`;
    })
    .join("");

  const hasDone = doneAll.length > 0;
  const summary = hasDone
    ? `${items.length} 项 · 已完成 ${doneAll.length}${leftPoints ? ` · 待领 +${leftPoints}` : ""}`
    : `${items.length} 项 · 约 +${leftPoints} 分`;

  return `<div style="margin-top:22px">
    ${showHeader ? sectionLabel(hasDone ? "任务清单" : "待领任务", summary) : ""}
    <div style="margin-bottom:2px">${chips}</div>
    ${sections}
  </div>`;
}

/** 提示块：左侧细色条，可带浅色底 */
export function notice(color, title, inner, { bg = T.card } = {}) {
  return `<div style="margin-top:20px;background:${bg};border:1px solid ${T.line};
    border-left:3px solid ${color};border-radius:10px;padding:13px 15px">
    <div style="color:${T.ink};font-size:13px;font-weight:600;margin-bottom:5px">${title}</div>
    <div style="color:${T.body};font-size:12px;line-height:1.85">${inner}</div>
  </div>`;
}

/** 整封邮件的骨架：顶部彩条 + 内容 + 页脚 */
export function shell({ band: header = "", body = "", footer = "" }) {
  return `<div style="background:${T.page};padding:28px 12px;font-family:${FONT}">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid ${T.line};
              border-radius:16px;overflow:hidden">
    ${header}
    <div style="padding:24px 26px 26px">${body}</div>
    <div style="padding:15px 26px;border-top:1px solid ${T.hair};color:${T.faint};
                font-size:11px;line-height:1.9">${footer}</div>
  </div>
</div>`;
}
