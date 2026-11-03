# 任务：补齐接口文档中“需新增”的后端数据

依据：

- 所有者 2026-11-01 在问答中选择“现在继续做”：接口文档《circle-hub 控制台前端：模块与接口》里标为“需新增”的后端数据（测试连接、搜索、知识条目近 30 天被引用次数、业务系统读取统计与响应时间、运行环境的占用与冻结）现在补齐。决定 126。
- 同日所有者授权在 Circle 仓库另开分支实现通用的 MCP 标准授权，并选择推送、建 PR（circle-platforms/circle#396，由所有者合并）。
- 决定 124、125，任务页 [`console-frontend.md`](console-frontend.md)、[`console-auth.md`](console-auth.md)。

做法：三个分支并行，各在自己的工作树里只跑自己的测试，再合进 `console-data` 统一检查：

- `console-search`：搜索、知识条目的被引用次数与出处；
- `console-probe`：测试连接、业务系统近 24 小时的读取；
- `console-envstate`：运行环境的状态、执行器版本与最近派发。

- 分支和工作树：`console-data`（目录 `circle-hub-console`），从 main（376a6de，#120 合并后）开出。
- 可以改的路径：
  - `hub/records/store.ts`、`hub/records/api.ts`（`countIndexed`）及其测试；
  - `hub/runs/engine/store.ts`、`hub/runs/api.ts`（提交所引知识的索引）及其测试；
  - `hub/connectors/trial.ts`、`hub/connectors/statistics.ts`（新）、`hub/connectors/connectors.ts`、`hub/connectors/api.ts` 及其测试；
  - `hub/dispatch/environment.ts`（新）、`hub/dispatch/service.ts`、`hub/dispatch/read-runs.ts`、`hub/dispatch/api.ts` 及其测试；
  - `contracts/model.json` 的词表（新增 `environment_state` 轴，D07 的变更记录）、`contracts/generated/` 重新生成、`docs/design/generic-model.md` 与 `en/`；
  - `hub/server/api.ts`、`hub/server/assemble/hub.ts`、`hub/server/console/**` 及对应测试；
  - 各包 README、`hub/server/README.md`、`docs/hub-r4-progress.md`、`CHANGELOG.md` 和本页。

  别的路径不动。不加依赖，不加迁移。
- 规则：业务系统只读，GET 与逐条放行的只读路由，从不打开写路由，登录失败不重试；测试只用合成数据（地址 192.0.2.0/24），本机回环上的夹具代替业务系统；不碰 7420、7443、默认数据根、钥匙串和环境配置文件；`git commit -s`，只暂存点名的路径。界面文字只陈述事实，不用“你、他”，进行中写作“等待××中”。
- 验证：`npm run typecheck`、`npm run verify:contracts`、`npm run test:unit`、`npm run test:docs`、`npm run test:acceptance`；跳过的测试照实列出。

## 做了的

1. **搜索**：`GET /console/api/search?q=` 与 `/console/search`，侧栏的搜索框在每个登录后的页面上。只在读者可见的范围里查：任务（最近 300 个运行的编号、任务包、标题、产品、版本、构建、执行人）、任务包（编号或标题）、知识（可读产品线及其构建与版本线；以 `/` 开头时按条目树路径）、记录（可见的调用日志行，按运行编号、工具或成员精确匹配，否则查最近 300 行）、成员（管理员）。查询至多 100 个字符，每类至多 10 条；扫描没有覆盖全部时标 `partial` 并在页面写明。不是全文索引。
2. **知识条目的被引用次数与出处**：受理的提交按所引的 `tree:` 引用记下节点与条目（`runs.submission.cites.*` 索引，不加迁移，不回填）；`GET /console/api/knowledge/node?root&path` 给出节点位置、摘要、子节点、条目及其依据，以及近 30 天被引用次数（引用该节点或其任一条目的受理提交，至多计到 10,000）。窗口早于最早一份建了索引的提交时只给下限，写明从何时起统计。出处只给依据，不解析原文。
3. **测试连接**：`POST /console/api/systems/test` 与接入业务系统页上的“测试连接”。用填写的系统包、地址、环境与凭据内容只读试读一次，不保存任何东西；认证只试一次，失败的登录在本进程内不再用同样的内容重发；只试不需要参数的接口（至多 20 条，60 秒后不再开始新的），不跟随跳转；答复只给结果、状态码与耗时，不转述来源原文，不回显凭据内容。
4. **业务系统近 24 小时的读取**：取自已有的读取清单（read-manifest），按结果分开计数，给出中位与最慢耗时；扫描至多 2,000 条，碰到上限时写“至少 N 次”。
5. **Hub 状态**：最近一次完整备份的时间与份数取自数据根下 `circle-hub backup` 写的备份（按清单的创建时间，未完成的不算），数据库大小取自 PostgreSQL；读不到时为未知，不当作没有。设置页的 Hub 状态与总览的运行状况显示它们。
6. **运行环境的状态**：由派发记录推出可用、使用中、已冻结、已停用，推不出时为未知；状态词进入词表 `environment_state`（D07），页面与接口只用词表的代码和界面用语。连接页给出执行器自报的版本、最近派发及其结局、“确认已恢复”与“处置派发结果”两个命令对话框；任务的派发步骤写明运行环境当前的状态。占用与冻结的变化发送 `environment.status`。

## 没有做的

- 运行环境的响应时间：没有任何记录。
- 测试连接没有审计记录：要写成记录需合约增加记录类型。
- 早于索引的提交不回填被引用次数。
- 失败登录的记忆只在 Hub 进程内，重启后同样的内容可以再试一次。

决定 127 补上了其中的回填与失败登录的持久记忆，并在读取结束时发送 `system.status`，见 [`console-finish.md`](console-finish.md)。另：运行环境的响应时间并非没有记录，派发记录对每次调用执行器都记了发出请求与收到应答的时间。

## 验证（2026-11-01，本机 macOS，Node 24.21）

三个分支合进 `console-data` 后（9425840）：

- `npm run typecheck`、`npm run verify:contracts`：退出码 0。
- `npm run test:unit`（共享通道并行度 4）：隔离通道 175 项，173 通过，2 项跳过（只在 Linux 上运行的检查）；共享通道 190/190；主通道 8133 项，8126 通过，0 失败，7 项跳过（同样是只在 Linux 上运行的检查与本机有 `sandbox-exec` 而不适用的一项）。
- `npm run test:acceptance`：201/201，没有跳过。
- `npm run verify:references`、`npm run test:references`：8/8。
- `npm run test:docs`：278/278。

之后合入“最近备份与数据库大小”（692e6e7）：`npm run typecheck` 通过；`node --test "hub/server/**/*.test.ts"` 499/499；`hub/records/store`、`count-indexed`、`hub/platform/backup` 31/31；`npm run test:docs` 278/278。全量以本 PR 的 CI 为准。
