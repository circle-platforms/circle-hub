# 任务：连接器与引用：源头说没有就记确定的观察，中性码只给无权者，读要重试

依据：

- 所有者 2026-10-23 的规矩：未知只是过渡状态，要写明缺哪个事实、取得它的下一步动作、由谁做、何时到期；流程自动执行这一步，或者写成请求交给具名的人。以未知结束的运行、报告或检查都是缺陷。
- 全量普查 `docs/hub-r4-research/unknown-sweep.md`：第 2 节缺陷、第 3 节设计缺口、第 4.2 节缺的动作、第 5.2 节数据缺口。下面各条写了位置和要改的模型元素，动手前先读普查里同一处的真实影响。
- 理论文档 `docs/design/truth-docked-architecture.md`；模型用 `node tools/show-element.ts <元素>` 读。

- 分支和工作树：`hub-read-absence`，目录 `circle-hub-read-absence`。等这一批（K2、core-fixes、views-and-notes、kb-sections、hub-job-dispatch 等）合并以后，由集成者从 hub-redesign 开出并通知。
- 范围（普查拟定，集成者照当时合并后的代码再核一遍）：缺席与中性码两部分依赖 hub-unknown-model；重试和覆盖可以马上做；登录请求用 hub-unknown-exits 的请求记录。可以改：hub/connectors/**、hub/ports.ts、hub/refs/resolve.ts、hub/server/tools.ts、readers.ts、mcp.ts、notes.ts、budget.ts、text.ts（start_run、get_nodes 答复与预算例外两段）、hub/records/calllog.ts、hub/runs/engine/projection.ts、inputs.ts（外部来源绑定一段）、生成 SOURCE_UNAVAILABLE 修正说明的源、packs/system/**；对应测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。枚举只来自生成的词表；Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对改到的目录；每条先写改前失败、改后通过的测试。

## 要做的

1. 缺席：系统包的缺席码（plm.absent、manual.not_found）和 HTTP 404/410 映射成结构化的 SOURCE_ABSENT，带进 ReadOutcome、ExternalRead；运行把“系统 S 里没有 X（读于 T）”作为确定的观察绑定为预期来源，检查能读到；start_run 对缺席的输入答“不在 S 里”。
2. 中性码只给无权或未定的读者：运行没锁根直说并给修正（tools.ts:404-405）；get_nodes 照知识侧给的原因作答（tools.ts:447）；读者出错先在服务内重试再给可重试码；原件丢失或不符记完整性未证明（resolve.ts:403-407 不再记检查出错），给管理员“从备份恢复”的结论；SOURCE_UNAVAILABLE 的修正说明写下一步，不写“无”。
3. 覆盖：ReadOutcome、ExternalRead、运行的来源绑定带 coverage{complete, examined, total, note}，据此的主张加“部分”限定；敏捷平台的规划函数把剩下的根读完再答完成；搜索在读预算内重试失败的树和文件读；所有根读过仍找不到的文档记“在本产品配置的根之外”。
4. 读重试：executeRead 对 SOURCE_TIMEOUT、SOURCE_UNREACHABLE、5xx、429 有界退避重试（遵守 Retry-After），每次尝试记进读清单；仍失败给带下次时间的可重试码。
5. 登录停下（login.ts:535-540、695-721）：给资源管理员发处置请求，运行答“已转交管理员”，重置后自动重读；停下本身照 D01 R[9] 保留。
6. 资源绑定：同一外部类型每个环境类别至多一个启用资源，启用时拒绝冲突；loadBound 的错误进管理员备注和 resource list（connectors.ts:240-244）。
7. 路由可声明分页；同源重定向作为新的计划请求跟随，否则把 Location 记为确定的结论。
8. 管理员备注每条理由单独存，2,000 字的备注只作摘要；已存结果查不到时重查一次、记缺陷指标，答复里写缺什么、去哪读；文字预算的两处例外（budget.ts:322、text.ts:1225）写明怎么读其余部分。

## 决定 35 加的

依据：决定 35 第 26 项（`docs/hub-r4-progress.md`）；普查 5.1 第 4 条；B03 R[0]（现在是“解析时重验摘要与读者权限”）、B04 R[1]、R[3]，W06 DEF（冻结的输入），R02。

- 模型文字由集成者改：
  - B03 R[0] 分两种读者。Hub 自己评估一次运行时，按运行开始时的授权读它冻结的输入；别人查看时，按读者当前的权限。
  - B04 R[3] 的“读者解析引用时按它重验权限”只管查看。
  - B04 R[1]“只覆盖绑定的确切内容，由使用端在使用时检查”加一句：对 Hub 自己的评估，“使用时”就是 start_run 绑定的那一刻。
- 这一条在上面的范围之外加的路径：`hub/runs/engine/readers.ts`、`evaluate.ts` 242–291 行、`exact.ts` 的 `buildScope`（59 行起）、`submit.ts` 只改调 `buildScope` 的那一行（约 382 行）、`hub/records/artifacts.ts`（只加读的接口）。
- 先后：evaluate.ts 那一段和 exact.ts 归 hub-retry-split，artifacts.ts 归 hub-view-scope，这一条等这两件合并后，由集成者通知再做。share-production-results 排在这一条后面，它的第 4 条用这里加的按运行读取器。行号照现在的写，合并以后以函数为准。

9. **评估按开始时的授权读冻结的输入，查看按读者当前的权限**（第 26 项）。
   - 冻结的输入：运行记录的 `sources`（输入和期望来源）、绑定的 Hub 记录、前驱的结果、锁定的根。start_run 绑定它们时是以运行者的身份读的，运行记录就是那次授权的凭据。
   - Hub 自己评估时，只读运行记录列出的这些，不再按运行者此刻的角色、分享和账号状态重查。评估包括：submit_result 的边界核对和检查，只出事实的生产结果，检查按 `reads` 读来源，自动重评。现在不是这样：evaluate.ts 242–291 行按运行者此刻的角色读；exact.ts 的 `buildScope` 按提交者读；artifacts.ts 的 `#viewer` 每次重读账号。
   - 读取档位和凭据受理照旧每次都核：它们是字节的性质，不是读者的权限，受理撤回立刻生效。没绑定的摘要照旧解析不出。
   - 查看照旧按读者当前的权限，运行者本人也一样：get_nodes 按引用读、resolve_reference 预览、控制台的源文件和结果页。分享撤回、账号停用以后，答“对你不可用”（D05 R[3]）。能不能看，等 share-production-results 合并以后照它的 `canViewRun`，在那之前照现在的 `canSeeRun`。
   - 做法：`readers.ts` 加一个按运行的读取器，只认运行记录里的摘要；字节和档位经 artifacts 取，不按此刻的读者查。三处要说清：
     - 读层取哪一条记录：同一摘要可能有几条 source_artifact 记录，`artifacts.ts` 的 `#choose` 按读者挑决定的那一条。按运行读时，照 `#choose` 的次序替运行开始时的运行者挑，挑中的那条记录号在绑定时钉进运行记录，以后照它取读层。
     - 树：锁定根的读现在经 `hub/knowledge` 的 treeReader，它的 `#read` 按读者核 `mayReadRoot`，开始以后取消运行者对包的分配，评估就读不了树了。`readers.ts` 包一层：用一个只许读 `run.root`（以后加上 kb-unversioned 锁的根）的 Hub 身份去读，不改 `hub/knowledge`。
     - 范围：`buildScope` 现在在 submit.ts 约 382 行按提交者调，在 preview.ts 约 52 行按查看者调。给它一个明写的参数，分清“按运行”还是“按查看者”；submit.ts 那一行改成按运行，preview.ts 不改，照旧按查看者。
   - Hub 侧运行也一样：core-fixes 的 8062ec5a（Preserve standing source restrictions and current reader roles）把 evaluate.ts 242–291 行 Hub 侧那一支改成按配置者此刻的角色读。这一条把它也改成按运行读：用配置者在开始时的授权。
   - 测试：
     - 开始运行以后撤回一份输入的分享，或把运行者从管理员改成用户，再交一份新的提交：照样核对，检查读得到来源，`unread_sources` 为空；
     - 同一时刻运行者用 get_nodes 按引用读那份来源，答“对你不可用”；
     - 开始以后取消运行者对包的分配，再交一份：树照样读得到，评估照常；
     - Hub 侧运行开始以后把配置者降成用户：评估照常；
     - 只保留的来源两边都不给原文；受理撤回以后，评估立刻读不到原文。

## 集成者答复（2026-10-24 凌晨）

- **05:24，答 codex**：覆盖传播可改 `contracts/src/run.ts`、`contracts/src/resources.ts` 及对应生成物、测试；引擎可改 `claims.ts`、`evaluate.ts` 的覆盖传播一段，避开 hub-unknown-model 正在改的段落。
- **06:20、06:23**：授权在模型协议码源和变更记录登记 `SOURCE_RETRYABLE`、`SOURCE_INTEGRITY_UNPROVEN` 并重新生成；`hub/knowledge/read.ts`、`service.ts` 只在确认有读权后给结构化诊断，`hub/server/tools.ts` 透传。`hub/runs/engine/exact.ts`、`evaluate.ts` 按内部 reason 识别这两类结果为未完成，不从私有消息猜原因。码的用途、受众和下一步见[决定 45](../hub-r4-progress.md)。
- **06:35**：`configureResource` 可加可选事务参数；与 hub-variables 的同一入口合一，不另做一套资源配置入口。
- **06:39**：可在 `hub/records/migrations.ts` 末尾追加迁移，逐条保存管理员理由；`CallLog` 的管理员字段和控制台详情显示这些理由，普通读者与 JSONL 不带。可改对应 calllog、控制台显示和测试，不改已应用迁移。
- **06:39、06:50、07:01**：继续授权登记 `SOURCE_REDIRECT_REFUSED`、`SOURCE_READ_LIMIT`、`SOURCE_READ_FAILED`，模型源、变更记录与生成物一起更新，语义和权限边界照决定 45。重定向带状态、脱敏 Location 和资源管理员核对动作；同源已声明跳转由规划函数发下一条请求。
- **05:56 的并行改动**：hub-view-scope 也获准给 `hub/ports.ts` 的失败分支加可选 manifest，并在 `hub/connectors/connectors.ts` 透传；本页也改这两个文件，后合并方解冲突，不丢任一边的失败/覆盖信息。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
