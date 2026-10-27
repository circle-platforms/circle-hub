# T7-4 读时有效条件与版本生命周期补充

基线 88fc4a81；块地址修复与 B1 审计已在该提交合入，本分支不动它们，不重写既有历史。此补充使用单独提交，仅改 hub/server/claims.ts、hub/server/console/{pages,results}.ts 的读侧呈现，新增 hub/server/claims-withdrawal.test.ts、tests/acceptance/T7-4-withdrawal-read-lifecycle.test.ts 及本页、覆盖表记录。不得改已存 Run/Validation/Claim 字节，原 T7-4 历史字节相等断言保持原样。

当前版本下架状态已经由通用查询在回执外携带。本补充在结果主张的有效条件展示读取上下文，显示生成词表的“规则已撤回（版本已下架）”，保留记录时条件文字。产品选择依据等非结果主张沿用其自身条件，不把工作包的撤回套到其他规则上。

新增验收覆盖下架前不显示、下架后显示、发布并重新分配新版本后旧运行仍显示，以及普通用户/管理员的限定一致；同时比较原运行、原回执与原件字节。新版本仅在临时合成注册表里发布，仓库中的任务包不改版。所有夹具合成，测试并发不超过 2。合入前按既有规矩跑完整 docs/contracts/hub/packs/acceptance（含 oracle）、typecheck 与生成一致性，经带说明的 merge-locked 合入。

聚焦结果：3 项纯显示/不可变单测 + 4 个生命周期子场景及父场景，共 8 项通过。已有 T7-4-publish-governance.test.ts（含历史字节相等断言）没有修改；新验收在临时目录复制现有包后用签名工具生成后继版本，源仓库包不改。旧运行继续查询其冻结的精确版本，重分配新版本不改变旧运行的当前限定。

全量进行中主线合入 513fccae（Hub 喂入与 test-bed 实现、42 号验收）。88fc4a81 基线的 docs/contracts/Hub/packs 已通过，刚开始的 acceptance 已取消，仅停止本工作树的测试进程。同步新基线后完整重跑，不把旧基线的未完成验收算通过。

最终验证：a09dd47e 的生产代码加本次读侧补充，完整 docs/contracts/hub/packs/acceptance（含 oracle）均执行；之后主线至 d4430e3c 只新增文档、3 份验收及其新辅助文件，没有改生产代码或已执行的原夹具/测试。逐文件清单核对：完整验收已跑 50 文件，新增 3 文件补跑，当前 53 文件零遗漏；191 + 6 = 197 项验收通过。明确是两批覆盖汇总，不伪称同一次命令。

最终计数：docs 同步后 254 通过；contracts 336；Hub 3186 通过、1 项既有环境跳过（已有 sandbox-exec，不运行缺失该机制的反向环境分支）；packs 3065；acceptance 含 oracle 197，均 0 失败。typecheck 与 gen-contracts --check 通过。源码差异核对确认同步前后 hub/contracts/packs/tools/scripts/bin/.github/依赖与原测试夹具字节不变；旧 T7-4 字节相等断言文件相对 88fc4a81 无差异。全程并发不超过 2。日志及验收逐文件清单归档 wf/t7-withdraw-read-display。

本次是独立读侧提交：有效条件文字按当前冻结版本的状态在渲染时计算，保留记录时状态；不写入或修改已存 Run/Validation/Claim。块地址、合约审计和 case-compile 3.8.4 仍使用先前已合入的 88fc4a81 成果。
