#!/usr/bin/env node
/**
 * hw-grow-check CLI
 *
 *   node src/cli.mjs login [--qr]      登录（--qr 输出二维码图片，服务器可用）
 *   node src/cli.mjs export-auth       导出登录态（base64），用于拷贝到服务器
 *   node src/cli.mjs import-auth       从 GROW_AUTH_B64 或文件导入登录态
 *   node src/cli.mjs run               执行启用的任务（定时任务调用这个）
 *   node src/cli.mjs status            查看积分与任务状态
 *   node src/cli.mjs doctor            环境自检
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authAgeDays, hasAuth, launchBrowser, newContext, saveAuth } from "./browser.mjs";
import { ensureDataDir, config, URLS } from "./config.mjs";
import {
  checkLogin,
  closePage,
  getPoints,
  getProfile,
  getSignStreak,
  getUserTasks,
  openApiPage,
} from "./api.mjs";
import { alert, alertConfigured, alertFailure, makeLogger, notify, notifyEnabled } from "./notify.mjs";
import { gateLoginFailure, humanHours, markLoginAlerted, markLoginOk } from "./alert-gate.mjs";
import { mailConfigured, readMailConfig, sendMail } from "./mail.mjs";
import { loginWithPassword, readCredentials } from "./login-password.mjs";
import { fetchCaseRepos, fetchPracticeRepos, getGitcodeUser, listStarredRepos, readGitcodeConfig } from "./gitcode.mjs";
import { recentSeries, recordPoints } from "./points-history.mjs";

const log = makeLogger();
const [cmd = "run", ...args] = process.argv.slice(2);

const TASK_IMPL = {
  checkin: () => import("./tasks/checkin.mjs"),
  harmony: () => import("./tasks/harmony-view.mjs"),
  devspace: () => import("./tasks/devspace.mjs"),
  star: () => import("./tasks/star-case.mjs"),
  "star-weekly": () => import("./tasks/star-weekly.mjs"),
};

/** 按 Asia/Shanghai 取 YYYY-MM-DD（不能先 toLocaleString 再 toISOString，会倒退 8 小时） */
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 给单个任务加超时，避免某个页面卡住整轮执行 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

// ---------------------------------------------------------------- login
/**
 * 用账号密码现场登录（服务器无人值守时的补救手段）。
 * 密码只从环境变量读，不落盘、不进 argv、不进 shell history。
 * 登录成功后立刻跑一次任务，省得人还要再敲第二条命令。
 */
async function loginWithEnv() {
  ensureDataDir();
  const creds = readCredentials() || {};
  const account = process.env.GROW_ACCOUNT || creds.account || "";
  const password = process.env.GROW_PASSWORD || creds.password || "";
  if (!account || !password) {
    log("✗ 没有账号密码：设置 GROW_ACCOUNT / GROW_PASSWORD，或写入 data/account.json 的 huawei 段");
    return 1;
  }

  const browser = await launchBrowser();
  let ok = false;
  try {
    const context = await newContext(browser, { withAuth: false });
    const page = await context.newPage();
    const r = await loginWithPassword(page, { account, password }, log);
    if (!r.ok) {
      log(`✗ 登录失败：${r.reason}`);
      await alertFailure(`账号密码登录失败：${r.reason}`, ["密码可能已修改，或该 IP 触发了风控"]);
      return 3;
    }
    // 带 service 登录后已经回跳到新站（URL 上可能还挂着 ticket），
    // 这时只能等 SPA 换会话，不能再 goto，否则 ticket 就白拿了。
    if (!page.url().startsWith("https://grow.developer.huaweicloud.com")) {
      await page.goto(URLS.grow, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    }
    await page.waitForTimeout(4000);
    const st = await checkLogin(page, { attempts: 2 }).catch(() => ({ ok: null }));
    if (st.ok !== true) {
      log(`✗ 登录后仍无法确认身份（${st.reason ?? "unknown"}）`);
      await alertFailure(`登录后仍不可用：${st.reason ?? "unknown"}`);
      return 3;
    }
    await saveAuth(context);
    const profile = await getProfile(page).catch(() => null);
    log(`✓ 登录成功，登录态已保存（账号 ${profile?.alias ?? account}）`);
    ok = true;
  } finally {
    await browser.close().catch(() => {});
  }

  if (ok) {
    log("→ 继续执行今日任务");
    return run();
  }
  return 3;
}

async function login() {
  if (args.includes("--from-env")) return loginWithEnv();
  ensureDataDir();
  // 默认开有头浏览器（本机扫码）；服务器没有桌面，用 --qr 走无头截图
  const qrMode = args.includes("--qr");
  const browser = await launchBrowser({ headless: qrMode });
  const context = await newContext(browser, { withAuth: false });
  const page = await context.newPage();

  await page.goto(URLS.login, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(5000);

  if (qrMode) {
    const qrPath = join(config.dataDir, "login-qr.png");
    await page.screenshot({ path: qrPath, fullPage: false });
    log(`已截图登录页：${qrPath}`);
    log("把这张图打开，用华为云 App 扫码；脚本会轮询登录状态（最长 10 分钟）");
  } else {
    log("请在打开的浏览器里完成登录（扫码或账号密码），最长等 10 分钟");
  }

  const deadline = Date.now() + 10 * 60 * 1000;
  /**
   * 登录成功后只跳一次签到页，之后纯轮询接口。
   * 之前每 4 秒 goto 一次，接口稍有抖动就会表现成「页面反复刷新」，
   * 人在页面上看公告都会被打断 —— 这里用 landed 标记把 goto 限定成一次。
   */
  let landed = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    if (qrMode) await page.screenshot({ path: join(config.dataDir, "login-qr.png") }).catch(() => {});

    if (!landed) {
      if (page.url().includes("auth.huaweicloud.com")) continue; // 还在登录页，继续等
      landed = true;
      // 带 service 登录完会回跳到新站并带 ticket，SPA 需要几秒把它换成会话；
      // 这时不能再 goto，否则会把 ticket 冲掉。
      if (!page.url().startsWith("https://grow.developer.huaweicloud.com")) {
        await page.goto(URLS.grow, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      }
      await page.waitForTimeout(4000);
    }

    const status = await checkLogin(page, { attempts: 1 }).catch(() => ({ ok: null }));
    if (status.ok === true) {
      await saveAuth(context);
      const points = await getPoints(page).catch(() => null);
      log(`✓ 登录成功，登录态已保存：${config.authFile}`);
      log(`  当前积分：${points ?? "未知"}`);
      await browser.close();
      return 0;
    }
  }
  log("✗ 登录超时");
  await browser.close();
  return 1;
}

// ---------------------------------------------------------------- auth 迁移
function exportAuth() {
  if (!hasAuth()) {
    log("✗ 没有登录态文件，先运行 login");
    return 1;
  }
  const b64 = readFileSync(config.authFile).toString("base64");
  const out = join(config.dataDir, "auth.b64");
  writeFileSync(out, b64);
  log(`已导出：${out}（${b64.length} 字节，含登录 Cookie，勿外传）`);
  log("拷到服务器后执行：GROW_AUTH_B64=$(cat auth.b64) node src/cli.mjs import-auth");
  return 0;
}

function importAuth() {
  ensureDataDir();
  const b64 = process.env.GROW_AUTH_B64 || (existsSync(args[0] || "") ? readFileSync(args[0], "utf8") : "");
  if (!b64) {
    log("✗ 没有拿到 GROW_AUTH_B64，也没找到文件参数");
    return 1;
  }
  const json = Buffer.from(b64.trim(), "base64").toString("utf8");
  JSON.parse(json); // 校验
  writeFileSync(config.authFile, json, { mode: 0o600 });
  chmodSync(config.authFile, 0o600); // 含 Cookie，不能是 644
  writeFileSync(config.authFile + ".meta.json", JSON.stringify({ savedAt: new Date().toISOString() }, null, 2));
  log(`✓ 登录态已导入：${config.authFile}`);
  return 0;
}

// ---------------------------------------------------------------- run
/**
 * 登录失效告警：所有入口共用同一道闸门（data/alert-state.json）。
 *
 * 定时任务、手动补跑、重试都会走到这里，若不共用就会重复打扰。
 * 退避规则：首次立即 → 4 小时 → 之后每 8 小时；登录成功即清零。
 */
async function reportLoginFailure(reason, extra = []) {
  const g = gateLoginFailure(config.dataDir);
  if (!g.allow) {
    log(`  已提醒 ${g.sent} 次，距下次提醒还有 ${g.waitH.toFixed(1)} 小时（本次不重复发送）`);
    return false;
  }
  const nth = g.sent + 1;
  const lines = [
    nth === 1
      ? "这是第 1 次提醒。若一直没恢复，4 小时后会再提醒一次，之后每 8 小时一次。"
      : `这是第 ${nth} 次提醒，会话已持续失效 ${humanHours(g.outageH)}。`,
    ...extra,
  ];
  const ok = await alertFailure(reason, lines, {
    title: nth === 1 ? "⚠️ 华为云签到失败" : `⚠️ 华为云签到失败（第 ${nth} 次提醒）`,
  });
  if (ok) markLoginAlerted(config.dataDir);
  else log("  ! 告警没有发出，本次不计数，下次运行会重试");
  return ok;
}

async function run() {
  ensureDataDir();
  if (!hasAuth()) {
    log("✗ 缺少登录态，先 login / import-auth");
    // 这条路径最容易被忽略：文件没了等于永远不会签到，必须同样告警
    await reportLoginFailure("登录态文件不存在（data/auth.json 缺失）", [
      "可能原因：误删、磁盘恢复、或首次部署未导入",
    ]);
    return 3;
  }

  const enabled = config.tasks;
  const unknown = enabled.filter((t) => !TASK_IMPL[t]);
  if (unknown.length) {
    log(`✗ 未知任务：${unknown.join(", ")}（可选：${Object.keys(TASK_IMPL).join(", ")}）`);
    return 1;
  }

  const browser = await launchBrowser();
  const context = await newContext(browser);
  let code = 0;
  const results = [];
  try {
    let page = await openApiPage(context);
    let auth = await checkLogin(page);

    // 会话失效时，若配了账号密码就现场重新登录一次 —— 不再靠「登录态能撑多久」
    if (auth.ok === false) {
      const creds = readCredentials();
      if (!creds) {
        log("✗ 登录态已失效，且没有配置账号密码（data/account.json 的 huawei 段）");
        await closePage(page);
        await browser.close();
        await reportLoginFailure("登录态已失效（华为云判定未登录）");
        return 3;
      }

      log("会话已失效，改用账号密码重新登录");
      await closePage(page);
      const loginPage = await context.newPage();
      const r = await withTimeout(loginWithPassword(loginPage, creds, log), 150000, "密码登录").catch((e) => ({
        ok: false,
        reason: String(e).slice(0, 160),
      }));
      await closePage(loginPage);

      if (!r.ok) {
        log(`✗ 自动登录失败：${r.reason}`);
        await browser.close();
        await reportLoginFailure(`自动登录失败：${r.reason}`);
        return 3;
      }

      await saveAuth(context);
      page = await openApiPage(context);
      auth = await checkLogin(page);
      if (auth.ok !== true) {
        log(`✗ 登录后仍无法确认身份（${auth.reason ?? "not-login"}）`);
        await browser.close();
        await reportLoginFailure(`登录后仍不可用：${auth.reason ?? "not-login"}`);
        return 3;
      }
      log("✓ 已用账号密码重新登录");
    }

    if (auth.ok === true) {
      // 登录正常即结束本轮失效期，下次再挂重新从「立即提醒」开始
      const rec = markLoginOk(config.dataDir);
      if (rec) log(`✓ 登录状态已恢复（本次失效期共提醒 ${rec.sent} 次、持续 ${humanHours(rec.outageH)}）`);
    }
    if (auth.ok === null) {
      // 网络抖动 / 网关 5xx 不该被当成登录过期，继续试，失败了任务里会报
      log(`! 登录态暂时无法确认（${auth.reason}），继续执行`);
    }

    const pointsBefore = await getPoints(page).catch(() => null);
    const profile = await getProfile(page).catch(() => null);
    log(`当前账号：${profile?.alias ?? "未知"}；积分 ${pointsBefore ?? "?"}`);

    for (const id of enabled) {
      const impl = await TASK_IMPL[id]();
      log(`→ [${id}] ${impl.meta.title}`);
      let r;
      try {
        // 单个任务可以声明更长的超时（比如 Star 要等外部校验）
        const taskTimeout = Number(impl.meta.timeoutMs) || config.timeoutMs;
        r = await withTimeout(impl.run({ page, context, log }), taskTimeout, `任务 ${id}`);
      } catch (e) {
        r = { status: "failed", detail: String(e).slice(0, 200) };
      }
      results.push({ id, title: impl.meta.title, ...r });
      log(`  ${r.status}: ${r.detail}`);
      if (r.status === "failed") code = 2;
    }

    // 任务跑完后重读积分与任务状态
    const pointsAfter = await getPoints(page).catch(() => null);
    const missions = await getUserTasks(page).catch(() => ({ missions: [] }));

    // 顺带汇报还有哪些任务没做（只提示，不自动做）
    const allTasks = (missions.missions ?? []).map((m) => ({
      title: m.title,
      bonus: m.bonus,
      url: m.url,
      cycle: m.cycle,
      done: m.done === true,
    }));
    const undone = allTasks.filter((m) => !m.done);
    if (undone.length) {
      log(`\n未完成任务（需人工，共 ${undone.length} 项）：`);
      for (const m of undone) log(`  +${String(m.bonus).padEnd(4)} ${m.title}  → ${m.url}`);
    }

    // 记一条积分历史，供邮件里的 7 天曲线用；同一天跑多次只保留最后一次
    if (pointsAfter != null) {
      recordPoints(config.dataDir, today(), pointsAfter);
      const pts = recentSeries(config.dataDir, 7).filter((x) => x.points != null);
      if (pts.length >= 2) {
        const head = pts[0];
        const tail = pts[pts.length - 1];
        log(`\n积分趋势（${pts.length} 天有记录）：${head.date.slice(5)} ${head.points} → ${tail.date.slice(5)} ${tail.points}`);
      }
    }

    const summary = {
      date: today(),
      at: new Date().toISOString(),
      pointsBefore,
      pointsAfter,
      results,
      pending: undone.map((m) => ({
        title: m.title,
        bonus: m.bonus,
        url: m.url,
        // 新版任务分每日/每周/每月/一次性，邮件要按这个分类分组
        cycle: m.cycle,
      })),
      // 全量清单（含已完成）：邮件里要显示哪些做完了、哪些还没
      tasks: allTasks,
    };
    writeFileSync(config.stateFile, JSON.stringify(summary, null, 2));

    const lines = [
      `签到：${results.find((r) => r.id === "checkin")?.detail ?? "-"}`,
      `积分：${pointsBefore ?? "?"} → ${pointsAfter ?? "?"}`,
      ...results.filter((r) => r.id !== "checkin").map((r) => `${r.title}：${r.detail}`),
    ];
    // 结论单独打一行：定时任务的调用方靠这行取结果
    log(`\n签到：${results.find((r) => r.id === "checkin")?.detail ?? "-"}`);
    log(`完成。积分 ${pointsBefore ?? "?"} → ${pointsAfter ?? "?"}`);
    if (code === 0) {
      await notify("华为云签到完成", lines); // 成功不打扰手机，webhook 有配才发
    } else {
      // 任务失败同样要能推到手机：只有 webhook 时等于没告警
      await alert("⚠️ 华为云签到异常", [...lines, "处理：看 journalctl 确认哪一步失败"]);
    }
    await closePage(page);
  } catch (e) {
    log(`✗ 执行异常：${String(e).slice(0, 300)}`);
    code = 1;
    await alertFailure(`执行异常：${String(e).slice(0, 120)}`);
  } finally {
    await browser.close().catch(() => {});
  }
  return code;
}

// ---------------------------------------------------------------- status
async function status() {
  if (!hasAuth()) {
    log("✗ 缺少登录态");
    return 3;
  }
  const browser = await launchBrowser();
  const context = await newContext(browser);
  try {
    const page = await openApiPage(context);
    const auth = await checkLogin(page);
    if (auth.ok === false) {
      log("✗ 登录态已失效（接口明确返回 not login），需要重新 login");
      return 3;
    }
    if (auth.ok === null) {
      log(`✗ 查询失败：${auth.reason}`);
      log("  这不代表登录过期，多为网络/网关临时故障，稍后重试即可");
      return 1;
    }
    const sign = auth.sign;
    const points = await getPoints(page);
    const missions = await getUserTasks(page);
    const profile = await getProfile(page).catch(() => null);
    log(`账号：${profile?.alias ?? "?"}   积分：${points ?? "?"}`);
    if (sign) {
      const streak = sign.signedToday ? await getSignStreak(page).catch(() => null) : null;
      log(
        `签到：${sign.signedToday ? "已签" : "未签"}${
          streak ? `（连续 ${streak} 天）` : ""
        }，每日 +${sign.bonusPerDay ?? "?"}`,
      );
    } else {
      log("签到：状态未知（任务接口抽风但会话有效，重跑一次即可）");
    }
    if (missions.error) log(`任务列表获取失败：${missions.error}`);
    log("\n任务：");
    for (const m of missions.missions ?? []) {
      log(`  ${m.done ? "✔" : "·"} +${String(m.bonus).padEnd(4)} ${String(m.cycle).padEnd(8)} ${m.title}`);
    }
    const age = authAgeDays();
    if (age != null) log(`\n登录态已保存 ${age.toFixed(1)} 天`);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- doctor
async function doctor() {
  ensureDataDir();
  log(`node ${process.version}`);
  log(`数据目录 ${config.dataDir}`);
  log(`登录态 ${hasAuth() ? "存在" : "缺失"}  ${config.authFile}`);
  log(`无头模式 ${config.headless}   浏览器 channel ${config.channel || "playwright-chromium"}`);
  log(`启用任务 ${config.tasks.join(", ")}`);
  try {
    const browser = await launchBrowser({ headless: true });
    const ctx = await newContext(browser, { withAuth: false });
    const page = await ctx.newPage();
    await page.goto("about:blank");
    log("✓ 浏览器可启动");
    await browser.close();
  } catch (e) {
    log(`✗ 浏览器启动失败：${String(e).slice(0, 200)}`);
    log("  服务器上请执行 npx playwright install --with-deps chromium");
    return 1;
  }
  return 0;
}

async function testNotify() {
  if (!alertConfigured()) {
    log("✗ 没有配置任何告警渠道（GROW_NOTIFY_URL 或 account.json 的 mail 段）");
    return 1;
  }
  const lines = [
    "这是一条测试消息，收到说明告警链路是通的。",
    `时间：${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })}`,
  ];

  let ok = false;
  if (notifyEnabled()) {
    // webhook 地址里带密钥，日志里只留主机名
    let host = "";
    try {
      host = new URL(config.notifyUrl).host;
    } catch {
      host = "（地址格式无法解析）";
    }
    log(`尝试 webhook：${config.notifyType} @ ${host}`);
    ok = await notify("华为云签到｜测试消息", lines);
  }
  if (!ok && mailConfigured()) {
    const mc = readMailConfig();
    log(`尝试邮件：${mc.host}:${mc.port} → ${mc.to}`);
    ok = await sendMail("华为云签到｜测试消息", lines.join("\n"), null, null, { fromName: "华为云签到测试" });
  }

  log(ok ? "✓ 已发出，去邮箱确认" : "✗ 发送失败，原因见上面的 [notify] / [mail] 行");
  return ok ? 0 : 1;
}

/**
 * 检查 GitCode 令牌与案例仓余量。
 * 只读：列出还没 Star 的仓库，不做任何写操作。
 */
async function gitcodeCheck() {
  const gc = readGitcodeConfig();
  if (!gc) {
    log("✗ 没有 GitCode 令牌：在 data/account.json 的 gitcode 段填 {token,username}，或设置 GROW_GITCODE_TOKEN");
    return 1;
  }
  try {
    const [me, starred, pool, practice] = await Promise.all([
      getGitcodeUser(gc.token),
      listStarredRepos(gc.token),
      fetchCaseRepos(),
      fetchPracticeRepos(gc.token),
    ]);
    const seen = new Set(starred.map((s) => s.toLowerCase()));
    const remain = pool.filter((c) => !seen.has(c.fullName.toLowerCase()));
    const remainPractice = practice.filter(
      (c) => !seen.has(c.fullName.toLowerCase()) && c.fullName.toLowerCase() !== "agent-best-practices/readme",
    );
    log(`✓ 令牌有效：${me.login || me.username || me.name || gc.username || "?"}`);
    if (gc.username && me.login && gc.username !== me.login) {
      log(`! 注意：令牌属于 ${me.login}，不是配置里的 ${gc.username}；Star 会记到令牌账号名下`);
    }
    log(`案例仓池 ${pool.length} 个，未 Star ${remain.length} 个`);
    for (const c of remain.slice(0, 5)) log(`  · ${c.fullName}  ${c.title}`);
    if (remain.length > 5) log(`  … 其余 ${remain.length - 5} 个`);
    log(`实践中心仓 ${practice.length} 个，未 Star ${remainPractice.length} 个`);
    for (const c of remainPractice.slice(0, 5)) log(`  · ${c.fullName}  ${c.title}`);
    if (remainPractice.length > 5) log(`  … 其余 ${remainPractice.length - 5} 个`);
    return 0;
  } catch (e) {
    log(`✗ ${String(e).replace(/^Error:\s*/, "").slice(0, 200)}`);
    return 1;
  }
}

const main = async () => {
  switch (cmd) {
    case "login":
      return login();
    case "export-auth":
      return exportAuth();
    case "import-auth":
      return importAuth();
    case "run":
      return run();
    case "status":
      return status();
    case "doctor":
      return doctor();
    case "test-notify":
      return testNotify();
    case "gitcode-check":
      return gitcodeCheck();
    default:
      console.log(readFileSync(new URL("./help.txt", import.meta.url), "utf8").toString());
      return 1;
  }
};

main()
  .then((c) => process.exit(c ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
