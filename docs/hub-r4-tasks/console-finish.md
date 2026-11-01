# 任务：补完决定 79 留下的三项

依据：

- 所有者 2026-11-01 在问答中选择“改为在本机做完”（第 1–3 项；测试连接的审计记录和运行环境的响应时间待所有者定）与“推送，不建 PR”。决定 80。
- 决定 79 与任务页 [`console-data.md`](console-data.md) 的“没有做的”；接口文档《circle-hub 控制台前端：模块与接口》的事件表（`system.status`：业务系统状态或响应时间变化）。

做法：

- 分支和工作树：`console-finish`（目录 `circle-hub-console`），从 main（0e5dfdc，#121 合并后）开出；推送，不建 PR。
- 可以改的路径：
  - `hub/server/console/live.ts`、`hub/server/console/citations.ts` 及其测试；
  - `hub/records/store.ts`、`hub/records/api.ts`（`addIndex`）及其测试；
  - `hub/runs/engine/store.ts`、`hub/runs/engine/service.ts`、`hub/runs/api.ts` 及其测试；
  - `hub/connectors/trial.ts`、`hub/connectors/connectors.ts`、`hub/connectors/api.ts` 及其测试；
  - 各包 README、`docs/hub-r4-progress.md`、`CHANGELOG.md`、`console-data.md` 和本页。

  别的路径不动。不加依赖，不加迁移，不加词表。
- 规则同 [`console-data.md`](console-data.md)。
- 验证：`npm run typecheck`、`npm run verify:contracts`、`npm run test:unit`、`npm run test:docs`、`npm run test:acceptance`；跳过的测试照实列出。

## 做了的

1. **读取结束时发送 `system.status`**：一次读取结束、写下读取清单（`action` 记录，正文顶层有 `resource` 与 `started_at`）时，给该业务系统发送 `system.status`，近 24 小时的读取次数与耗时随之刷新；保留 6 秒期间同一系统的事件只发一次。
2. **被引用次数回填**：`RecordStore.addIndex` 给已存的记录追加索引项（记录与摘要不变，已有的项保留，合计至多 200 项）。`backfillCitations` 从最早的提交往后，补到最早一份在存储时建了索引的提交为止，给每份已受理的提交补上与 `putSubmission` 现在相同的索引项，标记为 `backfilled`；中途停下，下次接着补；走到头时在分界的提交上记下 `runs.submission.cites.complete`。运行引擎的维护在启动时、此后没补完时每分钟在后台跑一遍，停止时中止。补完后近 30 天被引用次数是准确值（`citations.complete` 为真），页面不再写“更早的提交未计入”。
3. **测试连接的失败登录持久记住**：失败过的登录的摘要（系统包、登录来源、路径、填好的正文的 SHA-256）记在密钥库条目 `login-stop.trial`，加密保存，不含凭据内容；重启后同样的内容也不再发送，改正后的照常发送。至多 10,000 条，满了只去掉最早的一条。这份记录读不出时不登录，答复写“登录失败记录不可读，未登录”；写入失败时本进程仍记得，并记 `resource_trial_failure_unkept` 事件。答复的说法改为“同样的凭据此前登录失败，未再次发送；更正凭据后再试”。

## 没有做的

- 测试连接的审计记录：合约里没有对应的动作种类（`action_kind` 没有试读）或记录类型，用哪种形式记，待所有者定；记了以后，页面上“不保存任何东西”的说法要一并改。
- 运行环境的响应时间：接口文档的运行环境一行没有这一列。派发记录对每次调用执行器都记了发出请求与收到应答的时间（`hub/dispatch/service.ts`），可以据此统计；按什么口径统计，待所有者定。
- `login-stop.trial` 没有专门的清除命令：账户解锁后要用同样的凭据再试时怎样清除，待所有者定。

## 验证（2026-11-01，本机 macOS，Node 24.21）

在 b81fb2a 上（之后只改了文档）：

- 本次改动直接相关的测试：`hub/records/add-index`、`hub/runs/engine/citations`、`maintenance-citations`、`deadlines`、`hub/connectors/trial`、`hub/server/console-search`、`console-systems`、`console-live`，41/41。
- `npm run typecheck`、`npm run verify:contracts`：退出码 0。
- `npm run test:unit`（共享通道并行度 4）：
  - 隔离通道 175 项，173 通过，2 项跳过；
  - 共享通道 190/190；
  - 主通道 8140 项，8133 通过，0 失败，7 项跳过。
  - 跳过的 9 项中，8 项只在 Linux 上运行；1 项（没有 `sandbox-exec` 时拒绝运行）在有 `sandbox-exec` 的本机不适用。
- `npm run test:acceptance`：201 项，199 通过，2 项失败，都发生在本机负载较高时（可用内存约 2.4 GB）：
  - 场景 28 的派发结果为 `not_dispatched`；
  - 场景 42 报沙箱进程树的内存观测缺失，任务包样例检查出错。
  - 两项随后单独重跑都通过（7/7、3/3）。全量以本 PR 的 CI 为准。
- `npm run verify:references`、`npm run test:references`：8/8。
- `npm run test:docs`：279/279，改正文档后重跑仍为 279/279。
