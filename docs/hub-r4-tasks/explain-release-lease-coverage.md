# B7：explain-release 列出租约覆盖这一道门（#36）

来源：所有者全量计划 #36/#147/#199；基线 aded2ffd，`fix/explain-release-lease-coverage`。

## 允许路径

- `hub/dispatch/{service.ts,release-explanation.test.ts,README.md}`
- 本任务页、`CHANGELOG.md`

## 决定

真实台架派发时，`explain-release` 全部满足，`job dispatch` 却被边界拒绝（`LEASE_UNAVAILABLE`）：执行器声明了整台床的全部资源键，派发要求同一谱系在整个派发窗口里全部持有，只订够用设备的运行永远派不出去，而诊断没有覆盖这道门。

派发的拒绝信息在 main 上已经写出缺哪几把键。本批补上诊断一侧：

- `DispatchService.coverage` 是派发与诊断共用的判断（原 `holders` 的判断部分，不抛异常）；`holders` 仍在缺键时抛 `LeaseCoverageError`，行为不变。
- `explain-release` 的返回新增字段 `lease_coverage`（一个 `lease.coverage` 条件）：只读租约持有记录；缺键时 `missing_fact` 列出缺的键和共声明几把，`next_action` 说明要整台预订；前提尚未核对通过或读不到租约记录时为 null（未知，不显示成通过也不显示成失败）。
- 顶层 `satisfied` 的含义不变，仍只表示第 3 款放行条件满足，也不把该条件并入 `checks`。第一版把它并进 `satisfied` 后，`dispatch/accepted.test.ts` 两个测试失败：`dispatchAccepted` 用 `satisfied` 挑执行器，欠订的谱系不再被尝试派发，执行人也就收不到“Hub 没有派发：缺少……租约”的说明。所以覆盖单独返回。
- 命令行在 `放行条件满足` 之后另打 `租约覆盖` 一行，只有两者都成立时退出码才是 0（未知不算成功），不再出现“诊断通过而派发被拒”。

键名写进 `missing_fact` 的理由：`explain-release` 只给管理员；这些键是管理员登记的执行器资源，不是核验记录里的字段原文，现有“字段只给摘要”的约束针对后者，且派发拒绝信息本来就写键名。现有测试对 `synthetic-bed`（台架身份）不出现在输出里的断言仍然成立。

## 不做（#36 第二部分）

test-bed 在预订时提示“派发需整台预订”并提供整台预订：需要台架包知道哪个执行器把它声明为整台派发目标，涉及 Hub 把执行器声明交给包的上下文，是另一个设计，仍待办。

## 验收

- 谱系不是预订者：`lease_coverage` 列出全部声明的键且不满足，`satisfied` 仍为 true；随后真实派发在同一依据上被拒，且两边写出同一批键。
- 部分持有：只列缺的那把键，不列已持有的；全部持有：该条件满足、没有 `missing_fact`。
- 租约在派发窗口结束前到期：不算覆盖。
- 命令行：谱系不是预订者时打印 `租约覆盖 0：派发会被边界拒绝` 并退出 1，全部持有时打印 `租约覆盖 1` 并退出 0。
- `dispatch/accepted.test.ts` 的两个自动派发说明测试（欠订谱系被拒后给执行人写明原因）照旧通过。
- 原有的只读性（不写记录、不连执行器、不读密钥）测试照旧通过。

## 实际验证

见 PR 说明。仅合成数据与临时 PostgreSQL，没有真实台架或设备。
