# 任务：适用条件：章节开头的条件继承给子节，再加部件、内存、许可、部署形态四个字段

依据：

- 决定 35 知识库第 4 项（`docs/hub-r4-progress.md`）：章节开头的条件继承给子节，标明“继承自章节开头”，并带出处位置。
- 决定 35 知识库第 5 项：适用条件加部件、内存、许可、部署形态几个字段，只从闭集和明写的文字里取。这两项取代决定 24 的后两条（三字段保持窄、章节开头先不继承）。
- 调研 3（`docs/hub-r4-research/kb-real-sources.md` 39–65 行）：同一版本两份手册里 125 处按条件分叉，内存 51 处、许可 10 处、部署方式 5 处、芯片或卡 22 处；原来的三个字段表达不了“没有某部件时”；写在整节或整章上的条件占 7%。
- K1 的现状（`kb-sections` 分支，还没合并；按名字找，行号会变）：`packs/product/famx/functions/manual.ts` 的 `conditionsOf`（按 `TRIGGERS` 线性读）和 `toApplicability` 只读条目自己的文字，不从标题、兄弟块或别的行继承；平台只认 `PLATFORM_WORDS` 和“虚拟”“物理”，型号照写。README 里写“不继承”的两段（讲条件怎么读的那一段，和 Limits 里的那一条）写了这些限制。
- 模型：K02 F[6]、R[2]，B01 F[4]（`node tools/show-element.ts K02 B01`）。集成者改：
  - K02 F[6]：字段加这四个；章节开头的条件按位置继承给子节，标明来历；
  - K02 R[2]：新字段还没有能核对的观察，按 B01 F[4] 作为目标前提显示“未核对”，写明缺的是目标上的哪一项、下一步是观察（第 1 条做显示）。

  决定 35 第 5 项写的是“模型 K01 由集成者改”，字段在 K02 F[6]，集成者一并对齐。
- 词表加一个轴，照下面原样加。这一件在 `contracts/model.json` 里只许加这个轴，别的模型文字不动：
  - 轴 `applicability_field`，标签“适用条件字段”，归 K02；
  - 取值：`models` 型号、`platforms` 平台、`builds` 起止构建、`components` 部件、`memory` 内存、`licenses` 许可、`deployment_forms` 部署形态。

- 分支和工作树：`kb-applicability`，目录 `circle-hub-kb-applicability`。等 K1 和 hub-variables 第二步合并以后，由集成者从 hub-redesign 开出并通知。先后：
  - hub-variables 第二步（产品包在 `product.json` 的 `variables` 里声明变量，在参数里写 `${var:名字}`）先合并，这一件第 2 条直接照它声明；
  - FAMX 包里和 kb-links、kb-adoc 第二步改同一批文件（`manual.ts`、`producers.ts`、README、`pack.json`），`hub/knowledge/read.ts` kb-links 和 K2（kb-candidates）也改：合并排在它们后面，pack.json 的版本号和签名以合并后的为准，最后重签；
  - 也排在 famx-deployment-conventions 的 FAMX 那一步后面（同一批 FAMX 文件）；
  - 也加词表轴或重新生成 `vocabulary.ts` 的还有：K2、views-and-notes、kb-links、core-fixes、refs-diagnostics、review-output、hub-unknown-model。轴数写死在三处断言里（`contracts/src/vocab-axes.test.ts`、`vocabulary.test.ts`、`show-element.test.ts`）。后合并的一方重新生成，并改这三处的轴数；
  - kb-unversioned、hub-view-scope 排在这一件后面。
- 可以改的路径：
  - `contracts/model.json`：只加上面那个轴，照 `tools/gen-contracts.ts` 重新生成 `contracts/generated/**`；
  - `contracts/src/product.ts` 的 Applicability；
  - `hub/knowledge/digest.ts` 的 normaliseApplicability，`hub/knowledge/read.ts` 的 applicabilityText 和拼目标前提的那一段（约 524 行），`hub/knowledge/README.md` 里讲适用条件的那句；
  - `contracts/src/vocab-axes.test.ts`、`vocabulary.test.ts`、`show-element.test.ts` 的轴数；
  - `packs/product/famx/functions/manual.ts` 抽条件的一段，`producers.ts`（把生产器参数交进去），`types.ts`，`product.json`（manual 生产器的 params），`README.md`，`pack.json`，`testing/fixtures/manual.md`；
  - 对应的测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 枚举只来自生成的词表：字段名用上面的轴，显示用 labelOf；
  - Hub 只核验，不判断，不调用模型：条件由产品包的确定性生产器从原文抽，抽不出就留在原文，适用条件记“未声明”；
  - 核心里没有产品的字：闭集在包和部署数据里，核心只管形状和显示；
  - 未知只能是过渡状态：新字段在条目上记的是确定的“原文写了什么”，能不能满足要等观察，显示时写明缺什么、下一步是什么。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node tools/show-element.ts --vocab applicability_field`；`node --test --test-concurrency=1` 对 `contracts/**`、`hub/knowledge/**`、`packs/product/**`；`node packs/product/famx/api.ts check`。

## 要做的

测试全部用合成手册（`testing/fixtures/manual.md` 加段落），闭集用测试里给的合成参数。

1. **形状**：Applicability 加
   - components：`{ with?, without? }`，各是部件名的列表（原文写明“装有”或“没有”的）；
   - memory：下限、上限，各写字节数和是否含端点（布尔），另存原文写法；
   - licenses、deployment_forms：名字的列表；
   - inherited：继承来的字段，只写字段的码（上面轴的取值），不写章节路径和选择器。
     - 原因：Applicability 算进条目摘要（`hub/knowledge/digest.ts` 的 entryDigest）。出处放进去，就是把来历算进了内容（K02 F[1]、R[4]），改一个标题就会改掉所有继承它的条目；kb-adoc 两族里文字相同的章节也会对不上。
     - 位置照第 4 条，作为章节开头那一块的片段放进组成记录。“继承自章节开头：<章节路径>”在读时从那个片段推出来。

   normaliseApplicability 照新字段排序去重；applicabilityText 的字段名用 `labelOf('applicability_field', …)`，继承来的写“（继承自章节开头：<章节路径>）”。只放宽。

   新字段的显示（K02 R[2]、B01 F[4]）：部件、内存、许可、部署形态在目标上还没有能核对的观察。读出时在目标前提里写：“目标前提，未核对：缺目标上的<字段>观察；下一步：在目标上观察”，字段名照词表。

   测试：
   - 新形状的正例和反例；规范化以后顺序和重复不影响摘要；一个条件都没有的条目，摘要和现在一样；
   - 改了章节标题，继承来的条目摘要不变；
   - 显示文字里字段名来自词表，继承来的带章节路径（读时推出来的）；
   - 新字段在目标前提里显示上面那句。
2. **闭集**：部件、许可、部署形态只认闭集里的词。
   - 三个闭集是 `product.json` 里声明的变量 `FAMX_COMPONENTS`、`FAMX_LICENSES`、`FAMX_DEPLOYMENT_FORMS`，都是字符串列表，默认空列表（只给样例和试运行）；manual 生产器的 `params` 写这三个引用；
   - 真实同步时没设置会拒绝，所以集成者在启用那一版之前设好，空闭集就显式设成 `[]`；真实的闭集由集成者从手册里只读整理，这一件仍不碰真实值；
   - 写法照 K1 平台、型号的规则：“适用于 X”“仅 X 支持”“需要 X 许可”“装有 X 时”“没有 X 时”这一类，每个字段认哪几种写法列在 README；并列的几项要全部认得才算，一项不认得整组不抽；否定、例外、含糊的写法不抽，留在原文。“没有 X 时”记进 components 的 without。

   测试：三个字段各有正例；并列里有一项不认得；否定和例外不抽；“没有 X 时”记 without；变量设成空列表时一个都不抽。
3. **内存**：只取紧挨“内存”写明的数值加单位（GB、G、MB、M，换算写进 README），和“不少于、至少、大于、小于、不超过、以上、以下”这类写明的关系；“N G 内存的设备”记成上下限相同。没有数值的（如“内存较大时”）不抽。

   测试：几种关系各一例，含端点和不含端点分清；几种单位；没有数值的不抽。
4. **章节开头的条件**：
   - 章节开头指章节标题，和标题下在任何别的块、任何子节之前的第一个段落；
   - 从这里按第 2、3 条和 K1 现有的规则读出的条件，继承给这一节和下面各级子节的每个条目：签名条目、正文条目、表格拆出的行都算；
   - 同一个字段：条目自己写了就用自己的，否则用最近一级章节开头的；不同字段各取各的；
   - 继承来的字段只把码记进 inherited；章节开头那一块的片段加进条目的 fragments，排在条目自己的片段后面，由入树前的核对（K02 R[0]）一并核到，读时从它推出章节路径；
   - 内层和外层同一字段写得不同时用内层的，并在生产报告里列出，不悄悄丢；
   - adoc 生产器第二步映射到同一个文档模型（kb-adoc 第 4 条），这条规则原样适用。

   测试：章节标题和开头段落的条件继承到三级子节；子节自己写了同一字段；不同字段合在一起；表格行和签名条目也继承；inherited 的出处能回读成原文；内外层不同进报告；同样的输入两次产出字节相同。
5. **生产报告和 README**：报告按字段写抽到的条目数、继承来的条目数，列出内外层不同的地方。README 里写“不继承”的那两段照改。

   测试：报告里的计数和列出的地方对得上测试手册。
6. 包升小版本，README 同步，`node packs/product/famx/api.ts sign`。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
