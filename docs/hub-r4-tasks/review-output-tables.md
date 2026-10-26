# 任务：用例评审的输出按测试子项分表，每行对上原始用例和评审意见

依据：

- 所有者 2026-10-23 晚的新需求（`docs/hub-r4-progress.md` 377 行，记在决定 35）：AI 评审的输出不好看，原始用例和评审建议对不上；要按测试子项分表格输出。
- 决定 17（评审只提出问题）、26（生成在客户端，Hub 只核验；“Hub 不生成内容”不改）。
- 模型：I01（能确定性生成的产物不让模型写）、W01；显示规则 2、3、12、13、17（`contracts/model.json` 的 `displayRules`；第 17 条：模型原样转述，控制台运行页是权威视图）。元素用 `node tools/show-element.ts I01 W01 D05` 读。
- 架构第 6 节评审方法第 6、7 步：报告的材料取自复核方，结论和等级照抄；分块时整体取各块最差。
- 理论文档 `docs/design/truth-docked-architecture.md` 第 3 节 R7（候选的生产和检查分开）、第 6 节“零转录”那一段。

- 分支和工作树：`review-output`，目录 `circle-hub-review-output`（从 core-fixes 开出，依赖已装好；core-fixes 也改这几个包的 README 和清单，合并时排在它后面）。这是所有者点名的需求，先做；hub-pack-findings 排在它后面，在它改过的投影上改。
- 可以改的路径：
  - `packs/workflow/case-review-report/**`、`packs/workflow/case-review-verify/**`；
  - `packs/workflow/case-review/SKILL.md`、`README.md`、`pack.json`（只改“评审最后一步”那两处，重新签名）；
  - `tests/acceptance/26-review-report.test.ts`；`tests/acceptance/support/review.ts` 只加辅助函数；
  - `docs/hub-r4-guide.md` 的“用例评审”一节；
  - 核心（`hub/**`、`contracts/**`）不改，缺什么先停下回报。例外一处：`hub/server/console/**`，运行页加一节“投影字符串字段（只读）”，通用、转义、不写工作流的字段名（集成者当时答的“完整的表放在控制台运行页”，补记为决定 42）。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；git commit -s）。所有者的规矩：Hub 只核验，不生成内容、不调用模型——表里只有已受理的记录和源文件原文，排法是固定规则，不新增主张；未知只能是过渡状态，写明缺的事实和下一步动作；枚举只来自生成的词表，包里的码和中文名只来自包里的表；核心不出现产品词。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 "packs/workflow/case-review-report/**/*.test.ts" "packs/workflow/case-review-verify/**/*.test.ts" "packs/workflow/case-review/**/*.test.ts" tests/acceptance/26-review-report.test.ts`（数据库测试别和别的终端同时跑）；`node packs/workflow/case-review/packaging.ts check case-review case-review-verify case-review-report`。

## 调研

SyntheticReference 的 test-list-review 和 review-verifier（只读参照，下面是自己的话）：

- 初评按严重、主要、次要三档列发现，每条写用例文件的行号和一句说明。
- 复核交一份研究报告：摘要；逐条核对（证实、推翻、部分正确，证据是“文件:行号”加短引文）；新发现（带严重程度和证据）；等级质疑；改进建议（补什么用例、为什么、期望结果）；最后两行固定写法的结论和等级。
- 终稿由初评方按复核材料用中文自己组织：结论和等级照抄，复核列的每条发现都要写进去，再存成文件。
- 发现和用例只靠行号对应，不按测试项、子项分组，建议也不挂到用例上。那边的说明里提到，用户看完评审常接着要求“转成表格”。

Hub 现在：

- 初评、复核的发现都按条目（用例）提交，带位置和逐字引文（`packs/workflow/case-review/SKILL.md` 第 3 节，`packs/workflow/case-review-verify/SKILL.md` 第 2 节）。
- 复核的改进建议是跨条目主张，样例的 grounds 是空的，挂不到用例上（`case-review-verify/SKILL.md` 33、120–126 行）；处置说明的样例只写“初评发现属实”，看不出问题本身（77 行）。
- 终稿正文由模型自由写，建议另立主张（`case-review-report/SKILL.md` 21–24 行）；不分块的评审不用终稿（8 行）。终稿投影给条目的摘要只有发现的 rec: 引用和推翻条数（`case-review-report/functions/projection.ts` 66–74 行）。
- 回答文字是通用的：条目一行“编号 | 名称 | 摘要”（`hub/server/text.ts` 435–453 行），主张一行“字段：值”，每个字段最多 1500 字（81、167–171、690–698 行）；初评条目的摘要最多 200 字（`case-review/functions/projection.ts` 163–176 行）。没有分组，也没有用例原文。
- Circle（按 `foundation/circle` 1.0.4 源基线读）：工具结果默认只显示 6 行（`src/tui/tool_rows.ts` 19、272–276 行），用户完整看到的只有模型的回答。回答里的 Markdown 表画成带框的表、格内自动折行；格里的 `<br>` 照原样显示成字（`src/ink/components/markdown_renderer.ts` 56–98、241–313 行）。

测试子项在哪：

- kityminder@1 的解析结果按文档先序列出节点，带 parent、children、规范选择器和原始 data（`hub/refs/parsers/kityminder.ts` 113–176 行）。
- case-review 投影把用例以外带 priority 的节点当分组（`functions/project.ts` 209–223 行），`fields.path` 是从根往下的祖先文字（288–292 行）；用例里面，叶子是期望结果，优先级 3 的叶子是前置条件，有子节点的孩子是步骤（362–385 行）。
- 合成脑图 `tests/fixtures/mindmaps/review-150.km.json`：文档 → 测试项（优先级 1，如“基本功能”）→ 测试子项（优先级 1，如“探测结果”）→ 用例（优先级 2）→ 期望结果。但“配置 › CLI”下面的“IPv4”“IPv6”没有优先级，两边有同名用例。按“往上最近的分组”分，这 13 个用例并成一张表；按“用例的上一层节点”分，是 8 个、5 个两张表。按后一种分法，这份脑图是 17 张表、67 个用例（写这一页时用 case-review 的投影数过）。

## 定下的做法

- 表由 case-review-report 的投影在 Hub 里排：纯函数，确定性，在沙箱里跑，开始终稿运行时冻结进运行记录。模型用 get_nodes 读出来，原样贴进最终回答。
- 不做成 Circle 脚本（决定 26 那种）：两样输入都在 Hub 里。已受理的复核结果是 Hub 记录；敏捷平台上的脑图，客户端没有本地文件。放到客户端，就得让模型把几十 KB 的 JSON 从 get_nodes 抄进本地文件，抄错一个字就不是原文，这正是 I01 不许的。
- 这不是 Hub 生成内容：表里没有 Hub 新写的主张。用例原文逐字取自源文件；发现和建议是复核方已受理的陈述原样；计数和标签按规则算。它和终稿投影现在算整体结论、traceability 在投影里算矩阵是同一类，是已核验数据的视图（显示规则 12、13、17），不是决定 26 说的交给执行器的生成物。排表函数不依赖包外模块，以后真要放到客户端，Circle 脚本能直接导入同一个模块。
- 核心的回答文字不改：测试子项、用例原文是这个工作流的东西。get_nodes 读到字符串值时本来就按原样分行、分页显示（`hub/refs/resolve.ts` 351 行，`hub/server/text.ts` 1091–1092 行）。
- 每次评审的最后一步都开终稿运行，不分块也开（verifications 只写一条）。表只在这里排。
- 测试子项 = 用例往上第一个既不是用例、也不在用例里面的节点；找不到时算文档根。所有者在真实文档上确认前先按这条做。
- 终稿不再另写建议主张：建议在表里，取自复核方。“补、因为、期望”三段的检查挪到复核包，并要求每条建议指向它针对的用例或测试子项。

## 表的样子

合成例子（用例文字取自 review-150，评审文字是编的；省略了几行和几张表）：

```text
## 用例评审结果：<文档标题>
- 整体结论 PARTIAL，等级 P5（Hub 按 2 块复核结论取最差算出）
- 用例 67 个，有发现的 9 个；发现 12 条（主要 5、次要 7）；建议 4 条；初评发现被复核推翻 2 条
- 用例原文逐字取自 src:48728fe18b2e…，原文的换行显示为 ↵；发现和建议是复核方（omega-checker 2.0）的判断，原样列出，内容未经平台验证；Hub 核对过位置、引文和处置是否一致

### 1. 配置 › CLI › IPv4
用例 8 个，有发现的 2 个；发现 2 条（主要 1、次要 1）；建议 1 条

| 序号 | 用例原文 | Hub 核对 | 评审发现 | 改进建议 |
| --- | --- | --- | --- | --- |
| 1 | widget health interval pool1 5；标签：Configuration；期望：show health 显示 pool1 的探测间隔为 5 秒 | 无 | 无 | 无 |
| 4 | widget health probe pool1 tcp；标签：Configure；期望：show health 显示 pool1 的探测类型为 http | 无 | 【新增·主要·业务自相矛盾】步骤配的是 tcp，期望却写 http | 无 |
| 5 | widget health interval pool1 61；标签：Negative；期望：提示参数超出范围 1-60，探测间隔保持不变 | 无 | 【证实·次要】只测了越界值 61，没有测 0 | 【次要】补：探测间隔为 0 的反向用例；因为：只测了上界外的 61；期望：提示参数超出范围 1-60 |
| 8 | 修改探测间隔后立即生效；标签：Function；前置：已配置 pool1，探测间隔为 10 秒；步骤 1：widget health interval pool1 2 → 2 秒后按新间隔发出探测 | 无 | 无 | 无 |

### 跨子项（落在文档或更上层的节点上）
- 发现：【新增·主要·覆盖缺口】（位置：基本功能）没有用例同时测探测超时和重试次数
- 建议：无
```

## 要做的

1. **排表函数**：新文件 `packs/workflow/case-review-report/functions/tables.ts`，纯函数，只导入包里的模块和 `tables/labels.json`（类型可以取自 `contracts`）。输入：目标脑图的 kityminder@1 模型、各块复核结果（validation@1 和它的记录摘要）、投影算出的整体结论、参数 `precondition_priority`。输出 `{ markdown, counts }`。
   - **用例**：各块已交付分区里的条目，用条目位置的选择器在目标里找节点。分区名用生成的类型（`'delivered' satisfies Partition`），不写分区列表。
   - **分表**：测试子项照上面的规则；每个子项一张表，按子项节点的文档次序；每个用例一行，按文档次序，序号从 1 起。嵌套用例归外层用例所在的子项。表名是从根的下一层到子项的节点文字，用“ › ”连；子项是文档根时写“（直接在文档根下）”。
   - **原文格**：标题；有标签时接“；标签：a，b”；再按次序接用例的每个孩子：优先级等于 `precondition_priority` 的叶子接“；前置：…”，别的叶子接“；期望：…”，有子节点的孩子接“；步骤 k：…”，它下面的节点按先序各接“ → …”。嵌套用例和它下面的节点不进外层用例的格；备注不列。
   - **发现格**：落在这个用例上的复核陈述（要求项 verification 里的模型判断），每条写“【处置·严重程度·问题类别】说明”。处置是证实、部分正确、新增；问题类别取 `data.probe`，没有就不写；说明是复核方的 text 原样。推翻的不进格，只计数。几条之间空一格；没有写“无”。
   - **建议格**：落在这个用例上的复核建议（码 suggestion 的模型判断），每条“【严重程度】陈述原样”；没有写“无”。
   - **落点**：
     - 发现按它的位置（结果里 resolutions 中指针以 `/location` 结尾那条的引用；没有时按提交它的条目）：从位置节点往上，先碰到评审过的用例，就进那一行；先碰到某张表的子项，就进那张表下面的“子项上的发现：”一行；位置是文档根或一直碰不到，就进最后的“跨子项”。
     - 建议按 grounds 里指向目标的节点，逐个照上面定落点：都在同一行，进那一行；都在同一张表，进那张表下面的“子项上的建议：”一行；其余进“跨子项”，一个都不指向目标的注明“没有写落点”。
     - 只认 `src:<目标摘要>/kityminder@1/<选择器>`，后面可以带 `/@字段` 或字节范围。
     - 同一处的几条：先按落点节点的文档次序，再按提交它的条目的文档次序，再按在结果里的次序；和块的次序无关。
   - **转义**：格、表名和列表里的文字都原样放，只做两件事：`\` `` ` `` `*` `_` `[` `]` `<` `|` `~` `&` 前面加反斜杠；换行（LF、CR、CR LF 各算一个）写成 `↵`，原文里本来就有的 `↵` 写成 `\↵`。倒过来做就回到原文（CR、CR LF 回成 LF）。
   - **头和尾**：开头“## 用例评审结果：<文档标题>”和三行：整体结论和等级；合计（用例、有发现的用例、发现按严重程度、建议、被推翻的初评发现）；来源和性质（照例子写，模型名取各块结论主张声明的模型）。每张表标题的下一行写这张表的用例数、有发现的用例数、发现数（严重程度只列不为 0 的）、建议数。最后是“### 跨子项（落在文档或更上层的节点上）”，发现、建议各一行，没有写“无”。
   - **计数**：`counts` 按子项列出同样的数和合计，供测试和以后的控制台用。
   - **码和中文名**：处置、严重程度、问题类别从新表 `tables/labels.json` 读，照 case-review 的 `tables/codes.json`（findings、ranks）和 case-review-verify 的 `slots.schema.json`（verification 的码）抄，写明出处；代码里不写这些码的列表。

2. **投影接上**（`functions/projection.ts`、`workflow.json`）：
   - `target` 改必填；加参数 `precondition_priority`（1 到 9 的整数或 null，默认 3，和 case-review 同名同义）。
   - target 不是脑图，或摘要和各块条目位置的源文件不同：开始运行被拒，修正说明写出该用的 `src:<摘要>`。
   - 终稿条目排到条目列表第一个（序号 0），回答截短时也看得到。
   - 整体结论算出来时：`fields.review_tables` 放上面的 Markdown，`fields.review_counts` 放计数；摘要在“整体结论码 …、等级 …（最差那块的，照抄）”后面接“；评审表 <n> 张：get_nodes 读运行记录的 #/items/0/fields/review_tables，原样贴进最终回答”。
   - 整体结论算不出时不排表；摘要写出缺哪一块的结论或哪些条目，以及下一步（把那一块复核完，或把缺的条目重新初评、复核，再开终稿运行）。hub-pack-findings 合并后这种情况在投影里就拒绝了，照它的写法改。

3. **终稿去掉建议主张**：`slots.schema.json` 去掉 `suggestion` 码；`requirements.json` 去掉 `suggestion_incomplete` 那一行，描述里删去建议；删掉 `functions/checks.ts` 94–99 行。`functions/report.test.ts` 292–296 行那个测试随规则挪到复核包，这边改成“再写建议主张被槽位模式拒收”，在提交说明里写明原因。样例和 `examples/` 跟着改（start-run 的例子加 target）。

4. **复核包**（`packs/workflow/case-review-verify`）：
   - SKILL 第 2 节第 2 条：处置的 text 写核实后的问题本身（这个用例哪里有问题、为什么），表里照这段列；处置也可以写 `data.probe`。77 行的样例照此改。
   - 第 6 条和第 5 节样例（120–126 行）：建议的 statement 按“补：<用例>；因为：<原因>；期望：<结果>”三段写；grounds 至少一条指向被复核脑图的节点：针对某个用例写那个用例，补新用例写它该放进的测试子项。
   - 新检查 `suggestion_targets`（`functions/verify.ts`，整次运行，阻断，判待判定产物）：每条建议要有指向目标的根据（`case-review-verify.suggestion_target_missing`），三段要齐（`case-review-verify.suggestion_incomplete`）。照 `verdict` 的办法（`verify.ts` 105–173 行）挂在第一个已处理的条目上，指针 `/cross_item/<k>`；`verification` 和 `suggestions` 两个要求项都列它，`verification` 加两行修复（2 轮）。码进 `tables/codes.json`；正反样例写进 `testing/samples.ts` 再生成。`end-to-end.test.ts` 270 行那条建议照新写法改。
   - SKILL 第 4 节（58–60 行）和 README 的 Limits：每次评审最后都开 case-review-report。

5. **初评包 SKILL**（`packs/workflow/case-review/SKILL.md` 9 行和第 7 节）：评审最后一步总是 case-review-report；最终回答贴它排出的表。

6. **终稿 SKILL 和 README**：
   - 什么时候用：每次评审的最后一步，不分块也用。
   - 开始运行：verifications 每块一条；target 写各块评审的同一份脑图，被拒时照修正说明换成 `src:<摘要>`。
   - 读表：运行记录的引用在回答“完整的槽位模式”那一行；get_nodes 读 `<运行记录>#/items/0/fields/review_tables`，有下一页就接着读完。
   - 最终回答：先贴表，一页接一页，只贴每页“原文…：”那行之后、页末说明和“追踪”行之前的内容，一个字不改，不重排，不合并格；再写“## 评审意见”，贴你提交并被受理的报告正文和证据缺口；最后一行写控制台运行页。你另外加的话标“模型转述，未经校验”。
   - 报告正文写简短的总体意见和等级理由，不重抄表里的用例和发现。
   - README：决定（在哪排、为什么、子项规则、落点、转义）；限制（格两端的空白不显示；备注不列；只排各块里交付了的用例，没进任何一块的用例不在表里）；版本说明。

7. **指南**：`docs/hub-r4-guide.md` 用例评审一节加终稿这一步和评审表。

8. **版本和签名**：终稿 2.0.0（target 改必填，去掉建议主张）；复核升次版本；初评升修订号（hub-pack-findings 已经升过的，在它之上再升）。`node packs/workflow/case-review/packaging.ts sign case-review case-review-verify case-review-report`。

## 必须有的测试

- 排表（`packs/workflow/case-review-report/functions/tables.test.ts`，纯函数；合成脑图用 `hub/refs/api.ts` 的 `kityminderParser` 解析）：
  1. review-150 全部交付：表的张数、次序和每张的行数，等于测试里另写的“用例的上一层节点”分法（不调 tables.ts）；IPv4、IPv6 各一张；嵌套用例“恢复一台后端后”在外层用例的子项表里，外层用例的格里没有它的字。
  2. 测试里现写的小脑图：一个用例直接挂在根下（表名“（直接在文档根下）”）；文字里有上面那 10 个字符、`↵`、LF、CR LF 和全角“｜”。每个原文格等于按格式用解析出的原文拼出的串；每行按没转义的 `|` 切正好 5 格；行里没有换行。
  3. 转义往返：固定种子的随机串（含这些字符、全角符号、emoji）编码再解码，原样回来。
  4. 落点，各一例：位置在用例节点、在它的期望叶子、在子项节点、在上层分组、在文档根；挂在条目 X 下、位置在用例 Y；没有位置。建议：根据指向一个用例、一个子项、两张表、不指向目标。
  5. 推翻的发现不进任何格，只进合计；没有发现的用例两格都是“无”；每张表和合计的数，等于测试从合成结果独立数出的数。
  6. 同样的输入两次，字节相同；块的次序倒过来，表一字不差。
  7. `largeDocument()` 里取 500 个用例分 5 块（终稿一次最多 500 个条目），输出不超过 8 MiB。
  8. `tables/labels.json` 的码和中文名等于两个源包的声明（测试读三份文件比）。
- 投影（`functions/report.test.ts` 里加）：target 没绑、不是脑图、摘要不同，各被拒，修正说明给出 `src:<摘要>`；终稿条目排第一，带 review_tables、review_counts，摘要里有 `#/items/0/fields/review_tables`；有块没结论、有条目没交付时不排表，摘要写出缺什么和下一步；`precondition_priority` 取 3 和 null 时，优先级 3 的叶子分别写“前置”“期望”。
- 复核包（`functions/verify.test.ts` 和样例）：建议指向用例节点、指向子项节点、没有建议，各被支持；没有指向目标的根据、只指向期望来源、少了“期望：”，各被反驳，挂在第一个已处理的条目上，指针对得上；发布校验带着新样例通过。
- 验收（`tests/acceptance/26-review-report.test.ts`，真 Hub、合成数据、脚本化模型）：
  - 两块复核（有证实、部分正确、新增、带根据的建议）以后开终稿（带 target）；按摘要的指针 get_nodes，读到原样的 Markdown 行，不是 JSON；IPv4 那张表的行数、一个用例的原文格、一条建议所在的行都对。
  - 只有一块的评审也能开终稿、出表。
  - 一条建议没写落点的复核被退回修复，改了以后受理。

## 集成者按决定 35 的原则定下（原来的待确认项）

1. 测试子项就按“用例的上一层节点”分，照上面的规则做；集成者在一份真实文档上只读核对一次，对不上再改。
2. 表在 Hub 的投影里排，是已核验数据的视图，不算 Hub 生成内容，决定 26 不变。
3. 没有发现的子项折成一行：“### <子项> —— 用例 N 个，无发现”。有发现的子项出整张表，完整的表在控制台运行页。测试照此改。
4. Hub 自己判出的字面和目录事实（空期望、重复用例、参数越界这类带归责的反驳）也进表，另起一列“Hub 核对”，写码的中文名和一句说明；没有就写“无”。码和中文名从包的表里读。
5. 有了表，终稿不再逐条引用每条发现（去掉 `finding_missing` 这类检查），只核整体结论和等级。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。在真实 Circle 里看表的效果由集成者做。

## 集成者 10-24 凌晨答 codex-e（收尾核对第 2 条）

已发布的包在沙箱里不能运行时导入包外的 `contracts/generated`，包要显示词表标签，就由生成器给包生成。可改路径补上 `tools/gen-contracts.ts` 和它的测试，做成通用的：生成器里一处登记“哪个包要哪些轴”，report 包是第一个用户，不写 report 专用的逻辑；给登记的包在包内生成码、类型、标签、守卫和 `labelOf`；标签只从词表取，生成物字节确定，`--check` 管住，没登记的包生成物不变；不改模型和词表取值。
