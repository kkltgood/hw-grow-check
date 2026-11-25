import { join } from "node:path";
import { ROOT, config } from "./config.mjs";
import { mailConfigured, sendMail } from "./mail.mjs";
import { T, band, bandPill, esc, notice, row, shell } from "./mail-ui.mjs";

export function makeLogger() {
  const prefix = () =>
    new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace("T", " ");
  return (msg) => {
    const line = `${prefix()} ${msg}`;
    console.log(line);
    return line;
  };
}

export function notifyEnabled() {
  return Boolean(config.notifyUrl);
}

/**
 * daily.sh 会为每次运行发唯一一封结果邮件，内部告警就别再发第二封。
 * 设 GROW_QUIET_MAIL=1 时只保留 webhook，不碰邮件。
 */
const quietMail = /^(1|true|yes)$/i.test(process.env.GROW_QUIET_MAIL || "");

/**
 * 推送一条消息。失败只打日志，绝不影响主流程。
 * 支持：wecom（企业微信机器人）/ feishu / dingtalk / bark / serverchan / generic
 */
export async function notify(title, lines) {
  if (!config.notifyUrl) return false;

  const text = `${title}\n${lines.join("\n")}`;
  let url = config.notifyUrl;
  let body;

  switch (config.notifyType) {
    case "feishu":
      body = { msg_type: "text", content: { text } };
      break;
    case "wecom":
      body = { msgtype: "text", text: { content: text } };
      break;
    case "dingtalk":
      body = { msgtype: "text", text: { content: text } };
      break;
    case "bark":
      url = `${config.notifyUrl.replace(/\/$/, "")}/${encodeURIComponent(title)}/${encodeURIComponent(lines.join("\n"))}`;
      break;
    case "serverchan":
      body = { title, desp: lines.join("\n") };
      break;
    default:
      body = { title, text, lines };
  }

  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`[notify] HTTP ${res.status}`);
      return false;
    }
    // 企业微信/飞书即使 HTTP 200 也可能在 body 里报错
    const raw = await res.text().catch(() => "");
    if (/"errcode"\s*:\s*[1-9]/.test(raw)) {
      console.error(`[notify] 接口报错：${raw.slice(0, 120)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[notify] ${String(e).slice(0, 120)}`);
    return false;
  }
}

/**
 * 需要人看到的告警：webhook 优先，失败回落邮件。
 * 两个渠道都没配时只打日志，不影响主流程。
 */
export async function alert(title, lines, { html = null } = {}) {
  let ok = await notify(title, lines);
  let via = ok ? "webhook" : "";
  if (!ok && !quietMail && mailConfigured()) {
    ok = await sendMail(title, lines.join("\n"), html, null, { fromName: "华为云签到告警" });
    if (ok) via = "邮件";
  }
  if (ok) {
    console.log(`[alert] 告警已通过${via}发出`);
  } else if (quietMail) {
    console.log("[alert] GROW_QUIET_MAIL 已开启，结果邮件由调用方统一发送");
  } else if (!notifyEnabled() && !mailConfigured()) {
    console.error("[alert] 既没有 GROW_NOTIFY_URL 也没有邮件配置（data/account.json 的 mail 段），这条告警没有送出去");
  } else {
    console.error("[alert] 告警发送失败，检查 data/account.json 的 mail 段或 GROW_NOTIFY_URL");
  }
  return ok;
}

/** 补跑命令：默认按仓库实际位置生成，部署到别处也不会指向原作者的机器 */
export const DAILY_CMD = process.env.GROW_DAILY_CMD || `bash "${join(ROOT, "scripts/daily.sh")}"`;

/**
 * 失败告警的 HTML 版：和结果邮件同一套版式。
 * 之前这里只发纯文本，收到就是一封没有任何排版的信，和日报/结果邮件完全两个风格。
 */
export function buildFailureHtml({ reason, extra = [], when, title = "华为云签到失败" }) {
  const d = new Date(when.replace(" ", "T"));
  const md = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(d);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long" }).format(d);
  const hhmm = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);

  const notes = extra
    .filter(Boolean)
    .map(
      (t, i) => `<div style="color:${T.muted};font-size:12px;line-height:1.8;margin-top:${i ? 6 : 2}px">${esc(t)}</div>`,
    )
    .join("");

  const body = `
    ${notes}
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:${
      notes ? "18px" : "2px"
    }">
      ${row("发生时间", `${md} ${hhmm}`)}
      ${row("今日状态", "未签到", T.red)}
    </table>
    ${notice(
      T.red,
      "怎么补",
      `在本机终端执行<br>
       <code style="display:inline-block;margin-top:6px;background:#fff;border:1px solid ${T.line};
         padding:6px 10px;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px;
         color:${T.ink}">${esc(DAILY_CMD)}</code><br>
       <span style="color:${T.muted}">浏览器会弹出等你扫码，扫完自动补签；也可以手动重跑一次。</span>`,
      { bg: T.redBg },
    )}`;

  return shell({
    band: band({
      tone: "fail",
      right: `${md} · ${weekday}`,
      title: esc(String(title).replace(/^[⚠️\s]+/, "")),
      subtitle: esc(reason),
      badge: bandPill("需要处理"),
    }),
    body,
    footer: `由本机定时任务自动生成 · ${hhmm}<br>持续未恢复会按递延节奏再次提醒`,
  });
}

/** 统一的失败告警文案：手机上要一眼看懂 + 知道下一步做什么 */
export async function alertFailure(reason, extra = [], { title = "⚠️ 华为云签到失败" } = {}) {
  const when = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  const lines = [
    `时间：${when}`,
    `原因：${reason}`,
    ...extra,
    "影响：今天没有签到，积分不会增加",
    `处理：在本机执行  ${DAILY_CMD} ，浏览器会弹出等你扫码`,
    "      扫完自动补签；也可以手动重跑一次",
  ];
  const html = buildFailureHtml({ reason, extra, when, title });
  return alert(title, lines, { html });
}

/** 告警链路是否已配置（webhook 或邮件任一） */
export function alertConfigured() {
  return notifyEnabled() || mailConfigured();
}
