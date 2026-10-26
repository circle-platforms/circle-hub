# 任务：产品线“不分版本”的范围：规格文档和定不了版本线的用例文档挂进去，各版本都读得到

依据：

- 决定 35 知识库第 2 项（`docs/hub-r4-progress.md`）：没有发布记录的规格类文档，挂进产品线“不分版本”的范围，构建字段记未声明，各版本都读得到；普查 5.2 第 6 条那 762 份没有版本线的用例文档也这样处理。
- 普查 `docs/hub-r4-research/unknown-sweep.md` 5.2 第 6 条：产品同步从不列出的用例文档 762 份，670 份没有版本线，92 份所在的版本线没有构建；改法是放进不分版本线的范围，视图带上略去的计数。
- 调研 4（`docs/hub-r4-research/kb-real-sources.md` 74 行）：手册库的规格和 QA 文档还没读进知识库，K01 R[5] 的基线定下之前存而不挂。
- 模型：K01、K02 R[2]、K05、W06 F[4] 和 R[0]（`node tools/show-element.ts K01 K02 K05 W06`）。模型文字由集成者先改，再开这一件：
  - K01 DEF：每条产品线@版本一棵，另有一棵产品线不分版本的；
  - K01 R[5]：没有发布记录的规格类文档、定不了版本线的源进不分版本的范围，构建记未声明，依据是产品包的声明；
  - K01 R[6]：不分版本的范围也有一个当前根指针，移动规则同版本线；
  - K05 DEF、W06 F[4]：运行开始时同时锁定版本根和不分版本的根；换了其中一个就是新运行（W06 R[0]）；
  - K02 R[2]：不分版本的条目，“版本适用”的第二条看不分版本的根的组成，结论带“构建未声明”。

  动手时以集成者改后的模型为准，有出入写进 README。

- 分支和工作树：`kb-unversioned`，目录 `circle-hub-kb-unversioned`。等这一批（K1、K2、kb-links、views-and-notes、hygiene-2）和 hub-unknown-model（也改 `contracts/src/validation.ts`）合并、集成者改完模型以后，从 hub-redesign 开出并通知。先后：
  - hub-variables 第二步也改 `contracts/src/product.ts`（product@1 的 `variables`）、`knowledge.ts`（tree_root@1 的 `variables`）和 `hub/knowledge/sync.ts`、`sources.ts`、`produce.ts`。那一件先合并（它在决定 29 推送的路上），这一件第一步在它之后合并；不分版本的根的生产器照它解析变量，组成记录照它写 `variables`。
  - famx-deployment-conventions 的 FAMX 那一步和 kb-applicability 也改 FAMX 包，这一件第二步排在它们后面；`packs/product/famx/pack.json` 的版本号和签名以合并后的为准，最后重签；kb-applicability 还改 `contracts/src/product.ts` 的 Applicability 一段，和这一件第一步段落不同；
  - hub-retry-split 管着 `exact.ts` 和 `evaluate.ts` 的 80–560 行，这一件第 4 条要改其中两段：排在 hub-retry-split 合并以后；
  - hub-unknown-exits、hub-read-absence 也改 `hub/runs/engine/start.ts`、`submit.ts`、`hub/ports.ts`、`hub/server/text.ts`、`hub/server/console/pages.ts`、`packs/system/**`：这一件在这些文件里只动下面点名的几段，并行时后合并的一方解决冲突；
  - hub-view-scope 排在这一件后面。那一页第 10 条里“产品同步不列出的用例文档放进不分版本线的范围”改由这一件做，已从那一页拿掉；那一页第 2 条“略去的文档”只再数既不在构建的根、也不在不分版本的根里的。
- 可以改的路径：
  - 第一步：
    - `contracts/src/product.ts`、`knowledge.ts`、`run.ts`，`contracts/src/validation.ts` 的 Locks 一处，照生成器重新生成 `contracts/generated/**`；
    - `hub/knowledge/**`；
    - `hub/ports.ts` 的 KnowledgePort 和 RootInfo；
    - `hub/runs/engine/` 里：`target.ts`；`start.ts` 锁根的一段；`submit.ts` 里回注的 contributionScope 一段；`exact.ts` 的 `scopeProblem`；`evaluate.ts` 里 tree 引用的那一支（约 399 行）；`reuse.ts` 的 `unchanged()`；
    - `hub/server/text.ts` 的 start_run 回答一段；`hub/server/console/pages.ts` 的知识页和 `rootPage`；
    - 对应的测试和 README。
  - 第二步：
    - `packs/system/manual-store/**`；
    - `packs/system/openkm/functions/webdav.ts`、`system.json`、`README.md` 和 openkm 的 `pack.json`（只为和手册库那份保持一致：`webdav.test.ts` 逐字节比 webdav.ts，也比 system.json 里的读列表）；
    - `packs/product/famx/**`；
    - 对应测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 未知只能是过渡状态：产品还没有不分版本的根时，给确定的说明和下一步（同步这条产品线），不记未知；
  - 枚举只来自生成的词表：生产器只在不分版本的根上跑用布尔开关，组成的依据用现有的 `declared`，不加取值；
  - Hub 只核验，不生成内容，不调用模型：不分版本的根和版本根一样，由产品包的确定性生产器从源产出；
  - 核心里没有产品的字：规格目录、命名空间和文档的认法都在 FAMX 包里。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对 `contracts/**`、`hub/knowledge/**`、`hub/runs/**`、`hub/server/**`；第二步再加 `packs/system/**`、`packs/product/**`、`node packs/product/famx/api.ts check`，和 `tests/acceptance` 里受影响的。

## 要做的

### 第一步：核心（合成产品，放在 hub/knowledge 的测试支持里）

1. **契约**：
   - sync-plan-output@1 加可选的 `scope`：不挂版本线的源，按角色列出，写法同 BuildInfo.sources（一个或一列）；
   - 生产器声明加一个布尔开关（名字回报）：开了的只在不分版本的根上跑，没开的照旧只在构建的根上跑；
   - ProducerInput 的 build 在不分版本的生产里没有（`hub/knowledge/README.md` 约 690 行，Needs 里“contracts（milestone 2）”的第 (1) 条要的就是这个），已有的生产器照旧拿到构建；
   - tree_root@1 的 version 和 build、root_pointer@1 的 line 和 build，在不分版本的根上记未声明（null）；只放宽；
   - 运行摘要（`contracts/src/run.ts` 103 行的 root）和校验结果的 Locks 旁边，加不分版本的根。

   测试：几个新形状的正例和反例；旧的 tree_root、root_pointer 记录照样过校验。
2. **产出**（`hub/knowledge/sync.ts`、`produce.ts`、`store.ts`、`builds.ts`）：
   - plan 给了 scope，就用开了开关的生产器产一个根：和构建的根一样按内容寻址，源的摘要和生产器都没变就跳过；
   - 组成记录里每个源的依据记 declared，决定人是产品包 id@版本；
   - 每个产品一个不分版本的当前根指针，名字和任何版本线的指针都不撞（`store.ts` 195 行的 pointerName），照现在的比较并交换移动、留记录；同步报告单列一行；
   - plan 没给 scope 的产品照旧。

   测试：有 scope 的同步产出两类根；只改 scope 的源，只重产不分版本的根，构建的根不动；什么都没改，两次同步字节相同；指针名不撞；没给 scope 的产品，构建的根和指针一个都不变。
3. **读**（`hub/knowledge/read.ts`、`api.ts`，`hub/ports.ts`）：
   - KnowledgePort 加“这个产品不分版本的当前根”，声明成可选的方法（`unversionedRoot?(product)`），照以前给端口加方法的做法。这样 `hub/server/fakes.ts`、`hub/runs/engine/testing/knowledge.ts` 和各个包的测试桩（case-compile、defect-to-case、quality-board、traceability、regression-scope、case-location、maintenance-sweep 的测试 Hub，template-gap 的 `testing/bed.ts`）不用改。没实现这个方法的端口，当作这个产品还没有不分版本的根。
   - get_nodes、resolve_reference 按根摘要照常读它，读者权限同这个产品的其他根；
   - `read.ts` 427 行按 `version.line` 取读者的根、408 行写组成的构建名、出处里的 build：不分版本的根用它自己的指针，构建写“未声明”；
   - RootInfo 的 build 在这个根上没有：改成可空，或者给不分版本的根单独的返回形状，二选一写进 README，用到 RootInfo.build 的地方都过一遍，控制台的 `rootPage`（`pages.ts` 约 429 行的 `info.build.name`）也在内。

   测试：读得到不分版本的根；无权的读者照旧“对你不可用”、同形的空答复；读者的根取自它自己的指针；出处的构建写“未声明”；控制台的根页对这个根写“构建未声明”。
4. **运行**（`hub/runs/engine/target.ts`、`start.ts`）：
   - start_run 锁定版本根的同时，锁定这个产品不分版本的当前根，记进运行和 target_basis（一条依据，来源类型 projected，规则写明“产品线不分版本的当前根”）；
   - 还没有这个根时，回答里写“这条产品线还没有不分版本的根”，下一步是同步这条产品线，运行照开；
   - 运行的范围是它锁定的根的集合，不再只是 `run.root`。现在只认 `run.root` 的三处都改：
     - 边界：`exact.ts` 的 `scopeProblem`（约 153 行，“引用的知识树根不是本次运行锁定的根”）；
     - 检查的片段绑定：`evaluate.ts` 里 tree 引用那一支（约 399 行，现在记 not_bound）；
     - 条目复用：`reuse.ts` 的 `unchanged()`（约 82 行）。
   - 回注运行核对来源范围时，也认运行锁定的这个根（`hub/knowledge/contributions.ts` 取组成的一段，`submit.ts` 的 contributionScope）。

   测试：
   - 运行锁定两个根；没有不分版本的根时的确定说明，运行照开；不分版本的根换了以后再开是新运行；
   - 一份提交引用不分版本的根里的条目，被受理，检查读这个片段是 bound；引用第三个根的照旧被拒；
   - 不分版本的根里的条目没变时，条目照样复用；
   - 回注引用不分版本的根里的源能过范围核对。
5. **显示**：start_run 的回答（`hub/server/text.ts` 810 行）在锁定的知识根后面写出不分版本的根；控制台知识页（`hub/server/console/pages.ts` 350–389 行）每条产品线加一行“不分版本”，写当前根和源的个数。

   测试：回答文字里有这个根；知识页有这一行，没有根时写“—”。
6. **版本差不变**：两个构建的根做差（diffRoots、diffEntries），不分版本的内容不出现，回归范围也就不受它影响。

   测试：同一次同步产出的两个构建的根做差，结果里没有不分版本的路径。
7. **构建的视图也带上不分版本的根**（`hub/knowledge/views.ts`）：
   - 现在构建的视图（`knowledge:index/facets/impact:<产品>:<构建>`）只读构建的根。用例文档挪进不分版本的根以后，质量看板、追溯、用例定位、模板查缺会悄悄少掉这些文档。
   - 改成：视图把运行锁定的不分版本的根里的条目一起算进来，每条标“构建未声明”，带那个根的摘要；`totals` 里单独数“其中不分版本的”条目数和文档数，截断砍不掉。
   - 产品还没有不分版本的根时，视图照旧，说明里写“这条产品线还没有不分版本的根”。
   - 测试：同一份用例文档从构建的根挪到不分版本的根以后，四种视图里照样有它，标着“构建未声明”，计数对；两次读字节相同。

### 第二步：FAMX 包（第一步合并以后，集成者通知）

8. **手册库列目录**：manual-store 系统包加一个读，列出声明的目录下的直接成员。
   - 目录清单是资源设置里的一个参数（`settings.spec_folders`，一列），不写死。这一件只接现在的规格目录；`product/`、`qa/` 要不要加，由集成者只读数过、定了以后改部署数据，不改代码。
   - 目录清单仍是手册库资源的设置 `settings.spec_folders`（一列），包只读设置，代码不改；部署时这一项写成 `${var:MANUAL_SPEC_FOLDERS}`（hub-variables 的 `--setting-var`），`product/`、`qa/` 要不要加就是一条 `circle-hub var set`。原来的字符串设置 `settings.spec_folder` 并进列表还是保留，仍由这一件定。
   - 取目录照 spec-search 的做法；成员照 `functions/webdav.ts` 现有的 membersOf：不跟链接，放不进路径段的名字跳过并在读的警告里点名。
   - openkm 那份同名文件照测试保持一致：webdav.ts 逐字节相同，system.json 里加同一个读（前缀换成 openkm:），README 同步；两个包各升一个小版本，重签。

   测试：列目录的正例；目录读不到；跳过的名字；两个目录的清单；两份 webdav.ts 和读列表一致的那个测试照过。
9. **规格文档**：
   - 规格目录是几个产品共用的（架构第 8 节：约 1,070 份，文件名里有 FAMX 的 354 份，有 FAMY 的 47 份）。同步计划只把文件名或标题里写着 product.json 某个名字的文档（`manual:file:<路径>`）列成这条产品线不分版本的源，认名字的办法和 `documents.ts` 一样。
   - 别的文档不挂这棵树，在同步报告里数成“不属于这条产品线”：照旧存着、能被引用，只是不挂。
   - 新的规格生产器照 K1 的章节落点，挂在和 /manual 分开的规格命名空间下（例如 `/spec/<文档名>/<章节路径>`，最后的写法写进 README）；命令字面照 K1 记在 `data.command_literals`，生产时不解析；
   - 文档名或标题里写到的版本线（`functions/documents.ts` 的 documentLines）照原样记在 data 里，只作说明，不限制哪个版本能读；
   - 适用条件照 K1 和 kb-applicability 的规则抽（那一件合并在前）；构建不设。

   测试：规格文档按章节挂，命令字面照记；名字里写了版本线的规格也在不分版本的根里，data 里照原样记着那条线；一份别的产品的规格不挂、报告里计数；两次同步字节相同。
10. **用例文档**（`functions/cases-sync.ts` 的列出规则）：
    - 定位不出版本线的、所在版本线没有带命令树的构建的（uncoveredDocuments 数的那一类），改列进不分版本的范围；早于 min_line 的、编号敏捷包读不了的、空目录，照旧不列，计数照旧写进 note。
    - 不分版本的根里没有命令树：`product.json` 加一条开了开关的生产器，函数照用 cases，输入只有文档和目录、没有 tree。条目照 cases 现在的规则出，命令解析不了的照旧不挂节点。
    - 命令短语记在 `data.command_phrases` 里，原样。这个字段只在不分版本的那条生产器上加，用一个生产器参数打开；构建的根上的用例条目不加，它们的摘要不变，也就不用重产所有的根。
    - 读时对上读者版本根的命令，要等 kb-links 的链接声明，属于后续，写进 README。
    - 同步报告按原因写出进了不分版本范围的文档数，和仍然没列的文档数。

    测试：没有版本线的用例文档、版本线没有构建的用例文档进不分版本的根，带 `command_phrases`；构建的根里的用例条目字节不变；早于 min_line 的照旧不列；报告里两个计数对。
11. 包升小版本，README 同步，`node packs/product/famx/api.ts sign`。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
