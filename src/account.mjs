/**
 * 统一账号配置：所有凭据只放在 data/account.json 一个文件里。
 *
 *   {
 *     "huawei":  { "account": "手机号/邮箱", "password": "登录密码" },
 *     "mail":    { "host": "smtp.qq.com", "port": 465, "user": "you@example.com",
 *                  "pass": "邮箱授权码", "to": "you@example.com", "from": "you@example.com" },
 *     "gitcode": { "token": "xxxxxxxx", "username": "your-gitcode-name" }
 *   }
 *
 * 环境变量（GROW_GITCODE_TOKEN / GROW_ACCOUNT / GROW_PASSWORD）优先于文件。
 */
import { existsSync, readFileSync } from "node:fs";
import { config } from "./config.mjs";

let cache = null;
let cachedPath = "";

/** 读 account.json（整个文件）；不存在或解析失败按空对象处理 */
export function readAccount() {
  if (cache && cachedPath === config.accountFile) return cache;
  cachedPath = config.accountFile;
  try {
    cache = existsSync(config.accountFile) ? JSON.parse(readFileSync(config.accountFile, "utf8")) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** 取某一段（mail / gitcode / huawei），没有或类型不对返回 null */
export function accountSection(name) {
  const s = readAccount()[name];
  return s && typeof s === "object" && !Array.isArray(s) ? s : null;
}
