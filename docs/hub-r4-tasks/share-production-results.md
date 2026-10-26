# 任务：追溯和看板的结果分享给能用这个包的用户

依据：

- 决定 35 第 22 项：追溯和看板的结果，分享给能用这个包的用户。
- 模型：`node tools/show-element.ts B04 R01 R02 W06`。
  - B04 R[3]：分享是管理员把运行、结果、上传的源文件或 Hub 生成的产物分给受众；受众是主体集合；可以撤回；读者解析引用时按自己的权限重验；经连接器读到的源文件不能分享。
  - B04 R[1]：许可只覆盖绑定的确切内容。
  - R02：运行与结果默认只有运行者和管理员可见，分享只由管理员分配；对无权者只答“对你不可用”，给同形的空集。
  - W06 R[3]：Hub 侧运行只给管理员看。
  - R01 R[1]、R[2]。
- 现在的代码：
  - 分享记录已有：`hub/records/authorizations.ts` 的 `share`、`unshare`、`isSharedWith`，受众只能逐个写用户；只有源文件记录查它（`hub/records/artifacts.ts`，键是 `artifactShareKey`）。
  - 运行和结果的可见性只看管理员和运行者：`hub/runs/engine/readers.ts` 的 `canSeeRun`、`recordReader`、`sourceReader`；`hub/runs/engine/queries.ts` 的 `getRun`、`listRuns`、`getResult`、`runsFor`。
  - `canSeeRun` 不只管查看，它还守着三处写和接续：
    - submit_result（`hub/runs/engine/submit.ts` 约 151 行）；
    - resolve_reference 的预览（`preview.ts` 约 42 行）；
    - 前驱核对（`start.ts` 约 452 行）。
  - get_nodes 和 resolve_reference 读源文件，走的是 `hub/server/readers.ts` 的 `sourceReaderFor`（`hub/server/tools.ts` 约 435 行），用调用者自己的可见性读 `records.artifacts.source`，不走引擎的 `sourceReader`。知识视图的原件存的是 `readers: [运行者]`、`shareable: false`（`hub/knowledge/views.ts`），所以别人拿到结果，也读不到结果依据里的视图原件。
  - 控制台的运行页显示运行者和会话编号（`hub/server/console/pages.ts`）。console-results 分支加了生产运行的结果页（`hub/server/console/results.ts`），用的是同一个 `getRun`、`listRuns`。
  - 生产运行：要求项全是事实的运行（`hub/runs/engine/start.ts` 的 `isProduction`）。
  - 客户端键按运行者分开（`start.ts` 的 `runByClientKey(store, owner, key)`），别人看到它也拿不回这个运行。

- 分工：模型文字由集成者先改：
  - B04 R[3]：受众可以是“能用包 P 的用户”，读时按当时的分配核对；对象可以是一个运行（它的运行记录、全部已受理的结果、它绑定的 Hub 生成的产物），也可以是“包 P 的生产运行”（以后的也算）；给 R[1] 写这一种怎么算“绑定的确切内容”。
  - R02：经分享的读者只能看，不能提交，也不能拿它当前驱（第 3 条）。
  - W06 R[3]：加“经分享的除外”。
  - 终端只加一个词表轴：`share_audience`（受众，归 B04），取值 `user`（用户）、`pack_users`（能用这个包的用户），变更记录写来源“决定 35 第 22 项”，照生成器重新生成。
- 分支和工作树：`share-production-results`，目录 `circle-hub-share-production-results`。
  - 等下面这些都合并以后，由集成者从 hub-redesign 开出并通知：core-fixes、kb-candidates、kb-links、views-and-notes、console-results、hub-job-dispatch、plan-evidence、hub-read-absence，和集成者的模型提交。
  - hub-read-absence 第 9 条（按运行的读取器、artifacts 的读接口）要先合并，第 4 条在它上面做。
- 可以改的路径：
  - `contracts/model.json`：只加上面那个轴和它的变更记录；照生成器重新生成的 `contracts/generated/**`；轴数的断言（`contracts/src/vocab-axes.test.ts`、`vocabulary.test.ts`、`show-element.test.ts`）跟着改；
  - `hub/records/authorizations.ts`、`api.ts`、`artifacts.ts`（只加第 4 条的读接口；hub-read-absence 已经加了就用它的）、README、对应测试；
  - `hub/runs/engine/readers.ts`、`queries.ts`、`preview.ts`、README 和对应测试；`submit.ts` 和 `start.ts` 只在守门的那一行把检查换成第 3 条说的那个；
  - `hub/server/readers.ts`（`sourceReaderFor`）和它的测试；
  - `hub/server/cli-admin.ts`（新的 share 命令）、`hub/server/assemble/cli-admin.test.ts`；
  - `hub/server/console/**`（运行页、结果页）和控制台的测试；
  - 新的验收测试 `tests/acceptance/<开分支时的下一个编号>-shared-results.test.ts`。

  别的路径不动。说明两点：
  - 任务包不改：分享是核心的通用能力，分享哪个包是管理员的部署动作。工具回答走同一套查询，不另改 `hub/server/tools.ts`。
  - 几件改同一批文件，段落不同，集成者让它们先后合并，后合并的在先合并的之上重跑测试：
    - kb-unversioned 改 `start.ts`（锁根的一段）和 `hub/server/console/pages.ts`（知识页）；
    - hub-unknown-exits 改 `queries.ts`（列出没结的运行和请求）和控制台的 `pages.ts`；
    - kb-links 改 `hub/records/api.ts` 和 `start.ts`。
    - hub-variables 改 `hub/records/authorizations.ts`（只加在给定事务里写决定的入口）、`api.ts`、`hub/server/cli-admin.ts`、`start.ts` 开头读变量的一段，也加两个词表轴。段落不同，后合并的在先合并的之上重跑测试，改轴数的断言。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 核心里不出现包名和产品名：追溯、看板的分享只在部署时由管理员做；
  - 无权和不存在同样回答“对你不可用”，给同形的空集；
  - 枚举只来自生成的词表；
  - 未知只能是过渡状态，写明缺的事实和下一步动作（这一件不新增未知）。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对 `contracts/**/*.test.ts`、`hub/records/**`、`hub/runs/engine/**`、`hub/server/**` 和新的验收测试。

## 要做的

1. **受众“能用这个包的用户”**（`hub/records/authorizations.ts`、`api.ts`）：
   - `share` 的受众可以写一组用户，也可以写“能用包 P 的用户”。后一种只存一条记录，读时用 `canUse(读者, P)` 核对：分配了就看得到，取消分配就看不到，不用重写分享。
   - 两种受众各对应 `share_audience` 的一个取值。记录里怎么写由 records 包定，写进 records 的 README；读的时候先认出是哪一种，再核对。
   - `unshare` 两种都能撤；加一个按对象列出现有分享的读法，给管理员用。记录照旧只增，同一（许可种类，主体，对象）最新一条为准。
   - 测试：分享给用户、给包的用户；分配前、分配后、取消分配后各读一次；撤回；非管理员分享被拒。
2. **两种对象，以及经分享的读者看到什么**：
   - 一个运行：受众看得到这个运行和它全部已受理的结果，`rec:` 解析得到运行记录、提交记录、动作记录和校验结果。
   - 包 P 的生产运行：P 现在和以后的生产运行都对受众可见，Hub 侧运行也算（W06 R[3] 的例外）；P 的非生产运行不算。
   - 运行记录照原样给，不隐去运行者、会话编号和客户端键。记录按摘要核验，删掉几项就核验不了；客户端键按运行者分开，别人拿到也没用。管理员说明和调用日志不在运行记录里，照旧只给管理员。
   - 测试：
     - 两种对象各一组；非生产运行不在内；Hub 侧运行在内；
     - 经分享的读者解析运行记录的 `rec:`，摘要核验通过；
     - 经分享的读者用同一个客户端键开运行，得到他自己的新运行。
3. **看和写分开**（`readers.ts`、`queries.ts`、`preview.ts`、`submit.ts`、`start.ts`）：
   - 留着同步的 `canSeeRun`，意思不变：管理员，或运行者本人（Hub 侧运行除外）。submit_result 和前驱核对照旧用它。分享不让别人往别人的运行里交提交，也不让别人接着别人的运行跑。
   - 新加异步的 `canViewRun`，顺序是：
     1. `canSeeRun` 成立的；
     2. 直接分享给读者的；
     3. 分享给“能用包 P 的用户”而读者能用 P 的；
     4. P 的生产运行被整体分享了、这是一个生产运行、读者又能用 P 的。
   - 用 `canViewRun` 的：`getRun`、`getResult`、`runsFor`、`recordReader`、控制台、`preview.ts`（经分享的读者也能预览这个运行里的引用）。`listRuns` 把经分享的运行一起列出，按开始时间排序，游标稳定，翻页不重不漏。看不到的照旧是 null 和同形的空页。
   - 换成异步以后，每一处调用都要 `await`。`!canViewRun(...)` 少写 await 时 tsc 不报错，取反的 Promise 永远是 false，守门就失效了。所以每个守门处都要有一条“无权者被拒”的测试，不能只靠类型检查。
   - 测试：
     - `queries.test.ts` 加分享的几种情形；
     - `recordReader` 让经分享的读者读到校验结果、提交记录和动作记录；
     - 经分享的读者 submit_result，答“对你不可用”；
     - 拿别人分享的运行当前驱开运行，答“对你不可用”；
     - 经分享的读者预览这个运行里的引用成功；分享撤回以后被拒。
4. **结果的依据要读得到**（`hub/server/readers.ts` 的 `sourceReaderFor`，加上 hub-read-absence 第 9 条的按运行读取器）：
   - 经分享的读者带着这个运行解析引用时，读得到这个运行绑定的、Hub 生成的源文件（origin 为 generated，比如知识视图的原件）。
   - 做法：`sourceReaderFor` 收到一个运行，`canViewRun` 成立、摘要又在这个运行的记录里，才经 artifacts 的读接口按运行取字节，不按读者自己的可见性查。不带运行时照旧。
   - 经连接器读到的源文件照旧读不到（B04 R[3]）。
   - `tree:` 依据按读者自己能读的知识树解析（R01 R[2]），读不到的照旧“对你不可用”。
   - records 的可见性字段不改。
   - 测试：经分享的读者读得到结果依据里的视图原件；同一个原件不带这个运行去读，读不到；连接器读到的源文件读不到；不能用这个包的用户都读不到。
5. **管理员命令**（`cli-admin.ts`，只有管理员）：
   - `share run <运行> (--users <用户,…> | --pack-users) [--reason <理由>]`
   - `share production <任务包> [--reason <理由>]`：受众就是能用这个包的用户
   - `unshare run <运行> (--user <用户> | --pack-users)`、`unshare production <任务包>`
   - `share list [--object <对象>]`
   - 用法写进 USAGE 和帮助。对象不存在时照常回答，不泄露别人的运行。
   - 测试：`hub/server/assemble/cli-admin.test.ts` 加每个子命令，和非管理员被拒。
6. **控制台**：运行页和结果页对经分享的读者可见，页上写“经管理员分享”；管理员的运行页列出这个运行现在的分享。测试：控制台的测试加经分享的读者和管理员两种视角。
7. **验收**（新文件）：
   - 一个合成的只出事实的包；管理员 `share production`；
   - 能用这个包的用户看得到别人的生产运行和结果（get_nodes 读 `rec:`），也读得到结果依据里的视图原件；
   - 不能用的得到“对你不可用”和同形的空集；
   - 取消分配以后同样；撤回对生产运行的分享以后同样；
   - 经分享的读者交提交被拒。

部署（集成者做，不在这一件里）：合并、部署以后执行 `share production traceability`、`share production story-traceability` 和 `share production quality-board`，记进进度页。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
