/**
 * 统一的「等检查结果」工具。
 *
 * 签到、Star、鸿蒙案例、DevSpace 这些任务，动作做完不等于分数到账：
 * 成长中心的结算和外部校验都有延迟。以前每个任务各写一套轮询（1.2 秒 / 90 秒 / 3 分钟），
 * 超时还都记成 pending，邮件里看着像「没失败也没成功」。
 *
 * 现在统一规则：等到成长中心把任务标记完成才算完成。
 *
 * 两类预算要分开，别再混用：
 *   - RESULT_WAIT_MS（5 分钟）：签到这类「接口当场给结果」的任务，重试 + 确认共用预算；
 *   - SETTLE_WAIT_MS（10 分钟）：Star / 鸿蒙案例 / DevSpace 这类「动作已经做完、
 *     只等平台结算」的任务。平台结算偶尔要 6-8 分钟，5 分钟窗口会把已经成功的任务
 *     误判成失败（11-26、11-27 连续两天 Star 都踩了这个坑）。
 */

/** 签到等「接口当场给结果」的任务：5 分钟 */
export const RESULT_WAIT_MS = 5 * 60 * 1000;

/** 「动作已做、等平台结算」的任务：10 分钟 */
export const SETTLE_WAIT_MS = 10 * 60 * 1000;

/** 轮询间隔：前 5 分钟 10 秒一次（接口很轻） */
export const RESULT_POLL_MS = 10_000;

/** 超过 5 分钟还没结果，放慢到 30 秒一次，少打接口 */
export const RESULT_SLOW_AFTER_MS = 5 * 60 * 1000;
export const RESULT_SLOW_POLL_MS = 30_000;

/**
 * 轮询直到 check() 返回 done，或超时。
 *
 * @param {object} o
 * @param {import('playwright').Page} o.page
 * @param {Function} [o.log]
 * @param {string} [o.label]        日志里的任务名
 * @param {number} [o.timeoutMs]    总预算，默认 5 分钟
 * @param {number} [o.intervalMs]   轮询间隔，默认 10 秒
 * @param {number} [o.slowAfterMs]  超过多久放慢轮询，默认 5 分钟
 * @param {number} [o.slowIntervalMs] 放慢后的间隔，默认 30 秒
 * @param {Function} o.check        async () => ({ done: boolean, ... })
 * @returns {Promise<{ok: boolean, tries: number, waitedMs: number, last: any}>}
 */
export async function waitForResult({
  page,
  log,
  label = "任务结果",
  timeoutMs = RESULT_WAIT_MS,
  intervalMs = RESULT_POLL_MS,
  slowAfterMs = RESULT_SLOW_AFTER_MS,
  slowIntervalMs = RESULT_SLOW_POLL_MS,
  check,
}) {
  const started = Date.now();
  let tries = 0;
  let last = null;

  for (;;) {
    tries += 1;
    // 查询本身报错不算完成，继续等；错误留在 last 里给调用方判断
    last = await check().catch((e) => ({ done: false, error: String(e).slice(0, 160) }));
    if (last?.done) return { ok: true, tries, waitedMs: Date.now() - started, last };

    const elapsed = Date.now() - started;
    const left = timeoutMs - elapsed;
    if (left <= 0) return { ok: false, tries, waitedMs: elapsed, last };

    // 前段查得勤、后段查得稀：结算慢的时候不再每 10 秒打一次接口
    const interval = elapsed >= slowAfterMs ? slowIntervalMs : intervalMs;
    const sleep = Math.min(interval, left);
    log?.(`${label}：第 ${tries} 次还没确认，${Math.ceil(sleep / 1000)} 秒后再查`);
    await page.waitForTimeout(sleep);
  }
}

/** 等一下的秒数说法，邮件和日志共用 */
export const WAIT_MINUTES = Math.round(RESULT_WAIT_MS / 60_000);
export const SETTLE_MINUTES = Math.round(SETTLE_WAIT_MS / 60_000);
