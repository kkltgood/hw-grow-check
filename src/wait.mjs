/**
 * 统一的「等检查结果」工具。
 *
 * 签到、Star、鸿蒙案例、DevSpace 这些任务，动作做完不等于分数到账：
 * 成长中心的结算和外部校验都有延迟。以前每个任务各写一套轮询（1.2 秒 / 90 秒 / 3 分钟），
 * 超时还都记成 pending，邮件里看着像「没失败也没成功」。
 *
 * 现在统一规则：等到成长中心把任务标记完成才算完成，单个任务最多等 5 分钟，
 * 超时由调用方按失败返回。
 */

/** 单个任务等待检查结果的上限：5 分钟 */
export const RESULT_WAIT_MS = 5 * 60 * 1000;

/** 轮询间隔：10 秒（接口很轻，5 分钟最多 30 次） */
export const RESULT_POLL_MS = 10_000;

/**
 * 轮询直到 check() 返回 done，或超时。
 *
 * @param {object} o
 * @param {import('playwright').Page} o.page
 * @param {Function} [o.log]
 * @param {string} [o.label]        日志里的任务名
 * @param {number} [o.timeoutMs]    总预算，默认 5 分钟
 * @param {number} [o.intervalMs]   轮询间隔，默认 10 秒
 * @param {Function} o.check        async () => ({ done: boolean, ... })
 * @returns {Promise<{ok: boolean, tries: number, waitedMs: number, last: any}>}
 */
export async function waitForResult({
  page,
  log,
  label = "任务结果",
  timeoutMs = RESULT_WAIT_MS,
  intervalMs = RESULT_POLL_MS,
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

    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) return { ok: false, tries, waitedMs: Date.now() - started, last };

    const sleep = Math.min(intervalMs, left);
    log?.(`${label}：第 ${tries} 次还没确认，${Math.ceil(sleep / 1000)} 秒后再查`);
    await page.waitForTimeout(sleep);
  }
}

/** 等一下的秒数说法，邮件和日志共用 */
export const WAIT_MINUTES = Math.round(RESULT_WAIT_MS / 60_000);
