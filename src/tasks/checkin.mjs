import { doSign, getPoints, getSignStreak, getSignStatus } from "../api.mjs";
import { RESULT_WAIT_MS, WAIT_MINUTES, waitForResult } from "../wait.mjs";

export const meta = {
  id: "checkin",
  title: "每日签到",
  bonus: 10,
  cycle: "DAILY",
  // 纯接口调用，不需要真实用户交互
  safe: true,
  // 内部最多等 5 分钟检查结果，外层超时留 1 分半余量
  timeoutMs: RESULT_WAIT_MS + 90_000,
};

/**
 * 平台侧临时故障，等一会儿通常就恢复：
 * 40004 / GATEWAY_CONNECT_FAILED（网关连不上实名服务）、服务暂不可用、超时、网关错误页。
 * 这类错误不该在第一次失败时就把这一天判死。
 */
const TRANSIENT = /GATEWAY_CONNECT_FAILED|实名服务不可用|服务暂不可用|系统繁忙|try again|timeout|超时|bad-json|http-5\d\d/i;

/** 重试节奏：前几次快一点，之后每 30 秒一次，直到 5 分钟预算用完 */
const RETRY_STEPS_MS = [5_000, 15_000, 30_000];
const nextWait = (attempt) => RETRY_STEPS_MS[Math.min(attempt - 1, RETRY_STEPS_MS.length - 1)];

/**
 * 签到接口调用 + 临时错误重试，与结果确认共用同一个 5 分钟预算。
 * 40004 是华为云侧实名服务连不上，实测过几分钟自己就恢复了，
 * 所以这里按 5s / 15s / 30s… 一直重试到预算用完，而不是重试两次就放弃。
 */
async function signUntilDeadline(page, log, deadline) {
  let res = await doSign(page);
  let attempts = 1;
  while (!res.ok && !res.loginExpired && Date.now() < deadline && TRANSIENT.test(res.detail || "")) {
    const wait = Math.max(0, Math.min(nextWait(attempts), deadline - Date.now()));
    log?.(`签到第 ${attempts} 次没成功（${res.detail}），${Math.round(wait / 1000)} 秒后重试`);
    await page.waitForTimeout(wait);
    res = await doSign(page);
    attempts += 1;
  }
  return { res, attempts };
}

/**
 * 签到。幂等：今天签过就直接返回 already。
 *
 * 新版接口把「签到」做成了一次任务完成：POST /user/sign-in 返回
 * { success, points, total_points, signed }。points=0 表示今天已经签过。
 *
 * 返回前必须等到成长中心把任务状态翻成「已完成」，最多等 5 分钟；
 * 等不到且积分也没增加，按失败返回（daily.sh 会发失败邮件）。
 *
 * @returns {{status: 'signed'|'already'|'failed', detail: string, points?: number}}
 */
export async function run({ page, log }) {
  const deadline = Date.now() + RESULT_WAIT_MS;
  const before = await getSignStatus(page);
  if (before.error === "not-login") {
    return { status: "failed", detail: "登录态失效（未登录）" };
  }
  // 状态查不到不等于不能签：sign-in 是幂等的，points=0 就说明今天已经签过。
  if (before.error) log?.(`签到状态查询失败（${before.error}），直接尝试签到`);

  const pointsBefore = await getPoints(page).catch(() => null);

  if (!before.error && before.signedToday) {
    const streak = await getSignStreak(page).catch(() => null);
    return {
      status: "already",
      detail: `今日已签到${streak ? `（连续 ${streak} 天）` : ""}，当前 ${pointsBefore ?? "?"} 分`,
      points: pointsBefore,
    };
  }

  const { res, attempts } = await signUntilDeadline(page, log, deadline);
  if (!res.ok) {
    if (res.loginExpired) return { status: "failed", detail: "登录态失效，需重新登录" };
    const tried = attempts > 1 ? `；${WAIT_MINUTES} 分钟内重试 ${attempts - 1} 次仍未成功` : "";
    return { status: "failed", detail: `${res.detail}${tried}` };
  }

  const points = res.total ?? (await getPoints(page).catch(() => null));
  const streak = await getSignStreak(page).catch(() => null);
  const streakText = streak ? `，连续 ${streak} 天` : "";

  if (res.already) {
    return {
      status: "already",
      detail: `今日已签到${streakText}，当前 ${points ?? "?"} 分`,
      points,
    };
  }

  // 复查状态，确认真的签上了（POST 成功不等于任务状态已翻转）
  const confirm = await waitForResult({
    page,
    log,
    label: "签到结果",
    timeoutMs: Math.max(5_000, deadline - Date.now()),
    check: async () => {
      const st = await getSignStatus(page);
      if (st.error) return { done: false, error: st.error };
      return { done: st.signedToday === true };
    },
  });

  const gained = res.gained || before.bonusPerDay || meta.bonus;

  if (!confirm.ok) {
    // 状态接口一直不翻转时，以「积分是否真的增加」兜底，避免把已到账的一天记成失败
    const credited = points != null && pointsBefore != null && points - pointsBefore >= meta.bonus;
    if (credited) {
      log?.(`任务状态 ${WAIT_MINUTES} 分钟内没翻转，但积分已 +${points - pointsBefore}，按成功记`);
      return {
        status: "signed",
        detail: `签到成功（+${points - pointsBefore} 分${streakText}）；任务状态确认超时，按积分判定`,
        points,
      };
    }
    return {
      status: "failed",
      detail: `签到接口返回成功，但 ${WAIT_MINUTES} 分钟内成长中心未确认（${
        confirm.last?.error || "任务状态未翻转"
      }）`,
      points,
    };
  }

  log?.(`签到成功：+${gained} 分${streakText}，当前 ${points ?? "?"} 分`);
  return { status: "signed", detail: `签到成功（+${gained} 分${streakText}）`, points };
}
