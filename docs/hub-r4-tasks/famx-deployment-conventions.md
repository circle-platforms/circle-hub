# 任务：FAMX 包里的真实版本线约定挪进部署数据，包里只留合成的默认值

依据：

- 决定 35 知识库第 9 项（`docs/hub-r4-progress.md`）：FAMX 包里的真实版本线约定挪进部署数据（资源设置），包里只留合成的默认值。
- 进度 10-23 傍晚那条（`docs/hub-r4-progress.md` 233–235 行）：hygiene-2 加宽的全仓检查在 FAMX 包里还剩 6 处，和 K1 改的文件重合，等 K1 合并后再改。这一件一并改掉。
- 决定 29：推送的是压缩成新提交的干净分支，先过全仓检查。这些真实值要在推送之前清掉。
- 模型：D01 DEF 和 R[8]（产品方言档案进 Git、不带真实数据；部署实例由管理员管、不进 Git），B04 F[0]（资源配置里有“源到知识树的映射”），R01 R[1]（`node tools/show-element.ts D01 B04 R01`）。集成者在 D01 加了 R[11]（hub-variables）：产品包声明它读的变量，真实取值是部署数据，真实同步时没设置就拒绝。
- kb-adoc 名称族属性集（决定 35 第 3 项）的接线也挪到这一件（下面新的第 5 条）；kb-applicability 的闭集（第 5 项）照同样的写法做。
- 决定 29 的推送要等这一件合并、全仓检查清零（第 44 项）。

包里现在的真实版本线。以 `git grep -nE '10[._][0-5]([._][0-9]+)*' -- packs/product/famx` 的结果为准，行号会变。K1 的最终收尾核对在 kb-sections 4108e7f6 上数到 20 行：`product.json` 9 行（min_line）、`cases-rules.ts` 23 行（DEFAULT_MIN_LINE）、README 11、104、105、245、377、378、422 行、`cases-sync.ts` 6 和 16 行、`naming.ts` 31 行、`cases-sync.test.ts` 6 行、`cases.test.ts` 385 行、`naming.test.ts` 60 行。4108e7f6 已经换掉了 `documents.ts`、`types.ts`、`naming.ts` 136 行以后、`sync-plan.test.ts`、`adapters.test.ts` 和 README 111 行里的。分类如下：

- 代码里的约定：
  - `product.json` 的 `sync.options.min_line`，和 `functions/cases-rules.ts` 23 行的 `DEFAULT_MIN_LINE`（`cases-sync.ts` 的 caseIndexOptions 用它，提示文字里也拿它举例）；
  - `functions/naming.ts` 32 行的 `MAINLINE_TOKENS`（版本号后面还算主线页的词），取值来自一条真实版本线的名字，31 行的注释写着那条线。
- 只在注释和 README 里的：
  - 哪几条线的 FAMY 构建自带命令树（README 104–105 行）。代码按列表页判断（`select-build.ts` 的 resolveBase、`builds.ts` 的 hasCommandTree），不用改；
  - 哪几条线比哪条新（`cases-sync.ts` 16 行，README 367–368 行）；
  - 页名和目录名的例子（`naming.ts` 139–141 行，`types.ts` 98、110 行，`documents.ts` 2–4、16、22 行）；
  - README 11、111、237、412 行。
- 测试里的：`cases-sync.test.ts`（33、69、74–75、225–229 行一带），`cases.test.ts` 385 行，`naming.test.ts` 60 行，`sync-plan.test.ts` 117 行，`adapters.test.ts` 304 行。
- hygiene-2 检查剩的 6 处都在上面：`documents.ts` 16、22 行的 4 个目录名，`types.ts` 98 行的页名，`adapters.test.ts` 304 行的反例。

平台词（`naming.ts` 的 PAGE_PLATFORMS）不是版本线，属于产品方言（D01），这一件不动。

- 分支和工作树：`famx-deployment-conventions`，目录 `circle-hub-famx-deployment-conventions`。
  - 等 hub-variables 第二步、K1、kb-links、kb-adoc 都合并以后，由集成者从 hub-redesign 开出并通知，只做 FAMX 包这一步（原来的第一步由 hub-variables 第二步取代）。
  - kb-applicability、kb-unversioned 第二步也改 FAMX 包（`manual.ts`、`producers.ts`、`product.json`、README、`pack.json`），合并排在这一件后面；`pack.json` 的版本号和签名以合并后的为准，最后重签。
- 可以改的路径：`packs/product/famx/**`；`tests/fixtures/case-index/corpus.ts`；`.github/checks/docs-rules.ts` 和它的测试（第 8 条）；对应测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 真实值不进 Git，终端也不写真实值：测试和包里的默认值都用合成的，真实取值由集成者写进持久部署的部署数据；
  - 没设置的变量是确定的拒绝，真实同步在读任何页之前停下，写明 `circle-hub var set <名字>`；默认值只给样例和试运行；
  - 枚举只来自生成的词表；
  - Hub 只核验，不生成内容，不调用模型；核心里没有产品的字。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 "packs/product/famx/**/*.test.ts"`；`node packs/product/famx/api.ts check`；`node --test --test-concurrency=1 ".github/checks/*.test.ts"`。

## 要做的

原来的第一步由 hub-variables 第二步做；产品包在 `product.json` 的 `variables` 里声明变量，在 `sync.options` 和生产器 `params` 里写 `${var:名字}`；没有产品部署定义、`knowledge settings` 命令和新的许可对象；组成记录里的 `variables` 取代 `param_sources`。

### FAMX 包（hub-variables 第二步、K1、kb-links、kb-adoc 合并以后，集成者通知）

4. **两个约定改由变量给**：
   - `product.json` 声明 `FAMX_MIN_LINE`（字符串或 null，默认 null）和 `FAMX_MAINLINE_PAGE_WORDS`（字符串列表，默认空列表），`sync.options` 写这两个引用；
   - `cases-rules.ts` 的 `DEFAULT_MIN_LINE`、`naming.ts` 的 `MAINLINE_TOKENS` 改成读选项；提示文字里的例子换成合成的版本线。

   测试：按默认值和合成值各跑一遍；默认值只用于样例和试运行，真实同步必须先设置变量。
5. **adoc 接线（从 kb-adoc 挪来）**：
   - `product.json` 接上 adoc 生产器的槽；每个名称族声明一个变量 `FAMX_ADOC_ATTRIBUTES_<族名的大写>`（对象，键是属性名，值是字符串或布尔，默认空对象），`params.attributes.<族名>` 写引用；
   - `families.ts` 的说明不再提 `param_sources`，属性集的来历由 Hub 组成记录的 `variables` 写；`families.test.ts` 92 行一带的断言和 README 715–720 行的待办跟着改。

   测试：两族的合成属性集各自生效；只改一族的变量，只重产那一份。
6. **注释、README 和测试**里比合成线早的版本线，全部换成 10.6 以后的合成线或说明性文字。测试要测的情形不变，比如“按发布火车的日期排，不按点号大小”那组，用合成线照样造出来。hygiene-2 剩的 6 处一并改。

   测试：改过的测试照过，测的情形和改前一样多。
7. **真实值**：README 写明 min_line 和主线页的词的真实取值是部署数据，由集成者用 `circle-hub var set … --file` 写进持久部署，在这一版发布以后、启用以前设好；不设下限就显式设成 null。终端只用合成值。
8. **检查**：
   - `tests/fixtures/case-index/corpus.ts` 的 `MIN_LINE` 和那几行版本线跟着包的默认值走，也在这一步换成合成线。
   - 加一条全仓检查（`.github/checks/docs-rules.ts` 和它的测试）：除了 `foundation/`、`references/` 和锁文件，任何跟踪的文件里都不许出现比合成线早的版本线，点号和下划线两种写法都查，正则照上面 `git grep` 那一条。不留例外表；百分数、耗时这类误报照 hygiene-2 的做法改写。
   - hygiene-2 第三轮先清掉包外的其余各处，这一步合并时全仓应当正好清零，检查从这一步起生效。
   - 命令和结果写进回报。
9. 包升小版本，README 同步，`node packs/product/famx/api.ts sign`。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
