# 机器人接口接受经成员同意的登录令牌（决定 194 第四条）

2026-11-24 所有者裁定在保持既有直连成员访问令牌可用的同时，允许标准 MCP OAuth 登录流程（授权码与设备码）在成员主动勾选同意后签出带 `bot` 范围的客户端令牌访问机器人私聊与附件接口，并在控制台标注与成员/管理员文档中说明。

## 可以改的路径

- `contracts/model.json`
- `contracts/src/tokens.ts`
- `contracts/generated/protocol-codes.ts`
- `contracts/generated/schemas/token-issuance.v1.schema.json`
- `contracts/generated/vocabulary.ts`
- `hub/records/api.ts`
- `hub/records/configuration-authentication.ts`
- `hub/records/migrations.ts`
- `hub/records/principals.ts`
- `hub/records/member-batches.test.ts`
- `hub/records/migration-v2-upgrade.test.ts`
- `hub/records/migrations.snapshot.test.ts`
- `hub/server/access-auth.ts`
- `hub/server/access-auth.test.ts`
- `hub/server/bot-files.ts`
- `hub/server/bot-files.test.ts`
- `hub/server/oauth.ts`
- `hub/server/personal-bot.ts`
- `hub/server/personal-bot.test.ts`
- `hub/server/standard-authorization.test.ts`
- `hub/server/console/authorize-page.ts`
- `hub/server/console/authorize.ts`
- `hub/server/console/circles.ts`
- `hub/server/console/connections.ts`
- `hub/server/console.test.ts`
- `docs/admin-guide.md`
- `docs/compatibility.md`
- `docs/compatibility.en.md`
- `docs/member-guide.md`
- `docs/hub-r4-tasks/bot-consent.md`
- `.github/checks/doc-set.json`

## 变更要点

- 模型第 90 版与词表轴 `token_scope`（`bot`：`允许使用机器人`）；`token-issuance@1` 新增可选字段 `scope`（仅在授予 `bot` 时写入，保证既有 `contract-schema-freeze` 向后兼容）。
- 增量迁移 `3`（`token_scope`）在 `public.tokens` 上新增 `scope text[] NOT NULL DEFAULT '{}'`，约束只允许 `'bot'`（保留迁移 1、2 不动）。
- `/.well-known/oauth-protected-resource*` 与 `/.well-known/oauth-authorization-server` 宣告 `scopes_supported: ['bot']`；授权与设备码端点识别空格分隔的 `scope` 中的 `bot` 并忽略其余值。
- 授权确认页仅在请求包含 `bot` 时显示默认未勾选的「允许这个客户端使用我的机器人」（同意之后这个客户端可以读写当前账号和机器人的私聊与附件）；未请求 `bot` 时确认页 HTML 保持不变，未勾选直接点允许仍可签出仅用于 `/mcp` 与 `/local-tools/*` 的令牌。
- `POST /api/bot/v1` 与 `GET`/`PUT /api/bot/v1/files/<sha256>` 接受直连成员令牌（`client_id === null`）或 `scope` 含 `'bot'` 的 OAuth 令牌；否则返回 `403 BOT_CLIENT_FORBIDDEN` 及响应头 `WWW-Authenticate: Bearer error="insufficient_scope", scope="bot"`。
- 控制台在 `/console/team?tab=clients` 与 `/console/connections` 标注 `允许使用机器人` / `仅 MCP 工具`，撤销仍使对应令牌的全部入口立即失效。
