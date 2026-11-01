# 任务：MCP 标准授权、邀请码、一次性登录链接、实时更新与写接口

依据：

- 所有者 2026-11-01 合并 #118 后选择“全部按文档假设确认，开始实现”：《circle-hub 控制台前端：模块与接口》末尾的 7 条待定事项全部按文档的假设定下（文档第 16 版已勾选）：
  1. 授权页的身份确认采用邀请码与一次性登录链接，不设密码；
  2. 一次性登录链接 5 分钟内有效，授权请求 10 分钟内有效；
  3. 断开 Circle、停用成员在 Circle 中执行；管理员的 Circle 不可用时，在 Hub 所在主机上执行同一命令；
  4. 知识导入完成后自动发布为当前版本；
  5. 任务包暂存通过发布校验后，由“发布”一步转为当前版本；
  6. 成员在“记录”页只看到与本人相关的记录；
  7. 前端不引入构建步骤。
- 2026-11-01 的目标“按照 hub 最新 PR 和主线代码将后端接入前端”；决定 77 与任务页 [`console-frontend.md`](console-frontend.md)。

做法：Hub 自己同时是受保护资源 `/mcp` 和它的授权服务器，按 MCP 授权规范（OAuth 2.1、PKCE、RFC 8414、7591、8707、9728、7009、9207）实现，不加依赖；授权页、登录链接和写接口都沿用控制台的会话、来源检查和 CSRF；页面仍由服务端渲染，实时更新只在登录后的页面加一段按哈希放行的脚本。

- 分支和工作树：`console-auth`（目录 `circle-hub-console`），另开 `console-live`（`circle-hub-live`）做实时更新、`console-pack-stage`（`circle-hub-pack-stage`）做任务包两步发布，都从 main（88483d9，#118 合并后）开出，完成后合进 `console-auth`。
- 可以改的路径：
  - `hub/records/migrations.ts`（追加迁移 7）及其快照测试，`hub/records/principals.ts`、`hub/records/api.ts`，新测试 `hub/records/standard-authorization.test.ts`；`hub/platform/ownership.test.ts` 里新表的列；
  - `hub/server/oauth.ts`（新）、`hub/server/app.ts`、`hub/server/mcp.ts`、`hub/server/cli.ts`、`hub/server/cli-admin.ts`（`pack publish --dry-run`）、`hub/server/console/**` 及对应测试；
  - `hub/runs/packs/registry.ts`、`hub/runs/packs/types.ts`、`hub/runs/packs/changes.ts`（新）、`hub/runs/api.ts` 和 `hub/runs/packs/publish-check.test.ts`（新）：发布校验的试运行；
  - `hub/server/README.md`、`hub/records/README.md`、`docs/hub-r4-progress.md`、`CHANGELOG.md` 和本页。

  别的路径不动。不加依赖。
- 规则：推送和建 PR 按所有者 2026-11-01 的选择（推送并建 PR，由所有者合并）；不发布、不部署；不碰 7420、7443、默认数据根、钥匙串和环境配置文件；测试只用合成数据（地址 192.0.2.0/24）；`git commit -s`，只暂存点名的路径。界面文字只陈述事实，不用“你、他”，进行中的状态写作“等待××中”，状态用规范术语。
- 验证：`npm run typecheck`、`npm run verify:contracts`、`npm run test:unit`、`npm run test:docs`、`npm run test:acceptance`、`npm run verify:references`、`npm run test:references`；跳过的测试照实列出。

## 做了的

1. **存储（迁移 7 `standard_authorization`）**：`oauth_clients`（客户端自己登记的名字和回调地址）、`invitations`（邀请码只存 SHA-256，24 小时内有效，仅可使用一次，记下签发人、使用时间和用它授权的客户端）、`tokens.client_id`（经标准授权签发的令牌属于哪个客户端）。运行角色对新表只有 `SELECT, INSERT`，邀请码表另有 `UPDATE (used_at, used_by_client)`。客户端登记 10 分钟内最多 100 个。
2. **命令行**：`circle-hub user invite <用户>` 签发邀请码（只显示这一次）；`circle-hub pack publish <目录> [--stage] --dry-run` 跑完发布的全部检查而不写入任何内容。
3. **标准授权**（`hub/server/oauth.ts`）：
   - `/mcp` 未认证时的 401 带 `resource_metadata`（RFC 9728），令牌无效时另带 `error="invalid_token"`；
   - `GET /.well-known/oauth-protected-resource[/mcp]`、`GET /.well-known/oauth-authorization-server`：资源是本 Hub 的 `/mcp`，授权服务器就是本 Hub；
   - `POST /oauth/register`：只接受公开客户端（`none`），回调地址只能是 https、本机回环地址上的 http（端口不限，RFC 8252）或私有协议；
   - `GET /oauth/authorize`：要求 PKCE S256，`resource` 必须是本 Hub 的 `/mcp`；校验通过后转到控制台的授权页；
   - `POST /oauth/token`：授权码一次性、2 分钟内有效，绑定客户端、回调地址、资源与 PKCE；再次出示时拒绝并吊销它换出的令牌；换出的是普通的 Hub 令牌，标签为客户端的名字；
   - `POST /oauth/revoke`：持有者凭令牌值吊销。
4. **授权页**（`/console/authorize/<请求>`）：授权请求 10 分钟内有效；没有控制台会话时先验证邀请码，已登录时以登录的账号确认，也可改用邀请码；页面始终写明以哪个账号授权哪个客户端、回调到哪里；同一请求连续 5 次邀请码不对即结束；不设密码。
5. **一次性登录链接**：客户端以自己的令牌 `POST /console/api/login-links`（可带 `next`）取得链接，5 分钟内有效、仅可使用一次；浏览器打开后先显示以哪个账号登录，确认后建立以该令牌为凭据的会话，并转到 `next`；链接失效时不显示账号。未登录时打开任一页面，登录后回到该页面。
6. **添加成员**：默认签发邀请码，结果页给出不带令牌的 Circle 配置；客户端不支持标准授权时选“访问令牌”。设置页的“连接新的 Circle”给出标准授权的配置，成员行可生成“签发邀请码”的命令；已连接的 Circle 标出连接方式。
7. **任务包两步发布**：上传的 zip 先经 `--dry-run` 校验并暂存（30 分钟，最多 10 个，只在内存中），结果页列出各项校验结果和与当前版本的差异，再由“发布”一步转为当前版本；只有暂存的管理员能发布或放弃，过期或他人的暂存号得到中性回答。
8. **写接口**：`POST /console/api/members`、`/systems`、`/knowledge/imports`、`/packs/stage`、`/packs/stage/<编号>/publish|discard` 执行与表单相同的命令；`/commands` 只返回命令，不执行。需要管理员会话、本控制台的 Origin 和请求头 `X-CSRF-Token`。
9. **实时更新**：见“实时更新”一节。
10. **第 4 条**：知识同步本来就在完成后按比较并交换把每条涉及的版本线的当前根移到最新构建（`hub/knowledge/sync.ts`），控制台不再另做。**第 3、6 条**：命令对话框补写“管理员的 Circle 不可用时，在 Hub 所在的主机上执行同一命令”；成员的记录页本来只列本人的调用。

## 实时更新

（实时更新分支合并后补写。）

## 与接口文档的出入

- **记录类型**：文档写“验证邀请码、授权、令牌签发与吊销都写入记录，记录类型沿用「令牌签发」”。合约里没有这一记录类型；令牌的签发与吊销一直记在可变的令牌表（签发人、时间、吊销人）里，不写记录。实现照此：邀请码、客户端和令牌的客户端都在可变存储里，不新造记录类型。要写成记录，需要合约所有者增加记录类型。
- **令牌不过期，不发刷新令牌**：Hub 的令牌每次请求都对照存储核验，吊销立即生效；断开 Circle 就是吊销它的令牌。
- **验证邀请码**：文档写 `POST /console/api/invitations/verify`；邀请码只在授权请求里使用，实现为授权页上的表单。
- **一次性登录链接**：GET 只显示以哪个账号登录，确认后（POST）才建立会话，链接预取或他人投放的链接不会替人登录。
- **“完成”“已拒绝”**：授权或拒绝后浏览器立即转到客户端的回调地址，由客户端显示结果；浏览器回到授权页时显示已授权或已拒绝。
- **访问令牌登录未限为管理员**：Circle 还不能获取一次性登录链接，现在限制会让成员无法登录控制台。
- **测试连接**（`/systems/test`）、`/search`、被引用次数等文档中标为“需新增”的数据不在本件。
- **Circle 端**：Circle 基线（`foundation/circle`）的 MCP 客户端没有 OAuth，也不会请求一次性登录链接；这两项要在 Circle 仓库里做通用的 MCP 客户端改进，需所有者授权，不在本件。在此之前 Circle 以访问令牌连接（添加成员时选“访问令牌”）；任何支持 MCP 标准授权的客户端现在即可用邀请码连接。

## 验证

（全部合并后补写。）
