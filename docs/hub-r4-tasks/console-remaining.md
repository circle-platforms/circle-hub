# 任务：尝试读取记录、运行环境的响应时间、按凭据清除失败登录

依据：

- 所有者 2026-11-01 在问答中的选择（决定 128）：
  - 尝试连接的审计记录：新增动作种类“尝试读取”；
  - 运行环境的响应时间：调用应答时长，近 24 小时；
  - 尝试连接失败登录的清除：按这组凭据清除；
  - `console-finish`（决定 127）现在单独建 PR，由 Claude 处理，合并另由所有者决定；以下三项在新分支上做。
- 决定 127 与任务页 [`console-finish.md`](console-finish.md)。

做法：

- 分支和工作树：从本页所在的分支 `console-remaining`（基于 `console-finish`）开自己的工作树和任务分支。不要切换主检出（`circle-hub` 目录，停在 main）的分支，也不要改 `console-finish`。
  实际工作分支：`console-remaining-local`，基线为 `ae2b19c`。
- 只在本机提交；推送、建 PR 之前先问所有者。
- 可以改的路径：
  - `contracts/model.json`（`action_kind` 加代码，B05 的变更记录）、`contracts/generated/`（只用 `npm run gen:contracts` 生成，不手改）、`docs/design/generic-model.md` 与 `docs/design/en/` 中列出动作种类的地方；
  - `contracts/src/model-w04-w10-v07.test.ts` 与 `contracts/src/vocab-axes.test.ts`：只同步模型版本断言及测试名称（来源：所有者在本任务的追加问答中明确授权，2026-11-01）；
  - `hub/connectors/**`（`trial.ts`、`connectors.ts`、`api.ts`、尝试读取记录的 schema）及其测试；
  - `hub/dispatch/**`（`environment.ts` 或新的统计模块）及其测试；
  - `hub/server/console/**`、`hub/server/api.ts`、`hub/server/assemble/hub.ts` 及对应测试；
  - 各包 README、`docs/hub-r4-progress.md`（决定 128）、`CHANGELOG.md` 和本页。

  别的路径不动。不加依赖，不加迁移。
- 规则同 [`console-data.md`](console-data.md)：业务系统只读，只用 GET 与逐条放行的只读路由，登录失败不重试；测试只用合成数据（地址 192.0.2.0/24）、临时 PostgreSQL 与临时钥匙串；不碰运行中的 Hub（端口 7420/7443、默认数据根、LaunchAgent、钥匙串服务 `circle-hub`），不打开所有者的环境配置文件和凭据库；枚举、动作种类和界面用语只取自 `contracts/generated`（`labelOf`），不手写、不造词；界面文字只陈述事实，不用“你”“他”，进行中写作“等待××中”，说“运行环境”不说“台架”；代码注释和提交信息用英文；提交为一句首字母大写的英文祈使句，没有前缀，末尾不加句号，`git commit -s`，只暂存点名的文件。
- 验证（所有者要求）：不随意增加 SHA 数据校验和全量回归，只在数据有被篡改的风险或改动影响其他功能模块时才加。每项跑 `npm run typecheck` 和受影响包的测试；改了合约之后跑 `npm run verify:contracts`，并跑用到动作种类的包的测试；改了文档跑 `npm run test:docs`。跳过的测试照实列出，跳过不算通过。

## 要做的

### 1. 尝试连接的尝试读取记录

- 合约：在 `contracts/model.json` 的 `action_kind` 轴（属 B05）加代码 `trial`，界面用语“尝试读取”；照该文件已有的变更记录格式给 B05 记一条（2026-11-01，来源：所有者选择新增动作种类“尝试读取”，决定 128）。`npm run gen:contracts` 重新生成，`npm run verify:contracts` 通过；设计说明里列出动作种类的地方同步。
- 记录：每次尝试连接（`connectors.admin.trial`）结束后写一条 `action` 记录。schema 单独一种（例如 `trial-report@1`），在 hub/connectors 里用 zod 定义，像 `read-manifest@1` 那样存之前先校验；provenance 为 `observed`；索引 `action.kind=trial` 与 `action.user=<管理员>`。
- 内容：操作的管理员、开始与结束时间、系统包与版本、环境、登录是否发送、是否成功与错误码，以及各接口的编号、是否试过、状态码、错误码和耗时。不含凭据、地址、请求头和来源原文，与尝试连接的答复同一原则。
- 记录写不进去时，答复照常返回，另记一条连接器日志事件；不因此再联系业务系统。
- 原有测试“a trial logs in once, … and keeps nothing”改为：只多一条尝试读取记录，没有对象、指针和密钥库条目（登录失败时另有 `login-stop.trial`）。
- 控制台：尝试连接处“不保存任何东西”“不保存配置与凭据”的说法改为如实说明，例如“每次尝试连接记一条尝试读取记录（谁、何时、各接口的结果），不保存配置与凭据”；记录页按词表显示“尝试读取”。

### 2. 运行环境的响应时间

- 口径：Hub 向执行器发出请求到收到应答的时长。派发记录里已有：`hub/dispatch/service.ts` 对执行器的调用（约第 894 行的 read、read_back、lease，约第 1504 行的 precheck）把 `started_at` 记为发出、`ended_at` 记为收到应答（`received_at`）。只取这些真正发出过请求的记录，不取开始与结束相同的内部记录（预约、门控、完成等）。
- 窗口与结果：近 24 小时；每个运行环境（作业预约的执行器，`hub/dispatch/environment.ts` 已能从预约记录找到）给出调用次数、中位与最慢耗时。扫描有上限，到上限时写“至少”，做法照 `hub/connectors/statistics.ts` 的 `readStatistics`。
- 接口：`/console/api/environments` 的每个运行环境加这项统计，字段形状照 `/console/api/systems` 的 `reads_24h`。
- 页面：接入页的运行环境表加“响应时间”一列（中位与最慢）；近 24 小时没有调用时写“近 24 小时无调用”。
- 实时更新：新的调用记录也发送 `environment.status`（照决定 127 中读取清单发送 `system.status` 的做法，保留期间同一运行环境只发一次）。

### 3. 按这组凭据清除失败登录

- 接口：`POST /console/api/systems/test/forget`，只限管理员会话，检查本控制台的 Origin 与 `X-CSRF-Token`，与 `POST /console/api/systems/test` 相同。请求体与尝试连接相同（系统包、环境、地址、凭据），用与尝试连接相同的方法算出登录摘要：把 `trial.ts` 里算摘要的代码抽成一个函数，两处共用。从 `TrialLoginStops` 删除这一条：密钥库条目与本进程内存都删，写入取同一把锁。
- 答复只说有没有这条记录、是否已清除；不回显凭据，不联系业务系统，不自动重试，之后由管理员再执行一次尝试连接。
- 页面：尝试连接的结果为“同样的凭据此前登录失败，未再次发送”时，显示“清除这组凭据的失败记录”，用当前表单的内容提交。
- 不加命令行命令：凭据不经命令行，命令行也碰不到运行中 Hub 的内存。
- 测试：只清除匹配的一条，其他保留；清除后在同一进程和重启后都能再发送一次；并发写入；非管理员与跨站请求被拒，答复中性；清除失败时如实返回。

## 收尾

- 每项各一次提交；README、`CHANGELOG.md`、`docs/hub-r4-progress.md`（决定 128 下补做了什么）与本页的“做了的”“验证”两节一起更新。
- 接口文档在 claude.ai 上，读不到不影响：要改的接口和页面说法都写在本页，文档由 Claude 在完成后同步。
- 完成后报告分支、提交和测试结果（含跳过）；推送和建 PR 等所有者决定。

## 做了的

1. **尝试读取记录**：B05 增加动作 `trial`，模型第 14 版，合约由生成器更新；中英文设计说明列出新动作。`trial-report@1` 在连接器中用 zod 定义，只从答复中提取允许记录的字段，保存前校验，使用 `action.kind=trial` 与 `action.user` 索引；不写正式读取的资源索引。写入失败记 `resource_trial_record_failed`，保留原答复、不重发请求。管理员记录页可按成员、时间查尝试读取记录并查看各接口结果，成员看不到。尝试连接说明已区分尝试读取记录、失败登录摘要与不保存的配置和凭据内容。

2. **运行环境响应时间**：`readEnvironmentCalls` 只读作业绑定对应的 `dispatch.executor` 索引，不发测量请求、不新增记录。优先统计有显式发送、接收时刻的网络应答记录，读取／回读／租约／预检记录作为旧记录的补充；同一调用的应答和上层读取记录按作业、来源引用及两端时间去重。真实 0 毫秒调用计入，没有显式请求时间的内部记录排除。每个运行环境扫描至多 2,000 条；`calls_24h` 给出 `executor`、`since`、`until`、`calls`、`results`、`results_label`、`median_ms`、`slowest_ms`、`last_at`、`partial`，存储失败为 null。页面显示中位与最慢、无调用或不可用，受限时次数写“至少”、耗时只涵盖已扫描调用。新的计时记录经预约定位执行器，`environment.status` 保留 6 秒合并发送。

3. **按凭据清除失败登录**：管理员可通过结果页的“清除这组凭据的失败记录”或 `POST /console/api/systems/test/forget` 提交同样的表单内容，须重新输入凭据；共用已校验的配置、凭据变换与 `trialLoginKey`。只清除匹配摘要，使用原条目的锁，其他摘要保留，写入成功后清除本进程记忆；并发新失败的内存标记不会被旧清除动作删除，即使新失败的持久写入失败也继续停止。接口只返回 `found` 与 `cleared`，失败如实返回；非管理员、跨站与伪造 CSRF 请求被拒。清除本身不访问业务系统、不自动重试、不加命令行命令。

4. **界面用语**：按所有者 2026-11-01 的补充，动作 `trial` 的标签与 B05 变更说明使用“尝试读取”，页面按钮、步骤、卡片、答复与错误提示使用“尝试连接”和“尝试读取”；当前包说明、设计词表、本任务页与决定 128 同步。接口路径、动作名及代码不变；决定 124–127 和旧任务页保留原文。按追加授权同步两处模型版本 13 的固定断言到 14，没有减少其余检查。

## 验证

### 第 1 项（本机 macOS，Node 24.22.1）

- `npm ci` 完成；未改依赖或锁文件。
- `npm run typecheck`、`npm run verify:contracts`：退出码 0；生成物 140 份与模型一致。
- `node --test --test-concurrency=2 "hub/connectors/**/*.test.ts" "hub/server/**/*.test.ts"`：726/726，0 失败、0 跳过。
- `node --test --test-concurrency=2 "contracts/**/*.test.ts" "tools/gen-contracts*.test.ts" hub/records/pointers.test.ts hub/runs/engine/retry-evidence.test.ts hub/dispatch/journal-identity.test.ts hub/knowledge/operation-records.test.ts`：382 项，380 通过、2 失败、0 跳过。失败均为旧测试固定模型版本 13，而本次模型按版本规则升为 14：`contracts/src/model-w04-w10-v07.test.ts` 的模型修订检查与 `contracts/src/vocab-axes.test.ts` 的模型版本检查。两文件最初不在允许路径中；所有者在追加问答中明确授权同步版本断言及测试名称，已于第 4 项修正并定向复验通过（见下）。
- `node --test --test-concurrency=1 --test-name-pattern='uses generated axes' packs/workflow/case-review/packs.test.ts`：选中的 1 项通过，0 失败、0 跳过；其余名称未选中的测试未运行，不计为通过。
- `npm run test:docs`：280/280，0 失败、0 跳过。

### 第 2 项（本机 macOS，Node 24.22.1）

- `npm run typecheck`：退出码 0。
- `node --test --test-concurrency=2 hub/dispatch/environment.test.ts hub/dispatch/environment-statistics.test.ts hub/dispatch/read-runs.test.ts hub/server/console-environments.test.ts hub/server/console-live.test.ts hub/server/console-api.test.ts hub/server/assemble/testing-real.test.ts`：44/44，0 失败、0 跳过；包含真实回环执行器请求数与统计逐次对照、0 毫秒调用、重复记录、窗口、上限、不可读、页面与接口、事件可见范围和合并发送。
- `npm run test:docs`：280/280，0 失败、0 跳过。

### 第 3 项（本机 macOS，Node 24.22.1）

- `npm run typecheck`：退出码 0。
- `node --test --test-concurrency=2 hub/connectors/trial.test.ts hub/server/console-systems.test.ts hub/server/console-api-write.test.ts hub/server/console-manage.test.ts hub/server/assemble/testing-real.test.ts`：39/39，0 失败、0 跳过。
- 覆盖只清匹配项、其他记录保留、同进程和重启后再发送一次、来源修复后相同凭据可用、并发写入及清除期间的新失败、持久写入失败时仍停止、非管理员／未登录／跨站／伪造 CSRF 拒绝、页面重新填凭据、清除不自动登录和失败不报成功。
- 初轮有两项失败：锁定场景误用了“令牌立即过期”夹具，已改用明确拒绝登录后恢复的夹具；新增 JSON 路径漏接写接口入口，已补入白名单。两处修正后重跑上述定向集为 39/39；没有删减或放宽断言。缺少记录时隐藏清除按钮后另跑 `node --test hub/server/console-systems.test.ts`：5/5，0 失败、0 跳过。
- `npm run test:docs`：280/280，0 失败、0 跳过。
- 没有运行整仓单元回归、验收或来源校验；本项没有变更来源工具。

### 第 4 项（本机 macOS，Node 24.22.1）

- `npm run gen:contracts`、`npm run verify:contracts`：退出码 0；仅重新生成词表标签，140 份生成物与模型一致。
- `npm run typecheck`：退出码 0。
- `node --test --test-concurrency=2 hub/connectors/trial.test.ts hub/server/console-systems.test.ts hub/server/console-places.test.ts contracts/src/model-w04-w10-v07.test.ts contracts/src/vocab-axes.test.ts contracts/src/vocabulary.test.ts contracts/src/show-element.test.ts`：130/130，0 失败、0 跳过；包含第 1 项初轮失败的两处版本断言、生成标签、当前页面与尝试连接的行为。
- `node --test --test-concurrency=1 --test-name-pattern='uses generated axes' packs/workflow/case-review/packs.test.ts`：1/1，0 失败、0 跳过；只计选中的检查。初轮发现统计模块手写动作筛选，已改为从生成的 `ActionKindSchema` 提取子集，并归入第 2 项提交。
- 该筛选修正后，`node --test --test-concurrency=2 hub/dispatch/environment-statistics.test.ts hub/dispatch/environment.test.ts hub/server/console-live.test.ts`：25/25，0 失败、0 跳过。
- `npm run test:docs`：280/280，0 失败、0 跳过。
