# 没有配置机器人的部署不显示 `bot` 同意框（决定 197 第二条）

2026-11-24 所有者决定：只有部署配置并启用了机器人模型（复用 `POST /api/bot/v1` 的 `readBotProfile` 判断，读取失败按未启用处理）时，才在两份 OAuth 元数据公布 `scopes_supported: ["bot"]`、才在授权确认页显示「允许这个客户端使用我的机器人」、且在成员点击允许的那一刻按当前启用状态决定是否把 `bot` 写入令牌；未配置或停用机器人时不公布 `scopes_supported`（RFC 8414 §3.2 / RFC 9728 §3.2）并在成员请求 `bot` 时按 RFC 6749 §5.1 返回 `"scope": ""`，成员私人机器人接口（`POST /api/bot/v1` 全操作含读完请求体后的 `canAccessBot(renewed)` 复核及 `GET`/`PUT /api/bot/v1/files/<sha256>`）对携带 `client_id` 且 scope 不含 `bot` 的访问令牌在未启用时返回 `503 BOT_DISABLED`（沿用各自原有事实与下一步，不带 `insufficient_scope`）、启用后返回 `403 BOT_CLIENT_FORBIDDEN` 并带 `insufficient_scope` 与 `scope="bot"`，已签发的 `bot` 令牌在停用期间保持不变并在重新启用后恢复可用。模型第 91 版（R01 加一条变更说明），词表不变。

## 可以改的路径

- `.github/checks/doc-set.json`
- `CHANGELOG.md`
- `contracts/README.md`
- `contracts/generated/protocol-codes.ts`
- `contracts/model.json`
- `docs/admin-guide.md`
- `docs/compatibility.en.md`
- `docs/compatibility.md`
- `docs/hub-r4-tasks/bot-scope-gating.md`
- `hub/server/README.md`
- `hub/server/access-auth.test.ts`
- `hub/server/access-auth.ts`
- `hub/server/app.ts`
- `hub/server/bot-files.test.ts`
- `hub/server/bot-files.ts`
- `hub/server/console/authorize-page.ts`
- `hub/server/console/authorize.ts`
- `hub/server/oauth.ts`
- `hub/server/personal-bot.test.ts`
- `hub/server/personal-bot.ts`
- `hub/server/standard-authorization.test.ts`

## 变更要点

- 在 [hub/server/personal-bot.ts](https://github.com/circle-platforms/circle-hub/blob/main/hub/server/personal-bot.ts) 导出 `isBotEnabled(vault)`，直接复用 `readBotProfile(vault)`（密钥库缺失或读取/解析异常时用 `catch { return false; }` 返回 `false`）。
- [hub/server/app.ts](https://github.com/circle-platforms/circle-hub/blob/main/hub/server/app.ts) 向 `oauthOptions` 与 `handleBotFile` 传入 `() => isBotEnabled(deps.records?.vault)`；[hub/server/oauth.ts](https://github.com/circle-platforms/circle-hub/blob/main/hub/server/oauth.ts) 仅在 `botEnabled` 为 `true` 时于 `/.well-known/oauth-protected-resource*` 与 `/.well-known/oauth-authorization-server` 输出 `scopes_supported: [...TOKEN_SCOPE]`，未启用时按 RFC 8414 §3.2 与 RFC 9728 §3.2 省略该字段。
- [hub/server/access-auth.ts](https://github.com/circle-platforms/circle-hub/blob/main/hub/server/access-auth.ts)、[hub/server/personal-bot.ts](https://github.com/circle-platforms/circle-hub/blob/main/hub/server/personal-bot.ts) 与 [hub/server/bot-files.ts](https://github.com/circle-platforms/circle-hub/blob/main/hub/server/bot-files.ts) 在机器人未启用时对含 `client_id` 且 scope 不含 `bot` 的访问令牌返回各接口原有的 `503 BOT_DISABLED`（不含 `insufficient_scope`），启用后照常返回 `403 BOT_CLIENT_FORBIDDEN` 与 `WWW-Authenticate: Bearer error="insufficient_scope", scope="bot"`。
- [hub/server/console/authorize.ts](https://github.com/circle-platforms/circle-hub/blob/main/hub/server/console/authorize.ts) 与 [hub/server/console/authorize-page.ts](https://github.com/circle-platforms/circle-hub/blob/main/hub/server/console/authorize-page.ts) 仅在渲染确认页时 `isBotEnabled` 为真且请求包含 `bot` 时显示默认未勾选的同意框；在提交 `approve` 的那一刻重新检查 `isBotEnabled`，未启用时忽略勾选与 `bot` 范围。
- 更新 [contracts/model.json](https://github.com/circle-platforms/circle-hub/blob/main/contracts/model.json) 到第 91 版（`R01.changes91`）并运行 `npm run gen:contracts` 重新生成 [contracts/generated/protocol-codes.ts](https://github.com/circle-platforms/circle-hub/blob/main/contracts/generated/protocol-codes.ts)；同步更新 [CHANGELOG.md](https://github.com/circle-platforms/circle-hub/blob/main/CHANGELOG.md)、[contracts/README.md](https://github.com/circle-platforms/circle-hub/blob/main/contracts/README.md)、管理员手册、两份兼容页与 `hub/server/README.md`，并在 `access-auth.test.ts`、`bot-files.test.ts`、`standard-authorization.test.ts` 与 `personal-bot.test.ts` 补齐全部状态与状态切换回归测试。
