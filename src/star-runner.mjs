/**
 * 「Star 仓库」类任务的公共实现，日任务和周任务共用。
 *
 * 规则差异只在周期：日任务每天要换一个仓，周任务每周换一个。
 * 共同保护：
 *   1. 任务本周期已完成 → 跳过
 *   2. 本周期已经 Star 过一个、但还没结算 → 不 Star 第二个
 *   3. 池子里没有没 Star 过的仓 → 不发请求，只提醒
 *   4. 只加 Star，从不取消
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getUserTasks } from "./api.mjs";
import { config } from "./config.mjs";
import { getGitcodeUser, listStarredRepos, readGitcodeConfig, starRepo } from "./gitcode.mjs";
import { RESULT_POLL_MS, RESULT_WAIT_MS, WAIT_MINUTES, waitForResult } from "./wait.mjs";

const POLL_INTERVAL_MS = RESULT_POLL_MS;
/** Star 之后要等成长中心的外部校验，最多 5 分钟，超时按失败返回 */
const SETTLE_TIMEOUT_MS = RESULT_WAIT_MS;
const norm = (s) => (s || "").replace(/\s+/g, "");

/** 周期键：日任务用 YYYY-MM-DD，周任务用本周周一的日期 */
export function periodKey(cycle) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (cycle !== "WEEKLY") return day;

  // 用 UTC 正午算，避免服务器时区不是 Asia/Shanghai 时把星期算错
  const d = new Date(`${day}T12:00:00+08:00`);
  const dow = d.getUTCDay(); // 0=周日
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function findMission(missions, { tag, title }) {
  return (missions || []).find((m) => m.tag === tag || norm(m.title) === norm(title) || norm(m.title).includes(norm(title)));
}

function statePath(name) {
  return join(config.dataDir, name);
}

function readState(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeState(file, patch) {
  try {
    writeFileSync(file, JSON.stringify({ ...readState(file), ...patch }, null, 2), "utf8");
  } catch {
    /* 状态写不进去不影响主流程 */
  }
}

/**
 * 抓一次池子和已 Star 列表，算出「池内总数 / 已 Star / 还剩多少」。
 * 排除项（比如组织介绍仓）不计入分母，否则进度永远差一个、看起来像没跑完。
 */
async function collectStats({ task, token, loadPool }) {
  const [poolAll, starred] = await Promise.all([loadPool(token), listStarredRepos(token)]);
  const exclude = new Set((task.exclude || []).map((s) => s.toLowerCase()));
  const pool = poolAll.filter((c) => !exclude.has(c.fullName.toLowerCase()));
  const starredSet = new Set(starred.map((s) => s.toLowerCase()));
  const starredInPool = pool.filter((c) => starredSet.has(c.fullName.toLowerCase())).length;
  return {
    pool,
    starredSet,
    stats: {
      period: periodKey(task.cycle),
      poolSize: pool.length,
      starred: starredInPool,
      remaining: pool.length - starredInPool,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** 详情文案里的进度后缀，例如「案例仓 68/73」 */
function progressSuffix(task, stats) {
  return stats ? `${task.poolLabel} ${stats.starred}/${stats.poolSize}` : "";
}

/**
 * @param {object} opts
 * @param {import('playwright').Page} opts.page  华为云接口页
 * @param {Function} opts.log
 * @param {object} opts.task  { tag, title, bonus, cycle, stateFile, poolLabel, exclude? }
 * @param {Function} opts.loadPool  (token) => Promise<{fullName,title}[]>
 */
export async function runStarTask({ page, log, task, loadPool }) {
  const file = statePath(task.stateFile);
  const period = periodKey(task.cycle);
  const periodName = task.cycle === "WEEKLY" ? "本周" : "今天";

  const before = await getUserTasks(page).catch(() => ({ missions: [] }));
  if (before.error === "not-login") return { status: "failed", detail: "登录态失效" };
  const mission = findMission(before.missions, task);
  if (mission?.done) {
    const s = readState(file);
    if (s.pending) {
      writeState(file, { pending: null, last: s.pending });
      log?.(`上次 Star 的 ${s.pending.repo} 已结算`);
    }
    /**
     * 任务已完成时不再 Star，但结果文案里要带「已 Star / 仓库总数」。
     * 本周期统计过就直接复用；否则补一次只读查询（只在网页手动做完、
     * 脚本当天没跑过时才会发生）。
     */
    let stats = s.stats;
    const gc = readGitcodeConfig();
    if (gc && stats?.period !== period) {
      try {
        stats = (await collectStats({ task, token: gc.token, loadPool })).stats;
        writeState(file, { stats });
      } catch (e) {
        log?.(`统计 Star 进度失败（${String(e).replace(/^Error:\s*/, "").slice(0, 80)}），沿用上次记录`);
      }
    }
    const suffix = progressSuffix(task, stats);
    return { status: "already", detail: `${periodName}已完成${suffix ? `（${suffix}）` : ""}` };
  }

  const gc = readGitcodeConfig();
  if (!gc) {
    return {
      status: "pending",
      detail: "未配置 GitCode 令牌（data/account.json 的 gitcode 段），Star 任务跳过；生成令牌后会自动启用",
    };
  }

  try {
    const me = await getGitcodeUser(gc.token);
    if (gc.username && me.login && gc.username !== me.login) {
      return {
        status: "pending",
        detail: `GitCode 令牌属于 ${me.login}，与配置的 ${gc.username} 不一致，${periodName}不 Star`,
      };
    }
  } catch (e) {
    log?.(`无法读取令牌账号（${String(e).replace(/^Error:\s*/, "").slice(0, 100)}），继续尝试 Star`);
  }

  /**
   * 等成长中心把任务标记完成。Star 只是把仓库加到了 GitCode，
   * 分数要等平台的外部校验跑完才到账，所以必须等到状态翻转，最多 5 分钟。
   */
  const settle = () =>
    waitForResult({
      page,
      log,
      label: `${task.title}结算`,
      timeoutMs: SETTLE_TIMEOUT_MS,
      intervalMs: POLL_INTERVAL_MS,
      check: async () => {
        const after = await getUserTasks(page).catch(() => ({ missions: [] }));
        return { done: Boolean(findMission(after.missions, task)?.done) };
      },
    });

  const state = readState(file);
  if (state.pending?.repo && state.pending.period === period) {
    log?.(`${periodName}已 Star ${state.pending.repo}，等成长中心补确认（最多 ${WAIT_MINUTES} 分钟）`);
    const r = await settle();
    if (r.ok) {
      writeState(file, { pending: null, last: { ...state.pending, settled: true } });
      log?.(`上一条 Star 已结算，+${task.bonus} 分`);
      return { status: "signed", detail: `${periodName}已 Star ${state.pending.repo}，+${task.bonus} 分（补确认成功）` };
    }
    return {
      status: "failed",
      detail: `${periodName}已 Star ${state.pending.repo}，但 ${WAIT_MINUTES} 分钟内成长中心仍未确认，按失败计；不会重复 Star`,
    };
  }

  let collected;
  try {
    collected = await collectStats({ task, token: gc.token, loadPool });
  } catch (e) {
    return { status: "pending", detail: `GitCode 查询失败：${String(e).replace(/^Error:\s*/, "").slice(0, 160)}` };
  }
  const { pool, starredSet, stats } = collected;
  // 查询成功就先落盘：即使后面 Star 失败，邮件里也有最新的池子数字
  writeState(file, { stats });

  if (!pool.length) {
    return { status: "pending", detail: `${task.poolLabel}列表为空，可能接口已改版` };
  }

  const candidates = pool.filter((c) => !starredSet.has(c.fullName.toLowerCase()));
  if (!candidates.length) {
    writeState(file, { exhausted: { period, poolSize: pool.length } });
    return {
      status: "pending",
      detail: `${task.poolLabel} ${stats.starred}/${stats.poolSize} 全部 Star，剩余 0；等官方上新后会自动继续`,
    };
  }

  const pick = candidates[0];
  const r = await starRepo(gc.token, pick.fullName);
  if (!r.ok || r.json?.starred === false) {
    return {
      status: "pending",
      detail: `Star ${pick.fullName} 失败：HTTP ${r.status} ${r.json?.message || r.text.slice(0, 100)}`,
    };
  }

  // Star 成功后池内已 Star 数 +1
  const afterStar = {
    ...stats,
    starred: stats.starred + 1,
    remaining: Math.max(0, stats.remaining - 1),
    updatedAt: new Date().toISOString(),
  };
  writeState(file, {
    pending: { period, repo: pick.fullName, title: pick.title, starredAt: new Date().toISOString() },
    exhausted: null,
    stats: afterStar,
  });
  log?.(`已 Star ${pick.fullName}（${pick.title}）→ ${task.poolLabel} ${afterStar.starred}/${afterStar.poolSize}`);

  const settled = await settle();
  if (settled.ok) {
    writeState(file, { pending: null, last: { ...readState(file).pending, settled: true } });
    log?.(`任务已标记完成，+${task.bonus} 分`);
    return {
      status: "signed",
      detail: `已 Star ${pick.fullName}，+${task.bonus} 分（${task.poolLabel} ${afterStar.starred}/${afterStar.poolSize}）`,
    };
  }

  return {
    status: "failed",
    detail: `已 Star ${pick.fullName}（${task.poolLabel} ${afterStar.starred}/${afterStar.poolSize}），但 ${WAIT_MINUTES} 分钟内成长中心未确认，按失败计；${periodName}不会重复 Star`,
  };
}
