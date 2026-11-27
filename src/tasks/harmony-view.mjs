/**
 * 每日浏览一个鸿蒙案例（+10）。
 *
 * 完成判定完全在鸿蒙实践中心自己手里，但不需要模拟点击几十次：
 *   - 案例详情页会为 task_key=case-view-daily 开一个计时会话
 *     （GET /api/growth/tasks/case-view-daily → POST /api/growth/sessions/...）
 *   - 计时只在 document.hidden === false 时累加，累计满 30 秒服务端记完成
 *
 * 所以这个任务的关键不是「点哪里」，而是「让详情页在最前面停留够 30 秒」。
 * 多标签页同时计时由页面自己的 BroadcastChannel 去重，不会重复加分。
 */
import { getUserTasks } from "../api.mjs";
import { URLS } from "../config.mjs";
import { SETTLE_MINUTES, SETTLE_WAIT_MS, waitForResult } from "../wait.mjs";

export const meta = {
  id: "harmony",
  title: "每日浏览一个鸿蒙案例",
  bonus: 10,
  cycle: "DAILY",
  safe: false,
  note: "打开一个案例详情页并停留 40 秒",
  // 停留 40 秒 + 最多等 10 分钟结算，外层超时留余量
  timeoutMs: SETTLE_WAIT_MS + 180_000,
};

const norm = (s) => (s || "").replace(/\s+/g, "");
const TARGET = "每日浏览一个鸿蒙案例";

/** 案例中心第一张卡片的兜底地址；正常路径是现场从实践中心点进去 */
const FALLBACK_CASE = "https://harmonybp.developer.huaweicloud.com/cases/bff1556a1ad24181be82eba6f77b1ed9";

const DWELL_MS = 40_000;

function findMission(missions) {
  const t = norm(TARGET);
  return (
    missions.find((m) => norm(m.title) === t) ||
    missions.find((m) => norm(m.title).includes("浏览") && norm(m.title).includes("鸿蒙"))
  );
}

/** 在实践中心点开第一个案例，返回详情页；点不到就直接开兜底地址 */
async function openCase(context, log) {
  const hub = await context.newPage();
  try {
    await hub.goto(URLS.harmony, { waitUntil: "domcontentloaded", timeout: 90000 });
    await hub.waitForTimeout(6000);
    await hub.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await hub.waitForTimeout(1500);

    const btn = hub.getByText("查看案例", { exact: true }).first();
    if (await btn.count().catch(() => 0)) {
      const [popup] = await Promise.all([
        hub.waitForEvent("popup", { timeout: 15000 }).catch(() => null),
        btn.click({ timeout: 15000 }).catch(() => null),
      ]);
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        log?.("已从案例中心点开一个案例");
        return { page: popup, hub };
      }
    }

    log?.("页面上没找到「查看案例」，改用固定案例地址");
    await hub.goto(FALLBACK_CASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    return { page: hub, hub: null };
  } catch (e) {
    await hub.close().catch(() => {});
    throw e;
  }
}

export async function run({ context, page, log }) {
  const before = await getUserTasks(page).catch(() => ({ missions: [] }));
  if (before.error === "not-login") return { status: "failed", detail: "登录态失效" };
  const target = findMission(before.missions || []);
  if (target?.done) return { status: "already", detail: "今日已完成" };

  let hub = null;
  let casePage = null;
  try {
    const opened = await openCase(context, log);
    casePage = opened.page;
    hub = opened.hub;

    // 关键：计时只在页面可见时累加，必须把这个标签页推到最前
    await casePage.bringToFront().catch(() => {});
    await casePage.waitForTimeout(2500);

    const title = await casePage.title().catch(() => "");
    log?.(`已打开案例：${title.slice(0, 40) || casePage.url()}`);

    for (let waited = 0; waited < DWELL_MS; waited += 5000) {
      await casePage.waitForTimeout(5000);
      // 轻微滚动，避免被判定为「挂着不动」
      await casePage.evaluate(() => window.scrollBy(0, 120)).catch(() => {});
    }
    log?.("已停留 40 秒，关闭案例页");
  } finally {
    if (casePage && casePage !== hub) await casePage.close().catch(() => {});
    if (hub) await hub.close().catch(() => {});
    // 把接口页切回前台，后续回查才不会被浏览器节流
    await page.bringToFront().catch(() => {});
  }

  // 服务端记分有延迟：等到任务状态真的翻转，最多 10 分钟，超时记延迟结算
  const settled = await waitForResult({
    page,
    log,
    label: "鸿蒙案例任务",
    timeoutMs: SETTLE_WAIT_MS,
    check: async () => {
      const after = await getUserTasks(page).catch(() => ({ missions: [] }));
      return { done: Boolean(findMission(after.missions || [])?.done) };
    },
  });
  if (settled.ok) {
    log?.("任务已标记完成，+10 分");
    return { status: "signed", detail: "已完成，积分到账" };
  }
  return {
    status: "delayed",
    detail: `已浏览案例 40 秒，但 ${SETTLE_MINUTES} 分钟内任务状态还没变成已完成；分数只会晚到`,
  };
}
