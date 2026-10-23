# 任务：模型与契约：未知只作过渡状态，必须带缺什么和出口

依据：

- 所有者 2026-10-23 的规矩：未知只是过渡状态，要写明缺哪个事实、取得它的下一步动作、由谁做、何时到期；流程自动执行这一步，或者写成请求交给具名的人。以未知结束的运行、报告或检查都是缺陷。
- 全量普查 `docs/hub-r4-research/unknown-sweep.md`：第 2 节缺陷、第 3 节设计缺口、第 4.2 节缺的动作、第 5.2 节数据缺口。下面各条写了位置和要改的模型元素，动手前先读普查里同一处的真实影响。
- 理论文档 `docs/design/truth-docked-architecture.md`；模型用 `node tools/show-element.ts <元素>` 读。

- 分工：模型文字（`contracts/model.json` 里各元素的定义、规则和变更记录）和理论文档第 117–122 行那一段由集成者先改，和 K2 合并后的模型对齐一起提交。这一件做契约代码：`contracts/src` 的形状、生成器和词表生成物、对应测试。下面各条里改模型文字的部分，以集成者那个提交为准。
- 分支和工作树：`hub-unknown-model`，目录 `circle-hub-unknown-model`。等这一批（K2、core-fixes、views-and-notes、kb-sections、hub-job-dispatch 等）合并以后，由集成者从 hub-redesign 开出并通知。
- 范围（普查拟定，集成者照当时合并后的代码再核一遍）：先做，其余五件用它的契约字段。可以改：contracts/model.json（加变更记录，来源写所有者 2026-10-23 的规矩），照 tools/gen-contracts.ts 重新生成 contracts/generated/**（--check 要过）；contracts/src/validation.ts（LayerResult）、contracts/src/tables.ts（check-outcome@1、range@1、catalog-entry@1、required 语义）、contracts/src/submission.ts、contracts/src/pack.ts（checks.json 的 limits）、contracts/src/resources.ts（read-projection-output@1 的 absent）；docs/design/truth-docked-architecture.md 第 117-122 行那一段；对应测试。不碰 contracts/src/views.ts（views-and-notes 在改）。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。枚举只来自生成的词表；Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对改到的目录；每条先写改前失败、改后通过的测试。

## 要做的

1. A06 写入总则：未知只作过渡状态，带缺什么、动作、受众、期限，由流程执行或写成请求交给具名的人，不作运行、报告、检查的终态；F[2] 删去“保持未知的处置决定”；加一条：过去某一时刻当场没记下的事实不进运行判定，只进事件记录，预防靠 B06 R[0]。
2. 词表加出口动作轴，取值只用模型已有的词：重读（D03 R[0]）、核对（D04 R[2]）、观察（P07）、请求（B07 四种）、新修订重跑（W06 R[0]）；V03 给原因轴的每个取值写出口规则。
3. 契约：check-outcome@1 的 unknown 与 LayerResult 的 unchecked/incomplete/not_run/no_verdict 加 missing 和 exit{action, request_kind, audience, due}；已存结果读出时缺 exit 的显示“出口未写”，不补造。
4. A06 R[0]、D03 R[1]/R[7]、D04 R[1]：丢回复后的未知，出口是核对（作业记录、请求记录、回读），核对不成就重证基线、以新修订重跑；B07 R[3] 与处置轴的“保持未知”改为带期限的暂缓，到期转核对或重跑；理论文档第 117-122 行保留“超时不当未执行”，补一句：本过程里协议事实都在，丢回执的未知只持续到核对。
5. V01 R[1]、V03 R[1]、P11 R[2]：声明的静态层没有检查即拒绝发布，动态层写明由哪个 P07 观察来填；V01 R[6]/P11 R[3]：检查自身的工作上限记未核对（预算用完），出口为调高上限或拆分重跑，P11 的预算只管效果。
6. C04 R[4]：必需位置缺失记反驳 core.structure.required_empty（data.missing），按提供主体的一方归责；C04 R[1]：range 阈值声明 empty: fail|pass，默认 fail；C07 R[1]：闭集缺席记反驳，目录不完整时记未知并给补全出口；C07 R[0]、K01/K05：索引视图声明完整范围，范围内的缺席是确定结论。
7. W02 F[7]：错误表可按码或按原因写行；W02 R[5]：轮数用完发 B07 修复请求；W07 R[2]：跳过在 errors 里点名、计入修复轮数、理由进结果。
8. W06：加提交期限，过期交付为未完成（提交未覆盖）并发处置请求；W06 F[1]：根更新后，确定性的只出事实运行可由 Hub 以原运行为前驱代跑新修订；W03：工作流可声明 predecessor: required。
9. D01：每个外部类型在每个环境类别里至多一个启用资源；D01 R[2]：路由可声明分页，同源重定向作为新的计划请求跟随；D05：有权读者面前，外部系统答“没有”是确定的观察（结构化 SOURCE_ABSENT），中性码只给无权读者，修正说明写下一步。
10. C04 R[6]、B02 R[4]：按决定 20，已点名来源类别的凭据命中在同步时自动接受并记录，命中可分页列出、按检测类接受；B01：validity_status 加“未评估”；catalog-entry@1：参数地址角色、地址或主机名联合类型、单数 limit 的解释；checks.json 允许单个检查声明 limits（不超过沙箱最大值）。

## 集成者答复（2026-10-24 凌晨）

- **05:28，答 codex-b**：check-outcome 的 unknown 必须有**顶层 `missing`**；`exit` 可选，由 Hub 按原因补。新写的 `LayerResult` 必须有 `missing` 和完整 `exit`。旧结果只读解析，缺出口显示“出口未写”，不补造历史事实；hub-unknown-exits 第 1 条同步按这一口径执行。
- **05:28，可改路径补充**：`hub/runs/packs/validate.ts` 只做原因行/码行选择器的最小接线及对应测试。
- **05:56，可改路径补充**：`hub/rules/catalog/params.ts` 的参数判型分支及对应测试，接上 `hostname`、`ip_or_hostname` 两个契约类型，不把目录类型改成包私有枚举。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
