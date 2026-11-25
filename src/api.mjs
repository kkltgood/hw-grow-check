/**
 * 成长中心接口封装。
 *
 * 接口域名：grow-dataset.developer.huaweicloud.com/api
 * 统一响应包 { code, message, data }，code=0 才是成功，401 表示未登录。
 * 网关会拦截非浏览器请求，所以接口调用必须跑在真实页面上下文里。
 */
import { URLS } from "./config.mjs";

const TRACKING = /ugasdk|uga-cdp|hm\.baidu|cn\.miaozhen|pangu-chat-client/;

// 只读 DOM 文本，图片/字体/视频一律不下载：省内存也省流量
const SKIP_TYPES = new Set(["image", "media", "font"]);

export async function openApiPage(context) {
  const page = await context.newPage();
  await page.route("**/*", (route) => {
    const req = route.request();
    if (TRACKING.test(req.url()) || SKIP_TYPES.has(req.resourceType())) return route.abort();
    return route.continue();
  });
  await page.goto(URLS.grow, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
  return page;
}

/** 在页面上下文里发请求，cookie 自动带上 */
async function rawCall(page, method, path, body) {
  return page.evaluate(
    async ({ method, url, body }) => {
      const headers = { accept: "application/json, text/plain, */*" };
      if (body !== undefined) headers["content-type"] = "application/json";
      try {
        const res = await fetch(url, {
          method,
          credentials: "include",
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, text: await res.text() };
      } catch (e) {
        return { status: 0, text: `network error: ${String(e)}` };
      }
    },
    { method, url: URLS.api + path, body },
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null; // 网关错误页 / 空响应
  }
}

/**
 * 把响应归成几类，调用方只关心语义：
 *   ok         code=0
 *   not-login  401，或 code=10001
 *   api-error  业务码非 0（余额不足、未实名等，带 message）
 *   bad-json   2xx 但不是 JSON（多半是网关错误页）
 *   http-xxx   其他状态码
 *   network    请求没发出去
 */
function classify(status, json) {
  if (status === 0) return "network";
  if (status === 401) return "not-login";
  if (status >= 200 && status < 300) {
    if (!json) return "bad-json";
    if (json.code === 0) return "ok";
    if (json.code === 10001) return "not-login";
    return "api-error";
  }
  return `http-${status}`;
}

/** 发一次请求；网络抖动 / 5xx 重试 2 次，业务错误不重试 */
export async function call(page, method, path, body) {
  let res = await rawCall(page, method, path, body);
  let json = parseJson(res.text);
  let kind = classify(res.status, json);

  for (let i = 0; i < 2 && (kind === "network" || kind.startsWith("http-5")); i++) {
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    res = await rawCall(page, method, path, body);
    json = parseJson(res.text);
    kind = classify(res.status, json);
  }
  return { status: res.status, json, text: res.text, kind };
}

const P = {
  info: "/v1/hdgrowservice/user/info",
  tasks: "/v1/hdgrowservice/user/tasks",
  sign: "/v1/hdgrowservice/user/sign-in",
  pointsDetail: "/v1/hdgrowservice/user/points/detail",
};

/** 签到任务在新版任务列表里用 task_tag 标识，比标题匹配稳 */
const SIGN_TAG = "daily_login";
const isSignTask = (t) => t.task_tag === SIGN_TAG || /签到/.test(t.title || "");

/** 拉一次用户任务列表（含完成状态）。show=true 与官网页面一致：只列当前展示中的任务 */
export async function getUserTasks(page, { pageSize = 100 } = {}) {
  const res = await call(page, "POST", P.tasks, { show: true, page_no: 1, page_size: pageSize });
  if (res.kind === "not-login") return { error: "not-login", missions: [] };
  if (res.kind !== "ok") {
    return {
      error: res.kind === "api-error" ? `任务接口返回 ${res.json?.code} ${res.json?.message || ""}` : `任务接口异常（${res.kind}）`,
      transient: res.kind !== "api-error",
      missions: [],
    };
  }
  const list = res.json?.data?.records;
  if (!Array.isArray(list)) return { error: "任务接口返回结构异常", transient: true, missions: [] };
  return {
    total: res.json.data.total ?? list.length,
    missions: list.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      bonus: t.points,
      cycle: t.cycle_type,
      url: t.url,
      done: t.is_finish === true,
      completedTimes: t.completed_times,
      limit: t.task_limit,
      tag: t.task_tag,
      guide: t.guide,
    })),
  };
}

/**
 * 签到状态。
 * 新版没有「连续签到天数」字段，只有任务是否完成 + 完成次数；
 * 连续天数另外用 getSignStreak() 从积分明细里算。
 */
export async function getSignStatus(page) {
  const r = await getUserTasks(page);
  if (r.error) return { error: r.error, transient: r.transient };
  const t = r.missions.find(isSignTask);
  if (!t) return { error: "任务列表里找不到签到任务", transient: true };
  return {
    signedToday: t.done,
    completedTimes: t.completedTimes ?? 0,
    bonusPerDay: t.bonus,
    taskId: t.id,
  };
}

/**
 * 执行签到。
 * 接口幂等：已签到再调一次返回 points=0、signed=true，不是错误。
 */
export async function doSign(page) {
  const { json, kind } = await call(page, "POST", P.sign);
  if (kind === "not-login") return { ok: false, loginExpired: true, detail: "登录态失效" };
  if (kind !== "ok") {
    const msg = json?.message ? `（${json.code} ${json.message}）` : "";
    return { ok: false, detail: `签到接口异常（${kind}）${msg}` };
  }
  const d = json.data || {};
  if (d.signed === false) {
    return { ok: false, detail: `签到未生效${json.message ? `：${json.message}` : ""}` };
  }
  return {
    ok: true,
    already: !(d.points > 0),
    gained: Number(d.points) || 0,
    total: typeof d.total_points === "number" ? d.total_points : null,
    detail: d.points > 0 ? "签到成功" : "今日已签到",
  };
}

/**
 * 当前积分（接口直读，不需要重载页面）
 */
export async function getPoints(page) {
  const { json, kind } = await call(page, "GET", P.info);
  if (kind !== "ok") return null;
  const v = json?.data?.total_points;
  return typeof v === "number" ? v : null;
}

/** 连续签到天数：数积分明细里「每日签到」的记录，从今天往前数 */
export async function getSignStreak(page, { lookback = 120 } = {}) {
  const res = await call(page, "GET", `${P.pointsDetail}?page_no=1&page_size=${lookback}`);
  if (res.kind !== "ok") return null;
  const list = res.json?.data?.records;
  if (!Array.isArray(list)) return null;

  const days = new Set();
  for (const r of list) {
    if (!/签到/.test(r.source || "")) continue;
    if (!r.created_at) continue;
    days.add(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(r.created_at)),
    );
  }
  if (!days.size) return null;

  // 从今天往前数，遇到断档就停
  let streak = 0;
  for (let i = 0; i < lookback; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d);
    if (!days.has(key)) break;
    streak++;
  }
  return streak || null;
}

export async function getProfile(page) {
  const { json, kind } = await call(page, "GET", P.info);
  if (kind !== "ok" || !json?.data) return null;
  const d = json.data;
  return { alias: d.iam_name || d.domain_name, name: d.domain_name, userId: d.iam_id };
}

/**
 * 判定登录态。区分三态，别把「接口抽风」当成「登录过期」：
 *   ok: true   确定已登录
 *   ok: false  确定未登录（需要重新 login）
 *   ok: null   无法判断（网络 / 网关 / 5xx），调用方自行决定
 *
 * 2026-11 实测：新版网关会「整段」把正常会话判成 401 —— /user/tasks 和
 * /user/info 同时 401，过一分钟同样 cookie 又全好。这种抖动下，一次 401
 * 完全不足以判定失效，所以这里做三件事：
 *   1. 401 必须双接口交叉确认；
 *   2. 重试间隔拉到 4 秒、最多 4 轮；
 *   3. 第二轮仍失败就 reload 页面，换一个网关节点再试。
 * 只有全部轮次都明确未登录，才返回 ok:false。
 */
export async function checkLogin(page, { attempts = 4, delayMs = 4000 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const status = await getSignStatus(page).catch((e) => ({
      error: String(e).slice(0, 120),
      transient: true,
    }));
    if (!status.error) return { ok: true, sign: status };
    last = status;

    if (status.error === "not-login") {
      const info = await call(page, "GET", P.info).catch(() => null);
      if (info?.kind === "ok" && info.json?.data) {
        // 任务接口说未登录、用户信息却拿得到：说明是接口抽风，会话其实还在。
        // 此时 sign 置空，由调用方改用幂等的 sign-in 接口兜底。
        return { ok: true, sign: null, crossChecked: true };
      }
      if (info?.kind !== "not-login" && info?.kind !== "ok") {
        // 用户信息接口也给不出明确答复，只能算无法判断
        last = { error: `登录态无法确认（${info?.kind ?? "network"}）`, transient: true };
      }
    }

    if (i < attempts - 1) {
      // 第二轮还没成，换页面再试：网关按节点路由，重新加载常常就绕开了
      if (i === 1) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2500);
      } else {
        await page.waitForTimeout(delayMs);
      }
    }
  }
  if (last?.error === "not-login") return { ok: false, reason: "not-login", sign: last };
  return { ok: null, reason: last?.error || "unknown", sign: last };
}

export async function closePage(page) {
  await page.close().catch(() => {});
}
