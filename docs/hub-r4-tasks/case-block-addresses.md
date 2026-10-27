# B1 块调用的类型化地址闭环与 T7-4 发布治理验收

允许改动：packs/workflow/case-compile/**（修复、合成测试、README、版本与签名），新增 tests/acceptance/T7-4-publish-governance.test.ts，docs/hub-r5-test-map.md、本任务页，以及 docs/review 下本次 B1 合约读取审计与产品 adoc 依赖设计说明。其他旧测试不改；runtime-contract.ts 的 stripAdditions 由 cursor 负责，本分支只读审计，不抢改。

根因先用合成测试区分：原始块计划的 steps 为空，而 readSlots 会生成规范调用；typedAddressUses 不能把原始块计划当空计划，且必须按 origin 返回块 pointer。容量属于冻结 profile 前置，不得在块计划中绕过。沿用同一类型、角色、床成员及触发可达规则，不扫描散文或按角色名字猜语义。恢复的原文寄存器不能在编译时猜地址，已知类型化调用参数照样核对，运行期守卫要求保留。

补五类正反例、观察/配置/清理/恢复块位置、直接参数和完整命令身份中的地址；旧扁平 steps 断言保留。T7-4 按 T02/B04 的发布、所有权、分配、撤回与限定核对，无两人审批。测试并发不超过 2；最终跑 typecheck、docs、contracts、hub、packs、acceptance 含 oracle 全量。等待 cursor 先合后同步主线，包版本取较大值后加补丁并按 api.ts sign 重签。签署提交带指定合作者，经带说明的 merge-locked 合入。

所有者后续明确授权本分支补 T7-4 通用读时显示：追加允许 hub/ports.ts、hub/runs/engine/queries.ts、hub/server/console/{pages,results}.ts 及新增读时机制单测。仅从已有包元数据端口读取冻结精确版本的下架状态，以视图限定传递；回执摘要、原始 body、分区与要求项状态不重写。不得以修改带原摘要的 result body 来伪造身份。

允许路径补充：hub/runs/engine/README.md 记录读时限定语义。实际聚焦：新块地址 18 项通过；旧 bed/blocks 相关断言保持不变。T7-4 两项端到端通过；先前未显示撤回限定的规范断言已修复。游离 metadata 与回执 body 分离，不能修改 body 后继续沿用原 digest。同步 cursor 6d8b225f 后升 3.8.4；四份工作簿作者样例由 testing/samples-v2.ts 与 recompose-samples.ts 重新生成，没有手改生成物。只有包版本断言随授权补丁号更新，扁平 steps 旧断言没有修改。

最终全量（在 6d8b225f 基线上，并发 2）：typecheck 通过；gen-contracts --check 140 文件一致；docs 249 通过、contracts 336 通过、Hub 3183 通过 / 0 失败 / 1 既有环境跳过（本机已有 sandbox-exec，缺该机制时默认拒绝的反向环境分支不运行）、packs 3061 通过 / 0 失败 / 0 跳过、acceptance 含 oracle 185 通过 / 0 失败 / 0 取消 / 0 跳过。旧扁平 steps 的 bed.test.ts、blocks.test.ts 无差异；仅 pack.test.ts 与 publish.test.ts 的版本号断言随授权补丁更新。

case-compile 3.8.4 已经 pack-files.ts --write 重签，四份工作簿生成样例用现有生成器更新。B1 审计未发现第三个未剥离的新 runtime 成员；block_model/checkpoint_two_argument 已由 cursor 的闭集剥离，found_times_supported 是原字段仍保留原身份内。问题 11 的设计只文档化，未做迁移。T7-4 使用回执外的读取时包状态限定，不重写历史记录或改变原终态。全部测试记录归档到本机验收工作目录 wf/case-block-addresses。
