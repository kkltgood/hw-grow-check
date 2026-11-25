/**
 * GitCode OpenAPI v5 的最小封装：查已 Star 列表、Star 仓库、拉鸿蒙案例仓池。
 *
 * 认证：PRIVATE-TOKEN 头（也支持 Authorization: Bearer / access_token）
 * 文档：https://docs.gitcode.com/docs/apis
 *
 * 令牌从 data/account.json 的 gitcode 段读（和邮箱配置放在一起）：
 *   "gitcode": { "token": "xxxxxxxx", "username": "your-gitcode-name" }
 * 也可以只设环境变量 GROW_GITCODE_TOKEN。
 */
import { accountSection } from "./account.mjs";

const API = "https://api.gitcode.com/api/v5";
const CASES_API = "https://harmonybp.developer.huaweicloud.com/api/cases";
const UA = "hw-grow-check/1.0 (+https://gitcode.com)";

export function readGitcodeConfig() {
  const file = accountSection("gitcode") || {};
  const token = process.env.GROW_GITCODE_TOKEN || file.token || "";
  if (!token) return null;
  return {
    token: String(token).trim(),
    username: String(file.username || "").trim(),
  };
}

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "PRIVATE-TOKEN": token,
      accept: "application/json",
      "user-agent": UA,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 错误页 */
  }
  return { status: res.status, ok: res.ok, json, text };
}

/** 读取当前令牌对应的 GitCode 账号 */
export async function getGitcodeUser(token) {
  const r = await api(token, "GET", "/user");
  if (!r.ok) throw new Error(`GET /user 失败：HTTP ${r.status} ${r.json?.message || r.text.slice(0, 120)}`);
  return r.json;
}

function repoFullName(repo) {
  if (!repo) return "";
  if (repo.full_name) return String(repo.full_name);
  const owner = repo.owner?.login || repo.owner?.username || repo.namespace?.path;
  const name = repo.name || repo.path;
  return owner && name ? `${owner}/${name}` : "";
}

/**
 * 列出当前账号 Star 过的全部仓库。
 * 必须翻页，否则 Star 多了以后会把「已 Star」误判成「没 Star」。
 */
export async function listStarredRepos(token, { maxPages = 50 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await api(token, "GET", `/user/starred?per_page=100&page=${page}`);
    if (!r.ok) {
      throw new Error(`GET /user/starred 失败：HTTP ${r.status} ${r.json?.message || r.text.slice(0, 120)}`);
    }
    const list = Array.isArray(r.json) ? r.json : Array.isArray(r.json?.data) ? r.json.data : [];
    all.push(...list);
    // 不要用「本页不足 100 条」判断结束：服务端可能把 per_page 压得更小。
    // 一直翻到空页为止，宁可多一次请求，也不能漏掉已 Star 的仓库。
    if (!list.length) break;
  }
  return [...new Set(all.map(repoFullName).filter(Boolean))];
}

/** Star 一个仓库；接口是 POST /repos/{owner}/{repo}/star，不是 PUT /user/starred */
export async function starRepo(token, fullName) {
  const [owner, repo] = String(fullName).split("/");
  if (!owner || !repo) throw new Error(`仓库名不合法：${fullName}`);
  return api(token, "POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/star`);
}

/** 把 https://gitcode.com/owner/repo.git 归一成 owner/repo */
export function parseRepoUrl(url) {
  const s = String(url || "").trim();
  const m = s.match(/gitcode\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!m) return "";
  return `${m[1]}/${m[2].replace(/\.git$/i, "")}`;
}

/**
 * 拉 Agent 开发实践中心的仓库池（GitCode 组织 agent-best-practices）。
 * 需要令牌；full_name 是中文展示名，拼路径要用 namespace.path + path。
 */
export async function fetchPracticeRepos(token, { pageSize = 100, maxPages = 10 } = {}) {
  const all = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const r = await api(token, "GET", `/orgs/agent-best-practices/repos?per_page=${pageSize}&page=${page}`);
    if (!r.ok) throw new Error(`实践中心仓库列表异常：HTTP ${r.status} ${r.json?.message || ""}`);
    const list = Array.isArray(r.json) ? r.json : [];
    for (const repo of list) {
      const full = repo.namespace?.path && repo.path ? `${repo.namespace.path}/${repo.path}` : repoFullName(repo);
      if (full && !all.has(full.toLowerCase())) {
        all.set(full.toLowerCase(), { fullName: full, title: repo.description || repo.name || "" });
      }
    }
    if (list.length < pageSize) break;
  }
  return [...all.values()];
}

/**
 * 拉鸿蒙实践中心的案例仓池。
 * 案例接口是公开的，不需要登录；只保留能解析出 owner/repo 的条目。
 */
export async function fetchCaseRepos({ pageSize = 50, maxPages = 20 } = {}) {
  const seen = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const url = `${CASES_API}?page=${page}&page_size=${pageSize}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`案例列表接口异常：HTTP ${res.status}`);
    const json = await res.json();
    const list = json.cases || [];
    for (const c of list) {
      const full = parseRepoUrl(c.publicRepo);
      if (full && !seen.has(full.toLowerCase())) {
        seen.set(full.toLowerCase(), { fullName: full, title: c.title || "" });
      }
    }
    if (list.length < pageSize) break;
  }
  return [...seen.values()];
}
