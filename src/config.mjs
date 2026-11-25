/**
 * 配置：环境变量 + data/account.json。
 */
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function bool(v, def = false) {
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}

const dataDir = isAbsolute(env("GROW_DATA_DIR", "data"))
  ? env("GROW_DATA_DIR", "data")
  : join(ROOT, env("GROW_DATA_DIR", "data"));

export const config = {
  dataDir,
  // 统一账号配置：mail / gitcode / huawei 都写在这一份里
  accountFile: env("GROW_ACCOUNT_FILE", join(dataDir, "account.json")),
  // 登录态（Cookie），和账号配置分开存
  authFile: env("GROW_AUTH_FILE", join(dataDir, "auth.json")),
  stateFile: env("GROW_STATE_FILE", join(dataDir, "state.json")),

  // 无头模式：无桌面环境必须 true
  headless: bool(env("GROW_HEADLESS", "true"), true),
  // 本机可用系统 Chrome 省去下载：chrome / chromium
  channel: env("GROW_CHANNEL", ""),
  // 单任务超时
  timeoutMs: Number(env("GROW_TIMEOUT_MS", "120000")),
  // 页面语言
  locale: "zh-CN",

  // 启用的任务，逗号分隔：checkin,harmony,devspace,star,star-weekly
  tasks: env("GROW_TASKS", "checkin,harmony,devspace,star,star-weekly")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // 可选的 webhook 通知（飞书/钉钉/通用 JSON）
  notifyUrl: env("GROW_NOTIFY_URL", ""),
  notifyType: env("GROW_NOTIFY_TYPE", "generic"), // generic | feishu | dingtalk | bark
};

export const URLS = {
  grow: "https://grow.developer.huaweicloud.com/",
  api: "https://grow-dataset.developer.huaweicloud.com/api",
  devspace: "https://hands-on-agent.developer.huaweicloud.com/#tasks",
  harmony: "https://harmonybp.developer.huaweicloud.com/#practice-tasks",
  /**
   * 登录地址必须带 service 参数回跳成长中心。
   * 直接开 auth.huaweicloud.com 而不带 service，登录完会落到控制台，
   * 成长中心需要的 SSO ticket 换不到，回来仍然是「未登录」。
   */
  login: `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(
    "https://grow.developer.huaweicloud.com",
  )}&locale=zh-cn`,
};

export function ensureDataDir() {
  mkdirSync(config.dataDir, { recursive: true });
}
