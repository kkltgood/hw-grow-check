/**
 * 登录失效告警的闸门（退避 + 恢复清零）。
 *
 * 为什么需要：签到每天跑一次，失败重试和手动补跑都会发现问题。
 * 如果各发各的，用户一天会收到十几封重复邮件；如果只发一次，邮件被忽略或漏看，
 * 就等于没有告警——这正是之前「连续四天没人知道」的病根。
 *
 * 策略：首次立即提醒 → 4 小时后 → 之后每 8 小时一次。
 * 登录一旦成功，状态清零；下次再失效，重新从「立即」开始算。
 *
 * 状态落在 data/alert-state.json，所有入口共用同一份，保证只有一条时间线。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = "alert-state.json";
/** 第 1、2、3……封之前至少间隔多少小时；超出数组长度按最后一档 */
const BACKOFF_HOURS = [0, 4, 8];
/**
 * 判定容差（小时）。定时器有几十秒抖动，若严格按 8.000 小时比较，
 * 差 1.4 秒就会整档跳过、再等 2 小时（11-03 06:21 就是这么错过的）。
 * 3 分钟容差足以吸收抖动，又不会让提醒提前太多。
 */
const TOLERANCE_H = 0.05;

const fileOf = (dir) => join(dir, FILE);

export function readGate(dir) {
  try {
    const f = fileOf(dir);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeGate(dir, data) {
  const f = fileOf(dir);
  try {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function gapHours(sent) {
  return BACKOFF_HOURS[Math.min(sent, BACKOFF_HOURS.length - 1)];
}

/**
 * 这次该不该发告警。
 * @param {string} dir  数据目录
 * @returns {{allow:boolean, sent:number, gapH:number, waitH:number, outageH:number|null}}
 *   allow   是否可以发送
 *   sent    本失效期已经发过几封
 *   gapH    本档要求的最小间隔（小时）
 *   waitH   距离可以发送还差多少小时
 *   outageH 从 recordedSince 起算已持续多久（小时），未知为 null
 */
export function gateLoginFailure(dir, { now = Date.now(), since = null } = {}) {
  const g = readGate(dir);
  const sent = Number(g.sent) || 0;
  const gapH = gapHours(sent);
  const lastAt = g.lastAlertAt ? Date.parse(g.lastAlertAt) : 0;
  const elapsedH = lastAt ? (now - lastAt) / 3600e3 : Infinity;

  // 失效起点优先用外部给的（上一次成功的时间），否则用状态文件里记的
  const startRaw = g.failSince ?? (since ? new Date(since).toISOString() : null);
  const outageH = startRaw ? (now - Date.parse(startRaw)) / 3600e3 : null;

  return {
    allow: elapsedH + TOLERANCE_H >= gapH,
    sent,
    gapH,
    elapsedH,
    waitH: Math.max(0, gapH - TOLERANCE_H - elapsedH),
    outageH,
  };
}

/** 记一次「已发出告警」。首次会落失效起点，后续保留。 */
export function markLoginAlerted(dir, { now = new Date(), since = null } = {}) {
  const g = readGate(dir);
  const next = {
    failSince: g.failSince ?? (since ? new Date(since).toISOString() : now.toISOString()),
    sent: (Number(g.sent) || 0) + 1,
    lastAlertAt: now.toISOString(),
  };
  writeGate(dir, next);
  return next;
}

/**
 * 登录恢复：清零，下次失效重新从「立即」开始。
 * 没处在失效期时什么都不写，返回 null。
 */
export function markLoginOk(dir, { now = new Date() } = {}) {
  const g = readGate(dir);
  const sent = Number(g.sent) || 0;
  if (!sent) return null;
  const outageH = g.failSince ? (now - Date.parse(g.failSince)) / 3600e3 : null;
  writeGate(dir, { sent: 0, recoveredAt: now.toISOString(), lastOutageHours: outageH });
  return { sent, outageH };
}

/** 把小时数说成人话：47.2 → 「1 天 23 小时」 */
export function humanHours(h) {
  if (h == null || !Number.isFinite(h)) return "未知时长";
  if (h < 1) return `${Math.round(h * 60)} 分钟`;
  if (h < 24) return `${h.toFixed(1)} 小时`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${Math.round(h - d * 24)} 小时`;
}
