import { doSign, getPoints, getSignStreak, getSignStatus } from "../api.mjs";

export const meta = {
  id: "checkin",
  title: "每日签到",
  bonus: 10,
  cycle: "DAILY",
  // 纯接口调用，不需要真实用户交互
  safe: true,
};

/**
 * 平台侧临时故障，重试几次通常就过去了：
 * 40004 / GATEWAY_CONNECT_FAILED（网关连不上实名服务）、服务暂不可用、超时、网关错误页。
 * 这类错误不该在第一次就把整天判成「签到失败」。
 */
const TRANSIENT = /GATEWAY_CONNECT_FAILED|实名服务不可用|服务暂不可用|系统繁忙|try again|timeout|超时|bad-json|http-5\d\d/i;
const RETRY_WAIT_MS = [3000, 8000];

/** 签到失败时按退避重试；业务错误（今天已签、参数错）不重试，免得白等 */
async function signWithRetry(page, log) {
  let res = await doSign(page);
  let tries = 1;
  for (let i = 0; i < RETRY_WAIT_MS.length; i++) {
    if (res.ok || res.loginExpired || !TRANSIENT.test(res.detail || "")) break;
    const ms = RETRY_WAIT_MS[i];
    log?.(`签到接口临时异常（${res.detail}），${ms / 1000} 秒后重试 ${i + 1}/${RETRY_WAIT_MS.length}`);
    await page.waitForTimeout(ms);
    res = await doSign(page);
    tries += 1;
  }
  // 重试过仍失败：把「已经试过几次」带进 detail，邮件里能说清楚不是没管它
  if (!res.ok && tries > 1) res = { ...res, detail: `${res.detail}；已自动重试 ${tries - 1} 次` };
  return res;
}

/**
 * 签到。幂等：今天签过就直接返回 already。
 *
 * 新版接口把「签到」做成了一次任务完成：POST /user/sign-in 返回
 * { success, points, total_points, signed }。points=0 表示今天已经签过。
 *
 * @returns {{status: 'signed'|'already'|'failed', detail: string, points?: number}}
 */
export async function run({ page, log }) {
  const before = await getSignStatus(page);
  if (before.error === "not-login") {
    return { status: "failed", detail: "登录态失效（未登录）" };
  }

  // 状态查不到不等于不能签：sign-in 是幂等的，points=0 就说明今天已经签过。
  // 新版网关偶尔会把正常会话判成 401，这条兜底能少丢一天。
  if (before.error) log?.(`签到状态查询失败（${before.error}），直接尝试签到`);

  if (!before.error && before.signedToday) {
    const points = await getPoints(page).catch(() => null);
    const streak = await getSignStreak(page).catch(() => null);
    return {
      status: "already",
      detail: `今日已签到${streak ? `（连续 ${streak} 天）` : ""}，当前 ${points ?? "?"} 分`,
      points,
    };
  }

  const res = await signWithRetry(page, log);
  if (!res.ok) {
    if (res.loginExpired) return { status: "failed", detail: "登录态失效，需重新登录" };
    return { status: "failed", detail: res.detail };
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
  await page.waitForTimeout(1200);
  const after = await getSignStatus(page).catch(() => ({ error: "unknown" }));
  const gained = res.gained || before.bonusPerDay || meta.bonus;

  if (after.error) {
    // POST 已经成功，只是复查接口抽风，别把这次记成失败
    return {
      status: "signed",
      detail: `签到成功（+${gained} 分${streakText}），但复查失败（${after.error}）`,
      points,
    };
  }
  if (after.signedToday) {
    log?.(`签到成功：+${gained} 分${streakText}，当前 ${points ?? "?"} 分`);
    return { status: "signed", detail: `签到成功（+${gained} 分${streakText}）`, points };
  }
  return { status: "failed", detail: "POST 返回成功但复查仍未签到", points };
}
