import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { config } from "./config.mjs";

export function hasAuth() {
  return existsSync(config.authFile);
}

export function ensureAuthDir() {
  mkdirSync(dirname(config.authFile), { recursive: true });
}

/**
 * 启动浏览器。channel 为空时用 Playwright 自带 chromium（无桌面环境推荐），
 * 本机可设 GROW_CHANNEL=chrome 复用系统 Chrome。
 * 找不到 Playwright 版 Chromium 时自动回退系统 Chrome，省掉一次 150MB 下载。
 */
export async function launchBrowser({ headless = config.headless } = {}) {
  const opts = {
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // 小内存机器的减负项：不跑 GPU、不预加载、限制渲染进程数
      "--disable-gpu",
      "--disable-extensions",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--renderer-process-limit=2",
    ],
  };
  if (config.channel) opts.channel = config.channel;

  try {
    return await chromium.launch(opts);
  } catch (e) {
    const missing = /Executable doesn'?t exist|is not found|Failed to launch/i.test(String(e));
    if (!config.channel && missing) {
      try {
        const browser = await chromium.launch({ ...opts, channel: "chrome" });
        console.log("[browser] 未找到 Playwright Chromium，已回退到系统 Chrome");
        return browser;
      } catch {
        /* 系统 Chrome 也不可用，抛原始错误更有信息量 */
      }
    }
    throw e;
  }
}

export async function newContext(browser, { withAuth = true } = {}) {
  const opts = {
    locale: config.locale,
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 1000 },
  };
  if (withAuth && hasAuth()) opts.storageState = config.authFile;
  return browser.newContext(opts);
}

export async function saveAuth(context) {
  ensureAuthDir();
  await context.storageState({ path: config.authFile });
  chmodSync(config.authFile, 0o600); // 含登录 Cookie，不能是 644
  writeFileSync(config.authFile + ".meta.json", JSON.stringify({ savedAt: new Date().toISOString() }, null, 2));
}

export function authAgeDays() {
  const meta = config.authFile + ".meta.json";
  if (!existsSync(meta)) return null;
  try {
    const { savedAt } = JSON.parse(readFileSync(meta, "utf8"));
    return (Date.now() - new Date(savedAt).getTime()) / 86400000;
  } catch {
    return null;
  }
}
