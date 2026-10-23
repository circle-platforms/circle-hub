# 任务：任务包与验收脚本：能算的给确定结论，不在未知上判通过

依据：

- 所有者 2026-10-23 的规矩：未知只是过渡状态，要写明缺哪个事实、取得它的下一步动作、由谁做、何时到期；流程自动执行这一步，或者写成请求交给具名的人。以未知结束的运行、报告或检查都是缺陷。
- 全量普查 `docs/hub-r4-research/unknown-sweep.md`：第 2 节缺陷、第 3 节设计缺口、第 4.2 节缺的动作、第 5.2 节数据缺口。下面各条写了位置和要改的模型元素，动手前先读普查里同一处的真实影响。
- 理论文档 `docs/design/truth-docked-architecture.md`；模型用 `node tools/show-element.ts <元素>` 读。

- 分支和工作树：`hub-pack-findings`，目录 `circle-hub-pack-findings`。等这一批（K2、core-fixes、views-and-notes、kb-sections、hub-job-dispatch 等）合并以后，由集成者从 hub-redesign 开出并通知。
- 范围（普查拟定，集成者照当时合并后的代码再核一遍）：第 1、2、5、7 条可以马上做；用到缺席观察和视图范围的部分等 hub-read-absence、hub-view-scope；regression-scope、maintenance-sweep、quality-board 等 views-and-notes 合并后再改；台架观察等 hub-job-dispatch。可以改：packs/workflow/**（各包的 functions、测试、checks.json、requirements.json、README、SKILL、版本号）、scripts/real/accept/**、scripts/real/gold/compile-check.ts；对应测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。枚举只来自生成的词表；Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对改到的目录；每条先写改前失败、改后通过的测试。

## 要做的

1. traceability：跳过为 0、没截断时，未追溯记确定结论（提示档反驳 traceability.untraced，写明覆盖范围），check.ts:156-165、check.test.ts:59-69、README、SKILL 同改；no_defects（project.ts:93-99）照视图事实说是哪种原因；Bugzilla 上的缺陷记“状态未读：系统未接入”；编号按（系统，编号）连接，两边都有的记撞号结论；缺陷视图按本构建的编号 only= 收窄。
2. case-review：负向用例没引用命令行时从用例自身的命令行取 phrases（subjects.ts:57），一行都没有时记提示档反驳；删去无槽位记录的死分支（checks.ts:35、case-review-verify verify.ts:59）；SKILL 写明跳过要附理由、会被续做；case-review-verify、case-review-report：缺判定记可修复的反驳，缺等级的草稿和缺块的报告在投影里拒绝，并列出要先复核的块或条目。
3. regression-scope、maintenance-sweep：合法的空范围给支持“范围为空”（check.ts:141、363）；maintenance-sweep 只在 skipped_from > 0 时记未知并点名文档；投影拒绝没带 catalog=commands@1 的影响视图；视图有键没内容时按摘要从树上读，不编“/ null → null”。
4. regression-scope、maintenance-sweep：按新的视图范围把“没有用例覆盖路径 P”记成确定的覆盖缺口，未归位的用例以数目加引用列出。
5. defect-to-case：检查时经 reads 按草稿用到的命令头读收窄的索引；SKILL.md:31 删去“缺口未修”。
6. case-location：未标记的编号两种都读，存在的那个定种类（expected.ts:50-60）；用例粒度用“带标签或带标记”（project.ts:79，决定 18）；在配置的根之外、构建站没列出的构建名都记确定结论（后者为提示档反驳）。
7. 验收脚本：任何以未知结束的检查判失败并打印原因（scripts/real/accept/traceability.ts、case-location.ts）；compile-check 里 Hub 缺结论算差异，逐位置比较不跳过。
8. quality-board、template-gap：未打标签的用例单独计数；阈值写进参数模式，由 start_run 拒绝非法值；template-gap 的 covered 一律给出。
9. case-compile、test-bed：依赖修复的要求项记“在等某一步”；清单里没有接口地址的设备在导入时拒绝。装的构建和当前会话的只读探测由 `dispatch-gateway` 做（`gateway-request-ids.md` 第 13 条，`hub-device-run.md` 第 6 条），记成带采集时刻的观察；这一件只读用那份观察，不另做一套探测。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
