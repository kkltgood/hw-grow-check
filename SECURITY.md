# 安全说明

## 不要提交的东西

以下文件都在 `.gitignore` 里，提交前请再确认一次：

| 文件 | 内容 |
|---|---|
| `data/account.json` | 统一账号配置：SMTP 授权码、GitCode 令牌、可选华为云密码 |
| `data/auth.json` | 华为云登录 Cookie，等同于账号会话 |
| `data/auth.b64` | 登录态 base64，导入导出时生成 |
| `data/login-qr.png` | 登录二维码截图 |
| `data/state.json`、`data/points-history.json` | 执行结果与积分历史 |
| `data/star-case.json`、`data/star-weekly.json` | Star 池统计与待结算记录 |
| `data/alert-state.json` | 告警节流状态 |

## 泄露后的处理

- **Cookie**：在华为云控制台退出所有会话，重新登录生成新的 `auth.json`。
- **SMTP 授权码**：到邮箱设置里作废并重新生成。
- **GitCode 令牌**：到 GitCode「个人设置 → 访问令牌」撤销并重新生成。
- **账号密码**：立即改密，并检查登录记录。

## 报告问题

如果发现代码中存在凭据泄露、命令注入或其他安全问题，请开一个 Issue（不要贴真实凭据），或通过仓库主页留的联系方式私下告知。
