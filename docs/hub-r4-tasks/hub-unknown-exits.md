# 任务：引擎：每个未知进回执、有出口；轮数用完、跳过、到期都交给人

依据：

- 所有者 2026-10-23 的规矩：未知只是过渡状态，要写明缺哪个事实、取得它的下一步动作、由谁做、何时到期；流程自动执行这一步，或者写成请求交给具名的人。以未知结束的运行、报告或检查都是缺陷。
- 全量普查 `docs/hub-r4-research/unknown-sweep.md`：第 2 节缺陷、第 3 节设计缺口、第 4.2 节缺的动作、第 5.2 节数据缺口。下面各条写了位置和要改的模型元素，动手前先读普查里同一处的真实影响。
- 理论文档 `docs/design/truth-docked-architecture.md`；模型用 `node tools/show-element.ts <元素>` 读。

- 分支和工作树：`hub-unknown-exits`，目录 `circle-hub-unknown-exits`。等这一批（K2、core-fixes、views-and-notes、kb-sections、hub-job-dispatch 等）合并以后，由集成者从 hub-redesign 开出并通知。
- 范围（普查拟定，集成者照当时合并后的代码再核一遍）：依赖 hub-unknown-model 的契约字段。可以改：hub/runs/engine/terminals.ts、partitions.ts、submit.ts、queries.ts、start.ts（期限与启动时拒绝的一段）、evaluate.ts（路由与 errors 一段，约 600-725 行）、README.md；新增请求记录的写入与列出（其余几件用它）；hub/rules/check.ts 的 outcomeProblems；hub/runs/packs/validate.ts；hub/server/console/pages.ts；对应测试。evaluate.ts 的检查调用与来源读取一段归 hub-retry-split。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。枚举只来自生成的词表；Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对改到的目录；每条先写改前失败、改后通过的测试。

## 要做的

1. 在 BY_REASON 旁加出口表（satisfies Record<Reason, Exit>），每个未核对、未完成、未运行终态带 missing 和 exit；交付前边界拒绝没有出口的未知；outcomeProblems 拒收不带 data.missing 的包未知。
2. errors 点名每个未知（路径、缺什么、剩余轮数）并计一轮；错误表按原因的行可路由；缺的事实归到待判定产物上时给修复（case-review 负向用例那 33 个条目是第一个用例）。
3. 跳过：每个跳过条目一条错误（带模型的理由和剩余轮数）并计轮；SkippedItem.reason 进结果的未完成分区（W07 R[2] 的“附理由”）。
4. 轮数用完：写 B07 修复请求记录（运行、条目、要求项、领头的码），在 errors 和控制台列出；回执写明完整的新提交仍可取代；剩 0 轮的未覆盖改记修复轮数用完；“发请求”行写请求记录，“记未知”行写假设集（V08）并点名。
5. 运行期限：过期仍无已受理提交的运行，交付为全部条目未完成（提交未覆盖），给运行者发处置请求（以本运行为前驱续跑 / 放弃）；list_runs 和控制台列出未收口的运行与未回答的请求。
6. 内部失败也写校验动作（受理为空、内部码、重试提示）；getRun 显示“未校验（中断）”；启动时和定时重验孤儿提交。
7. 终态映射：装了检查却对条目零结果记未核对（检查出错，包缺陷）；出件失败后动态层记未运行（出件失败）；层上保留每个不同原因及其缺的事实；依赖被路由修复的要求项记“在等某一步”并指向那条修复。
8. 发布：声明的静态层没有检查即拒（requirements.no_check）；start_run：执行 knowledge.json 的 requires（拒绝并列出可选构建），声明有误的包拒绝并给包作者发修复请求；修好的版本发布后，提示运行者以原运行为前驱重跑；模型驱动的运行在根更新后给运行者发重跑请求；只保留来源上的引文给管理员发接受请求。
9. 控制台：产品页、差异页、运行页按已有游标翻页，截断处写明（pages.ts:257、397-408、476-477）。
10. hub-job-dispatch 合并后：把派发结局接进动态层终态和已隔离分区，自动发起核对；过去的结局仍观察不到时重证基线、以新修订重跑用例。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
