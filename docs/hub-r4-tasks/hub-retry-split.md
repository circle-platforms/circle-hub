# 任务：引擎与解释器：自动重试、拆批、重读、重评，能算的不记未知

依据：

- 所有者 2026-10-23 的规矩：未知只是过渡状态，要写明缺哪个事实、取得它的下一步动作、由谁做、何时到期；流程自动执行这一步，或者写成请求交给具名的人。以未知结束的运行、报告或检查都是缺陷。
- 全量普查 `docs/hub-r4-research/unknown-sweep.md`：第 2 节缺陷、第 3 节设计缺口、第 4.2 节缺的动作、第 5.2 节数据缺口。下面各条写了位置和要改的模型元素，动手前先读普查里同一处的真实影响。
- 理论文档 `docs/design/truth-docked-architecture.md`；模型用 `node tools/show-element.ts <元素>` 读。

- 分支和工作树：`hub-retry-split`，目录 `circle-hub-retry-split`。等这一批（K2、core-fixes、views-and-notes、kb-sections、hub-job-dispatch 等）合并以后，由集成者从 hub-redesign 开出并通知。
- 范围（普查拟定，集成者照当时合并后的代码再核一遍）：重试部分可以马上做，其余依赖 hub-unknown-model。可以改：hub/runs/engine/evaluate.ts（检查调用、来源读取、引文分级一段，约 80-560 行）、exact.ts、start.ts（生产结果的一段）；hub/rules/check.ts（outcomeProblems 除外）、hub/rules/sandbox/sandbox.ts、hub/rules/interpreters/**；对应测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。枚举只来自生成的词表；Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对改到的目录；每条先写改前失败、改后通过的测试。

## 要做的

1. 输出超限或超时（evaluate.ts:519-521、check.ts:212-214）：把条目二分、按块重建主体再调，合并逐条结果；单条仍失败才记未知，出口交包作者；按 checks.json 的 limits 调高单个检查的上限（不超过 MAX_LIMITS）；用 1,147 条目的合成规模复现。
2. callCheck、buildSubject、callPackFunction 对超时和 queue_full、stopping、spawn_failed 有界重试（例如 2 次、带退避，第二次用检查的最大时限），尝试记进校验动作。
3. 绑定来源读不出（evaluate.ts:243-361）：带退避重读；给包代码固定原因码，不给 describe(error)；结果里存 unread_sources。
4. 重评：带瞬态原因的生产结果自动重评；根更新后，只出事实的运行以原运行为前驱自动开新修订，新结果取代旧的（照 W06 F[1] 新规则）；来源被管理员接受后，重评引用它的结果。
5. exact.ts:193-194：带内部原因的 SOURCE_UNAVAILABLE 先重读，仍失败给不计轮的 Hub 侧错误，出口为管理员恢复。
6. 解释器：类型不符按值的提供方记反驳（membership、pattern、range、catalog；range@1 两个分支一致）；畸形陈述记反驳（quote.ts:24-26、catalog.ts:118-120、171-178）；必需位置缺失与空集阈值照新的 C04 规则。
7. 上限：结构分页走；引文按存储字节流式比；长十进制用 BigInt；bounded()（evaluate.ts:113-123）保留判定、码、陈述和根据，深层 data 另存为按摘要引用的对象。
8. 引文分级（evaluate.ts:376-426）：各方案的 REFERENCE_UNRESOLVED 都记无片段（反驳），带上解析器自己的原因；预热时也收集表里的引用。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
