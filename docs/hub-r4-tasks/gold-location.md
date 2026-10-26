# 任务：用例定位的构建候选、全树核对、人工抽查和按文档的回退

依据：集成者 10-23 的终审（`docs/hub-r4-progress.md` 198 行）。用例定位还有几处没在真实数据上证实：

- 构建候选从没和独立答案 `scripts/real/gold/builds.ts` 在真实数据上比过。场景只在 gold 带候选时才比（`scripts/real/accept/case-location.ts` 609–611 行），取的又是整份回答里的第一处候选（90、313 行）。
- 全树核对（进度 84 行）比的是产品包的用例索引分面视图（`packs/product/famx/functions/cases.ts` 292 行），不是定位包；定位包有自己的约定代码（`packs/workflow/case-location/functions/locate.ts` 28 行）。火车是在脚本外直接读条目比的；树里有多少份文档不在视图里，没有写。
- 关联编号的人工抽查只是报告里的一节（`case-location.ts` 126 行），没有记录。找不到某份文档的行时，场景拿整份回答去比（507 行）。

每条一个提交，先写测试。

- 分支和工作树：`gold-location`，目录 `circle-hub-gold-location`（依赖已装好）
- 可以改的路径：`scripts/real/accept/case-location.ts`、`scripts/real/gold/builds.ts`、`scripts/real/hub-call.ts` 和它们的测试，以及 `scripts/real/accept-circle.test.ts` 里 case-location 那一例（21–31 行）；新文件 `scripts/real/accept/location-tree.ts`、`scripts/real/accept/id-spot-check.ts` 和它们的测试。`scripts/real/gold/locations.ts`、`scripts/real/accept/location-index.ts` 只导入，不改。别的路径不动（定位包、产品包、`hub/`、`contracts/` 都不改）。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。另外：
  - 核对代码不导入 `hub/` 和 `packs/`；
  - 脚本在屏幕上只打印计数、sha256 和通过与否，不打印文档号、关联编号、构建名、版本线、火车、模块和标题；带值的明细只写进 `--out` 指的目录（0600，不覆盖，在仓库里的路径拒绝）；
  - 合成样例的版本线用 10.6 以后的。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1` 对 `scripts/real/**`。

## 要做的

1. **构建候选的独立答案收两个名称族**（`scripts/real/gold/builds.ts`）。
   - 列表页按名称族分页（`packs/product/famx/README.md` 113 行：页名里带名称族），一条版本线的两族构建在不同的页上。现在只读第一个 `--page`（193 行），基础构建不在这一页时“基于”的链就停下（139 行）。
   - 改成收多个 `--page`，几页合起来解析：跨页去重，“基于”的链在合起来的构建里解析。
   - 跑完打印一行：候选 N 个，FAMX a、FAMY b、别名 c、没有制作时间 d。不打印名字。
   - 测试：两份合成列表页，FAMY 页上的别名基于 FAMX 页上的构建；同一构建两页都有只留一份；打印的那行里没有构建名。
2. **场景必须比构建候选**（`scripts/real/accept/case-location.ts`）。
   - gold 里每份文档都要有 `buildCandidates`（第 1 条对它所在版本线的输出）。没有就在 `check` 里记一项不符，不跳过（609–611、665 行），构造场景时也不抛错（`capability-scenarios.test.ts` 219 行不带候选构造这个场景，只调 respond）。原来“没有 buildCandidates 时行为不变”的测试（`case-location.test.ts` 29 行）和 `accept-circle.test.ts` 21–31 行那一例改成不通过。
   - 这份文档的候选只从它自己的主张读：位置写着“条目 <文档>，要求项 build_candidates”的那条（`hub/server/claims.ts` 23 行）。“另有 N 个”也只从这条陈述里取：333 行现在取整份回答里第一个“另有”，会读到关联编号的“另有”（`locate.ts` 433 行）。一行被分页切开（“接上页：第 n 行的前 m 个字符在上一页”，`hub/server/text.ts` 1251 行）先接回去。没有这条主张，或者它是未知，记不符。
   - 逐个比，顺序也比：候选总数、别名数；按 `orderGoldCandidates`（75 行）的顺序比前 12 个，每个比名称、名称族、基础构建（别名写“基于”，不是别名的不写）、制作时间（到分钟；没有时是“制作时间未知”）、发布状态（“已发布”和日期，或“未发布”）；“另有”等于总数减 12。文字写法见 `packs/workflow/case-location/functions/candidates.ts` 53–58、93 行。
   - 覆盖：全部文档比到的候选里，FAMX、FAMY 和别名都至少有一个，否则记不符。
   - 合成的回答照真实写法（条目明细见 `hub/server/text.ts` 690 行）。测试：两族加别名的正例；15 个候选（前 12 个加“另有 3 个”）。反例各一个：gold 缺候选、回答缺候选、名称族错、基础构建错、制作时间错、发布状态错、顺序错、拿了别的文档的候选、把关联编号的“另有”当成候选的、没有 FAMY。
3. **按文档的回退和屏幕上的真实值**（同一个文件）。
   - 505–507 行：找不到这份文档的条目行，就拿整份回答去比。改成只从这份文档自己的地方读：start_run 里它的条目那一行，或者结果里位置写着这份文档、要求项 location 的主张。两处都没有，记一项不符，名称写“第 k 份文档”（gold 里的序号），不再到整份回答里找。288 行关联编号的同样回退一并改。
   - 511、523、536 行用 `has()` 按字面找 `文档 …[^\n]*…` 这样带正则写法的字符串，永远不成立，删掉。
   - 报告会打印到屏幕（`scripts/real/accept-circle.ts` 85 行）。核对的名称、期望和实际只写序号（第 k 份文档、第 j 个候选、第 i 个编号）、字段名和计数；473 行出错时不再带回答的前 120 个字；`buildManualPlmSections`（112 行）只写找到几个、没找到几个。
   - 测试：缺了一份文档的行、另一份文档的行有同样取值时仍不通过，名称是“第 k 份文档”；不通过的报告全文里没有 gold 里的任何值。
4. **全树核对**（新文件 `scripts/real/accept/location-tree.ts`）。
   - 输入：`--tree`（敏捷平台用例树的原件导出，和 `scripts/real/gold/locations.ts` 读的同一种），`--out`，可选 `--facets`（用例索引分面视图的 JSON，`location-index.ts` 读的那种）。
   - 独立答案：`locationsGold(tree).all`（`locations.ts` 421 行）给每份文档的版本线、火车、模块，火车也在脚本里比。这不循环：`locations.ts` 是独立答案脚本，不导入 `hub/` 和 `packs/`（9 行），被核对的是定位包自己的约定代码。读视图可以用 `parseFacetView`（`location-index.ts` 83 行），它只读视图的格式。
   - `--collect --token-file <文件> [--url <地址>] [--batch 40] [--timeout-ms <毫秒>]`：
     - 把树里的文档按批开始定位运行：`start_run`，`pack: case-location`、`product: famx`，`inputs.documents` 是每份的 `agile:mindmap:<文档>`；
     - 用 `get_nodes {reference}` 读 `result.reference` 指的完整结果，取结构化应答里 `content.text` 的 JSON（`contracts/src/tools.ts` 107–108 行，`hub/server/tools.ts` 458 行）；
     - 一批被拒：path 是 `/inputs/documents/<k>` 的那几份记为缺、原因写错误码（`hub/runs/engine/inputs.ts` 216 行），其余的重开一次；没有 path 的错误整批记缺；
     - 每次应答原样存在 `--out/runs/` 下；不带 `--collect` 时只读这里存下的；
     - 调用经 `callTools`（`scripts/real/hub-call.ts` 48 行）。MCP 客户端默认 60 秒超时，61 行没传选项：给 `callTools` 加可选的单次超时，不给时不变。
   - 比较：每份文档取结果里（任何分区）它的 `location` 主张的 `statement.data`。版本线按 lineKey 比；火车和模块做 NFKC、去首尾空白后逐字比；null 只等于 null。
   - 屏幕上只打印：
     - 树里的文档数；
     - 相等、不等（分版本线、火车、模块）、缺（分开始被拒、结果里没有条目、条目没有定位数据）、只在结果里，各几份；
     - 有 `--facets` 时：树里有、视图里没有的几份，视图里有、树里没有的几份，视图的 `truncated` 和 `skipped`（`contracts/src/views.ts` 106–107 行）；
     - 树原件的 sha256，全部结果文件按名字排序连起来的 sha256；
     - 判定：不等、缺、只在结果里都是 0 才通过，退出码 0。
   - 带值的明细（文档号、字段、两边的值、缺的原因、视图里缺的文档）写 `--out/details.json`。
   - 测试用合成的树和假的调用函数，不连网：相等；三个字段各自不等；10.6 和 10.6.0 相等；null 对有值不等；按 path 记缺、其余重开；结果里没有条目、没有定位数据；只在结果里；分批（5 份、每批 2 份）；视图里缺的份数和 truncated；`runs/` 不覆盖；屏幕输出里没有合成的文档号和取值；源码不导入 `hub/` 和 `packs/`。超时：在 `hub-call.test.ts` 的假服务里加一个慢工具，超时短于延迟时出错，长于延迟时通过。
5. **人工抽查的样本和记录**（新文件 `scripts/real/accept/id-spot-check.ts`）。
   - `sample --results <第 4 条的 --out> --count <n> [--seed <s>] --record <文件>`，n 默认 10：
     - 从结果的 `location` 数据里取全部 `requirements` 和 `defects`，照定位包的写法记成 `plm:story:<编号>`、`plm:bug:<编号>`（`packs/workflow/case-location/README.md` 135 行），去重；
     - 按 sha256(种子加编号) 排序取前 n 个；没给种子就随机取一个；
     - 记录文件里每个编号带 `found: null`，由集成者人工查完填；
     - 屏幕上只打印总体数（需求、缺陷各几个）、抽了几个、种子和记录文件的 sha256。
   - `tally --record <文件>`：打印找到、没找到、没填各几个和记录的 sha256；全部填了、而且都找到才退出 0。
   - 测试：同一种子同一样本；n 大于总体时全取；仓库里的路径被拒；已有的记录不覆盖；tally 的计数和退出码；屏幕输出里没有编号。

## 集成者之后跑的（终端不跑）

列表页和树原件由集成者用 `circle-hub original export` 导出到仓库外，分面视图照上一轮的取法存下。

1. 每条要用的版本线：`node scripts/real/gold/builds.ts --page <FAMX 列表页> --page <FAMY 列表页> --line <版本线> --out <仓库外>/builds-<n>.json`。打印一行计数；挑 FAMX、FAMY、别名都不是 0 的线。
2. gold 至少 5 份文档、跨几条版本线和模块，每份的 `buildCandidates` 是它那条线的输出：`HUB_REAL_TOKEN=… node scripts/real/accept-circle.ts --scenario scripts/real/accept/case-location.ts --gold <仓库外>/location-gold.json --out <仓库外的目录>`。核对行只有序号、字段和通过与否，要全部相符。
3. 树原件导出后马上跑：`node scripts/real/accept/location-tree.ts --tree <仓库外>/agile-tree.json --facets <仓库外>/case-facets.json --out <仓库外的目录> --collect --token-file <仓库外的令牌文件>`。打印计数、sha256 和判定。
4. `node scripts/real/accept/id-spot-check.ts sample --results <第 3 步的目录> --count 10 --record <仓库外>/spot-check.json`；到缺陷系统里逐个查，把 `found` 填成 true 或 false；再跑 `… tally --record <仓库外>/spot-check.json`。

进度里只记这些计数和 sha256。

完成后在终端里回报：提交号、测试数量、场景报告和三个脚本在合成数据上打印出来的样子、没做完或拿不准的地方。

## 集成者对待定问题的答复（2026-10-23）

1. 抽查的编号照页面写进仓库外的记录文件，屏幕上只有计数、种子和 sha256。
2. 别的场景把真实值打到屏幕上的，记为后续待办，这一件不改。
3. 全树核对的批大小默认 40，什么时候跑由集成者定。
4. 独立答案和定位包的约定不同：不等的条目按原因分类报告（版本线节点取法、前缀代码、其他），不改定位包。定位包 README 里五个约定问题，由集成者转给所有者。
5. 做：全树核对拿运行结果 data 里的全部候选，和 `builds.ts` 逐字段比，`builds.ts` 的输出带上版本线。
6. 做：“bug to case”后面没分类的编号也抽。
7. 覆盖检查要的版本线由集成者挑，挑最新 12 个构建里就有 FAMY 别名的。
8. 做：`--facets` 报视图里缺的份数时按原因分开（没有用例节点、不是脑图、凭据只保留、原因不明），原因取自生产记录。
