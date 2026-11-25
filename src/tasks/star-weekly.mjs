/**
 * 每周 Star 一个 Agent 开发实践中心代码仓（+50/周）。
 *
 * 池子是 GitCode 组织 agent-best-practices 下的公开仓库（当前 32 个）。
 * 规则和日任务一样：每周换一个、不能取消；只是去重周期从「天」换成「周」。
 * 具体流程在 src/star-runner.mjs。
 */
import { fetchPracticeRepos } from "../gitcode.mjs";
import { runStarTask } from "../star-runner.mjs";

export const meta = {
  id: "star-weekly",
  title: "每周Star一个Agent开发实践中心代码仓",
  bonus: 50,
  cycle: "WEEKLY",
  safe: true,
  note: "从 agent-best-practices 组织挑一个没 Star 过的仓库，用 GitCode 令牌 Star",
  timeoutMs: 300_000,
};

export async function run({ page, log }) {
  return runStarTask({
    page,
    log,
    task: {
      ...meta,
      tag: "star_practice_repo",
      stateFile: "star-weekly.json",
      poolLabel: "实践中心仓",
      // 组织介绍仓不算项目，不 Star
      exclude: ["agent-best-practices/Readme"],
    },
    loadPool: (token) => fetchPracticeRepos(token),
  });
}
