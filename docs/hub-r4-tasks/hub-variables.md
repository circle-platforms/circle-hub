# 任务：Hub 和 Circle 一样，管理员写变量和密钥，配置按名字引用

依据：

- 所有者 10-23 22:40：“Hub应该和circle一样，可以写变量然后引用才对”。起因是集成者列部署取值时，每一样都另占一个专门的位置：
  - 网关的运行密钥只能在 `executor add` 时经标准输入进一条执行器登记，换钥匙要整份定义重交；
  - FAMX 的 min_line 和主线页的词要等一套新的产品部署定义（famx-deployment-conventions 第一步）；adoc 各名称族的属性集，部件、许可、部署形态的闭集，都排在它后面；
  - PLM 修复说明的字段名、手册库的规格目录各占一项资源设置；第一次真实评审的基线构建还没有去处；
  - 台架清单的摘要每次 `doc put bed-topology` 以后要手抄进执行器定义，再整份 `executor update`。
- Circle 的做法（Circle 仓库，行号会变，以小节为准）：
  - main 的 `docs/settings.md` 的 `variables`：名字是大写字母、数字和 `_`，字母开头，至多 64 个字符（`src/settings.ts` 的 VARIABLE_NAME：`^[A-Z][A-Z0-9_]{0,63}$`），值至多 2000 个字符；模型在工具参数里写 `%NAME%`，模型知道名字和值。
  - main 的 `docs/security.md` 的 Secrets by name：密钥存在主目录的 `secrets.json`，模型只知道名字；工具运行之前 Circle 把 `%NAME%` 换成值，任何工具的输入都换，MCP 工具也换，所以也包括 Hub 的工具。
  - main 的 `docs/mcp.md`：服务器的 `headers` 只认 `${env:NAME}`，可以嵌在值里（`Bearer ${env:DOCS_TOKEN}`）。还没合并的 hub-mcp-client 分支（a8a9da09 起）加了 `${secret:NAME}`（Tokens in headers）：没保存的名字在发出任何请求之前就停下，写明名字和 `/secrets NAME`，从不显示值。Circle 没有 `${var:…}`。
- Hub 现在（hub-redesign c68e2abb 和几条没合并的分支，只读调研；行号会变，以函数为准）：
  - 密钥库条目名由使用者推出：`connector.<资源>.<凭据项>`（`hub/connectors/resources.ts` 的 credentialEntry）、hub-job-dispatch 上的 `executor.<执行器>.bearer`。管理员起不了名字；门户账号同时给敏捷平台和 PLM，要存两遍；写密钥不留许可记录；`resource update` 改了 origins，凭据照旧跟着走。
  - 资源设置：`--setting` 按 JSON 猜类型（`10.6` 变成数），`update` 整项替换，没有命令能看。产品包的 `sync.options` 和生产器 `params` 只在 Git 里。
  - 资源配置许可（`hub/records/authorizations.ts` 的 configureResource）已经是这样的记录：一个管理员在一个时刻绑定一份内容的摘要，只增，带理由，按对象加锁、用 supersedes 成链；资源和执行器的定义都这样存。变量和密钥照它存，不加表。
  - 运行的外部读只在 start_run 里（`inputs.ts` 的 readExternal、`projection.ts` 的 bindExpected，都只由 `start.ts` 调），读到的字节冻结进运行，评估只读冻结的字节；资源定义在每次读时取，读清单记 `rec:<决定>`。读清单带 `run`，运行者读得到，里面有发出的路径、参数和失败原因。
  - 派发：`job dispatch` 开始时绑定执行器定义的摘要，提交前再比一次；恢复和对账按这个摘要从对象库取定义，严格解析。
- 模型：`node tools/show-element.ts D01 B04 R01 R02 B08 D07 K01 T01 T02 W06 C01 C04`。
  - D01 DEF、R[6]：部署实例由管理员管、不进 Git，端点与凭据引用只出现在部署实例里。C01 R[0]、R[1]：不新增概念，资源由管理员配置。变量和密钥是部署实例里的取值，不是新的家。
  - B04：资源配置是管理员作出、当时生效的决定，只增；没有审批人（R[6]）。C04 R[4]：缺不等于空。
  - W06：运行冻结输入。决定 35 能力第 26 项：Hub 评估运行时，按运行开始时的授权读冻结的输入。
  - 协议码 SOURCE_UNAVAILABLE：对读者一律“对你不可用”，真实原因只在管理员日志里。
  - 决定 35：知识库第 3、5、9 项（属性集、闭集、版本线约定是部署数据），运维第 12 项（基线构建记在部署数据里），上真实台架第 11 问和“仍要所有者亲手做的”网关运行密钥。
- 分工：模型文字由集成者先改，并把 version 加一。要改的有：
  - D01 DEF、R[6]，新加 R[11]；
  - B04 F[0]、F[1]；R01 R[1]；R02 新加 R[3]；
  - B08 R[1]；D07 R[2]；K01 R[7]；
  - T01 新加 F[12]；T02 新加 R[7]；
  - 分类规则第 15 条（`classificationRules[15].rule`）；格式提案里 product.json 那一行。

  改的元素各在新版本的 changes 里写一条，来源是所有者 10-23 22:40 和进度页的决定 44（写这页时的下一个空号，以提交时为准）。终端在第一步加两个词表轴，都归 D01，变更记录写在同一版里：
  - `variable_kind`“变量种类”：`var` 普通变量、`secret` 密钥；
  - `digest_rule`“摘要规则”：`plain` 原样、`sha512_base64` Base64(SHA-512)。
    - 摘要规则要记进密钥的记录，手写的闭集不能进核心记录：删掉 `contracts/src/resources.ts` 的 `DIGEST_RULES`、`DigestRule` 和开头注释里讲摘要规则的那半句，`hub/connectors/resources.ts` 的 `declaredCredentials`、`storedCredential` 两处手写的 `'plain' | 'sha512_base64'` 换成生成的类型；
    - 连接器 README 偏差清单（489 行一带）和 Needs 第 (2) 条里的摘要规则删掉。
- 分支和工作树：`hub-variables`，目录 `circle-hub-hub-variables`。
  - 第一步：等 plan-evidence、hub-job-dispatch、dispatch-gateway、hub-device-run 合并以后，由集成者从 hub-redesign 开出并通知（hub-case-runtime、plm-fields 到 c68e2abb 已经合并）。kb-links、views-and-notes 不挡第一步。第一步做完单独先合并，网关的运行密钥从此经 `secret set` 进来。
  - 第二步：第一步合并以后接着做；先把 kb-links、views-and-notes 合并进这条分支（它们改 `contracts/src/product.ts`、`knowledge.ts`、`hub/knowledge/**`）。第二步先于 kb-unversioned 第一步合并。
  - 排在后面的：
    - 第一步之后：d03-p11-boundary（executor@1 移进合约时，连同这一件的改动一起移）。
    - 第二步之后：famx-deployment-conventions 只剩 FAMX 包那一步（原来的第一步取消），kb-adoc 的接线也挪到那一步；kb-applicability；kb-unversioned 第一步。kb-unversioned 第二步、hub-view-scope 照旧排在它们后面。
    - 决定 29 的推送要等 FAMX 包里的真实约定变成变量，也就要等第二步和 FAMX 那一步。
  - 文件重叠、段落不同的：test-bed-ownership、share-production-results、hub-read-absence、hub-unknown-exits、w04-rulings-ledger、v07-repetition、w10-criterion-change、hub-unknown-model、hub-view-scope，也改 `hub/records/authorizations.ts`、`api.ts`、`hub/server/cli-admin.ts`、`hub/runs/engine/start.ts`、`inputs.ts`、`projection.ts`、`hub/ports.ts`、`hub/connectors/**`、`hub/dispatch/**`、`hub/server/cli-job.ts`、`contracts/src/resources.ts` 或 `hub/knowledge/**`。一条规则：集成者排先后；后合并的一方在合并后的分支上解决冲突，照合并后的契约重新生成 `contracts/generated/**`，改轴数的断言，并把它新写的测试里设凭据的地方改成按名字设密钥。
- 可以改的路径：
  - 第一步：
    - `contracts/model.json`：只加两个轴和它们的变更记录；照生成器重新生成 `contracts/generated/**`；轴数的断言（`contracts/src/vocab-axes.test.ts`、`vocabulary.test.ts`、`show-element.test.ts`）跟着改；
    - `contracts/src/variables.ts`（新）和测试，`contracts/src/index.ts`（登记 schema），`contracts/src/resources.ts`（resource@1 的引用、read-manifest@1 的 `variables`、摘要规则）；
    - `hub/records/variables.ts`（新）、`api.ts`、`index.ts`，README 和测试；`authorizations.ts` 只加“在给定事务里写决定”的入口；不加迁移；
    - `hub/connectors/**`：`resources.ts`、`login.ts`、`read.ts`、`redact.ts`、`connectors.ts`、`api.ts`，README 和测试；`testing/**` 只加新的合成应答和一个设合成密钥的帮助函数；
    - 各包测试里建资源、设凭据的那几行（c68e2abb 上是这 8 个文件）：`packs/system/plm/plm.test.ts`、`builds-connectors.test.ts`、`packs/system/agile-platform/agile.test.ts`、`roots.test.ts`、`packs/system/openkm/webdav.test.ts`、`packs/system/svn/webdav.test.ts`、`packs/product/famx/functions/cases-integration.test.ts`、`packs/workflow/case-review-verify/testing/bed.ts`。只改这几行，改用那个帮助函数；这些文件不在包的清单里，不用重签；
    - `hub/dispatch/**`、`hub/server/cli-job.ts`；
    - `hub/ports.ts`（ExternalReadContext 加一项）；`hub/runs/engine/start.ts`（开头读一次变量、参数的凭据扫描）、`inputs.ts`、`projection.ts`（把那份取值交给读），README 和测试；
    - `hub/server/variables.ts`（新）、`cli-admin.ts`、`testing-real.ts`；
    - `hub/server/assemble/**`：接线、`env-file.ts`、`secret-input.ts`、`cli-admin.test.ts`、`testing-real.test.ts`、README 的 Secrets 一段；
    - `hub/platform/**` 里讲钥匙丢失和从备份恢复的几处和测试；
    - `scripts/real/accept/device-run.ts` 的第 0 步（checkedDefinition）和 `device-run.test.ts`；
    - `tests/acceptance/support/hub.ts`，`09-connectors.test.ts`、`17-hub-restart.test.ts`、`28-device-run.test.ts` 里设凭据和登记执行器的地方，新的 `tests/acceptance/<开分支时的下一个编号>-variables.test.ts`。
  - 第二步：
    - `contracts/src/product.ts`（product@1 的 `variables`）、`contracts/src/knowledge.ts`（tree_root@1 的 `variables`），照生成器重新生成；
    - `hub/runs/packs/validate.ts`、`registry.ts`，README 和测试；
    - `hub/knowledge/**`：`sync.ts`、`sources.ts`、`produce.ts`、`lists.ts`、`cli.ts` 的同步报告，README 和测试；
    - `hub/server/variables.ts`、`cli-admin.ts`、`hub/server/assemble/**` 的接线和测试；
    - 第一步那个验收文件，`tests/acceptance/14-knowledge-sync.test.ts` 里受影响的。

  别的路径不动：`hub/config/**`、`config/platform.json`、控制台、`packs/**`（上面那几行测试除外，各包由对应那一页改）、`scripts/real/**`（device-run.ts 的第 0 步除外，其余是集成者的）。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - Hub 是通用平台：核心只认名字、引用和声明，不出现产品、系统、网关的字；`hub/**` 的测试用 `DEMO_…` 这类编的名字和值。
  - Hub 只核验，不生成内容，不调用模型：引用只是把管理员写下的值原样换进去，不拼接、不计算。
  - 名字没设置、值不合声明，都是确定的结果，写明下一步的命令；这一件不新增未知。
  - 枚举只来自生成的词表。
  - 密钥：只从标准输入读；值不显示、不打印、不返回；任何记录、对象、日志、错误和输出里只有名字、第几版、摘要规则和长度，也不存值的摘要；每一版只发往设置时登记的地址。
  - 真实值不进 Git、测试、日志和终端：普通变量的值也不进日志，列表默认不显示值。
  - 记录只增：改值就是一条新决定；已部署的资源配置历史不改写，旧的定义照样读得出来。
  - 运行在 start_run 冻结输入（W06），Hub 按开跑时的授权评估（决定 35 能力第 26 项）；部署实例由管理员管（D01）。
- 验证：
  - `npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node tools/show-element.ts --vocab variable_kind digest_rule`；
  - 第一步：`node --test --test-concurrency=1` 对这些跑：
    - `contracts/**/*.test.ts`、`hub/records/**`、`hub/connectors/**`、`hub/dispatch/**`；
    - `hub/runs/**`、`hub/server/**`、`hub/platform/**`、`scripts/real/accept/device-run.test.ts` 和改过的各包测试；
    - `tests/acceptance/09-connectors.test.ts`、`17-hub-restart.test.ts`、`28-device-run.test.ts` 和新的验收文件；
  - 第二步再加 `hub/knowledge/**`、`packs/product/**` 和 `tests/acceptance/14-knowledge-sync.test.ts`；
  - `node --test ".github/checks/*.test.ts"`：词表扫描零命中、不加例外，仓库卫生检查通过。

## 要点

1. 两种，一个命名空间：普通变量（JSON 值）和密钥（一行文本）。名字照 Circle：`^[A-Z][A-Z0-9_]{0,63}$`；`CIRCLE_HUB_` 开头的留给进程配置，`CIRCLE_SERVER_` 是退役的前缀，都不收。一个名字只有一种，第一次设置时定下。
2. 只有管理员写和看，每次写理由。每次设置或撤回是一条资源配置决定，对象写 `var:<名字>` 或 `secret:<名字>`；这个名字的第 n 条设置决定就是第 n 版，撤回不算版。不加表，不加迁移，没有审批。
3. 引用：`${var:名字}`、`${secret:名字}`，只许占满一个 JSON 字符串。只认这几处：
   - 资源设置里的值（普通变量）；
   - 资源的凭据项（密钥）；
   - 执行器定义：`credential` 写密钥；期望值（`target`、`manifest_sha256`，只读核对条件里的 `equals`、`at_least`、`sha256`）写普通变量；别的字段只照字面；
   - 产品包的 `sync.options` 和生产器 `params`（普通变量，要在包里声明）。

   Hub 不解析客户端的输入：工具参数里的这种写法只是文字。
4. 产品包声明它读的变量：名字、JSON Schema、合成的默认值、说明。名字属于第一个发布时声明它的包。真实同步时引用的变量没设置，就在读任何页之前拒绝，写明 `circle-hub var set`；默认值只给发布校验的样例和试运行用。
5. 普通变量在用它的那件事开始时取一份：一次 start_run、一次同步各取一份；作业在 `job dispatch` 开始时钉住解析后的执行器定义，提交前按当前值再解析一遍，变了就不提交，发出以后只读钉住的那份。运行的外部读都在 start_run 里，读到的字节冻结进运行，之后改变量不影响它。
6. 密钥每一版一个密钥库条目，只发往设置时登记的地址：引用它的资源的 origins，执行器的 endpoint 和 CA。用的时候取当前一版；记录里只有名字、第几版、摘要规则和长度。换一次密钥，下一次登录或开会话就用新的，不用重启；新加的使用者、改了发往的地址，要重新输入一次值。
7. 没设置都是确定的结果：部署定义引用的普通变量在配置时就要设置好，还被引用的撤不掉；密钥没设置、或者这一版没登记发往这里，一个请求都不发，管理员日志写明 `circle-hub secret set --name <名字>`，调用方照旧只看到 SOURCE_UNAVAILABLE。
8. 变量是部署数据，不是密钥：它的值会出现在用到它的请求、产物和知识里。列表和查看默认不显示值；要藏的值写成密钥。

现在的专门位置各去哪：

- 资源凭据：改成有名字的密钥，凭据项写 `${secret:名字}`；门户账号两个资源共用一对名字（第 4 条）。
- 网关的运行密钥：改成密钥 `GATEWAY_RUN_KEY`，执行器定义的 `credential` 引用它；先登记执行器，再交钥匙（第 5 条）。
- `secret import`：改成写到名字（第 3 条）。
- FAMX 的 min_line 和主线页的词、adoc 各名称族的属性集，部件、许可、部署形态的闭集：改成 FAMX 包声明的变量（第二步；包由 famx-deployment-conventions 和 kb-applicability 改）。famx-deployment-conventions 第一步的产品部署定义、`knowledge settings` 命令和 `param_sources` 都不做了。
- PLM 的 `settings.bug_fix_field`、手册库的 `settings.spec_folders`：照旧是资源设置，部署时用 `--setting-var` 写成引用；PLM、手册库和缺陷转用例包的代码都不改。
- 台架清单摘要的手抄：执行器定义写 `${var:BED_MANIFEST_SHA256}`，重发清单以后一条 `var set`。
- 第一次真实评审的基线构建：变量 `REVIEW_BASELINE_BUILD`，没有包读它，只是记录。

管理员平常这样用（占位）：

```
circle-hub secret set --name PORTAL_USERNAME --name PORTAL_PASSWORD --digest PORTAL_PASSWORD=sha512_base64 --reason "门户口令换了"
#   先列出这一版的使用者，再依次从标准输入读，不回显
circle-hub var set PLM_BUG_FIX_FIELD --file <暂存目录>/plm-bug-fix-field.txt --text --reason "照真实原件核过"
circle-hub var list
#   每个名字：种类、第几版、长度、谁在用、问题和下一步；不显示值
```

照 Circle 的：

- 两种、一个命名空间、同一条名字规则；
- 部署配置里按名字引用密钥，写法照 hub-mcp-client 分支的 `${secret:名字}`，由可信的一方在用的时候换成值；
- 没设置的名字在发出任何东西之前就停下，写明设置它的命令；
- 密钥只显示名字、有没有和长度。

不照 Circle 的，各有理由：

- 不用 `%名字%`：那是 Circle 给模型写工具参数用的，没设置的名字原样放过（为了 Windows 的 `%PATH%`）。Hub 不解析客户端的输入，引用只写在部署配置里；和 `%名字%` 分开，经 Circle 传过的文字里，Circle 也不会把它自己的值填进 Hub 的引用。
- 多了 `${var:名字}`：Circle 没有，部署配置里的普通取值也要能按名字引用。
- 只许整值引用（Circle 的 headers 可以嵌在值里）：凭据发往哪里不许拼出来；变量还要能是列表和对象。
- 值是至多 64 KiB 的 JSON，不只是至多 2000 个字符的字符串：属性集是对象，闭集是列表。值从文件或标准输入读，不放在命令行上，也不猜类型。
- 只有管理员写，每次写理由；用户、模型和客户端都列不出变量（Circle 把名字和值都告诉模型）。变量的值只经用到它的读、产物和知识出现。
- 存在密钥库和只增的决定记录里，不是主目录里明文的 `secrets.json`；“一个名字一种”在存的时候就挡。
- 密钥每一版只发往登记的地址：Hub 有几位管理员，一位管理员不能把别人交的钥匙指到自己选的主机（Circle 的密钥是本人的）。
- 没有 `${env:名字}`：Hub 不读进程环境，进程配置只认 `CIRCLE_HUB_*`。
- 密钥可以只存 Base64(SHA-512)：门户口令现在就这样存，原文不进密钥库。
- 外部编号模板里的 `{product}` 这类占位、执行器调用里的 `{$value: …}`，是 Hub 运行时的事实，不是变量，照旧。

## 要做的

### 第一步：变量和密钥，部署定义里的引用

1. **名字、引用和值**（`contracts/src/variables.ts`，新）：
   - 名字：`^[A-Z][A-Z0-9_]{0,63}$`，区分大小写；`CIRCLE_HUB_` 开头的留给进程配置，`CIRCLE_SERVER_` 是退役的前缀，都不收。名字不合规则时只说第几个参数、违反哪条，不回显，也不替人改写。
   - 普通变量的名字不能像密钥。像密钥指：
     - 按 `_` 分段后有一段是 KEY、PASS、PWD、PIN、OTP、AUTH、CERT、SALT、HMAC、COOKIE、BEARER、SIGNATURE、AUTHORIZATION；
     - 或者名字里含 PASSWORD、PASSWD、SECRET、TOKEN、CREDENTIAL、PRIVATE、API_KEY。

     这张词表只在这里写一份。`hub/config/index.ts` 的 SECRET_LIKE 不动，由一个测试读它的原文，核对它的每个词都在这张表里。修正说明：这是密钥，用 `circle-hub secret set --name <名字>`。原因：普通变量的值进记录，放错了删不掉。
   - 引用：一个 JSON 字符串的整个值是 `${var:名字}` 或 `${secret:名字}`，种类码来自 `variable_kind`。
     - 字符串里有 `${var:` 或 `${secret:`（不论大小写），就算写了引用；不恰好是一个整值引用、或名字不合规则的，都算写错。别的 `${…}`（shell 的 `${HOME:-x}`、PowerShell 的 `${env:PATH}`）只是文字。
     - 在能写引用的地方写错：拒绝，写出对的写法。在不能写的地方写了引用：拒绝，写明这里不能引用。
   - 两个函数：
     - `referencesIn(值)`：列出一个 JSON 值里的每个引用和它的 JSON 指针；
     - `resolve(值, 取值)`：只换一趟，换进来的值不再展开。
   - 值：
     - 普通变量：任意 JSON，规范 JSON 至多 64 KiB；字符串里不许有换行和制表符以外的控制字符；值里不许再写引用。
     - 密钥：8 到 4096 个字符、不含控制字符的文本。短于 8 个字符的（用户名这类）要显式给 `--short <名字>`，输出写明这样的值脱敏器遮不住、也找不出回显。
   - 形状，在 `contracts/src/index.ts` 登记：
     - `variable@1`：`{schema, name, value}`；
     - `secret@1`：`{schema, name, entry, digest_rule, length, consumers}`。entry 是这一版的密钥库条目名；length 是存下的文本的长度；consumers 是设置时登记的使用者，每项 `{definition, item, sends_to}`：definition 是资源号或执行器号，item 是凭据项（执行器写 `credential`），sends_to 是它当时发往的地址的摘要（资源：origins 和 allow_plaintext；执行器：endpoint 和 CA）。不含值，也不含值的摘要；
     - `VariableUse`：`{at, name, decision}`。at 写“定义或包#JSON 指针”，例如 `res_…#/settings/bug_fix_field`、`exe_…#/manifest_sha256`、`<包>@<版本>#/producers/2/params/components`；decision 是所用那条决定的摘要；
     - `VariableDeclaration`：`{name, description, schema, default}`（第二步用）。
   - 测试：
     - 名字：64 和 65 个字符、小写、数字开头、`CIRCLE_HUB_X`、`CIRCLE_SERVER_X`；
     - `DEMO_PASSWORD`、`DEMO_KEY`、`DEMO_AUTH` 作普通变量被拒，`DEMO_KEYS`、`DEMO_AUTHOR` 能收；SECRET_LIKE 的每个词都在表里；
     - 引用：整值、嵌入、两个、`${env:X}`、`${var:demo}`、`${Var:X}`、`${HOME:-x}` 各一例；
     - 替换只一趟；64 KiB 的边界；值里写引用被拒；拒绝的文字里没有输入的原文。

2. **记录**（`hub/records/variables.ts` 新；`api.ts`、`index.ts`；`authorizations.ts` 只加“在给定事务里写决定”的入口；README）：
   - 每次设置或撤回是一条资源配置决定，照 configureResource 写：
     - 主体是全 Hub，对象是 `var:<名字>` 或 `secret:<名字>`；
     - 理由进 note：必填，至多 500 个字符，凭据扫描命中就拒绝；
     - 撤回就是这条许可的撤回；照旧按对象加锁、用 supersedes 成链；
     - 这个名字的第 n 条设置决定是第 n 版，撤回不算版。
   - 别的资源配置读者都按自己的对象过滤：资源按 ResourceId，执行器按 `executor.`，扫描接受按 `scan:`，所以读不到这两种前缀。各加一条测试锁住。
   - 名字锁：设置、撤回和跨对象的核对，都在写决定的那个事务里先取 `RecordStore.lock('variable-name:<名字>', tx)`，几个名字按名字排序依次取。资源、执行器的配置和产品包的发布，也给它们涉及的每个名字取同一把锁（第 4、5、8 条）。锁里重新核对：
     - 一个名字一种：`var:X` 有过任何一条决定，X 就不能设成密钥，反过来也一样，撤回以后也不行；
     - 产品包声明过的名字不能设成密钥（第 8 条）。
   - 普通变量：
     - 值按规范 JSON 存进对象库（variable@1），决定绑定它的摘要；
     - 值和当前这一版相同就不记新版，回答“和第 n 版相同”；
     - 值被凭据扫描命中，或者有字符串像令牌（16 个字符以上、没有空白、大写字母、小写字母和数字都有），就拒绝：“值像是凭据：用 circle-hub secret set”。确实不是的，给 `--not-secret`，这一句记进理由。构建名、十六进制摘要、字段名这类不像令牌。
   - 密钥：
     - 每一版一个密钥库条目 `secret.<名字的小写>.<24 位随机十六进制>`，决定绑定 secret@1；
     - 先写条目，再写决定。上一版的条目留到下一次设置才删，换钥匙时正拿着上一版的登录不会扑空；
     - 没有决定指着、写下超过一小时的条目，下一次设置这个名字时删掉；`secret list` 照样列出它们；
     - 同值再设也是新的一版；撤回时删掉这个名字的全部条目。
   - 几个一起写（`secret set --name A --name B`、`secret import`）：先写好全部条目，再在一个事务里按名字排序取锁、写全部决定。读的一方在一次查询里读它要的几条决定，只看到全旧或全新：登录要账号和口令两项，不会用新账号配旧口令去登录（登录失败从不重试）。
   - 读：
     - 普通变量：按名字给当前的值和决定，按决定给那一版的值；一次查询给出全部普通变量的当前决定，值用到时再按决定取（第 6、9 条）。
     - 密钥：按名字给当前一版的值、决定和使用者，只给 Hub 的传输层和派发用，不经过任何包的函数。用的时候核对条目在、条目里文本的长度等于决定里写的长度（B04 R[1]）；条目不在时绕过缓存再读一次最新的决定，还不在才拒绝。
     - 最近的决定是撤回、条目确实不在（比如钥匙丢失以后）、这个使用者不在这一版的使用者里、或者它发往的地址变了：都是确定的拒绝，修正说明写 `circle-hub secret set --name <名字>`。
   - 列出和历史：一个名字按 `authz.object` 取全部决定；全部名字按许可种类翻页，只取这两种前缀。
   - 只有管理员能设置、撤回、列出、看历史（`#decide` 已经只许管理员作资源配置）；用户没有任何读法。
   - README 写明：普通变量里放错了密钥，唯一的补救是在签发方换掉它。
   - 测试：
     - 设置、改值、同值、撤回、再设，版数和历史都对；非管理员被拒；
     - 种类互斥，撤回以后也互斥；`var set X` 和 `secret set X` 并发，只有一个成功；理由必填，理由里有凭据被拒；
     - 50 个连接并发设置同一个名字，版本连续、链不断；
     - 两个密钥一起写时，另一个连接反复读，只见全旧或全新；
     - 换钥匙时另一个连接正拿着上一版，照常用完；用时长度不符被拒；
     - 换一个进程读得到最新一版；
     - 把全部记录、对象库（密钥库除外）和日志，按原文、URL 编码、JSON 转义、Base64、SHA-256、SHA-512 几种写法搜一遍，找不到合成密钥的值；
     - 把存下的每个摘要，和“遮盖处换回合成密钥以后的字节”的摘要比一遍，没有相同的（第 4、5 条的回显）。

3. **命令**（`hub/server/variables.ts` 新，`cli-admin.ts` 只调它；都要管理员）：

   ```
   var set <名字> [--file <文件>] [--text] [--not-secret] --reason <理由>
   var unset <名字> --reason <理由>
   var list [--run <运行> | --root <根摘要>]
   var show <名字> [--history] [--value]
   secret set --name <名字> [--name <名字> …] [--digest <名字>=sha512_base64 …] [--short <名字> …] --reason <理由>
   secret unset --name <名字> --reason <理由>
   secret list
   secret show --name <名字> [--history]
   secret import --env-file <文件> --key <键>=<名字> … [--basic <用户键>:<口令键>=<名字>] [--digest <名字>=sha512_base64 …] [--short <名字> …] --reason <理由> [--dry-run]
   ```

   - 值从不出现在命令行上：
     - `var set` 的值从 `--file` 读，没给就从标准输入读（照 `secret-input.ts` 的读法）。内容是 UTF-8 的 JSON，至多 64 KiB；给了 `--text` 就整份存成一个字符串（去掉末尾一个换行），`10.6` 存的是 `"10.6"`。JSON 读不了，只报第几行第几列，不带原文。
     - `var set` 多给一个位置参数就拒绝：“值只从 --file 或标准输入读”，不回显。
     - `secret` 的名字只经 `--name` 给；命令行上多出任何位置参数都拒绝：“密钥只从标准输入读”，不回显那个参数。`secret set` 的值只从标准输入读：终端上不回显，几个名字依次提示；从管道读时一行一个，行数要正好对上。
   - 拒绝时不回显、不改写输入：名字、映射、理由写错，只说第几个参数、违反哪条。`pairs()` 现在会回显 120 个字符，一并改掉。名字也过一遍凭据扫描。
   - 理由里含这次设置的密钥的值，或值里任意连续 8 个字符（按脱敏器认得的几种写法），就拒绝，不回显。
   - `secret set`：
     - 先找出现在引用每个名字的定义；没有就拒绝：“还没有部署定义引用这个名字：先在资源或执行器定义里写 ${secret:名字}，再设置”。
     - 读值之前先列出这一版的使用者（资源号、执行器号）；地址照各自的定义，这里不打印。
     - 摘要规则：默认原样存；`--digest <名字>=sha512_base64` 只存 Base64(SHA-512)，原文不进密钥库。有使用者要原值的（执行器、要原值的凭据项），不能只存摘要，拒绝，修正说明：给那一项换一个名字。
     - 新值已经以明文出现在某个普通变量或部署定义里（至少 8 个字符的值），拒绝：“这个值已经明文存在 <哪个变量或哪份定义的哪一处>：先在签发方换掉它”，不写值。
     - 写进以后输出名字、第几版、摘要规则、长度和使用者；最后一行是下一步：“在签发方吊销或换掉旧值；Hub 删掉条目只是自己不再用它，备份里还有”。
   - `secret import`：plan-evidence 那条改成写到名字。
     - 照旧全部核对过才写，核对和 `secret set` 一样：要先有定义引用、先列出使用者、摘要规则合使用者、短值要 `--short`；
     - 屏幕上只有键名、找到或没有、长度，和写进了哪个名字的第几版；
     - `--basic` 拼出整个 `Basic base64(用户:口令)` 头值，存成一个密钥，并照 plan-evidence 现在的核对，核引用这个名字的每个凭据项都是原样存整个 Authorization 头的；以后新加的使用者要重新输入一次值，那时由输入的人负责；
     - 同一个名字不能写两次。
   - `var set` 另外用新值，重新核对引用它的每份启用中的资源和执行器定义：解析以后要过各自的模式和大小上限（第 4、5 条）；不合格就不设，写明哪一份、哪一处，不写值。第二步再加按所属包的声明核对（第 9 条）。
   - 撤回：
     - `var unset`：还有启用中的定义引用它就拒绝，列出它们；产品包声明的名字照样能撤，输出写明那个包的下一次真实同步会拒绝；
     - `secret unset` 不拦，要能马上停用一把钥匙：删掉条目，列出从此会被拒的使用者，最后一行写同样的下一步（在签发方吊销）。
   - 输出：
     - 默认不显示值，也不显示值的摘要（字段名、目录名从摘要猜得出来）。
     - `var list` 每个名字一行：名字、种类、第几版或没设置、长度、谁在用（定义和位置）、最近一次谁在什么时候为什么改、问题和下一步。“设置了，没有使用者”只是说明，不算问题。`--run` 列这个运行的读清单和作业里每处引用用的名字和第几版；`--root` 列这个根的组成记录里每一处。
     - `var show <名字>` 同样不显示值；`--value` 才显示（和 `--history` 一起时显示每一版的值），先打一行提醒：“下面是变量的值，会留在终端记录里”。
     - `secret list`、`secret show` 从不出现密钥的值，只有第几版、长度、摘要规则、使用者。另分几段列出：旧写法的条目（`connector.<资源>.<凭据项>`、`executor.<执行器>.bearer`，各写改法）；登录状态的条目；没有决定指着的条目；登记了、却没有条目的版本。这几段是输出里分开的几段，不编种类码。
   - 旧写法 `secret set <资源> <凭据项>` 拒绝（位置参数），修正说明：先 `resource update <资源> --credential <凭据项>=<名字>`，原值会迁移过去；以后换值用 `secret set --name <名字>`。
   - 钥匙丢失以后的恢复照新写法，就是 `hub/platform/**`、`hub/server/assemble/README.md` 里 plan-evidence 写的那几步：停服务、移开 `vault/`、`key init`、`operator-token reissue`、`secret import`、起服务。导入之前 `secret list` 写“登记了第 n 版，密钥库里没有它的条目”。
   - 从备份恢复：恢复步骤加一步，开服务之前看 `secret list` 列出的每个密钥最近一次设置的时刻；恢复点以后在签发方换过或吊销过的，先 `secret set` 或 `secret unset`。
   - `hub/server/assemble/README.md` 123 行“secret list 从不打印长度”改成“只打印名字、版本、长度、摘要规则和使用者，从不打印值和值的摘要”。
   - 测试（`hub/server/assemble/cli-admin.test.ts`）：
     - 每个子命令；非管理员被拒；
     - 终端和管道两种输入，几个名字一起设；`secret set --name A AKIA…`（多一个位置参数）被拒，什么也没记下，那个参数不出现在任何输出和日志里；小写名字被拒，输出里也没有它的大写写法；
     - 还没有定义引用的名字被拒；使用者先列出来；
     - `--text` 存成字符串；JSON 坏了只报行列；`--dry-run` 什么也不写；像令牌的值被拒，给了 `--not-secret` 能存；理由里含密钥的值被拒；
     - 钥匙丢失以后，`secret list` 写“登记了第 n 版，密钥库里没有它的条目”；`secret import` 以后读一次成功；
     - 全部输出和日志里找不到合成密钥的值，也找不到普通变量的值（`--value` 那一次除外）；
     - 旧写法被拒，并带改法。

4. **资源**（`contracts/src/resources.ts`、`hub/connectors/**`、`cli-admin.ts` 的 resource 命令）：
   - resource@1 的 `credentials`：值可以是 `${secret:名字}`；旧的条目名照旧解析得出，只为读历史。`credential_digests` 照旧写凭据项要的摘要规则，类型换成生成的 DigestRule。
   - 命令：
     - `resource add` 要给系统包声明的每个凭据项一个 `--credential <凭据项>=<密钥名>`，缺了就拒绝并列出；AddResourceInput 加 `credentials`（凭据项 → 密钥名），声明了凭据项的系统包必填；
     - `update` 给了哪项换哪项；`--system-pack` 换到多了凭据项的版本时，同一次给；
     - 引用的密钥可以还没设置，命令回一行：“密钥 X 还没有设置：用 circle-hub secret set --name X 设置”；已经设置、但这一版没有登记这个资源的，回一行：“要重新输入一次值才会发往这里”。
   - 迁移旧值（照退役 CIRCLE_SERVER_* 的做法，不留兜底）：
     - `update` 把凭据项从资源自己的旧条目改成引用一个名字时：
       - 那个名字还没设置：旧值照凭据项的摘要规则成为它的第一版，使用者就是这个资源，发往的地址取迁移之前那份定义的，理由写“从资源 <资源> 的凭据项 <凭据项> 迁移来”；
       - 已经设置：按凭据项的规则比，相同就记一个新版（同值，使用者加上这个资源），不同就拒绝，修正说明：换一个名字；
       - 同一次 update 还改了 origins 或 allow_plaintext：不迁移，拒绝，两件分开做（改了地址要重新输入一次值）；
       - 次序：先写密钥的条目；再在一个事务里写密钥的那条决定和资源的新定义；最后删旧条目。中途失败，旧条目还在，可以重来；
       - 旧条目已经不在（比如钥匙丢失以后）：照常改成引用，没有可迁移的，命令回一行：“原值不在密钥库里：接着用 circle-hub secret set --name <名字> 设置”。
     - `update` 不再因为凭据项不声明了、或者规则变了去删密钥（可能还有别人用）；资源自己的旧条目照旧删。
     - 凭据项还指着资源自己的条目时，读一个请求都不发，确定地拒绝。管理员日志写：“资源 <资源> 的凭据还是旧写法：用 circle-hub resource update <资源> --credential <凭据项>=<密钥名> 改成引用，原值会迁移过去”；调用方照旧看到 SOURCE_UNAVAILABLE。可以一次迁一项，全部迁完以前读照旧拒绝。
   - 设置：
     - `settings` 里任何一个字符串值都可以是 `${var:名字}`；不许有 `${secret:…}`；`origins`、`allow_plaintext` 不许引用。
     - 配置（加、改、启用）时，在写决定的事务里取第 2 条的名字锁再核：引用的变量要已经设置，不然拒绝：先 `var set`；名字不能是产品包声明的：“名字不可用：它属于一个产品包”。解析以后的设置照旧至多 64 KiB。
     - 命令行上逐项改：`--setting <键>=<文字>` 存成字符串（不再猜 JSON；值是 JSON 数组或对象的拒绝，提示用 `--setting-json`），`--setting-json <键>=<JSON>`，`--setting-var <键>=<变量名>`（命令替你写成引用，免得 shell 把 `$` 吃掉），`--unset-setting <键>`。`update` 只改给了的键，别的设置不动；`add` 用同样的写法。
     - 凭据扫描照旧扫设置，引用不算命中。
   - 用的时候：
     - 设置里的引用按这次读拿到的那份变量取值解析：start_run 和同步各给一份（第 6、9 条），嵌套的读用上层那份；别的读在读的那一刻取。资源定义照旧在每次读时取，读清单写 `rec:<资源配置决定>`。
     - 密钥在登录、带静态头时，按名字取当前一版，核对这个资源在这一版的使用者里、发往的地址没变。
     - 读清单（read-manifest@1）的 `inputs` 在 `rec:<资源配置决定>` 后面，加上用到的每个变量和密钥的 `rec:<决定>`；新加可选的 `variables`，写每处 VariableUse；读缓存的键也算上这些决定。
     - 登录状态的绑定加上所引用密钥的决定：换了一版，旧的登录状态和停下都不再用，下一次读用新值登录一次，不用重启。
     - 登录被拒时，停下另记在所用的那几版密钥上（一个密钥库条目，名字由这几版的决定算出）。引用同样这几版的别的资源也不再登录，一个请求都不发，下一步同样是 `secret set` 或 `resource reset-login`；reset-login 同时清掉这几版上的停下。
   - 这一件新加的给管理员的拒绝文字（旧写法、密钥没设置、这一版没登记这个资源），只走 `read.ts` 现有的管理员原因那条路进管理员日志；读清单的 `reason` 里只记码。
   - 脱敏：
     - 进程启动时、每读到一条密钥决定时，把每个密钥当前一版和上一版的值登记进脱敏器；摘要规则算出的值、组出的头值、Basic 的两段，在第一次发出之前用 addSent 登记；
     - 回显了 Hub 发出的凭据的应答：原件照旧只保留，可见范围改成只有管理员；带运行号的读清单里这一条的 `sha256`、`artifact` 写 null，原件的记录号只进管理员日志。
   - 去掉 `connectors.admin.setCredential(s)`，凭据都经密钥。`hub/connectors/testing/` 加一个合成用的帮助函数：建资源时引用合成的名字，再按名字设合成值；各包测试里那几行改用它。`describe` 给出每个凭据项引用的密钥、摘要规则、有没有设置、这一版有没有登记这个资源，不读值。
   - 新命令 `resource show <资源>`（只有管理员），列出：
     - 列表那一行；
     - 设置：引用照写，注明变量现在是第几版；字面值只写键和长度，给了 `--values` 才显示；
     - 凭据项和它引用的密钥：第几版、长度、摘要规则、有没有登记这个资源。
   - 测试：
     - 两个合成资源引用同一对密钥，各登录一次；换口令以后，下一次读各重新登录一次；第二个进程不重启也看得到；
     - 新口令是错的：两个资源合起来只登录失败一次；
     - 改了一个资源的 origins：读被拒，管理员日志写重新输入；重新输入以后照常；新资源引用已有的密钥、用自己定的 origin：一个请求都不发；
     - 旧写法的资源：读被拒，管理员日志有改法；`update --credential` 以后照常读，旧条目没了；原值和已有密钥不同的被拒；迁移时同时改 origin 被拒；旧条目不在时照常改引用并提示；
     - 摘要规则不合被拒；`origins` 里写引用、设置里写 `${secret:…}`、引用没设置的变量、引用产品包的名字，都被拒；
     - `var unset X` 和新引用 X 的 `resource update` 并发：只有一个成功，不会留下引用没设置的变量的定义；
     - `--setting` 不再猜类型、JSON 数组被拒并提示；逐项改不动别的设置；`--unset-setting`；
     - 读清单的 `inputs`、`variables` 和缓存键里有变量和密钥的决定；`reason` 里没有新的管理员文字；
     - 回显凭据的应答：读清单里没有它的摘要，原件只有管理员读得到；
     - `resource show` 不显示密钥的值，字面设置只显示长度。

5. **执行器**（`hub/dispatch/**`、`hub/server/cli-job.ts`）：
   - executor@1 加可选的 `credential`：写 `${secret:名字}`，调用执行器时作 `Authorization: Bearer` 的值。已存的定义照样读得出来；没有它的定义，precheck 和派发都拒绝，修正说明：定义里加 `credential` 以后 `executor update`，原来的钥匙从 `executor.<执行器>.bearer` 迁移过去（次序和“同一次不许改 endpoint、ca”照第 4 条）。
   - 能写普通变量的只有期望值：`target`、`manifest_sha256`，和 `conditions`、`precheck_reads[].conditions` 里的 `equals`、`at_least`、`sha256`（`pointer` 不行）。别的字段，连同 dispatch-gateway 加的（retry_safety、premises、actor、probes、refused_tools、side_effects、clock_skew_ms、reconciliation、conformance、read_retry_when，和 receipt、result 里加的指针）和以后加的，都只照字面，只能经 `executor update` 改。换进来的值里不许有 `$value` 键，不能借变量加出新的绑定。
   - 两份模式：
     - 源定义（新，`ExecutorSource`）：只在上面几处多认引用，其余和 ExecutorDefinition 一样，照样补默认值；登记存的是它；
     - 解析后的定义：按当前值换进去，再用 ExecutorDefinition 严格核对，大小上限也照它。登记时在写决定的事务里取第 2 条的名字锁再核：引用的变量要已经设置、不能是产品包声明的名字；密钥可以还没设置。
   - 作业：
     - `job dispatch` 开始时解析一次，把解析后的定义存成对象；作业绑定里写源定义的摘要、解析后的摘要和所用变量的决定；
     - 提交前按当前值再解析一遍，源定义或解析后的定义变了，就照现在那句拒绝：“执行器配置已变；未提交，请按当前配置重新核验”；
     - 写了意图以后从不重新解析：恢复、对账、读状态和结果都读钉住的那份；之后变量改了，只在作业里记一条漂移说明；
     - `job precheck` 同样钉住它那时解析的定义，`--save` 写出的就是这份；
     - 核验运行以后改了 `manifest_sha256` 引用的变量：派发在证明核对处被拒，下一步照决定 31：用当前清单重跑核验运行。
   - 钥匙：
     - 每次开会话时按名字取当前一版，核对这个执行器在这一版的使用者里、endpoint 和 CA 没变；
     - 作业的动作记录写所用密钥的名字和第几版，不写值；
     - 派发前没设置或不合：一个请求都不发，记“未发出”，下一步写 `circle-hub secret set --name <名字>`；
     - 恢复和对账时（`resume`、`dispose --reconcile`）钥匙没设置或已撤回：不抛出，记一条确定的下一步：`circle-hub secret set --name <名字>`，然后 `circle-hub job resume <作业>`。
   - 资源键：`executor update` 改了 `resources`，而现在这些键上还有未结束或冻结的作业，就拒绝，写明作业和 `circle-hub job dispose <作业> …`。README 那条“按相交物理资源检查未完成作业”从此改键名也绕不过去。
   - 命令：`executor add` 不再读标准输入；`update --secret` 去掉，给了就拒绝，修正说明：用 `circle-hub secret set --name <名字>` 换钥匙，引用它的每个执行器下一次开会话就用新的；`setSecret` 去掉。
   - “定义里不许有钥匙原文”和绑定元数据的核对，比的是全部密钥现在的值，不只自己的那把。
   - 派发改用和连接器同一个脱敏器（装配时传进来）。派发作业里经过脱敏改了字节的应答，动作记录不写 `received_sha256`（这类记录运行者读得到），改记在一条不带运行号的动作里，只有管理员读得到；预检作业的记录只有管理员能读，照旧写。
   - `executor list` 照现在那一行（`执行器编号 …；定义摘要 <源定义的摘要>；启用 …；具备派发登记 …`）后面加上解析后的摘要和所引用变量各在第几版。`scripts/real/accept/device-run.ts` 的第 0 步改按源定义模式解析，照旧比源定义的摘要，另核同一行的解析后摘要。
   - 测试（照 hub-job-dispatch 的合成网关）：
     - 两个执行器引用同一把钥匙，换一次，两个都用新的；
     - 没有 `credential` 的旧定义被拒；`executor update` 以后钥匙迁移过去；同一次改 endpoint 被拒；
     - `add` 不读标准输入；`--secret` 被拒；
     - 在绑定和提交之间插一次 `var set`：照现在那句拒绝，提交 0 次；核验运行以后改清单摘要的变量：在证明核对处被拒，下一步是重跑核验；
     - 派发以后改它引用的变量、杀掉进程、`resume`：指针和映射照旧，结果读得到，作业里有一条漂移说明；
     - `resume` 时钥匙已撤回：记下一步，不抛出；
     - 在 `endpoint`、`calls`、映射、`proof`、`allowed_tools` 或 dispatch-gateway 加的字段里写引用，`executor add`、`update` 都拒绝；换进来的值带 `$value` 被拒，`var set` 也拒绝；
     - 冻结的作业占着键 A，`executor update` 把 A 改成 A2 被拒；
     - 改了 endpoint 以后不重新输入钥匙，开会话被拒；
     - 动作记录、日志和输出里找不到钥匙的值；脱敏过的应答旁边没有原字节的摘要。

6. **运行**（`hub/runs/engine/start.ts`、`inputs.ts`、`projection.ts`、`hub/ports.ts`）：
   - start_run 开始时读一次全部普通变量的当前决定，这次调用里的读（绑定的输入、期望来源）都用这一份；`ExternalReadContext` 加可选的这份取值，不进运行记录。运行的外部读都在 start_run 里，读到的字节冻结进运行，评估只读冻结的字节，之后改变量不影响已开的运行。以后有了开跑以后的外部读，再加持久的快照。
   - start_run 的参数照 B08 R[1] 过一遍凭据扫描，命中就整次不受理：SUBMISSION_SCHEMA_VIOLATION，修正说明“参数里不能有凭据”。Circle 会把 `%名字%` 换成值再调 Hub 的工具，换进来的口令会冻结进运行记录；这一步挡住扫描认得出的那部分。参数里的 `${var:…}` 这类写法只是文字，Hub 不解析，也不拒。
   - 测试：
     - 一次 start_run 里两处读引用同一个变量，两处读的中间插一次 `var set`：两处用同一版；
     - 改值以后新开的运行用新值，已开的运行的输入不变；
     - 参数里有合成口令被拒；参数里写 `${var:X}` 照常受理，原样记进运行记录。

7. **验收**（`tests/acceptance/<开分支时的下一个编号>-variables.test.ts`，全部合成）：
   - `tests/acceptance/support/hub.ts`、`hub/server/testing-real.ts` 和 `tests/acceptance/28-device-run.test.ts` 改成按名字设密钥，资源和执行器引用它。
   - 两个合成资源共用一对门户密钥，读成功，各登录一次；换口令以后，下一次读各登录一次，不重启。
   - 撤回口令：读被拒，管理员日志写明 `secret set` 那句；用户只看到“对你不可用”。
   - 照旧写法建的资源：读被拒；`resource update --credential` 以后照常读。
   - 资源设置引用一个变量：开运行 A，改这个变量，再开运行 B；A、B 的读清单各记着自己用的版本，`var list --run` 对得上。
   - 合成执行器用 `${secret:…}` 和 `${var:…}`：绑定和提交之间改变量，派发被拒；重新核验以后派发成功。
   - 普通用户的 var、secret 命令都被拒；没有任何工具返回变量记录。
   - 扫数据目录、日志和全部命令输出，找不到合成密钥的值。

### 第二步：产品包声明它读的变量（第一步合并以后接着做）

8. **声明和发布检查**（`contracts/src/product.ts`、`hub/runs/packs/validate.ts`、`registry.ts`）：
   - product@1 加可选的 `variables`，每项是 VariableDeclaration：
     - `schema` 是 JSON Schema 2020-12，和工作流参数用同一个 `packSchema`（`hub/runs/engine/slots.ts`），Hub 执行不了的不收；
     - `default` 必须有、要合模式、只许合成的值，只用于发布校验的样例和试运行；
     - 名字照第 1 条，同一个包里不重名，不许像密钥。
   - 引用只许写在 `sync.options` 和生产器 `params` 里：任何深度、整值 `${var:名字}`；名字要在本包的 `variables` 里。
   - 名字属于第一个发布时声明它的包，和包号属于第一个发布它的人一样（R01 R[0]）。核对放在写发布决定的事务里，先取第 2 条的名字锁；产品包的发布本来就在 PRODUCTS_LOCK 下逐个进行。
   - 发布检查拒绝这几种：
     - 别的位置出现引用；包里出现 `${secret:…}`；
     - 引用了没声明的名字；声明了却没引用；
     - 同一个包各版本里同名变量的模式不同（按规范 JSON 比；要改模式就换名字）；默认值可以不同；
     - 名字属于别的包、被部署定义引用着、或者是密钥：这三种都只回答一句“名字不可用”，不说是哪一种。
   - 包登记经装配接进来一个端口问名字（`hub/server/variables.ts` 知道哪些定义引用了哪些名字）。
   - 系统包和工作流包这一件不加声明；它们的文件里出现引用，照第 1 条写明这里不能引用。
   - 测试：
     - 声明的正例和反例：模式执行不了、没有默认值、默认值不合模式、重名、名字像密钥；
     - 引用的位置对和不对；包里写 `${secret:…}`；声明了没引用；
     - 另一个包声明同一个名字被拒；同一个包新版改模式被拒，只改默认值能发布；名字是密钥、或被资源定义引用着，被拒，三种回答一样；
     - 不带 `variables` 的包照旧通过。

9. **同步和生产**（`hub/knowledge/**`、`contracts/src/knowledge.ts`、`contracts/src/product.ts`）：
   - 每次 `knowledge sync` 开始时读一次全部普通变量的当前决定，这次同步的计划、读和生产都用这一份（`ExternalReadContext` 的那份取值由同步经 `sources.ts` 填上）。
   - 真实同步：包里引用的变量有一个没设置，或者值不合所属包的声明，这个产品的同步在读任何页之前确定地失败。报告列出每个名字和改法（`circle-hub var set <名字> --file …`），不写值，不记未知，也不产出任何东西。
   - 试运行（`--dry-run`）：没设置的按包里的默认值，报告写明哪些名字用了默认值；试运行什么都不写。
   - 先解析引用，再照旧合并：这次调用给的选项压过包里的（`sync.ts` 合并 planOptions 的地方）。解析以后的同步选项和生产器参数照包函数输入的上限核；`var set` 时也按所属包里引用它的每一处核，超了就不设，写明是哪一处。
   - 记录：
     - 计划轮动作（`writePlanAction` 写的那条）的 detail 加上同步选项里每处引用的 VariableUse；
     - tree_root@1 加可选的 `variables`（VariableUse 列表），由 Hub 写；
     - “已有根，来源和生产器都没变”的判断加上所用变量的决定：变了就重产，报告写“变量 X 从第 m 版变为第 n 版”。生产器照旧按“函数@版本 + 输入摘要”复用，值没变就不重算。
   - 生产器只收到解析后的参数，ProducerInput 和 SyncPlanInput 都不加字段：值的来历由组成记录写，生产器不写。
   - 同步报告每个产品一行：用到的每个变量是第几版。
   - 命令：
     - `var set` 按所属包的声明核对值，不合就不设，写明哪个包、哪一处，不写值；模式要的不是字符串、却给了 `--text` 的，提示去掉 `--text`；
     - `var list` 加上声明了却没设置的名字（问题一栏写“没设置：包 P 的真实同步会拒绝；下一步 circle-hub var set …”），和值不合声明的。
   - 测试（`hub/knowledge` 的合成产品）：
     - 没设置时真实同步失败并写明，什么都没产出；试运行按默认值并写明；
     - 设置以后，选项和参数被覆盖，组成记录写决定；调用给的选项压过变量；
     - 按名称族一族一个变量：只改一族的变量，只重产用它的那一份；
     - 同样的包版本、变量的值和源，两次产出的根摘要相同；
     - 值不合模式时，同步失败并写明。

10. **验收**（第 7 条那个文件加一段）：
    - 合成产品包声明两个变量，一个字符串、一个列表：没设置时同步被拒并写明；试运行按默认值；`var set` 以后再同步，选项和参数变了，组成记录和 `var list --root` 对得上。
    - 第二个合成产品包声明同一个名字，发布被拒，回答是“名字不可用”。
    - `var list` 里声明了没设置的、设置了没人用的（只是说明）、值不合声明的，各一行都对。

## 部署（集成者做，不在这一件里）

1. 第一步部署之前：用 `executor list` 看持久部署上登记了哪些执行器；用 `secret list` 记下旧写法的条目。
2. 部署以后，在同一个维护窗口里逐个资源执行 `resource update <资源> --credential <凭据项>=<密钥名> …`，原值会迁移过去。在这之前，旧写法的资源读不了（照退役 CIRCLE_SERVER_* 的做法，不留兜底）：
   - 敏捷平台和 PLM 的门户账号共用 `PORTAL_USERNAME`、`PORTAL_PASSWORD`；迁移来的原值不同，就分开起名；
   - SVN 和 OpenKM 的整个 Authorization 头，各用一个名字；
   - 迁移那一次不改 origin；每个资源各读一次；做完以后 `secret list` 里不再有旧写法的条目。
3. 网关的运行密钥（“仍要所有者亲手做的”那一节）：
   - 已经经 `executor add` 登记过的：`executor update <执行器> <定义文件>`，定义加 `"credential": "${secret:GATEWAY_RUN_KEY}"`，钥匙迁移过去，所有者不用再交；
   - 还没交的：集成者先登记执行器，定义里引用这个名字；所有者再执行 `circle-hub secret set --name GATEWAY_RUN_KEY --reason …`，从标准输入交；
   - 或者集成者在本机生成一把新的，明文只经管道进 `secret set`；跳板机上的摘要文件照那一节换；
   - 定义写 `"manifest_sha256": "${var:BED_MANIFEST_SHA256}"`。以后每次 `doc put bed-topology`，执行 `printf '%s\n' <doc put 打印的摘要> | circle-hub var set BED_MANIFEST_SHA256 --text --reason "重发台架清单"`，执行器定义不用改。台架名照旧写在定义里，资源键只经 `executor update` 改；
   - 改了执行器的 endpoint 或 CA，要重新输入一次钥匙。
4. 基线：`circle-hub var set REVIEW_BASELINE_BUILD --file <暂存目录里的文件> --text --reason "决定 35 运维第 12 项：第一次真实评审用的构建"`。没有包读它，`var list` 写“设置了，没有使用者”，只是记录，不当基线依据；以后要当依据，引用那次评审运行。
5. PLM（plm-fields 已经合并）：
   - 照真实原件核过字段名以后，`var set PLM_BUG_FIX_FIELD --file <文件> --text --reason …`；
   - PLM 资源执行 `resource update <资源> --setting-var bug_fix_field=PLM_BUG_FIX_FIELD`，别的设置不动。
6. 手册库（kb-unversioned 合并以后）：
   - `var set MANUAL_SPEC_FOLDERS --file <暂存目录>/spec-folders.json --reason …`（内容是 JSON 列表），资源执行 `--setting-var spec_folders=MANUAL_SPEC_FOLDERS`；
   - 以后要不要加 product/、qa/，就是一条 `var set`。
7. 第二步和对应的几页合并以后，发布那一版 FAMX 包，先设好这些变量再启用它（没设置的，FAMX 的真实同步会拒绝）：
   - `FAMX_MIN_LINE`（不设下限就显式设成 null）、`FAMX_MAINLINE_PAGE_WORDS`（famx-deployment-conventions）；
   - `FAMX_ADOC_ATTRIBUTES_<族名>`，每族一个，不设属性就设成 `{}`（adoc 的接线，在 famx-deployment-conventions 里）；
   - `FAMX_COMPONENTS`、`FAMX_LICENSES`、`FAMX_DEPLOYMENT_FORMS`，空闭集就设成 `[]`（kb-applicability）。
8. 真实值只用 `--file` 从 Git 外的暂存目录读，清单摘要那一条除外；密钥只经标准输入；进度页只记名字和第几版。做完以后，`var list`、`secret list` 的问题一栏清零。

## 集成者答复（2026-10-24 凌晨）

- **05:12，答 codex-e**：第 3 条的密钥列表可用 `Vault.stat(name)` 读取写入时间等元数据，不读密钥值。可改路径补上 `hub/records/vault.ts` 和对应测试；元数据查询不成为回显值或值摘要的出口。
- **06:23，答 codex-e（第 5 条与 D02 R[6]）**：固定原作业的变量决定和派发字段；管理员仍可更新只读策略与认证。修补定义只按原作业固定的变量决定解析，派发字段完全相同才另存修补定义，并记录源摘要和解析摘要，绝不取当前变量替换原作业的取值。
- **06:35，共用入口**：`configureResource` 可加可选事务参数，与 hub-read-absence 在同一入口的改动合一，沿用本页 `hub/records/authorizations.ts` 的最小事务接线，不分出两套入口。重叠由后合并方解决。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
