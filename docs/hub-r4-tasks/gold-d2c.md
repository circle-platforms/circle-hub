# 任务：缺陷转用例的独立答案，补参数、引文重判、查重重算和多配对批跑

依据：

- 架构 6b（`docs/hub-r4-architecture.md` 137 行）：草稿和已有回归文档比命令和参数；每个期望结果都要是修复说明或手册的逐字引文。
- 终审（`docs/hub-r4-progress.md` 200 行）：
  - 比对脚本只比命令头，引文读 Hub 的判定、不重做（`scripts/real/accept/defect-to-case-compare.ts` 6–10 行）；屏幕上还列出命令头、主张原文和草稿标题（242–260 行）。
  - 期望文字可以改写引文，只有提示档的实体检查（`packs/workflow/defect-to-case/requirements.json` 53 行，`checks.json` 47–53 行）；引文可以来自任何绑定的来源（`functions/subjects.ts` 96–103 行）。
  - 后几轮都只跑同一个缺陷（进度 139、169 行），两个配对的比对是更早一轮的（94 行）；全量索引的查重重算（139 行）没有脚本。
- 独立答案照 `docs/hub-r4-tasks/accept-gaps.md` 3 行：自己解析原件，不导入包或核心的函数；Hub 的结论只在最后拿来比。

- 分支和工作树：`gold-d2c`，目录 `circle-hub-gold-d2c`（依赖已装好）
- 可以改的路径：`scripts/real/accept/defect-to-case-compare.ts` 和它的测试；新文件 `scripts/real/gold/command-domains.ts`、`scripts/real/gold/quotes.ts`、`scripts/real/gold/dup-recount.ts`、`scripts/real/accept/defect-to-case-batch.ts` 和它们的测试；`scripts/real/gold/command-diff.ts` 只把 22 行的 XML 读取器导出，行为不变。`regression-doc.ts` 只导入不改，`regression-doc.test.ts` hygiene-2 在改；`packs/`、`hub/`、`contracts/` 都不动，缺什么先回报。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。每步一个提交。测试里不起 Circle、不连 Hub、不调模型，外部调用都注入假实现；夹具里的命令照现有测试编（`widget …`、`demo …`），地址用 192.0.2.0/24。
- 独立性：只复用 `scripts/real/gold/` 里现成的文件格式解析（`command-diff.ts` 的 XML 读取，`regression-doc.ts` 的按目录最长匹配拆命令；`compile-check.ts` 389–416 行的 `parseCommandTree` 已按重载读出 `arg` 的属性，也可以导入）。它们不导入 `hub/` 和 `packs/`（`command-diff.ts` 2–6 行），被核的是 Hub 的目录检查、引文检查和查重，所以复用不会绕回被核的代码。判定、原因和满足状态的取值用 `contracts/generated/vocabulary.ts` 的 `VERDICT`、`REASON`、`REQUIREMENT_STATUS`，那只是封闭的取值集。报告里的分组（下面参数三类、引文四类）只是计数用的说明，不进任何记录；觉得要成为模型里的取值，回报给集成者，由集成者在模型里加轴。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1` 对 `scripts/real/accept/defect-to-case*.test.ts` 和 `scripts/real/gold/**/*.test.ts`。

## 要做的

1. **屏幕上只有计数**（`defect-to-case-compare.ts`）：只打计数、比例、摘要和通过/不通过的行；逐条的结果写进 `--details <文件>`，也只写位置（第几个草稿、第几条命令、第几个期望结果）和类别，不写原文。改相应的测试，加一条反例：输出里不出现夹具的任何标题、命令和引文。
2. **参数**（取值域放 `command-domains.ts`，比对脚本调用；没给 `--commands` 时这一节不比，照报）。
   - 取值域从命令树原件自己读：形状照 `packs/product/famx/functions/command-tree.ts` 1–3 行，类型和 `limit`、`length` 的读法照 `packs/product/famx/README.md` 134–143 行，各类型的合法写法照 `hub/rules/README.md` 111–114 行，可选参数可以跳过（同 73 行）。README 里的例外（帮助文字写了别的形式的 DOTTEDIP、联合类型展开超过上限、部署声明的参数类型）不仿，遇到记 `unknown`（`no_check`），不算合法。读不懂的 `limit` 也记 `unknown`（不照 `compile-check.ts` 424–438 行记不通过）。
   - 每条草稿命令（用同一份目录拆出命令头和参数值）：
     - 和回归文档里同一命令头的命令比：参数相同、命令头相同参数不同、文档里没有这个命令头，三类计数；反过来报文档的（命令头，参数）组合有几成草稿也用到。只报告，不判通过。
     - 对取值域：`support`（合某个重载）、`refute`（都不合，分个数、类型、范围、枚举）、`unknown`。目录里找不到命令头的命令行记 `refute`（不在目录里：FAMX 的命令目录声明完备，`packs/product/famx/product.json` 的 `catalogs`），单独计数，不记 `unknown`。
   - 和 Hub 比：`expects_refutation` 为假（没写的也算假，和包一样，`functions/subjects.ts` 75 行）的草稿要全部 `support`，`expects_refutation` 和 `negative` 都为真的草稿要至少一条 `refute`，别的组合记 `unknown`。按条目得出结论，和校验结果里这个条目 `commands` 要求项的满足状态比，报一致和不一致的条目数；含 `unknown` 的条目单列。
   - 包有两处判法和这里不同，不一致的条目按这两个原因单列：反向草稿包是逐步判的，哪一步被目录接受都算违规（`functions/checks.ts` 345–355 行），这里照要求项按草稿判；`commands_refutation` 用包自己的简化匹配（258–311 行：按空格切参数、按位置配、只核整数和端口的范围），不是 `catalog@1` 的判法。
   - 测试：每种类型、每种 `limit` 写法合法和越界各一例；可选参数跳过；参数多了、少了；DOTTEDIP 不是 IPv4、类型不认都记未知；目录里找不到命令头记 `refute`；没写 `expects_refutation` 的草稿按假判；反向草稿一步合法、一步越界，按“逐步判”单列；回归文档一侧三类各一例；Hub 判满足而这里判越界记不一致。夹具照真实形状（`arg` 元素带属性）；现有测试里 `<string name=…/>` 的写法不是真实形状（`defect-to-case-compare.test.ts` 149–165 行），一并改掉。
3. **引文重判**（`quotes.ts`，比对脚本调用）。
   - 匹配规则照 `hub/refs/README.md` 151–156 行自己写。测试把 `hub/rules/quote-vectors.json` 的 27 个向量当数据全部跑过：只读这个文件，不导入，也不改（那个目录 core-fixes 在改）。
   - 引用照 `hub/refs/README.md` 23–41 行自己解析：
     - `src:`：字节从 `--sources <目录>` 读（文件名是 sha256），先重算 sha256，对不上就停下报错；没有这份字节记 `unknown`（`missing_input`）。`json@1` 的 `p/…` 和 `text@1` 的 `l/…` 照选择器取片段再比（53–60 行），字符串以外的值记未知；带区间的照 40–41 行取。`markdown@1` 只核整份文字（片段是整份的一段，所以这是必要条件），结果单列。别的解析器记 `unknown`（`no_check`）。
     - `tree:`：根要是运行锁定的根；核引文在不在 `--manual` 给的这个构建的手册原件里（也是必要条件）；没给手册记 `unknown`（`missing_input`）。`rec:`、`entry:` 记 `unknown`（`no_check`），目标也记未知，不算进“其他来源”。
   - 每条引文按目标归类：缺陷记录的修复说明字段（摘要是 `defects` 槽绑定的来源，路径最后一段是 `--fix-field` 给的字段名）、缺陷记录的其他字段、锁定根或手册原件（`src:` 的摘要等于 `--manual` 原件 sha256 的也算）、其他来源。绑定关系从 `--run <run show 的 JSON>` 的 `run.sources`（`slot`、`reference`）和 `run.root` 读（`contracts/src/run.ts` 25–32、103–104 行）。没给 `--fix-field` 时缺陷记录不细分，来源这一行记未知。
   - 另报两个数：期望文字本身也逐字在同一来源里的；只有引文逐字、期望文字是改写的。
   - 和 Hub 比：条目里引文全部 `support` 为支持、有 `refute` 为反驳，和这个条目 `grounded` 要求项的满足状态比，报一致和不一致。
   - 测试：27 个向量；路径段带百分号编码；行选择器；区间；摘要对不上；没有字节；五种目标（修复说明、其他字段、手册、别的根、没绑定的摘要）；改写的期望文字；和 Hub 不一致的两个方向。
4. **全量查重重算**（`dup-recount.ts`）。
   - 输入：一个或几个导出的 `index-view@1` 文件（`--index`，可重复）、提交（`--drafts`）、命令树原件（`--commands`）、校验结果（`--result`）。
   - 草稿的命令头集合按第 2 条的拆法自己算。条目的命令集合取 `data.commands`，`/commands/a/b` 和 `a b` 两种写法都认。一个用例每条命令一个条目（`packs/product/famx/README.md` 227–231 行），按（`document`，`node`）去重后再数。
   - 每个草稿报三个数：命令集合相同的已有用例；其中反向标记也相同的；再其中规范化标题（NFKC、小写、空白折成一个空格、去两端空白）也相同的。第三个数大于 0 就是重复。和 Hub 的 `defect-to-case.duplicate_case` 主张比，集合相等才算一致。
   - 先核输入完整（字段见 `contracts/src/views.ts` 122–138 行）：草稿至少有一个命令头在某个文件的 `only` 里（没有 `only` 的文件算整份），这个文件 `truncated` 为假，命令头不在 `cut_keys` 里。做不到的草稿记 `unknown`（`integrity_unproven`），不报“不重复”。`skipped` 大于 0 照报，写明“不重复”只覆盖读到的文档。
   - 要求项写的是“标题相同或期望结果相同”（`requirements.json` 70 行），可条目不带期望文字（`packs/product/famx/README.md` 230–231 行），包也只比标题（`functions/checks.ts` 590–593 行）。期望结果这一支照实报“没法重算”，不补。
   - 索引里每个用例带哪些命令是 Hub 给的输入，这里不核（那是回归范围用例一侧的缺口），报告里写明。
   - 测试：两条命令的用例只数一次；同命令集合下标题不同、反向标记不同、两者都相同；命令头不在 `only`、在 `cut_keys`、视图被截断三种记未知；几个文件按条目摘要合并；条目顺序打乱结果不变；和 Hub 集合相等、不等。
5. **多配对批跑**（`defect-to-case-batch.ts`，集成者跑）。
   - 输入 `--pairings <清单>`（Git 之外）：产品、提示模板（占位 `{defect}`、`{product}`、`{build}`）、修复说明的字段名，和 N 个配对；每个配对是缺陷编号、构建、命令树原件、手册原件、回归文档的脑图原件和文档号。端点参数原样传给 `scripts/real/review-circle.ts`（用法见 9–13 行），Hub 令牌从 `HUB_REAL_TOKEN` 读。
   - 每个配对依次做：
     1. 回归文档的独立答案（`regressionDocGold`）里根标题要写着这个缺陷号，不然不跑、单列；
     2. 起一次 `review-circle.ts`（子进程，每个配对一个新的 Circle 目录）；
     3. 从它导出的调用日志（`parseCallLog`）找出这段时间 `start_run` 的运行（日志行带运行号，`hub/server/tools.ts` 339 行），用 `bin/circle-hub run show <运行> --json`（照 review-circle 149 行的调法）取运行记录和最新的校验结果，只认 `defect-to-case@` 的运行；没有就单列，有几个取最后一个有校验结果的，并报运行数；
     4. 受理的提交是 `submissions` 里 `result` 等于 `latest.record` 的那份（`hub/ports.ts` 127–143 行）；用 `hub-call.ts` 的 `callTools` 以 `get_nodes` 读 `rec:<它的 record>`，回答的 `content.text` 是这份记录 body 的规范 JSON（`hub/refs/resolve.ts` 331、351 行），body 就是收到的参数；不是规范 JSON 的提交，body 只有 `received.object`，照这个摘要用 `original export` 取原样（`hub/server/readers.ts` 45–47 行）；
     5. `run.sources` 里每个 `src:` 的字节（`defects`、`indexed_cases` 两槽，和包绑的命令行手册，`functions/expected.ts` 21–26 行）用 `bin/circle-hub original export` 导出到这个配对的目录；
     6. 跑第 2、3 条的比对和第 4 条的重算（索引用运行绑定的那份视图）。
   - 汇总所有配对的计数。配对按序号称呼（配对 k/N）；屏幕上不出现缺陷号、文档号、运行号、标题、命令、参数值和引文。子进程（review-circle、run show、original export）的标准输出和标准错误只写进这个配对的目录，不转到屏幕（review-circle 会打出模型端点的主机）。细节照第 1 条写进 `--out`（Git 之外，权限照 review-circle）下每个配对一个 JSON。
   - 退出码：通过行全过为 0，有不通过或未知为 1，用法错为 2。
   - 测试（Circle、Hub 命令和 hub-call 都是假的）：两个配对的汇总；根标题不写这个缺陷号的配对被拒；一轮里没有缺陷转用例的运行；受理的那份提交找对（含不是规范 JSON 的那种）；屏幕输出里不出现夹具的任何标题、命令、引文、缺陷号、文档号和假子进程打出的主机名。

## 集成者之后跑

合并以后在当前发布上跑，配对由集成者挑（配对有效、覆盖不同命令）：

```
HUB_REAL_TOKEN=<令牌> node scripts/real/accept/defect-to-case-batch.ts --pairings <清单.json> --out <目录> (--endpoint-from circle | --env-file <文件> --provider qwen --model <模型>)
```

屏幕上只有这些：

- 每个配对一行：运行数、提交数和受理数、修复轮（已用/上限）、五个要求项满足几项、任务包和它的摘要（`run.pack`、`run.pack_digest`）、各输入原件的 sha256；
- 汇总：草稿数、命令数；命令头和（命令头，参数）组合两个方向的重叠比例（只报告）；取值域三种判定各几条；引文按四类目标和三种判定的计数；期望文字是改写的条数（照报，算不算 6b 不通过由所有者定）；
- 通过/不通过：
  - 命令与参数：和 Hub 不一致的条目 0 个（第 2 条按原因单列的两类照报，算不算不通过由集成者定）；
  - 引文：判 `refute` 的 0 条，和 Hub 不一致的条目 0 个；
  - 引文来源：不是修复说明也不是手册的 0 条；
  - 查重：每个草稿的重算和 Hub 一致，且输入完整（不完整记未知）。

单独重算查重：`node scripts/real/gold/dup-recount.ts --index <视图.json> [--index …] --drafts <提交.json> --commands <命令树.xml> --result <校验结果.json>`，每个草稿按序号一行三个数，加是否和 Hub 一致。

完成后在终端里回报：提交号、测试数量、第 2 条记成未知的类型和写法、第 3 条认得的解析器和选择器、没做完或拿不准的地方。真实客户端上的批跑由集成者做。

## 集成者对待定问题的答复（2026-10-23）

1. 要求项写“标题相同或期望结果相同”，而索引条目不带期望文字：照页面做，期望这一支照实报“没法重算”。要求项的说法和实现不一致，记为包的待修项，不在这一件里改。
2. 架构 6b 要求期望结果本身是修复说明或手册的逐字引文，而包允许改写、只做提示档的实体检查：这是包和规格不一致，记为包的待修项（按 6b 改成阻断）。这一件只照页面报条数。
3. 引文来源：照页面，既不是修复说明、也不是手册的引文记为不通过。
4. 修复说明的字段名由集成者写进配对清单；包的 SKILL.md 和样例里那条解析不出的引用路径，记为包的待修项。
5. 规范化标题的规则就用页面写的（NFKC、小写、空白折成一个空格、去两端空白）；包的 README 要补写这条规则，记为包的待修项。
6. 全量重算要的索引由集成者按运行绑定的视图导出；草稿用到收窄范围以外的命令头时，由集成者另取视图。
7. `tree:` 引文只核到“出现在这个构建的手册原件里”，作为必要条件够用，报告里写明这一点。
8. 配对清单、导出的原件和输出目录都在 Git 之外，由集成者准备；批跑用的账号也由集成者定。
