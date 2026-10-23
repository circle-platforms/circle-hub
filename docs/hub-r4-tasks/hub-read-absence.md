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

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
