# 任务：回归范围与维护巡检的用例一侧独立核对，和未归位用例的披露

依据：集成者 10-23 的终审（能力 4，记在 `docs/hub-r4-progress.md`）。

- 变更路径和独立的命令树比较逐条相同（31 条），条目 491/491、111/111。但用例一侧不独立：期望条目取的是 Hub 自己 `get_nodes` 里种类为 `case` 的条目（`scripts/real/accept/scope-cases.ts` 11–14 行），没有一个 gold 从原始脑图里取命令（`scripts/real/gold/cases.ts` 1–13 行只计数）。
- 没有解析出命令的用例，索引给一条 `path` 为空的条目（`packs/product/famx/README.md` 227–231 行），留在根下，标为未归位（K04 R[6]），不在任何命令路径上，两个包都看不见它们。两包 README 只披露没有用例的路径和跳过的文档（`packs/workflow/regression-scope/README.md` 50–53 行、`packs/workflow/maintenance-sweep/README.md` 46–49 行）。上次是 10-22 量的：84,656 个用例里 58,162 个（`docs/hub-r4-progress.md` 44 行），之后没有重新量。A05 R[0]：没读完不说“没有”。
- 影响视图不带未归位的数（`contracts/src/views.ts` 56–85 行；合约和知识包有别的分支在改）。分面视图里空列表记为 null（`hub/knowledge/views.ts` 217–230 行），所以 `knowledge:facets:<产品>:<构建>?kind=case&by=commands` 里 `commands` 为 null 那一行的计数，就是没有解析出命令的用例数。
- 步骤要不要也扫，所有者还没定（`docs/hub-r4-tasks/agile-case-index.md` 74 行）。这一件不改索引：相等只按标题和上面的标签判，和索引一样；步骤只另量一个数给所有者。

- 分支和工作树：`gold-case-commands`，目录 `circle-hub-gold-case-commands`（依赖已装好）
- 可以改的路径：新文件 `scripts/real/gold/case-commands.ts`、`scripts/real/accept/command-index.ts` 和它们的测试；`scripts/real/accept/` 的 `scope-cases.ts`、`regression-scope.ts`、`maintenance-sweep.ts`，`scripts/real/accept-circle.ts`，和它们的测试（含 `capability-scenarios.test.ts`）；`packs/workflow/regression-scope/**`、`packs/workflow/maintenance-sweep/**`。`scripts/real/gold/cases.ts`、`command-diff.ts` 和 `tests/fixtures/case-index/**` 只导入、不改。别的路径不动（`packs/product/famx/**`、`hub/**`、`contracts/**` 有别的分支在改）。这两个包 core-fixes 也在改（生成的取值换掉手写的：两包的 `functions/check.ts`、`view.ts`、`scope.ts` 或 `sweep.ts`、`pack-files.ts` 和 `pack.json` 到 1.6.1，新加 `functions/generated/vocabulary.ts`）：第 4、5 步等它合并后，从合并后的 `hub-redesign` 开始做；第 1–3、6 步可以先做。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。每步一个提交。两个新脚本不导入 `hub/`、`packs/` 的任何东西；取命令的规则照 README 的文字写，不看 `packs/product/famx/functions` 的代码。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1` 对 `scripts/real/**`、`packs/workflow/regression-scope/**`、`packs/workflow/maintenance-sweep/**`；两包各跑 `node packs/workflow/<包>/pack-files.ts --check`。

## 要做的

1. **从原始脑图取命令**：`scripts/real/gold/case-commands.ts`，`--tree <该构建的命令树.xml> (--map <文件>:<文档编号> … | --maps <清单>) --out <gold.json>`，清单每行一个 `<文件>:<文档编号>`。
   - 认用例用 `gold/cases.ts` 的 `parseMindMap`、`caseNodesOf`，完整命令路径用 `gold/command-diff.ts` 的 `parseTree`（item 的路径才是命令，菜单前缀不是）。这两个本身是独立的 gold，不导入 `hub/`、`packs/`，用例数和命令差都已和 Hub 逐项对上；借它们读文件格式，不会变成拿 Hub 核 Hub。取命令这一段新写，不借 `regression-doc.ts`（没有缩写，切词也不同）。
   - 扫的文字和索引一样：用例标题和它上面的每个标签（含根节点），每段单独扫，路径取并集。
   - 规则照 `packs/product/famx/README.md` 172–176 行（短语怎样起止、什么不算命令）和 212–226 行：
     - 全角字母数字转半角，Unicode 空白和零宽字符转空格，竖向换行算行尾，不做完整 NFKC；
     - 命令词是连续的 ASCII 字母、数字、`-`、`_`；短语从某条命令开头的词起，到汉字、全角标点、句读、行尾或闭合的引号括号处断开，引号和反引号里的取到闭合处；粘在命令前的列表序号（`1.`、`2）`）去掉；
     - 不收散文：英文停用词或占位词（`xxx`）截回命令头；前面是英文词时只留命令头；单独一个词只在引号里、或是夹在汉字里的完整命令头而且后面没写“命令”时才算。停用词表 gold 自己列（README 只说“英文停用词”）；
     - 每个词的位置找最长的完整命令，不分大小写；一个词可以是它那一层唯一的前缀（至少两个字母，大写写法至少三个），靠缩写得到的命令至少两个词，首词缩写不收英文短词（gold 自己列一张小表）；树里没有的 `no <命令>` 归到它撤销的命令；
     - 命令后面的词算参数，到断开处为止，或者遇到另一条至少两个词的命令。
   - 编号：`data.id` 在这份文档的用例里唯一的，键是 `<文档>:<id>`；重复或缺失的标为不比较，只计数。Hub 的位置键和 `#k` 键（`@` 开头或 `#<数字>` 结尾）也不比较。文档编号去掉 `agile:case:`、`agile:mindmap:` 前缀。
   - 输出：命令树字节的 SHA-256；每个用例的键、能不能比、解析出的路径（排好序，每条带 `abbreviated`、`via_no` 两个布尔值和词数），步骤（用例下面带子节点的子节点，嵌套用例除外）里解析出的路径（只作测量）；合计。
   - 测试：汉字紧贴命令；内层词和首词的缩写，两个大写字母、单独的缩写、有歧义的前缀都不算；`no` 的两种情形；列表序号；全角、不换行空格、零宽字符；行尾断开；停用词和占位词截回命令头，英文语境只留命令头，单独一个词在引号里、夹在汉字里、后面写了“命令”三种情形；参数里夹着另一条两个词的命令；不是命令的分组标签（命令前缀、`IPv4`、带缺陷号的标题）；编号重复的不比较；嵌套用例拿到外层标题的命令；读不了的文件、坏的 XML 退出码非 0；4,000 条命令、2 万个用例几秒内跑完。再拿 `tests/fixtures/case-index/table.ts` 的手写真值逐行跑（树是 `catalog.ts` 的 `commandTreeXml(CATALOG_A)`，这两个文件不导入任何代码）：对不上的行在测试里列成已知差异，每行写原因，不改表。
2. **和 Hub 的索引视图比**：`scripts/real/accept/command-index.ts`，`--gold <gold.json> --index <视图.json> [--index …] [--out <报告.json>]`。视图是 `knowledge:index:<产品>:<构建>?kind=case&key=document&fields=commands,document,node` 的导出，大构建按 `only=` 分几份。
   - 条目的路径取自它的树引用（`tree:<根><路径>@<摘要>`，未归位的在 `/`），一个用例的条目合起来是 Hub 的命令集合；和条目里 `data.commands` 对不上的另计。
   - 有一份 `truncated` 为真、`cut_keys` 不空、`skipped` 不是 0（`contracts/src/views.ts` 136 行：这时缺的键是未知，A05 R[0]），或者几份的根不同：判“输入不全”，不判相等。
   - 屏幕上只有计数、摘要和判定，不出现编号和命令路径：两边都有、只在 gold、只在 Hub 的文档和用例，不比较的用例；命令集合相等、不等的用例；只在 gold 的路径（其中缩写、`no`、单词命令各多少），只在 Hub 的路径；未归位（gold、Hub、两边都、只有 gold、只有 Hub）；步骤测量（Hub 未归位的用例里，步骤能解析出命令的个数，不进判定）；两边“用例 → 命令集合”表的 SHA-256；末行 `判定：相等`、`判定：不相等` 或 `判定：输入不全`，相等才退出码 0。逐个用例的差异只写进 `--out`。
   - 测试：相等；只在一边的文档、用例、路径；两种未归位不一致；条目和 `data.commands` 对不上；截断、`cut_keys`、`skipped`、根不同；分几份导出和一份的结果相同；屏幕输出里没有编号和路径。
3. **条目核对的用例一侧换成 gold**（`scripts/real/accept/scope-cases.ts`）：
   - 加 `--later-cases`、`--earlier-cases`（第 1 步在两个构建上各跑一次的输出，各用自己的命令树）。给了就不要 `--later-nodes`、`--earlier-nodes`：期望的回归范围是后一构建里命令落在新增或修改路径上的用例，期望的维护巡检是前一构建里命令落在删除或修改路径上的用例；不比较的用例两边都去掉，只报个数。
   - 两种方式都改成屏幕上只有计数、每张差异表的 SHA-256 和判定，条目编号只写进新加的 `--out`（现在 260–322 行会把最多 50 个编号打到屏幕上）。
   - 测试：同一个小例子两种方式的期望相同；gold 多解析出一条命令时判不相等；不比较的用例不算；屏幕输出里没有编号。
4. **回归范围说出未归位的用例数**（`packs/workflow/regression-scope`，1.7.0）：
   - `workflow.json` 加可选输入槽 `facets`：角色 `hint`（同 15 行的 `behaviour` 槽；A03 R[6]：线索只作提示），接受 `knowledge:facets`，写法 `knowledge:facets:<产品>:<目标构建>?kind=case&by=commands`。
   - 新文件 `functions/facets.ts` 自己解析 `facet-view@1`（包函数只能加载包内模块，照 `view.ts`）；`view.ts` 把两个根留下（88–93 行现在只校验）。`project.ts` 照 `behaviourClue`（106–125 行）读这个槽：只收一个，`kind` 是 `case`，`by` 正好是 `["commands"]`，`build.root` 等于影响视图的目标根，不符就拒绝（`regression-scope.facets_view`，写进 `tables/codes.json`，修正说明给出正确写法）。
   - 未归位数：`values.commands` 为 null 那一行的 `count`；没有这一行、视图没截断，是 0；没有这一行、视图截断了，是未知。运行的说明里只放这个数和构建名（`note.unplaced`，`note.message` 末尾一句），不把视图的行抄进输出（`docs/hub-r4-tasks/defect-to-case-compact.md` 3 行：整份视图进了输出，超了沙箱上限）。
   - `check.ts` 的 `uncovered_changes`（211–267 行）加一条跨条目结论，`data` 带 `unplaced` 和构建名，照 A06 写明缺什么、为什么、出口：
     - 大于 0：未知（`missing_input`）：后一构建的用例索引里有 N 个用例没有解析出命令（未归位），不在任何命令路径上，回归范围不含它们，受不受这次变更影响不知道；出口是人工查看，或等归位提议（K04 R[6]）；
     - 等于 0：支持，没有未归位的用例；
     - 截断、数未知：未知（`integrity_unproven`）；
     - 没绑：未知（`missing_input`），未归位的数没有给出，写明怎么绑。

     “N 个用例没有解析出命令”这几个字固定，场景按它取数。只用 `check.ts` 已有的 `Outcome` 类型和取值；觉得要新的取值，回报给集成者，由集成者在模型里加轴，不要自己加。
   - 测试：上面四种各一；绑不绑分面视图，条目、原因和详情表都不变；不对的绑法被拒；`production.test.ts` 真实知识读取器那一例（247–317 行）：合成生产器的数据加上 `commands`，后一构建多一个没有命令的用例，绑上分面视图，结论说 1 个。
   - `requirements.json`、`SKILL.md`（开始运行时绑 `inputs.facets`，原样转述这一句）、README（The answer、Limits、How to test；Needs 写一句：影响视图要是每边带上未归位的数，就不用第二个输入）同步；`pack-files.ts --write`。发布由集成者做。
5. **维护巡检照做**（`packs/workflow/maintenance-sweep`，1.7.0）：分面视图绑前一构建（`build.root` 等于影响视图的起始根），代码 `maintenance-sweep.facets_view`；结论放在 `command_exists` 已有的索引说明旁边（`check.ts` 229–239 行，`sweep.ts` 149–154 行），写较早构建的用例索引里有 N 个用例没有解析出命令（未归位），巡检不含它们，它们的命令删没删、改没改不知道。测试和文档照第 4 步，真实读取器那一例在 `production.test.ts` 231 行。
6. **真实客户端场景**：
   - `scripts/real/accept/regression-scope.ts`（39 行）绑后一构建的分面视图，`maintenance-sweep.ts`（31 行）绑前一构建的；gold 文件加可选的 `unplaced`，有就核回答里“N 个用例没有解析出命令”的 N，核对项只写期望和实际两个数。`capability-scenarios.test.ts`（44、74 行断言了开始运行的输入）跟着改，相符和不符各一例。
   - `scripts/real/accept-circle.ts` 85 行把整份报告打到屏幕上，已有核对项的名字里带用例编号：改成屏幕只打一行汇总（共几项、相符几项、不符几项）和报告文件名，报告照旧写进 `--out`。

## 集成者之后在真实数据上跑（终端不跑）

1. 导出到仓库外的临时目录：两个构建的命令树（`circle-hub original export <sha256> --out <文件>`）、各自列出的用例文档、第 2 步写法的索引视图、两次运行的 `circle-hub run show <运行> --json`。
2. `node scripts/real/gold/case-commands.ts --tree <后一构建.xml> --maps <清单> --out <临时目录>/later.json`，前一构建同样。
3. `node scripts/real/accept/command-index.ts --gold <临时目录>/later.json --index <视图> … --out <临时目录>/later-index.json`，前一构建同样。屏幕上只有第 2 步列的计数、两个摘要和判定行；两边的未归位数就是重新量出的结果。
4. `node scripts/real/accept/scope-cases.ts --diff <命令差.json> --later-cases <later.json> --earlier-cases <earlier.json> --regression-run <回归.json> --maintenance-run <巡检.json> --out <临时目录>/scope.json`：计数、摘要、判定。
5. 两包 1.7.0 发布后，`HUB_REAL_TOKEN=… node scripts/real/accept-circle.ts --scenario scripts/real/accept/regression-scope.ts --gold <gold.json> --out <仓库外目录>`，巡检同样；gold 的 `unplaced` 填第 3 步 Hub 一侧的数。屏幕上只有汇总行。

完成后在终端里回报：提交号、测试数量、第 1 步对不上手写真值的行和原因、有没有要模型加轴的取值、没做完或拿不准的地方。

## 集成者对待定问题的答复（2026-10-23）

这一件从 `core-fixes` 分支开出（那边改过这两个包的生成词表），合并时排在 core-fixes 之后。

1. 未归位数先用分面视图 `by=commands` 的空行；K2 合并后要不要挪进影响视图，由集成者再定。
2. 分面视图的槽改成必填：Hub 对每个已建的根都能算出这个视图，能拿到的就该拿到，不留“没有给出”的未知。旧场景、金标准文件和 SKILL 一并改成绑定它，两个包升版本。
3. 这个槽的角色用线索（A03 R[6]），这个数只作披露，不作判据。
4. 金标准只照 FAMX 包 README 的文字规则写；代码注释里另有、README 没写的规则，第 1 步列出对不上的行。K1 合并后由集成者把这些规则补进 README。
5. 编号重复或缺失的用例这一件不比，按条数报。
6. 步骤要不要扫、缩写规则，仍是所有者的问题；这一件只给出测量数。
7. 质量看板也写出未归位数：归 gold-trace（那件管质量看板），这一件不改质量看板。
8. 大构建的视图超过上限时，比较脚本自己按 `only=` 分几份读完，不判输入不全；集成者负责导出。
9. `scripts/real/accept-circle.ts` 这一轮归 gold-template-gap，这一件不改它；要注册场景的，先回报。
