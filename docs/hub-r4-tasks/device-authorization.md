# 任务：MCP 标准授权加设备码（RFC 8628）

依据：

- 所有者 2026-11-09：Circle 桌面版连接 Hub 时，浏览器登录页没有打开（circle#470，修复在 circle#472）。所有者要求客户端和 GitHub 一样用设备码登录：客户端显示一次性码，用户在任意浏览器里输入并确认。这样就不依赖客户端自己打开浏览器，也不依赖跳回客户端的回调地址。
- 同一天所有者决定：Hub 端的改动在审查机上写，开拉取请求，不合并；合并和部署到所有者的持久部署由开发机做。
- 模型没有限定授权方式（`contracts/model.json` 里没有授权码、PKCE 或设备码的规定）。设备码是标准 OAuth，任何 MCP 客户端都可以用，不是 Hub 专用的界面，和 D06 R[1] 不冲突。

做法：沿用决定 125 的标准授权，不加依赖，不加迁移。

- `/oauth/device_authorization` 发设备码和用户码。用户码是 20 个辅音字母里的 8 个，显示为 `XXXX-XXXX`。
- 用户在控制台 `/console/device` 输入用户码。码有效时，按这个码开一个授权请求，与这个浏览器绑定，然后转到已有的 `/console/authorize/<request>`。身份这一步（邀请码或控制台登录）、确认页、CSRF 和重复提交的处理都照旧。确认页上，回调地址一行换成设备码，并提醒核对设备码。
- 确认后不跳转。客户端下一次轮询 `/oauth/token` 时得到结果：`authorization_pending`、`slow_down`、`access_denied`、`expired_token`，或者一枚普通的 Hub 令牌，只给一次。
- 同一来源 15 分钟内最多输入 10 次用户码，对错都算。设备请求和授权请求一样只在内存里，10 分钟有效，Hub 重启后失效。

- 分支和工作树：`device-authorization`（目录 `circle-hub-device-code`），从 main（1100fcb4）开出。
- 可以改的路径：
  - `hub/server/oauth.ts`、`hub/server/console/index.ts`、`hub/server/console/authorize.ts`、`hub/server/console/session.ts`；
  - `hub/server/standard-authorization.test.ts`，以及 `hub/server/console-wording.test.ts` 里手写的授权请求（加 `device: null`）；
  - `hub/server/README.md`、`docs/compatibility.md`、`docs/compatibility.en.md`、`CHANGELOG.md` 和本页。

  别的路径不动。不加依赖。
- 规则：按所有者 2026-11-09 的决定推送并建拉取请求，由开发机合并；不发布、不部署；不碰 7420、7443、默认数据根和环境配置文件；测试只用合成数据（地址 192.0.2.0/24）；`git commit -s`，只暂存点名的路径。
- 验证：`npm run typecheck`、`npm run verify:contracts`、`npm run test:unit`、`npm run test:docs`；跳过的测试照实列出。

## 未做

- 记录层要求客户端登记 1 到 10 个回调地址，所以只用设备码的客户端登记时也要带回调地址。登记的授权方式不随客户端保存，令牌端点接受任何已登记客户端用这两种方式中的任一种。
- Circle 端改用设备码另开任务，要所有者先定：做成 Hub 专用的扩展，就要改 D06 R[1]；也可以做成通用的 MCP 客户端改进，对任何声明了设备码的服务器都适用。
