# 任务：控制台按设计稿改版，接上主线后端

依据：

- 所有者 2026-11-01 的目标：“按照 hub 最新 PR 和主线代码将后端接入前端”。主线即 main（#117 及之前，含 #115 的网页管理和 #114 的内置 HTTPS）。
- 所有者 2026-10-31 在《circle-hub 简化提案》决策事项里勾选的第 3 项（模型词表增加“界面用语”字段，界面只从那里取词）和第 6 项（控制台只保留四种管理操作：添加成员、接入业务系统、发布任务包、导入知识；其余在 Circle 中完成）。第 6 项收窄了决定 75 在网页上开放的操作面，决定 75 的命令桥和表单接口不动。
- 设计稿《circle-hub 控制台设计稿》第 25 版（14 块画板）和文档《circle-hub 控制台前端：模块与接口》。

做法：沿用主线控制台的写法，服务端渲染、不带脚本，一份按哈希放行的样式表，写操作仍是本站表单经命令桥执行 `circle-hub` 命令（决定 75）。所有者 2026-11-01 选择先做接口文档的只读 `/console/api`；MCP 标准授权、邀请码、一次性登录链接和实时推送不在这一件里。

- 分支和工作树：`console-frontend`，目录 `circle-hub-console`（从 main 开出）
- 可以改的路径：
  - `contracts/model.json` 的词表（取值加 `ui`，加 `task_result` 轴）、显示规则和 V05 的变更记录，`tools/gen-contracts.ts` 的词表生成，`contracts/generated/` 重新生成，`contracts/src/vocabulary.test.ts`；`contracts/src/tools.ts` 给每个工具加控制台用的中文名 `label`（不发给模型）及其测试；
  - `hub/server/console/**`，`hub/server/claims.ts`（标签函数可换成界面用语，MCP 文本照旧用模型标签）和 `hub/server/text.ts` 里随之改写的一处调用；
  - `hub/server/api.ts`、`hub/server/app.ts` 和 `hub/server/assemble/hub.ts`（给控制台一个可选的执行器与作业只读端口）；
  - `hub/server/console*.test.ts`、`hub/server/console/*.test.ts` 和受控制台文字影响的验收断言；
  - `hub/server/README.md`、`docs/hub-r4-progress.md`、`CHANGELOG.md` 和本页；
  - `scripts/diagnostics/seed-lists-repro.test.ts`：主线上已有的问题，本地 `npm run test:unit` 把它分进共享集群通道，它要核对的 postmaster 进程号读不到，17 项必然失败（公开 CI 分组不用共享集群，所以 CI 不受影响）；只改为请求私有集群。

  别的路径不动。不加依赖。
- 规则：不推送、不建 PR、不发布、不部署；不碰 7420、7443、默认数据根、钥匙串和环境配置文件；测试只用合成数据（地址 192.0.2.0/24）；`git commit -s`，只暂存点名的路径。界面文字只陈述事实，不用“你、他”，进行中的状态写作“等待××中”，状态用规范术语。
- 验证：`npm run typecheck`、`npm run verify:contracts`、`npm run test:unit`、`npm run test:docs`、`npm run test:acceptance`；跳过的测试照实列出。

## 要做的

1. **界面用语进合约**：词表取值可带 `ui`（与模型标签不同时才写），轴也可带 `ui`；生成 `<轴>_UI`、`uiLabelOf`、`axisUiLabel`。新增 `task_result` 轴（V05）：已通过、已交付（含未决项）、已拒收、未完成、派发结果未确认、等待提交中、已放弃，由分区和要求项满足状态推出，推导只写在控制台的一个模块里。
2. **外壳**：左侧 7 个入口（总览、任务、知识库、任务包、连接、记录、设置）和当前账号；浅色与深色跟随系统，减少动效跟随系统；没有内联样式和脚本，图表用内联 SVG 的属性画。
3. **页面**，数据全部取自现有端口，没有来源的数值不显示：
   - 总览：今日任务及其执行过程，最近 7、14、30 天每日的任务结果，检查项结果，主要阻塞原因，业务系统，知识库，运行状况；
   - 任务：按任务结果筛选的列表；详情页顶部是执行过程（调用记录、Hub 校验、请求的接收人与期限、派发作业），下面保留原运行页的权威内容（显示规则 3、4、5、6、13、17）；
   - 知识库、任务包、连接（已连接的 Circle、业务系统、运行环境）、记录（调用记录与按工具、成员的统计）、设置（成员与已连接的 Circle、凭据、Hub 状态、需停机的操作；成员只看到自己的 Circle）；
   - 登录、初始化（证书信任步骤分 macOS、Linux、Windows 浏览器）、不存在或无权查看、登录已过期。
4. **四种管理操作**：添加成员（`user create` 后 `token issue`，令牌只显示一次，附 Circle 配置）、接入业务系统（`secret set` 后 `resource add`）、发布任务包（上传 zip，`pack publish --stage`）、导入知识（`knowledge sync`，可试运行，后台执行）。其余操作的按钮只生成命令，在管理员的 Circle 中执行。
5. **旧路径**：`/console/runs`、`/console/results`、`/console/knowledge/*`、`/console/admin/*` 照旧可用；`/console/admin` 与 `/console/admin/calls` 分别显示设置页与记录页。
6. **只读接口** `/console/api/…`：与页面同一会话、同一可见范围；只接受 GET，未登录答 401，缺失与无权同为 404 `SOURCE_UNAVAILABLE`，没有登记的码时 `code` 为 null；不出现令牌值和凭据内容。

## 不在这一件里

- MCP 标准授权（授权页、邀请码）、一次性登录链接、实时推送和写接口：等所有者在接口文档里定下待定事项后再做。
- 业务系统的读取统计、知识条目的被引用次数、最近备份、数据库大小、运行环境的占用与冻结：后端还没有这些数据，页面上不显示。
- 其余手写的状态词（启用、停用、是、否等）改由词表提供。

## 验证（2026-11-01，本机 macOS，Node 24.21）

- `npm run typecheck`、`npm run verify:contracts`：通过。
- `npm run test:unit`：8039 项，8032 通过，0 失败。跳过的都是只在 Linux 上运行的检查（systemd 用户服务、Linux 恢复与私钥演练、Linux 操作系统隔离、孤儿进程清理、驻留内存统计），以及本机有 `sandbox-exec` 而不适用的一项。
- `npm run test:acceptance`：201 项，201 通过，0 跳过。
- `npm run test:docs`：276 项全部通过；`npm run verify:references`、`npm run test:references`：8 项全部通过。
- 控制台各页面另用无头 Chrome（临时配置目录）截图核对了深色与浅色两种主题。
