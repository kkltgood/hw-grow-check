/**
 * 账号密码登录。
 *
 * 为什么需要它：华为云的门户会话有很短的闲置超时，而签到是 24 小时一次。
 * 实测登录后十几小时内会话就会失效，靠一次登录撑到第二天并不可靠。
 * 与其想办法续命，不如每次运行时现场登录一次 —— 会话从建立到用完只有几十秒，
 * 不存在过期问题。
 *
 * 凭据从 data/account.json 的 huawei 段读（和邮箱、GitCode 放一起）：
 *   "huawei": { "account": "手机号/邮箱/账号名", "password": "..." }
 */
import { accountSection } from "./account.mjs";
import { URLS } from "./config.mjs";

export function readCredentials() {
  const j = accountSection("huawei");
  if (!j || !j.account || !j.password) return null;
  return { account: String(j.account).trim(), password: String(j.password) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 在给定 page 上完成登录。成功返回 { ok: true }，否则 { ok: false, reason }。
 * 不打印任何凭据内容。
 */
export async function loginWithPassword(page, creds, log = () => {}) {
  await page.goto(URLS.login, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(3000);

  // 有的落地页默认是「手机号登录」，需要切到密码登录
  for (const label of ["密码登录", "Password Login", "Password login", "账号登录"]) {
    const tab = page.locator(`text="${label}"`).first();
    if (await tab.count().catch(() => 0)) {
      await tab.click({ timeout: 3000 }).catch(() => {});
      await sleep(1200);
    }
  }

  // 页面里有个隐藏的 username 输入框（hwid-hidden-useraccount），必须只挑可见的
  const visibleText = page.locator(
    "input[type='text']:visible, input[type='tel']:visible, input[type='email']:visible",
  );
  const pwd = page.locator("input[type='password']:visible").first();

  const n = await visibleText.count();
  if (!n || !(await pwd.count())) {
    return { ok: false, reason: "登录页结构不认识（找不到输入框）" };
  }

  // IAM 用户是「账号名 / 用户名 / 密码」三个框，普通账号是两个
  if (n >= 3) {
    log("检测到 IAM 用户表单（3 个输入框），按 账号名/用户名/密码 填写");
    const parts = creds.account.split("/").map((s) => s.trim());
    await visibleText.nth(0).fill(parts[0] || creds.account);
    await visibleText.nth(1).fill(parts[1] || parts[0] || creds.account);
  } else {
    await visibleText.first().fill(creds.account);
  }
  await pwd.fill(creds.password);
  await sleep(400);

  // 提交按钮是个 span（不是 button），点它容易点到上面的「密码登录」标签，
  // 直接回车最稳；回车没反应再退回到「密码框下方那个 登录」
  await pwd.press("Enter");
  await sleep(1500);

  // 等跳转或报错，最多 60 秒
  const deadline = Date.now() + 60000;
  let lastText = "";
  while (Date.now() < deadline) {
    await sleep(2500);
    const url = page.url();
    if (!url.includes("auth.huaweicloud.com")) {
      await sleep(2000);
      return { ok: true };
    }
    lastText = await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => "");
    if (/Incorrect ID or password|账号或密码错误|密码错误|account or password is incorrect/i.test(lastText)) {
      return { ok: false, reason: "账号或密码不正确" };
    }
    if (/verification code|验证码|短信验证|two-factor|二次验证/i.test(lastText)) {
      return { ok: false, reason: "登录要求短信/二次验证，无法自动化" };
    }
    if (/locked|冻结|已锁定|多次失败/i.test(lastText)) {
      return { ok: false, reason: "账号被临时锁定（失败次数过多）" };
    }
    // 还在登录页：可能提交没生效，再回车一次
    if (Date.now() > deadline - 40000) {
      await pwd.press("Enter").catch(() => {});
    }
  }

  return { ok: false, reason: `登录超时（停留在 ${page.url()}）` };
}
