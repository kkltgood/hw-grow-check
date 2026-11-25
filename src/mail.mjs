/**
 * 邮件告警。
 *
 * 配置从 data/account.json 的 mail 段读（和 GitCode、华为云账号放在一起）：
 *   "mail": {
 *     "host": "smtp.qq.com",
 *     "port": 465,
 *     "user": "you@example.com",
 *     "pass": "邮箱授权码（不是登录密码）",
 *     "to": "you@example.com"
 *   }
 *
 * 为什么自己直发：告警要在没人管的时候也能送出去。
 * 依赖本机跑任务、依赖第三方机器人，都多一层会坏的地方。
 */
import nodemailer from "nodemailer";
import { accountSection } from "./account.mjs";

export function readMailConfig() {
  const j = accountSection("mail");
  if (!j || !j.user || !j.pass || !j.to) return null;
  return {
    host: j.host || "smtp.qq.com",
    port: Number(j.port || 465),
    user: String(j.user),
    pass: String(j.pass),
    to: String(j.to),
    from: j.from || `hw-grow-check <${j.user}>`,
  };
}

export function mailConfigured() {
  return Boolean(readMailConfig());
}

let cached = null;

function transporter(mc) {
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: mc.host,
    port: mc.port,
    secure: mc.port === 465,
    auth: { user: mc.user, pass: mc.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  return cached;
}

/**
 * 从 "显示名 <地址>" 里取出地址；配置只写地址时直接用它。
 */
export function fromAddress(from, fallback) {
  const s = String(from || "").trim();
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return s.includes("@") ? s : fallback;
}

/**
 * 生成 from 字段。传了 fromName 就用它覆盖显示名，地址仍取配置里的。
 * 这样同一发件箱可以按结果切换「签到成功 / 签到提醒 / 签到告警」。
 */
export function buildFrom(mc, fromName) {
  if (!fromName) return mc.from;
  return { name: fromName, address: fromAddress(mc.from, mc.user) };
}

/**
 * 发送一封邮件，失败返回 false 并打日志，不抛异常。
 * html 是可选增强：手机邮件客户端读 HTML 排版更省事，纯文本同时保留，
 * 这样极简客户端（或关闭 HTML 的场景）也不会看到空白。
 *
 * opts.fromName：覆盖发件人显示名（不传则用 account.json 里的 from）。
 */
export async function sendMail(subject, text, html = null, attachments = null, opts = {}) {
  const mc = readMailConfig();
  if (!mc) return false;
  try {
    const msg = { from: buildFrom(mc, opts.fromName), to: mc.to, subject, text };
    if (html) msg.html = html;
    if (attachments?.length) msg.attachments = attachments;
    await transporter(mc).sendMail(msg);
    return true;
  } catch (e) {
    console.error(`[mail] ${String(e).slice(0, 200)}`);
    return false;
  }
}
