# 任务：APV 包里的真实版本线约定挪进部署数据，包里只留合成的默认值

依据：

- 决定 35 知识库第 9 项（`docs/hub-r4-progress.md`）：APV 包里的真实版本线约定挪进部署数据（资源设置），包里只留合成的默认值。
- 进度 10-23 傍晚那条（`docs/hub-r4-progress.md` 233–235 行）：hygiene-2 加宽的全仓检查在 APV 包里还剩 6 处，和 K1 改的文件重合，等 K1 合并后再改。这一件一并改掉。
- 决定 29：推送的是压缩成新提交的干净分支，先过全仓检查。这些真实值要在推送之前清掉。
- 模型：D01 DEF 和 R[8]（产品方言档案进 Git、不带真实数据；部署实例由管理员管、不进 Git），B04 F[0]（资源配置里有“源到知识树的映射”），R01 R[1]（`node tools/show-element.ts D01 B04 R01`）。集成者在 D01 补一句：产品包约定里的真实取值放在部署数据里，经资源配置生效，包里只留合成的默认值。
- 同一个机制还给两件用：kb-adoc 名称族的属性集（决定 35 第 3 项）、kb-applicability 部件、许可、部署形态的闭集（第 5 项）。

包里现在的真实版本线。以 `git grep -nE '10[._][0-5]([._][0-9]+)*' -- packs/product/apv` 的结果为准，行号会变。K1 的最终收尾核对在 kb-sections 4108e7f6 上数到 20 行：`product.json` 9 行（min_line）、`cases-rules.ts` 23 行（DEFAULT_MIN_LINE）、README 11、104、105、245、377、378、422 行、`cases-sync.ts` 6 和 16 行、`naming.ts` 31 行、`cases-sync.test.ts` 6 行、`cases.test.ts` 385 行、`naming.test.ts` 60 行。4108e7f6 已经换掉了 `documents.ts`、`types.ts`、`naming.ts` 136 行以后、`sync-plan.test.ts`、`adapters.test.ts` 和 README 111 行里的。分类如下：

- 代码里的约定：
  - `product.json` 的 `sync.options.min_line`，和 `functions/cases-rules.ts` 23 行的 `DEFAULT_MIN_LINE`（`cases-sync.ts` 的 caseIndexOptions 用它，提示文字里也拿它举例）；
  - `functions/naming.ts` 32 行的 `MAINLINE_TOKENS`（版本号后面还算主线页的词），取值来自一条真实版本线的名字，31 行的注释写着那条线。
- 只在注释和 README 里的：
  - 哪几条线的 NSAE 构建自带命令树（README 104–105 行）。代码按列表页判断（`select-build.ts` 的 resolveBase、`builds.ts` 的 hasCommandTree），不用改；
  - 哪几条线比哪条新（`cases-sync.ts` 16 行，README 367–368 行）；
  - 页名和目录名的例子（`naming.ts` 139–141 行，`types.ts` 98、110 行，`documents.ts` 2–4、16、22 行）；
  - README 11、111、237、412 行。
- 测试里的：`cases-sync.test.ts`（33、69、74–75、225–229 行一带），`cases.test.ts` 385 行，`naming.test.ts` 60 行，`sync-plan.test.ts` 117 行，`adapters.test.ts` 304 行。
- hygiene-2 检查剩的 6 处都在上面：`documents.ts` 16、22 行的 4 个目录名，`types.ts` 98 行的页名，`adapters.test.ts` 304 行的反例。

平台词（`naming.ts` 的 PAGE_PLATFORMS）不是版本线，属于产品方言（D01），这一件不动。

- 分支和工作树：`apv-deployment-conventions`，目录 `circle-hub-apv-deployment-conventions`。
  - 第一步要改的文件，别的分支也在改：K2 和 views-and-notes 改 `contracts/src/knowledge.ts`、`hub/knowledge/lists.ts`、`service.ts`、`context.ts`；kb-links 改 `contracts/src/product.ts` 的 ProductDeclaration（加 links）、`knowledge.ts` 的 TreeRootBody（加 links 快照）、`hub/knowledge/produce.ts`、`service.ts`、`builds.ts` 和重新生成的 product.v1、tree_root.v1 两个 schema。所以等 K1、kb-links、K2、views-and-notes 都合并以后，由集成者从 hub-redesign 开出并通知。
  - 第一步做完单独先合并，不等第二步。合并以后，kb-adoc 才接 product.json 的 adoc 槽和族属性参数，kb-applicability 才开工。
  - 第二步改 APV 包，等 K1、kb-links、kb-adoc 都合并以后接着做（集成者通知）。
  - kb-applicability、kb-unversioned、hub-view-scope 也改 `contracts/src/product.ts`、hub/knowledge 或 APV 包，合并排在这一件后面。
- 可以改的路径：
  - 第一步：`contracts/src/product.ts`（产品声明里可由部署给的值、部署定义的形状，注册 schema），`contracts/src/knowledge.ts`（组成记录写下所用的部署定义），照生成器重新生成 `contracts/generated/**`；`hub/knowledge/**`（`cli.ts` 的管理员命令，`sync.ts`、`produce.ts`、`lists.ts`、`service.ts`、`context.ts`）；对应测试和 README。
  - 第二步：`packs/product/apv/**`；`tests/fixtures/case-index/corpus.ts`；`.github/checks/docs-rules.ts` 和它的测试（第 7 条）；对应测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 真实值不进 Git，终端也不写真实值：测试和包里的默认值都用合成的，真实取值由集成者写进持久部署的部署数据；
  - 未知只能是过渡状态：没有部署数据时给确定的说明（按包里的默认值），写明下一步是管理员写部署数据；
  - 枚举只来自生成的词表；
  - Hub 只核验，不生成内容，不调用模型；核心里没有产品的字。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对 `contracts/**`、`hub/knowledge/**`；第二步再加 `packs/product/**`、`node packs/product/apv/api.ts check` 和 `node --test ".github/checks/*.test.ts"`。

## 要做的

### 第一步：部署数据怎么交给产品包（通用，合成产品测）

1. **产品包声明哪些值可以由部署给**：product@1 加可选的一段（名字回报），列出同步选项的名字和各生产器参数的名字。默认值照旧写在 `sync.options` 和生产器的 `params` 里，只许合成的。没列的键，部署不能覆盖。

   测试：声明的正例和反例（重名、指向不存在的生产器）；不带这一段的产品包照旧通过校验。
2. **存法照资源配置**（`hub/connectors/resources.ts` 开头的说明，`hub/records/authorizations.ts` 142 行的 configureResource）：
   - 一份定义（新 schema，名字回报）写产品 id、各选项、各生产器参数，按规范 JSON 存进对象库，由一条资源配置许可（许可种类 resource_config，对象写这个产品）绑定它的摘要生效；
   - 换值就是新定义、新决定，历史可查；只有管理员能写、能看；
   - `context.ts` 的 KnowledgeRecords 加上要用的两个许可方法，组装处传的记录对象里已经有；
   - 管理员命令放在 `hub/knowledge/cli.ts` 的 knowledge 命令下（例如 `knowledge settings <产品> --option <键>=<值> --param <生产器>.<键>=<值>`，另有只看的写法）；声明里没列的键、类型不对的值，拒绝并写明。

   测试：写入、改值、看历史；没列的键和类型不对的值被拒；非管理员写不了、看不到；许可对象和资源的对象不撞。
3. **同步和生产用它**：
   - 同步选项：包的默认 < 部署数据 < 这次命令给的（`hub/knowledge/sync.ts` 155 行合并 planOptions 的地方）；
   - 生产器参数：包的默认 < 部署数据（`produce.ts` 601 行、`lists.ts` 213 和 360 行一带交给生产器的 params）；按调用复用的键已经盖住参数，部署值变了就重产，没变就复用；
   - 组成记录写下所用的部署定义摘要（没有就是 null）；同步报告写一行“部署数据 <摘要>”，没有时写“没有部署数据，按包里的默认值”，下一步是管理员写部署数据。
   - 每个键的来源也要交下去，kb-adoc 要靠它写“这一族的属性集没有配置”：
     - ProducerInput 加 `param_sources`：每个参数键一项，`definition` 是给出它的部署定义摘要，取包里默认值的是 null；
     - Hub 把每个生产器实际用的参数和同样的来源写进组成记录（tree_root@1），生产器不用自己记；
     - 名称族这类按族给的值，声明成每族一个键（例如 `attributes.<族名>`），这样每族的来源各自分得清。

   测试：没有部署数据时产出和现在一样；有部署数据时选项和参数被覆盖；命令给的压过部署数据；`param_sources` 和组成记录里的来源对，只覆盖一个族时另一个族的来源是 null；改部署数据只重产用到它的根，组成记录的摘要对；同样的包版本、部署数据和源，两次产出字节相同。

### 第二步：APV 包（K1、kb-links、kb-adoc 合并以后，集成者通知）

4. **两个约定改由部署给**：
   - `product.json` 把 `min_line` 和主线页的词（现在的 MAINLINE_TOKENS）声明为可由部署给；
   - 包里的默认值：min_line 不设下限（定位得到版本线的文档都列），主线页的词为空；
   - `cases-rules.ts` 的 DEFAULT_MIN_LINE、`naming.ts` 的 MAINLINE_TOKENS 改成读选项；提示文字里的例子换成合成的版本线。

   测试：默认值下两个约定的行为；给了合成的 min_line 和主线页的词以后，列出的文档和页面的分类照变。
5. **注释、README 和测试**里比合成线早的版本线，全部换成 10.6 以后的合成线或说明性文字。测试要测的情形不变，比如“按发布火车的日期排，不按点号大小”那组，用合成线照样造出来。hygiene-2 剩的 6 处一并改。

   测试：改过的测试照过，测的情形和改前一样多。
6. **真实值**：README 写明 min_line 和主线页的词的真实取值是部署数据，由集成者照合并前包里的值写进持久部署，再升包版本发布；终端只用合成值。
7. **检查**：
   - `tests/fixtures/case-index/corpus.ts` 的 `MIN_LINE` 和那几行版本线跟着包的默认值走，也在这一步换成合成线。
   - 加一条全仓检查（`.github/checks/docs-rules.ts` 和它的测试）：除了 `foundation/`、`references/` 和锁文件，任何跟踪的文件里都不许出现比合成线早的版本线，点号和下划线两种写法都查，正则照上面 `git grep` 那一条。不留例外表；百分数、耗时这类误报照 hygiene-2 的做法改写。
   - hygiene-2 第三轮先清掉包外的其余各处，这一步合并时全仓应当正好清零，检查从这一步起生效。
   - 命令和结果写进回报。
8. 包升小版本，README 同步，`node packs/product/apv/api.ts sign`。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
