/**
 * 积分历史。每天签到时记一条 {date, points}，用于邮件里的 7 天曲线。
 *
 * 为什么要单独存：state.json 每天被覆盖，只保留当天；想看变化趋势必须自己攒。
 * 文件放 data/points-history.json，按日期升序，最多保留 120 天。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "points-history.json";
const KEEP_DAYS = 120;

export function historyPath(dataDir) {
  return join(dataDir, FILE);
}

export function readHistory(dataDir) {
  const p = historyPath(dataDir);
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(j)) return [];
    return j
      .filter((r) => r && typeof r.date === "string" && Number.isFinite(Number(r.points)))
      .map((r) => ({ date: r.date, points: Number(r.points) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/** 写入/更新某一天的积分；同一天跑多次只留最后一次 */
export function recordPoints(dataDir, date, points) {
  if (!Number.isFinite(Number(points))) return readHistory(dataDir);
  const list = readHistory(dataDir).filter((r) => r.date !== date);
  list.push({ date, points: Number(points) });
  list.sort((a, b) => a.date.localeCompare(b.date));
  const kept = list.slice(-KEEP_DAYS);
  try {
    writeFileSync(historyPath(dataDir), JSON.stringify(kept, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error(`[points] 写历史失败：${String(e).slice(0, 120)}`);
  }
  return kept;
}

/** 取最近 n 天的序列（含没记录的日子，points 为 null），用于画断点曲线 */
export function recentSeries(dataDir, days = 7, endDate = new Date()) {
  const map = new Map(readHistory(dataDir).map((r) => [r.date, r.points]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endDate.getTime() - i * 86400000);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
    out.push({ date: key, md: key.slice(5), points: map.has(key) ? map.get(key) : null });
  }
  return out;
}
