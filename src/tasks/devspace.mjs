/**
 * 每日体验 AI DevSpace（+30）。
 *
 * 完成信号来自实践中心自己的埋点，不是任务接口：
 *   - 打开 https://hands-on-agent.developer.huaweicloud.com/#tasks → POST /api/track/visit
 *   - 点「前往AI DevSpace实践」→ POST /api/track/aishell_click（这个才是任务完成信号）
 *
 * 所以流程是「打开页面 → 点入口 → 等埋点 200 → 回查任务状态」。
 * 埋点成功不等于立刻结算，后面最多等 5 分钟；超时按失败返回，
 * 不再用 pending 含糊过去（页面上找不到入口这类前置问题仍记 pending）。
 */
import { getUserTasks } from "../api.mjs";
import { URLS } from "../config.mjs";
import { RESULT_WAIT_MS, WAIT_MINUTES, waitForResult } from "../wait.mjs";

export const meta = {
  id: "devspace",
  // 任务清单里的标题是「体验 AI DevSpace」
  title: "体验 AI DevSpace",
  bonus: 30,
  cycle: "DAILY",
  safe: false,
  note: "打开实践中心并点击「前往AI DevSpace实践」，等埋点上报后回查任务状态",
  // 埋点后最多等 5 分钟结算，外层超时留余量
  timeoutMs: RESULT_WAIT_MS + 90_000,
};

const norm = (s) => (s || "").replace(/\s+/g, "");

function findMission(missions, title) {
  const t = norm(title);
  return (
    missions.find((m) => norm(m.title) === t) ||
    missions.find((m) => norm(m.title).includes(t)) ||
    // 兜底：标题再改也认得出「体验 + DevSpace」
    missions.find((m) => /DevSpace/i.test(m.title || ""))
  );
}

const ENTRY_LABELS = ["前往AI DevSpace实践", "前往 AI DevSpace", "进入AI DevSpace", "AI DevSpace"];

export async function run({ context, page, log }) {
  const before = await getUserTasks(page).catch(() => ({ missions: [] }));
  if (before.error === "not-login") return { status: "failed", detail: "登录态失效" };
  const target = findMission(before.missions, meta.title);
  if (target?.done) {
    return { status: "already", detail: "今日已完成" };
  }

  const tab = await context.newPage();
  let clickReported = false;
  try {
    // 先挂监听，避免点击太快、响应在 click 返回前就结束
    const clickResponse = tab
      .waitForResponse(
        (res) => res.url().includes("/api/track/aishell_click") && res.request().method() === "POST",
        { timeout: 20_000 },
      )
      .catch(() => null);

    await tab.goto(URLS.devspace, { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (tab.url().includes("auth.huaweicloud.com")) {
      return { status: "failed", detail: "打开实践中心时被跳转到登录页，登录态已失效" };
    }
    await tab.waitForTimeout(5000);
    await tab.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => {});
    await tab.waitForTimeout(1000);

    // 入口文案改过几版，按优先级找一个能点的
    let btn = null;
    for (const label of ENTRY_LABELS) {
      const cand = tab.getByText(label, { exact: false }).first();
      if (await cand.count().catch(() => 0)) {
        btn = cand;
        break;
      }
    }
    if (!btn) {
      return { status: "pending", detail: "页面上找不到 AI DevSpace 入口（可能已改版），今天未完成" };
    }

    const [popup, resp] = await Promise.all([
      tab.waitForEvent("popup", { timeout: 15_000 }).catch(() => null),
      btn
        .click({ timeout: 15_000 })
        .then(() => clickResponse)
        .catch(() => null),
    ]);
    clickReported = Boolean(resp?.ok());
    log?.(clickReported ? "已点击「前往AI DevSpace实践」，埋点上报成功" : "已点击入口，但未捕获到埋点响应");

    // 新开的 DevSpace 页面只用来触发埋点，不用等它加载完
    if (popup) await popup.close().catch(() => {});
  } catch (e) {
    // 这是可选的加分任务，页面异常不应把当天签到结果带成失败
    return { status: "pending", detail: `实践中心执行异常：${String(e).slice(0, 120)}` };
  } finally {
    await tab.close().catch(() => {});
  }

  // 回查任务状态：等到真的翻转，最多 5 分钟，超时按失败
  const settled = await waitForResult({
    page,
    log,
    label: "AI DevSpace 任务",
    check: async () => {
      const after = await getUserTasks(page).catch(() => ({ missions: [] }));
      return { done: Boolean(findMission(after.missions || [], meta.title)?.done) };
    },
  });
  if (settled.ok) {
    log?.("任务已标记完成，+30 分");
    return { status: "signed", detail: "已完成，积分到账" };
  }

  return {
    status: "failed",
    detail: clickReported
      ? `埋点已上报，但 ${WAIT_MINUTES} 分钟内任务状态未变为已完成，按失败计`
      : `已尝试点击入口，但未捕获埋点上报，${WAIT_MINUTES} 分钟内任务状态未完成，按失败计`,
  };
}
