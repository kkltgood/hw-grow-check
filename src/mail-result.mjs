#!/usr/bin/env node
/**
 * 把「本次跑完的结果」发成一封邮件。
 *
 * 为什么单独一个脚本：签到成功时 cli.mjs 走的是 notify()（只推 webhook，不发邮件），
 * 而定时任务需要「每次都有结论」。失败那封由 cli.mjs 的 alert 链路负责，
 * 但那样会出现「登录失效发一封 + 补登成功又发一封」，所以 daily.sh 里用
 * GROW_QUIET_MAIL 让 cli 闭嘴，最后由这里统一发唯一的一封。
 *
 * 版式对齐新站 grow.developer.huaweicloud.com：白底、近黑标题、浅灰卡片 + 细边框、
 * 积分用琥珀色；待领任务按「每日 / 每周 / 每月 / 一次性」分组，和官网任务清单一致。
 * 版式零件都在 src/mail-ui.mjs，日报共用同一套。
 *
 * 用法：
 *   node src/mail-result.mjs --ok
 *   node src/mail-result.mjs --fail --code 3 --reason "登录态失效"
 *   node src/mail-result.mjs --remind --reason "..."
 *   加 --dry 只打印不发送
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, config } from "./config.mjs";
import { mailConfigured, sendMail } from "./mail.mjs";
import { recentSeries, recordPoints } from "./points-history.mjs";
import { renderPointsChart } from "./chart.mjs";
import {
  T,
  band,
  bandPill,
  esc,
  notice,
  row,
  sectionLabel,
  shell,
  statCard,
  statPair,
  tasksBlock,
} from "./mail-ui.mjs";

const TZ = "Asia/Shanghai";
/** 补跑命令：默认按仓库实际位置生成，也可用 GROW_DAILY_CMD 覆盖 */
const DAILY_CMD = process.env.GROW_DAILY_CMD || `bash "${join(ROOT, "scripts/daily.sh")}"`;
/** 只补签到：登录态还在时用这条，不用再扫一次码 */
const RETRY_CMD =
  process.env.GROW_RETRY_CMD || `cd "${ROOT}" && GROW_TASKS=checkin node src/cli.mjs run`;
const args = process.argv.slice(2);
const OK = args.includes("--ok");
const REMIND = args.includes("--remind");
const DRY = args.includes("--dry");
const pick = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : "");
const CODE = pick("--code");
const REASON = pick("--reason");

/**
 * 发件人显示名跟着结果走：成功 / 提醒 / 告警。
 * 以前统一叫「华为云签到告警」，签到成功也顶着一个告警的发件人，很容易误判。
 */
const FROM_NAME = REMIND ? "华为云签到提醒" : OK ? "华为云签到成功" : "华为云签到告警";

const now = new Date();
const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
const md = day.slice(5); // 11-23
const hhmm = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TZ,
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
}).format(now);
const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, weekday: "long" }).format(now);

/** 每日定时任务的执行时刻，只用于邮件文案；改定时任务时同步这里（或设 GROW_RUN_AT） */
const RUN_AT = process.env.GROW_RUN_AT || "09:15";

function readState() {
  try {
    return existsSync(config.stateFile) ? JSON.parse(readFileSync(config.stateFile, "utf8")) : {};
  } catch {
    return {};
  }
}

/**
 * Star 任务的池子进度：读 star-runner 落盘的 stats，在任务清单那一行显示
 * 「已 Star 数 / 仓库总数」。任务清单里没有 tag，按标题匹配；读不到就不显示。
 */
const STAR_PROGRESS = [
  { title: "Star一个鸿蒙案例代码仓", file: "star-case.json" },
  { title: "每周Star一个Agent开发实践中心代码仓", file: "star-weekly.json" },
];

const normTitle = (v) => String(v || "").replace(/\s+/g, "");

function readStarStats(file) {
  try {
    const p = join(config.dataDir, file);
    if (!existsSync(p)) return null;
    const st = JSON.parse(readFileSync(p, "utf8")).stats;
    const poolSize = Number(st?.poolSize);
    if (!Number.isFinite(poolSize) || poolSize <= 0) return null;
    return { starred: Math.min(poolSize, Number(st.starred) || 0), poolSize };
  } catch {
    return null;
  }
}

function withStarProgress(items) {
  const pairs = STAR_PROGRESS.map((s) => ({ ...s, stats: readStarStats(s.file) })).filter((s) => s.stats);
  if (!pairs.length) return items;
  return items.map((m) => {
    const title = normTitle(m.title);
    const hit = pairs.find((p) => title.includes(normTitle(p.title)));
    return hit ? { ...m, progress: { done: hit.stats.starred, total: hit.stats.poolSize } } : m;
  });
}

const s = readState();
const todayState = s.date === day;
const checkin = todayState ? (s.results || []).find((r) => r.id === "checkin") : null;
/** Star 类任务（每日 / 每周）没自动完成时，在成功邮件里单独提醒 */
const starResults = todayState
  ? (s.results || []).filter((r) => r.id === "star" || r.id === "star-weekly")
  : [];
const starAttention = starResults.filter((r) => !["signed", "already"].includes(r.status));
const delta = s.pointsBefore != null && s.pointsAfter != null ? s.pointsAfter - s.pointsBefore : null;
const pending = s.pending || [];
const pendingSum = pending.reduce((a, m) => a + (m.bonus || 0), 0);
/**
 * 全量任务清单（含已完成）。新跑法会写 s.tasks；老 state.json 只有 pending，
 * 那就退回「只列未完成」，展示上等价于以前的待领清单。
 */
const tasks = withStarProgress(
  Array.isArray(s.tasks) && s.tasks.length ? s.tasks : pending.map((m) => ({ ...m, done: false })),
);
/** 签到值多少分：优先取任务清单，读不到按 10 分，用于「0 / 10」这类文案 */
const signBonus = Number((tasks.find((m) => /签到/.test(m.title || "")) || {}).bonus) || 10;

const detail = checkin?.detail || (todayState ? "已签到" : "已完成（未见今日记录）");
const streak = Number((detail.match(/连续\s*(\d+)\s*天/) || [])[1] || 0);
const perDay = Number((detail.match(/\+(\d+)/) || [])[1] || 0);

const brand = `${md} · ${weekday}`;

/** 把 state.json 里的 ISO 时刻转成本地 HH:MM */
function hhmmAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
const footerText = (nextLine) => `由本机定时任务自动生成 · ${hhmm}<br>${esc(nextLine)}`;

// ---------------------------------------------------------------- 内容

let subject;
let lines = [];
let html;
let chartPng = null;

if (REMIND) {
  const reason = REASON || "周末不在电脑前，无法扫码登录";
  subject = `📅 周末签到提醒 · ${md} · 请用手机补签`;

  lines = [
    `原因：${reason}`,
    `时间：${day} ${hhmm}（${weekday}）`,
    `影响：今天没有签到，积分不会增加`,
    "处理：手机打开成长中心，登录后点签到（约 20 秒）",
  ];

  const body = `
    <div>
      ${statPair(
        statCard("今日积分", "0", "分", "这 10 分还没拿到", T.orange),
        statCard("待补积分", String(perDay || 10), "分", "补上就能续上连续"),
      )}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px">
      ${row("日期", `${md} ${weekday}`)}
      ${row("会话状态", "已失效", "#B54708")}
    </table>
    ${notice(
      T.orange,
      "手机上补签（约 20 秒）",
      `1. 打开 <a href="https://grow.developer.huaweicloud.com/" style="color:${T.amber};text-decoration:none">grow.developer.huaweicloud.com</a><br>
       2. 没登录就先登录（账号密码 + 短信验证码，只需一次）<br>
       3. 在「每日签到」任务卡片上点「签到」`,
      { bg: T.orangeBg },
    )}`;

  html = shell({
    band: band({
      tone: "warn",
      right: brand,
      title: "今天还没签到",
      subtitle: esc(reason),
      badge: bandPill("待补签"),
    }),
    body,
    footer: footerText(`工作日 ${RUN_AT} 自动运行，周末不弹扫码窗口`),
  });
} else if (OK) {
  const gained = delta != null && delta > 0;
  const pts = s.pointsAfter ?? "?";

  // 先把今天的积分补记进历史（手动 / 单独调用本脚本时也能攒数据）
  if (s.pointsAfter != null) recordPoints(config.dataDir, day, s.pointsAfter);
  const series = recentSeries(config.dataDir, 7);
  const knownCount = series.filter((x) => x.points != null).length;
  // 少于两天数据就不画图，省掉一次浏览器启动
  chartPng = knownCount >= 2 ? await renderPointsChart(series).catch(() => null) : null;

  const chartBlock =
    chartPng && knownCount >= 2
      ? `<div style="margin-top:22px">
           ${sectionLabel("近 7 天积分", `共 ${knownCount} 天有记录`)}
           <div style="background:#fff;border:1px solid ${T.line};border-radius:12px;padding:10px 6px 4px">
             <img src="cid:points7" width="500" alt="近 7 天积分曲线"
                  style="display:block;width:100%;max-width:500px;height:auto;border:0" />
           </div>
           <div style="color:${T.faint};font-size:11px;margin-top:7px">
             空心灰点＝当天没有在本机签到，积分沿用前一日
           </div>
         </div>`
      : `<div style="margin-top:20px;background:${T.card};border:1px dashed ${T.line};border-radius:12px;
                     padding:14px 16px;color:${T.faint};font-size:12px;line-height:1.8">
           积分曲线需要至少两天的记录，今天这条已经存下了，明早开始显示趋势。
         </div>`;

  subject = gained
    ? `✅ 华为云签到成功 · ${md} · +${delta}（积分 ${pts}）`
    : `✅ 华为云签到完成 · ${md} · 今日已签（积分 ${pts}）`;

  const pointsText =
    s.pointsBefore != null && s.pointsAfter != null
      ? `${s.pointsBefore} → ${s.pointsAfter}${gained ? `（+${delta}）` : "（无变化）"}`
      : String(pts);

  const title = gained ? "签到成功" : "今日已签到";
  const subtitle = gained
    ? `今天这 ${delta} 分已经到账${streak ? `，已连续签到 ${streak} 天` : ""}`
    : `今天已经签过了${streak ? `，已连续签到 ${streak} 天` : ""}，没有重复加分`;

  const starNote = starAttention.length
    ? notice(
        T.orange,
        "Star 任务提醒",
        starAttention.map((r) => esc(`${r.title}：${r.detail}`)).join("<br>"),
        { bg: T.orangeBg },
      )
    : "";

  const body = `
    <div>
      ${statPair(
        statCard("当前积分", pts, "分", gained ? `今日 +${delta}` : "与上次记录持平"),
        gained
          ? statCard("本次获得", `+${delta}`, "分", perDay ? `每日基础 +${perDay}` : "已到账", T.amber)
          : statCard("连续签到", streak || "—", "天", "断签会重新计数"),
      )}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px">
      ${row("执行时间", `${md} ${hhmmAt(s.at) || hhmm}`)}
      ${row("会话状态", "有效")}
      ${row("下次执行", `明天 ${RUN_AT}`)}
    </table>
    ${chartBlock}
    ${tasksBlock(tasks)}
    ${starNote}`;

  lines = [`结果：${detail}`, `积分：${pointsText}`, `时间：${day} ${hhmm}（${weekday}）`];
  if (starAttention.length) lines.push(...starAttention.map((r) => `${r.title}：${r.detail}`));
  if (tasks.length) {
    const doneCount = tasks.filter((m) => m.done === true).length;
    lines.push(`任务：已完成 ${doneCount}/${tasks.length} 项，待领 +${pendingSum} 分（需人工）`);
  }

  html = shell({
    band: band({
      tone: "ok",
      right: brand,
      title: title,
      subtitle: esc(subtitle),
      badge: bandPill(gained ? `+${delta} 分` : "无变化"),
    }),
    body,
    footer: footerText(`下次执行：明天 ${RUN_AT}`),
  });
} else {
  /**
   * 失败邮件只说人话：发生了什么、要不要我管、怎么补。
   *
   * 以前药丸和标题直接写「退出码 2」——那是给脚本看的，收件人看到只会更困惑。
   * 现在按原因分三种：平台临时故障（橙色、等它恢复）/ 登录失效（红色、要扫码）/
   * 其他签到失败（红色、可手动补）。技术细节只保留「失败环节」一行。
   */
  const rawReason = REASON || "未知（详见日志）";
  const apiDetail = todayState ? checkin?.detail || "" : "";

  /** 接口原始报错 → 一句人话 */
  const humanize = (text) => {
    if (!text) return "";
    if (/GATEWAY_CONNECT_FAILED|实名服务不可用|40004/.test(text)) {
      return "华为云侧的实名服务暂时连不上（网关连接失败），不是你的账号问题";
    }
    if (/超时|timeout/i.test(text)) return "签到接口响应超时，多半是网络一时抖动";
    if (/登录态|未登录|401|10001/.test(text)) return "登录态已失效，需要重新登录";
    if (/bad-json|http-5\d\d/i.test(text)) return "签到接口返回了网关错误页";
    return text.replace(/（api-error）/, "").replace(/^签到接口异常/, "签到接口报错");
  };

  const platformIssue = /GATEWAY_CONNECT_FAILED|实名服务不可用|40004|timeout|超时|bad-json|http-5\d\d/i.test(
    apiDetail,
  );
  const loginIssue = ["1", "3", "4"].includes(CODE);
  const needScan = loginIssue; // 只有登录类问题才需要重新扫码

  const fail = platformIssue
    ? {
        tone: "warn",
        title: "签到没成功",
        badge: "平台临时异常",
        subtitle: `${humanize(apiDetail)}；不用重新登录，等平台缓过来补一次就行`,
        stage: "签到接口（平台侧异常）",
        session: "正常",
        sessionColor: T.green,
        subject: `⚠️ 华为云签到没成功 · ${md} · 平台临时故障，可补签`,
      }
    : loginIssue
      ? {
          tone: "fail",
          title: "今天没登录上",
          badge: "需要重新登录",
          subtitle: rawReason,
          stage: CODE === "1" ? "扫码登录（超时）" : "登录环节",
          session: "已失效",
          sessionColor: T.red,
          subject: `❌ 华为云签到失败 · ${md} · 需要重新登录`,
        }
      : {
          tone: "fail",
          title: "签到没成功",
          badge: "签到未完成",
          subtitle: humanize(apiDetail) || rawReason,
          stage: apiDetail ? "签到接口" : "运行过程",
          session: apiDetail ? "正常" : "未确认",
          sessionColor: apiDetail ? T.green : T.muted,
          subject: `❌ 华为云签到没成功 · ${md} · 可手动补签`,
        };

  const codeStyle = `display:block;margin-top:6px;background:#fff;border:1px solid ${T.line};
    padding:7px 10px;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px;
    line-height:1.9;color:${T.ink};word-break:break-all`;
  /** 长命令拆成两行，比用 && 串起来好读，也不会顶出提示框 */
  const retryCmdHtml = `cd &quot;${esc(ROOT)}&quot;<br>GROW_TASKS=checkin node src/cli.mjs run`;

  subject = fail.subject;
  lines = [
    `原因：${fail.subtitle}`,
    `时间：${day} ${hhmm}（${weekday}）`,
    `影响：今天这 ${signBonus} 分还没到账`,
    `处理：${needScan ? `本机执行 ${DAILY_CMD} 扫码补签` : `重跑签到：${RETRY_CMD}`}`,
  ];

  const fixBlock = needScan
    ? notice(
        T.red,
        "怎么补（要扫一次码）",
        `在本机终端执行<br>
         <code style="${codeStyle}">${esc(DAILY_CMD)}</code>
         <span style="display:block;margin-top:7px;color:${T.muted}">浏览器会弹出来等你扫码，扫完自动补签。</span>`,
        { bg: T.redBg },
      )
    : notice(
        T.orange,
        "怎么补（约 10 秒，不用扫码）",
        `${platformIssue ? "登录态还在，平台恢复后" : ""}重跑一次签到就行：<br>
         <code style="${codeStyle}">${retryCmdHtml}</code>
         <span style="display:block;margin-top:7px;color:${T.muted}">也可以打开成长中心，手点一下「签到」，这 ${signBonus} 分同样会到账。</span>`,
        { bg: T.orangeBg },
      );

  const body = `
    <div>
      ${statPair(
        statCard("签到得分", "0", `/ ${signBonus} 分`, "今天这次没加上", T.red),
        statCard(
          "当前积分",
          s.pointsAfter ?? "?",
          "分",
          !todayState
            ? "上次记录，今天没取到最新"
            : delta != null && delta > 0
              ? `其他任务 +${delta} 已到账`
              : s.pointsAfter != null
                ? "最近记录"
                : "暂无数据",
        ),
      )}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px">
      ${row("发生时间", `${md} ${hhmm}`)}
      ${row("登录状态", fail.session, fail.sessionColor)}
      ${row("失败环节", `<span style="font-weight:400;color:${T.muted}">${esc(fail.stage)}</span>`)}
    </table>
    ${fixBlock}`;

  html = shell({
    band: band({
      tone: fail.tone,
      right: brand,
      title: fail.title,
      subtitle: esc(fail.subtitle),
      badge: bandPill(fail.badge),
    }),
    body,
    footer: footerText(`下次执行：明天 ${RUN_AT}`),
  });
}

const text = [subject, "", ...lines].join("\n");

// 调试用：把 HTML 落盘，方便本地渲染截图检查版式（GROW_MAIL_HTML_OUT=/tmp/x.html）
if (process.env.GROW_MAIL_HTML_OUT) {
  writeFileSync(process.env.GROW_MAIL_HTML_OUT, html);
  console.log(`[mail-result] HTML 已写入 ${process.env.GROW_MAIL_HTML_OUT}`);
}

if (DRY) {
  console.log(`[dry] 发件人：${FROM_NAME}`);
  console.log(`[dry] 主题：${subject}\n`);
  console.log(text);
  console.log("\n（HTML 版式已生成，实际发送时会一并带上）");
  process.exit(0);
}

if (!mailConfigured()) {
  console.error("[mail-result] 没有邮件配置（data/account.json 的 mail 段），结果邮件发不出去");
  process.exit(1);
}

const attachments = chartPng
  ? [{ filename: "points-7d.png", content: chartPng, cid: "points7" }]
  : null;

const sent = await sendMail(subject, text, html, attachments, { fromName: FROM_NAME });
if (sent) console.log(`[mail-result] 已发送：${subject}`);
else console.error("[mail-result] 发送失败");
process.exit(sent ? 0 : 1);
