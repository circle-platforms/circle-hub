# 任务：追溯与看板补上正例和逐组核对，再做需求矩阵、测试类型覆盖和控制台结果页

依据：集成者 10-23 的终审（`docs/hub-r4-progress.md` 201、208 行）；能力 6 见架构 6a 第 6 项（`docs/hub-r4-architecture.md` 124 行）和 6b（138 行）。

- 追溯 79/79 相符，但已关闭缺陷只在“没有”一侧对上：那个构建 25 个已关闭缺陷，没有一个追溯到已索引的用例，正例没证明。
- 看板只核了各组之和（`scripts/real/accept/quality-board.ts` 4–5、131–143 行）。注释说分组按用例涉及的命令归属，这不对：版本线和模块是产品包按文档在敏捷树里的目录定的（`packs/product/famx/functions/cases.ts` 290–293 行），能从原始的敏捷树独立算出来。
- 没做：需求到用例的矩阵（追溯包的条目只有缺陷，`docs/hub-r4-tasks/traceability.md` 14 行）、按版本线和模块的模板覆盖、按记录算出的只读控制台页面（`hub/server/console/index.ts` 147–157 行没有这类路由）。

第 1、2 条是独立核对，只动 `scripts/real/`；第 3 到 6 条是功能。每条一个提交，测试先写。

- 分支和工作树：`gold-trace`，目录 `circle-hub-gold-trace`（依赖已装好）
- 可以改的路径：`scripts/real/` 里只动这些文件和它们的测试：新文件 `gold/trace-scan.ts`、`gold/board.ts`、`gold/trace-stories.ts`、`accept/story-traceability.ts`、`console-page.ts`，改 `gold/trace.ts`、`gold/join.ts`、`gold/cases.ts`、`accept/traceability.ts`、`accept/quality-board.ts`、`accept/capability-scenarios.test.ts`（只改追溯和看板两段）；`scripts/real/` 下别的文件不动，gold-d2c、gold-location、gold-review 和 hygiene-2 在改其中几处。`packs/workflow/quality-board/**`（`test-hub.ts` 除外，core-fixes 在改）；新包 `packs/workflow/story-traceability/**`；`packs/system/plm/**`（plan-evidence 第 4 条也改这个包，先后和版本号由集成者定）；`hub/server/console/**`、`hub/server/console*.test.ts`、`hub/server/fakes.ts`、`hub/server/README.md` 的控制台一节。改过的包升版本并重新签，发布由集成者做。`contracts/`、`hub/knowledge/`、`hub/runs/`、`hub/server/text.ts`、`hub/server/tools.ts`、`packs/product/`、`packs/workflow/traceability/`、`packs/workflow/template-gap/` 只读（测试里可以导入）；缺什么先回报。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。另外：
  - 独立答案脚本只读原始输入（脑图 JSON、敏捷树导出、修复缺陷页、PLM 原件），自己算，不导入 `hub/` 和 `packs/` 的代码；`scripts/real/gold/` 里的脚本互相导入可以。
  - 新脚本和新核对项在屏幕上只打计数、SHA-256 前 12 位和通过与否；构建名、编号、标题、模块名和命令只写进 `--out` 的文件。名字的摘要只用来和 `--out` 对号，不抄进进度：构建名和模块名能穷举出来。
  - 取值用 `contracts/generated/vocabulary.ts` 的类型，包函数里只 `import type`；运行时要整组取值的，照 core-fixes 给包生成 `functions/generated/vocabulary.ts` 的办法（它合并以后；登记要改 `tools/gen-contracts.ts`，先回报）。需要新的轴，回报给集成者，由集成者在模型里加轴。合成例子用 10.6 以后的版本线、192.0.2.0/24 的地址。
- 验证：`npx tsc --noEmit`；`node packs/workflow/quality-board/pack-files.ts --check`、`node packs/workflow/story-traceability/pack-files.ts --check`、`node packs/system/plm/api.ts check`；`node --test --test-concurrency=1` 对 `scripts/real/**/*.test.ts`、`packs/workflow/quality-board/**/*.test.ts`、`packs/workflow/story-traceability/**/*.test.ts`、`packs/system/plm/**/*.test.ts`、`hub/server/console*.test.ts`。

## 要做的

1. **找一个已关闭缺陷追溯到已索引用例的构建**：新脚本 `scripts/real/gold/trace-scan.ts`。
   - 输入：`--fixed-dir`（每个构建一份导出的 `Bugs_Fixed_with_<构建>.html`）、`--cases-dir`（导出的脑图）、`--tree`（敏捷树导出）；可选 `--docs-dir`（每个构建一份 `<构建>.json`，格式同 `trace.ts --docs`）、`--plm <文件>…`、`--closed-statuses`、`--case-rule`；`--out`。
   - 每个构建算：缺陷数、已追溯数、PLM 里已关闭的数、其中已追溯的数、状态未知的数。复用 `trace.ts`、`join.ts`、`cases.ts`、`locations.ts` 的函数。没给 `--docs-dir` 就用全部脑图，并在输出里写明没按构建的文档清单筛。
   - 屏幕上每个构建一行：`#序号 <构建名的 SHA-256 前 12 位>：缺陷 N；已追溯 T；已关闭 C，其中已追溯 CT；状态未知 U`；最后一行 `建议用 #序号`（CT 最多的；都是 0 就取 T 最多的），或 `没有找到已追溯的已关闭缺陷`。
   - `trace.ts` 补两处：
     - 加 `--tree`：用例带的缺陷号也算文档在敏捷树里的标题和目录（产品包就是这样取的，`packs/product/famx/README.md` 238–239 行），用 `locations.ts` 的 `extractAssociatedIds`；
     - `--closed-statuses` 现在只认纯数组（`trace.ts` 420–424 行，`join.ts` 241–245 行同样），包里的表却是 `{statuses: [...]}`（`packs/workflow/traceability/tables/closed-statuses.json`），传表文件会被悄悄忽略、退回默认值。两种都认，别的形状报错退出。读这张表不循环：读的是“哪些状态算已关闭”这份声明，不是包算出的结果。
   - 场景 `scripts/real/accept/traceability.ts`：加一项“已关闭且已追溯的缺陷至少 1 个”，独立答案里没有就不通过，写明正例没核到。核对项的名字、期望和实际不再写缺陷号和用例号，改成序号、SHA-256 前 12 位和个数。
   - 测试：合成三个构建，只有一个有已关闭且已追溯的缺陷，扫描建议它；PLM 没返回的、bugzilla 的不算已关闭；前导零；`--docs-dir` 筛掉清单外的文档；编号只在敏捷树目录里的也算追溯；表的两种写法和错的写法；屏幕输出里找不到任何合成的构建名、缺陷号和标题。
   - 集成者之后跑：导出全部修复缺陷页、脑图和敏捷树（`circle-hub original list --external <前缀>` 重定向到文件，一次最多 500 行、不翻页，多了按更长的前缀分批；`circle-hub original export <sha256> --out <文件>`）；`node scripts/real/gold/trace-scan.ts --fixed-dir <目录> --cases-dir <目录> --tree <文件> --out <文件>`；挑已追溯最多的几个构建，用 `node scripts/real/hub-call.ts --token-file <文件> --max 0 --structured <文件> start_run '<追溯运行的参数>'` 在部署的 Hub 上各开一次追溯运行（屏幕上只有字符数），让 Hub 读 PLM 状态，导出 `plm:bugs:` 原件，再加 `--plm <文件>… --closed-statuses packs/workflow/traceability/tables/closed-statuses.json` 扫一次；对建议的构建用 `trace.ts`（加 `--docs`、`--tree`、`--plm`、`--closed-statuses`）出独立答案，再跑 `HUB_REAL_TOKEN=… node scripts/real/accept-circle.ts --scenario scripts/real/accept/traceability.ts --gold <文件> --out <目录>`，全部通过，屏幕上只有序号、个数和通过与否。找不到这样的构建，就记下正例仍没证明。

2. **看板逐组独立核对**：新脚本 `scripts/real/gold/board.ts`。
   - 输入：`--tree`、`--cases-dir`、`--docs`（这个构建的根读到的文档清单）、`--product`、`--build`、`[--case-rule]`、`--out`；输出 `BoardGold`（`scripts/real/accept/quality-board.ts` 11–32 行）。
   - 每份文档：版本线和模块用 `locations.ts` 的 `locationsGold`（版本线用 `lineKey` 的写法，空的记 `unplaced`）；用例、无期望、含糊、负面用 `cases.ts` 的 `caseGold`。按 `<版本线>/<模块>` 求和。
   - 屏幕只打：文档份数（其中不在树里的、没有用例的各几份）、分组数、四项合计、分组表的 SHA-256 前 12 位。
   - 场景：把各组之和换成逐组比：每组用例数相同，三项比例等于用独立计数算的 `percentOf`；摘要里写了个数（第 3 条以后）就比个数。组的集合也要相同，多几组、少几组都报。核对项按组的序号和组名的 SHA-256 前 12 位命名。照追溯场景用 `scripts/real/lib/pager.ts` 翻页。改掉 4–5 行的注释。
   - 测试：两条版本线、几个模块、一份目录不合约定的文档（模块记 unplaced）、一份不在树里的文档；一个用例从一组挪到另一组、总和不变，场景必须不通过；少一组、多一组也不通过；屏幕输出和核对项名字里没有组名和标题。
   - 集成者之后跑（第 3、4 条发布之前）：`node scripts/real/gold/board.ts --tree <文件> --cases-dir <目录> --docs <文件> --product famx --build <构建> --out <文件>`，四项合计要等于 10-23 那次的独立计数；再跑 `accept-circle.ts --scenario scripts/real/accept/quality-board.ts --gold <文件> --out <目录>`，逐组全部通过。

3. **看板摘要写出个数**（`packs/workflow/quality-board/functions/board.ts` 33–35 行），照合计句（`totals.ts` 74 行）写成 `用例 20 个；无期望结果 1 个（5.0%）；含糊期望 1 个（5.0%）；负面用例 1 个（5.0%）`。重新生成样例，改测试、README、SKILL，包升补丁号。集成者发布后用第 2 条的场景重跑，逐组比个数。

4. **按版本线和模块的测试类型覆盖，放进质量看板**。
   - 为什么放看板：看板的条目本来就是整个构建用例索引的（版本线，模块）分组；模板查缺一次运行读三十份左右的脑图（`packs/workflow/template-gap/README.md` 205 行），条目是文档，没有版本线和模块。用例条目带着原样的标签（`packs/product/famx/functions/cases.ts` 334 行），六种测试类型能按分组算。其余 18 个类别按路径、标题、步骤（个别还有期望）里的关键词判定，索引里没有步骤和期望的文字，看板不给这些类别并写明看不到；按文档的完整缺口仍由模板查缺给。
   - `facets` 槽改成可以绑两个视图（`many: true`，只给一个时照旧）：计数视图，加上标签视图 `knowledge:facets:<产品>:<构建>?kind=case&by=line,module,tags`。不能合成一个视图：列表字段每个取值计一次（`contracts/src/views.ts` 100 行），用例数会重复。两个视图要同一个产品、同一个根，不是就拒绝运行；两个都是计数视图或别的组合也拒绝，修正说明写清怎么绑。
   - 标签归到六种测试类型：把 `packs/workflow/template-gap/functions/tags.ts` 16–23 行和 `tables/template-v3.json` 7–12 行抄成看板自己的表和函数；测试里导入 `template-gap` 的 `canonicalTag`，在几千种写法上比对，分开就失败。
   - 每组给出：出现了哪几种类型、哪几种没有用例带标签、没打标签的用例数（标签为空那一行，精确）。不给“每种几个用例”：一个用例写了同一类型的两种写法会被算两次。不加阈值，不加违规码。视图截断或有没读到的来源时，写“在已读的来源里没看到”，并标“部分”。
   - 摘要后面接 `；未打标签 N 个；没有用例带这些类型的标签：压力测试、兼容性测试`；没绑标签视图时和现在一样。
   - 独立答案：`cases.ts` 给每个用例留下原样标签，`board.ts` 加 `--types`；写法表从 `template-gap` 抄数据（抄的是声明，不是包算出的结果），归类代码自己写。独立答案带类型时场景才绑标签视图，逐组比没有的类型和没打标签的数。
   - 测试：六种都有、一种都没有、只有没打标签的；不认识的标签；一个用例两种写法；截断；根不同被拒；不绑标签视图时结果不变；10 万个随机用例上和独立计算比；次序无关；发布校验；生产运行端到端。包升小版本。
   - 集成者发布后：`board.ts --types` 重出独立答案，再跑看板场景。

5. **需求到用例的矩阵**：新的工作流包 `packs/workflow/story-traceability`，文件照 `packs/workflow/traceability`。
   - 另做一个包，不并进追溯包：一个工作流只有一个被判对象所在的输入槽（`contracts/src/pack.ts` 411 行），追溯包的槽名、条目编号和结论文字是现有 SKILL、场景和独立答案在读的。
   - 一个构建有哪些需求，Hub 里现在没有来源（发布说明只列缺陷）。条目是调用方给的需求号；SKILL 让模型向用户要编号，不猜（`docs/hub-r4-architecture.md` 101 行）。
   - PLM 包先加批量读 `plm:stories:<编号>+<编号>+…`，照 `plm:bugs`（`packs/system/plm/system.json` 102–108 行，`functions/plm.ts` 56、125 行）：最多 50 个，按数值排序去重；内容 `{stories: [{id, status, stage, title}], unread: [...]}`，状态和阶段原样。包升小版本（plan-evidence 第 4 条也升这个包，版本号接在先合并的那件后面）。
   - 输入：`stories`（被判对象，接受 `plm:stories`，可多个）和 `cases`（期望来源，`knowledge:index:<产品>:<构建>?kind=case&key=stories&fields=document,node,title`）；不绑定产品线。
   - 证据规则照缺陷：编号按数字规范化后精确比较；至少一个已索引用例带这个需求号记支持，数据里列出用例；没有记未知（缺输入），写明索引按构造不完整；PLM 没返回的需求号也是条目，状态记未知，不当成任何状态。运行级计数：需求数、已追溯、未追溯、PLM 没返回的，按 PLM 原样状态分开计；不定哪些状态算“已交付”。
   - 两条完整性反驳照追溯包（列出的用例的原始编号里没有这个需求号；视图声明没截断却少于总数），给发布校验做反例样例。
   - 独立答案 `scripts/real/gold/trace-stories.ts`：读需求号清单、`plm:stories:` 原件、脑图、敏捷树、文档清单；用例的需求号取用例标题、上面各级标签、文档在敏捷树里的标题和目录（和 `packs/product/famx/functions/cases.ts` 320 行同一组文字），用 `locations.ts` 的 `extractAssociatedIds`。场景 `scripts/real/accept/story-traceability.ts` 照 `traceability.ts` 写，核对项按序号命名；它的测试放新文件，不改 `capability-scenarios.test.ts`。
   - 测试照追溯包：一个用例、多个、没有；一个用例带两个需求；前导零；和缺陷号同号的需求号连不上；PLM 没返回；次序无关；2,000 个随机需求上和独立的两重循环比；发布校验；生产运行端到端（假的知识读取器、假的 PLM）；`ids.ts` 和追溯包的规范化在测试里比对。PLM 包：分组与上限、没返回的编号、编号是数字和字符串两种写法。
   - 集成者发布、分配以后：准备一份需求号清单（已追溯的和没有用例的都要有），先用 `hub-call.ts --max 0 --structured <文件>` 开一次运行让 Hub 读 PLM，导出 `plm:stories:` 原件；`node scripts/real/gold/trace-stories.ts --stories <文件> --plm <文件>… --cases-dir <目录> --tree <文件> --docs <文件> --out <文件>`；再跑 `accept-circle.ts --scenario scripts/real/accept/story-traceability.ts --gold <文件> --out <目录>`。屏幕上只有计数和通过与否。

6. **控制台的生产运行结果页**：新文件 `hub/server/console/results.ts`，`index.ts` 147–157 行加路由 `results`，`html.ts` 111 行的导航加“结果”。
   - 通用，不写包名：生产运行是要求项全由事实生产者给出的运行（`docs/hub-r4-architecture.md` 127 行；看运行记录的 `requirements[].accepted_producer`）。
   - `/console/results`：读者看得到的生产运行（`RunsService.listRuns`：用户只看自己的，管理员看全部），新的在前，可按任务包和构建筛，分页沿用列表的游标；一页筛完是空的也给“下一页”。
   - `/console/results/<运行>`：`getRun` 的最新结果。分区计数（`countsLine`）、覆盖、跨条目主张（`claimBlock`），然后一个条目一行：编号、名称、摘要、每个要求项的静态层终态和主张陈述，未知用自己的样式。500 行一页，可按静态层终态筛（取值和标签用生成的词表）。记账型运行的总体只显示“已交付”和分区计数，不写“通过”（V06 R[4]）。链接到运行页（权威视图）。不存在、看不到、不是生产运行、编号格式不对，都给同一个“对你不可用”页（404）。
   - 安全规则照现在的控制台，不另开口子：Host 和 Origin 检查（`hub/server/app.ts` 77–84 行），只接受 GET，每页重新认证令牌（`index.ts` 175–183 行），CSP 不许脚本和外部资源（`html.ts` 91–98 行），所有值经 `html` 转义。
   - 测试（新文件 `hub/server/console-results.test.ts`，临时 PostgreSQL，用 `hub/server/fakes.ts` 74 行只含事实要求项的假包）：用户甲看得到自己的、看不到乙的（乙的运行和不存在的编号回答一模一样），管理员都看得到；不是生产运行的给“对你不可用”；条目名称里的 `<script>` 被转义，页面没有脚本、没有外部地址，CSP 头在；POST 是 405；错的 Host、外来的 Origin 是 403；没登录跳登录页；令牌撤销后会话立刻失效；1,200 个条目分三页，每页的分区计数相同，且等于按分区直接数的；未知不显示成通过或不通过。
   - 给集成者的 `scripts/real/console-page.ts --token-file <文件> --path <路径> [--url <Hub 地址>]`：令牌从文件读、不打印；走登录表单登录、取页、退出；屏幕只打状态码、有没有 CSP、脚本标签数、外部地址数、每张表的行数、正文的 SHA-256 前 12 位。测试用合成服务器，断言页面上的合成名称不出现在输出里。
   - README 控制台一节同步。
   - 集成者部署后：用 `console-page.ts` 取 `/console/results?build=<构建>` 和第 1、2 条那几次运行的 `/console/results/<运行>`：状态 200、有 CSP、脚本 0、外部地址 0，条目表的行数等于运行的条目数。

完成后在终端里回报：提交号、测试数量、第 1、2 条两个脚本在合成数据上的一次屏幕输出、哪些值需要模型加轴、没做完或拿不准的地方。

## 分三件做（集成者 2026-10-23）

按起草时的建议拆开，三块路径不重叠、互不依赖：

- `gold-trace`（本分支）：第 1–4 条。路径：`scripts/real/gold/**`、`scripts/real/accept/{traceability,quality-board}.ts` 和它们的测试、`packs/workflow/quality-board/**`。gold-case-commands 的答复第 7 条（质量看板写出未归位数）也归这一件。
- `story-trace`：第 5 条。路径：`packs/system/plm/**`、新包 `packs/workflow/story-traceability/**`、`scripts/real/gold/trace-stories.ts`、`scripts/real/accept/story-traceability.ts` 和它们的测试。
- `console-results`：第 6 条。路径：`hub/server/console/**`、`hub/server/console*.test.ts`、`hub/server/fakes.ts`、`hub/server/README.md` 的控制台一节、`scripts/real/console-page.ts`。

三件都不改 `scripts/real/accept-circle.ts`（这一轮归 gold-template-gap），要注册场景的先回报。

## 集成者对待定问题的答复（2026-10-23）

1. 拆分照上面。
2. 需求矩阵另做一个包 `story-traceability`：一个工作流只有一个被判对象槽，追溯包的槽名、编号和结论文字已经有人在读。
3. 一个构建有哪些需求：集成者先从已存的 PLM 构建原件核对有没有需求字段，有就告诉 story-trace 从构建记录取；在那之前，SKILL 向用户要编号，不猜。需求的真实状态和阶段取值，也由集成者核对后告诉终端。
4. 需求的哪些状态算已交付或已关闭，转给所有者；在那之前按原样状态计数。
5. 按测试类型的精确用例数、其余模板类别按版本线和模块的覆盖，等 K1（产品包）合并后再定。
6. 看板的独立答案只核归属和计数，不核这个构建该索引哪些文档；选取的核对以后另开一件。
7. 结果页照 R02 只给运行者和管理员看；要不要分享，转给所有者。
8. `accept-circle.ts` 的屏幕输出这一轮由 gold-template-gap 统一改；这三件不碰它。
