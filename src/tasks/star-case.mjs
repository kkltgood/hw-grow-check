/**
 * Star 一个鸿蒙案例代码仓（+30/天）。
 *
 * 规则：绑定 GitCode 账号，Star 任意一个案例仓，每天要换一个、不能取消。
 * 具体流程与保护逻辑在 src/star-runner.mjs，日任务和周任务共用。
 */
import { fetchCaseRepos } from "../gitcode.mjs";
import { runStarTask } from "../star-runner.mjs";
import { RESULT_WAIT_MS } from "../wait.mjs";

export const meta = {
  id: "star",
  title: "Star一个鸿蒙案例代码仓",
  bonus: 30,
  cycle: "DAILY",
  safe: true,
  note: "从案例仓池里挑一个没 Star 过的仓库，用 GitCode 令牌 Star",
  // 内部最多等 5 分钟结算，外层超时留余量
  timeoutMs: RESULT_WAIT_MS + 90_000,
};

export async function run({ page, log }) {
  return runStarTask({
    page,
    log,
    task: {
      ...meta,
      tag: "hm_star_case_repo",
      stateFile: "star-case.json",
      poolLabel: "案例仓",
    },
    loadPool: () => fetchCaseRepos(),
  });
}
