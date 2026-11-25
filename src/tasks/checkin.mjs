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

  const res = await doSign(page);
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
