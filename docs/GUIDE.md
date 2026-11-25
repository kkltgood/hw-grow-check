# hw-grow-check 详细说明

本文是 [hw-grow-check](../README.md) 的详细说明，覆盖华为云开发者成长中心自动签到的账号配置、结果邮件、GitCode 令牌、全部命令与环境变量、数据隐私和常见问题。

## 环境与安装

- Node.js >= 18
- Playwright 版 Chromium，或本机已安装的 Chrome（设置 `GROW_CHANNEL=chrome`）
- 能正常访问华为云；首次登录需要图形界面（扫码或账号密码）

```bash
git clone <你的仓库地址> hw-grow-check
cd hw-grow-check
npm install
npx playwright install chromium
```

国内网络下载 Chromium 慢时：

```bash
PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright npx playwright install chromium
```

没有图形界面的机器用 `node src/cli.mjs login --qr`：脚本把登录页截图存到 `data/login-qr.png`，扫完自动继续。

## 账号配置

邮件、GitCode、华为云账号的凭据统一放在 `data/account.json`，只写用到的段：

```json
{
  "mail":     { "host": "smtp.qq.com", "port": 465, "user": "you@example.com", "pass": "授权码", "to": "you@example.com" },
  "gitcode":  { "token": "xxxxxxxx", "username": "your-gitcode-name" },
  "huawei":   { "account": "手机号或邮箱", "password": "登录密码" }
}
```

```bash
chmod 600 data/account.json
```

- `mail`：结果邮件与失败告警，见「配置邮件」
- `gitcode`：两个 Star 任务，见「GitCode 令牌」
- `huawei`：可选。`run` 发现会话失效时会自动用账号密码登录一次；配好后也可以用 `node src/cli.mjs login --from-env` 完全跳过扫码

环境变量 `GROW_GITCODE_TOKEN`、`GROW_ACCOUNT`、`GROW_PASSWORD` 优先于文件。全部环境变量的默认值见 [`.env.example`](../.env.example)。

## 登录态

```bash
npm run login          # 弹出浏览器，扫码登录，登录态存到 data/auth.json
npm run status         # 确认能读到积分和任务
```

没有图形界面：

```bash
node src/cli.mjs login --qr
```

要在另一台机器上复用登录态：

```bash
npm run export-auth    # 生成 data/auth.b64
npm run import-auth    # 在目标机器导入
```

华为云会校验登录环境，异地复用 Cookie 有风控风险，能重新扫码就重新扫码。

> 登录态会较快失效。`scripts/daily.sh` 每次运行前都会先登录，正常情况下不需要手动处理。

## 结果邮件

`scripts/daily.sh` 把「登录 → 执行任务 → 发结果邮件」串成一次完整执行：

```bash
bash scripts/daily.sh              # 工作日：扫码登录 + 任务 + 发信
bash scripts/daily.sh --weekend    # 强制静默模式，用于测试或无人值守
```

退出码：`0` 成功 / `1` 扫码超时 / `2` 任务失败 / `3` 登录异常 / `4` 周末已发补签提醒。

邮件内容包括签到结果、积分变化、会话状态、近 7 天积分曲线，以及按「每日 / 每周 / 每月 / 一次性」分组的完整任务清单。效果见 [`mail-preview/`](mail-preview/)。

也可以单独发某一种结果：

```bash
node src/mail-result.mjs --ok
node src/mail-result.mjs --fail --code 3 --reason "登录态失效"
node src/mail-result.mjs --remind --reason "周末不弹扫码窗口"
node src/mail-result.mjs --ok --dry      # 只打印不发信
```

### 配置邮件

写在 `data/account.json` 的 `mail` 段：

```json
{
  "mail": {
    "host": "smtp.qq.com",
    "port": 465,
    "user": "you@example.com",
    "pass": "邮箱授权码，不是登录密码",
    "to": "you@example.com",
    "from": "you@example.com"
  }
}
```

`from` 只用来确定发件地址，**发件人显示名会按结果自动切换**：成功是「华为云签到成功」，周末补签提醒是「华为云签到提醒」，出问题才是「华为云签到告警」。如果 `from` 里写了名字，仅在没有指定结果类型时作为兜底。

QQ 邮箱的授权码：设置 → 账号 → 开启 POP3/SMTP 服务 → 生成授权码。

```bash
node src/cli.mjs test-notify   # 发一封测试邮件，确认链路
```

### Webhook

```bash
GROW_NOTIFY_URL="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx" \
GROW_NOTIFY_TYPE=feishu \
node src/cli.mjs run
```

支持 `generic` / `feishu` / `dingtalk` / `wecom` / `bark` / `serverchan`。

**告警节奏**（`src/alert-gate.mjs`）：会话真失效时首次立即发一封，之后 4 小时再发，再之后每 8 小时一次，直到登录恢复。登录成功后状态清零，节流状态存在 `data/alert-state.json`。

## GitCode 令牌

日任务「Star 一个鸿蒙案例代码仓」和周任务「每周 Star 一个 Agent 开发实践中心代码仓」都走 GitCode OpenAPI，需要一枚个人访问令牌（不需要账号密码）：

1. 登录 [gitcode.com](https://gitcode.com)，右上角头像 → **个人设置** → **访问令牌** → **新建访问令牌**
2. 权限选 `api`（全量读写）最省事；只勾部分权限时，至少要有「项目读写 + 用户读取」，否则查 `/user` 或 Star 会返回 `403`。设置一个过期时间
3. 写入 `data/account.json` 的 `gitcode` 段：

```json
{
  "gitcode": {
    "token": "粘贴生成的令牌",
    "username": "your-gitcode-name"
  }
}
```

也可以用环境变量 `GROW_GITCODE_TOKEN`。

```bash
node src/cli.mjs gitcode-check   # 只读：验证令牌，查看两个池子各剩多少
```

两个仓库池：

| 任务 | 周期 | 池子来源 | 当前规模 |
|---|---|---|---|
| `star` | 每日 | 鸿蒙实践中心已发布案例的 `publicRepo` | 73 个 |
| `star-weekly` | 每周 | GitCode 组织 `agent-best-practices` 的公开仓 | 32 个（排除组织介绍 `Readme` 后 31 个可选） |

保护逻辑（日/周相同，只是去重周期不同）：

- 任务本周期已完成 → 直接跳过
- 本周期已经 Star 过一个、但成长中心还没结算 → **不会再 Star 第二个仓**
- 池子全部 Star 过 → 不发任何请求，成功邮件里单独提醒「池子空了」
- 只做「加 Star」，从不取消；同一个仓不会重复 Star
- 令牌账号与 `username` 不一致时拒绝执行，避免把 Star 记到别的账号上

> 案例池来自 `harmonybp.developer.huaweicloud.com/api/cases` 的**已发布案例**。该组织下另有 3 个非案例仓（组织介绍、一个未挂案例的模板、skills 集合），Star 了也不算任务，所以不纳入池子。官方上新案例后，下一次运行会自动把新仓加进来。

> 令牌等同于账号的 API 权限，`data/account.json` 必须 600，不要提交。泄露后到 GitCode「访问令牌」页面撤销即可。

## 命令

| 命令 | 说明 |
|---|---|
| `node src/cli.mjs login [--qr]` | 登录；`--qr` 走无头模式并输出二维码截图 |
| `node src/cli.mjs login --from-env` | 用账号密码登录，然后立即执行任务 |
| `node src/cli.mjs export-auth` | 导出登录态为 base64（`data/auth.b64`） |
| `node src/cli.mjs import-auth` | 从 `GROW_AUTH_B64` 或文件导入登录态 |
| `node src/cli.mjs run` | 执行启用的任务 |
| `node src/cli.mjs status` | 打印积分、签到状态、全部任务及完成情况 |
| `node src/cli.mjs doctor` | 环境自检（浏览器能否启动等） |
| `node src/cli.mjs gitcode-check` | 只读检查 GitCode 令牌与两个 Star 池的剩余量 |
| `node src/cli.mjs test-notify` | 发一条测试告警，验证 webhook / 邮件链路 |
| `node src/mail-result.mjs [--ok\|--fail\|--remind] [--dry]` | 发结果邮件 |

CLI 退出码：`0` 正常，`1` 异常，`2` 有任务失败，`3` 登录态失效。

## 环境变量

[`.env.example`](../.env.example) 是全部环境变量的默认值清单，可作为配置模板。项目不会自动读取 `.env`，需要时执行 `set -a; source .env; set +a`，或由调度器注入。

| 变量 | 默认 | 说明 |
|---|---|---|
| `GROW_TASKS` | `checkin,harmony,devspace,star,star-weekly` | 启用的任务，逗号分隔 |
| `GROW_DATA_DIR` | `./data` | 数据目录（登录态、状态、日志） |
| `GROW_AUTH_FILE` | `./data/auth.json` | 登录态文件 |
| `GROW_HEADLESS` | `true` | 无头模式；本机调试可设 `false` |
| `GROW_CHANNEL` | 空 | 填 `chrome` 复用系统 Chrome |
| `GROW_TIMEOUT_MS` | `120000` | 单个任务超时，超时按失败计入本次结果 |
| `GROW_RUN_AT` | `09:15` | 结果邮件文案里的执行时刻 |
| `GROW_NOTIFY_URL` | 空 | webhook 地址 |
| `GROW_NOTIFY_TYPE` | `generic` | `generic` / `feishu` / `dingtalk` / `wecom` / `bark` / `serverchan` |
| `GROW_ACCOUNT_FILE` | `./data/account.json` | 统一账号配置 |
| `GROW_GITCODE_TOKEN` | 空 | GitCode 令牌，优先级最高 |
| `GROW_ACCOUNT`、`GROW_PASSWORD` | 空 | 华为云账号密码，优先级最高 |
| `GROW_QUIET_MAIL` | 空 | 设为 `1` 时 `cli` 不发告警邮件，由 `daily.sh` 统一发 |
| `GROW_DAILY_CMD` | 自动生成 | 告警邮件里展示的补跑命令 |
| `GROW_MAIL_HTML_OUT` | 空 | 把结果邮件 HTML 落盘，调试版式用 |

## 数据与隐私

以下文件都在 `.gitignore` 中，**不要提交**：

| 路径 | 内容 |
|---|---|
| `data/account.json` | SMTP 授权码、GitCode 令牌、可选账号密码 |
| `data/auth.json` | 华为云登录 Cookie，等同于账号会话 |
| `data/auth.b64` | 登录态 base64，导入导出时生成 |
| `data/login-qr.png` | 登录二维码截图 |
| `data/state.json`、`data/points-history.json` | 当次执行结果与积分历史 |
| `data/star-case.json`、`data/star-weekly.json` | Star 池统计与待结算记录 |
| `data/alert-state.json` | 告警节流状态 |

第一次运行后建议确认权限：

```bash
chmod 700 data && chmod 600 data/*.json
```

如果曾经把上述文件提交过，仅删除文件不够——它们仍在 git 历史里，需要用 `git filter-repo` 或 BFG 清理，并立即更换 Cookie / 授权码 / token。详见 [SECURITY.md](../SECURITY.md)。

## 实现要点

这几个坑踩过之后才写通的，改代码时注意别踩回去：

1. **网关挡非浏览器请求**。拿同样的 Cookie 在 Node 里直接 `fetch` 会得到 401，必须跑在真实页面上下文里（页面里 `fetch` + `credentials: include`）。
2. **统一响应包 `{code, message, data}`**。`code=0` 才是成功；`code=10001` 与 HTTP 401 都表示未登录。`classify()` 负责把两者归一，登录判定是三态（已登录 / 未登录 / 无法判断），临时故障不会触发「请重新登录」。
3. **签到是幂等的**。已签到时 `POST /user/sign-in` 返回 `points=0, signed=true`，代码把它当「今日已签到」处理，重复执行不会报错、也不会多加积分。
4. **任务完成状态是布尔值**。`is_finish` 是 `true/false`，签到任务用 `task_tag=daily_login` 定位，比标题匹配稳。
5. **任务标题会带不带空格**。`体验 AI DevSpace` 和 `体验AI DevSpace` 都出现过，比较前统一去空白。
6. **积分走接口，不读 DOM**。`/user/info` 的 `total_points` 是权威值，签到后立刻就是新值。
7. **`/user/tasks` 要带 `show: true`**。不带这个参数会多出一个官网页面上不显示的隐藏任务，清单就和官网对不上。
8. **DevSpace 的完成信号是埋点，不是任务接口**。打开实践中心只发 `/api/track/visit`；点「前往AI DevSpace实践」才发 `/api/track/aishell_click`，后者返回 200 后服务端才会把 `ai_devspace_try` 标成完成。所以 `devspace` 任务必须真的点一次入口，不能只打开页面。
9. **GitCode 的 Star 接口是 `POST /repos/{owner}/{repo}/star`，不是 `PUT /user/starred/...`**。已 Star 列表是 `GET /user/starred?per_page=100&page=N`，必须翻页，否则 Star 多了会把「已 Star」误判成「没 Star」。认证用 `PRIVATE-TOKEN` 请求头。

## 目录结构

```
src/cli.mjs          CLI 入口（login / run / status / doctor / gitcode-check …）
src/api.mjs          接口层（REST 封装、错误归一）
src/browser.mjs      浏览器启动与登录态存取
src/config.mjs       环境变量配置
src/account.mjs      统一账号配置读取（account.json）
src/login-password.mjs  账号密码登录（会话失效时自动补登）
src/alert-gate.mjs   告警节奏控制（首次 / 4 小时 / 8 小时）
src/tasks/checkin.mjs       每日签到
src/tasks/harmony-view.mjs  浏览鸿蒙案例（停留计时）
src/tasks/devspace.mjs      体验 AI DevSpace（点入口 + 等埋点）
src/tasks/star-case.mjs     Star 鸿蒙案例仓（每日）
src/tasks/star-weekly.mjs   每周 Star 实践中心仓
src/star-runner.mjs         Star 类任务公共流程（查已 Star、选仓、去重）
src/gitcode.mjs      GitCode OpenAPI 封装（已 Star 列表 / Star / 两个仓库池）
src/mail.mjs         SMTP 发信
src/mail-ui.mjs      邮件版式零件
src/mail-result.mjs  结果邮件
src/chart.mjs        7 天积分曲线（无头浏览器渲染 PNG）
src/points-history.mjs  积分历史
src/notify.mjs       webhook 推送与失败告警
src/help.txt         `--help` 文本
scripts/daily.sh     登录 + 任务 + 结果邮件
docs/GUIDE.md        本文
docs/mail-preview/   结果邮件效果预览
data/                运行时数据（含登录 Cookie，勿提交）
```

## 常见问题

**`401` / `code=10001` / `登录态失效`**：会话过期。重新 `login`，或配好 `huawei` 段后用 `login --from-env`。`daily.sh` 每次运行前都会先登录，正常情况下不需要手动处理。

**`接口暂时不可用` / `登录态暂时无法确认`**：网关或网络抖动，不是登录过期。脚本会重试 3 次，仍不行时照常继续跑任务；如果 `status` 这样报，重跑一次即可。

**浏览器起不来**：`npx playwright install --with-deps chromium`。国内可设 `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright`。

**任务显示 `pending`**：不是报错。常见原因是 Star 已提交但成长中心外部校验还没同步（通常几分钟），或者仓库池已经空了、没配令牌。日志和结果邮件会写明具体原因。

**积分没到账**：签到积分是实时的；任务积分可能有延迟（部分任务 30 分钟内到账）。

**扫码超时**：默认等 10 分钟。无人值守时改用 `bash scripts/daily.sh --weekend`，或配好 `huawei` 段后直接 `node src/cli.mjs run`（会话失效会自动用密码登录）。

**Star 任务没执行**：先跑 `node src/cli.mjs gitcode-check`，确认令牌有效、池子里还有没 Star 的仓。

**没收到结果邮件**：用 `node src/cli.mjs test-notify` 验证链路；再确认 `mail` 段里的 `pass` 是授权码而不是登录密码。
