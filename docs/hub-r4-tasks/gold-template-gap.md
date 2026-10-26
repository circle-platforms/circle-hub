# 任务：模板查缺的蜕变核对改走真实 Circle 客户端，两份以上文档，含关键词类别

依据：

- 架构 6b（`docs/hub-r4-architecture.md` 134 行）：删掉一个类别的全部用例，这一类必须变成缺；加回一个，必须变成有；报告与用例的次序无关。139 行：每项能力最后都经 Otty 里真实的 Circle 客户端验收。
- 终审（`docs/hub-r4-progress.md` 197 行）：蜕变核对没经过 Circle，只核了一份文档，关键词类别没测。先前的核对 `scripts/real/accept/template-gap-metamorphic.ts` 经 MCP SDK 调 Hub（29 行），最多挑 3 个类别（512–520 行）；真实客户端的场景 `scripts/real/accept/template-gap.ts` 只核用例数和“缺 N 个模板类别”的写法（28–29 行）。
- 包 README（`packs/workflow/template-gap/README.md`）：
  - 类别只看用例自己的标签和文字、以及祖先节点的文字（64–70 行；`functions/template.ts` 150–158 行）；六种测试类型以外的类别按关键词找（202–203 行）；
  - 上传的条目编号是 `upload-` 加字节 sha256 的前 12 位（50–51 行）；一次运行里根编号不能相同，有一份文档没有用例整次运行就被拒（187–188、86–89 行）；
  - 删去用例会让带标签的分组节点变成用例（偏离 5，167–174 行）。
- 摘要以 `functions/project.ts` 140–155 行的写法为准（README 81 行里“用例规则”的位置旧了）。回答里摘要超过 300 个字符就截断，截断处写出全文的引用（`hub/server/text.ts` 81、139、439–441 行）；`get_nodes` 按引用读时，回答第一行是“内容 <引用>：…”（1219 行）。
- 独立的用例规则：`scripts/real/gold/cases.ts` 的 `parseMindMap`、`caseNodesOf`（34、157 行），照 README 的文字另写，不导入 `hub/` 和 `packs/`（1–3 行）。
- Circle 对 base64 的文件参数收本地路径，自己读文件、发字节，相对路径按工作目录算（`contracts/src/tools.ts` 68 行；Circle 的 `src/mcp_loader.ts` 99–100 行，本地分支 `hub-mcp-client`）。

- 分支和工作树：`gold-template-gap`，目录 `circle-hub-gold-template-gap`（依赖已装好）
- 可以改的路径：新文件 `scripts/real/gold/gap-metamorphic.ts`、`scripts/real/accept/template-gap-metamorphic-circle.ts` 和它们的测试；按第 1 条改 `scripts/real/lib/accept.ts`、`scripts/real/accept-circle.ts`、`scripts/real/circle-home.ts`、`scripts/real/circle-home.test.ts`。`hub/`、`packs/`、`contracts/` 不动；旧的 `template-gap-metamorphic.ts`、`template-gap.ts` 不动；Circle 仓库只读。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。第 1 条单独一个提交。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 "scripts/real/**/*.test.ts"`。

## 要做的

1. **驱动真实客户端的三处通用改动**（别的场景行为不变）
   - `Scenario`（`scripts/real/lib/accept.ts` 6–16 行）加可选的 `prepare(workdir)`。`accept-circle.ts` 在写好专用目录（53 行）之后、启动 Circle（60 行）之前调用它，传 `written.workdir`；临时目录照旧在结束时整个删掉（69 行）。场景的 `sections` 在 `check` 里算好就行（82 行在 75 行的 `check` 之后才读）。
   - `Scenario` 再加可选的 `limits`：`accept-circle.ts` 81 行把它接在两句固定的限度后面。现在场景没有这个字段，第 3 条要写的限度靠它。
   - 这个场景一轮对话里有几百次工具调用。Circle 按估算的 token 数到窗口的 85% 就压缩对话，压缩时请模型写总结，不知道窗口时按 128,000 算（Circle 的 `src/context_middleware.ts` 290–312、428 行，`src/model_catalog.ts` 6 行）；脚本化模型写不了总结。`writeHome`（`circle-home.ts` 129 行）加一个可选项，只由 `accept-circle.ts` 传：在 `settings.json` 里给脚本化模型写 `models.<模型名>.context_window`（`src/model_catalog.ts` 160–167 行），取 1,000,000。先只读 Circle 源码确认这条路，确认不了就回报，不改 Circle。

2. **副本和预期**（`scripts/real/gold/gap-metamorphic.ts`，纯函数）
   - 输入是导出的原始脑图 JSON。用例按 `caseNodesOf` 的默认规则（标签或标记，和包的默认一致）；最外层用例是不在别的用例里面的用例。
   - 副本，每份换一个文档里没有的新根编号，别处原样：
     - a 原件；b 换序：每一层的子节点倒序；
     - c 单用例：根、到这个用例的祖先链（每个祖先只留通往它的那个子节点）、用例的整棵子树，每个最外层用例一份；
     - d 删去 X（原件里为“有”的每个类别一份）：去掉 X 在其单用例副本里为“有”的全部最外层用例，连同子树；
     - e 加回：在 d 上把其中文档次序第一个放回原来的父节点下；
     - f 加入（A 里缺、B 的单用例副本里有的每个类别一份）：把 B 的根（换新编号，当普通节点）、祖先链和 B 里第一个 X 为“有”的最外层用例，挂在 A 的根下最后。
   - 预期只有一条：一份副本的缺失集合 = 它包含的每个最外层用例的单用例副本缺失集合的交集（a、d、e、f 都用；f 里两份文档的用例都算）。b 的摘要与 a 逐字相同。理由：副本里每个用例的标签、文字和祖先文字都和它的单用例副本一样；f 里 A 的根文字只会带来 A 本来就有的类别。
   - 前提，每份副本都用独立规则核：用例数 = 它包含的单用例副本用例数之和。以下几种不做，按原因记下：前提不成立（删去以后有上层节点变成了用例，例如偏离 5）；X 在每个最外层用例上都有；没有一个单用例副本显示 X；依赖的单用例副本答案未知。
   - 不读包的标签写法和关键词。`packs/workflow/template-gap/tables/template-v3.json` 只用 `JSON.parse` 读 `id`、`label`、`group`（7–30 行），用来解析摘要、列出 24 个类别、分出类型标签类别（`group` 为 `test_type`）和关键词类别；`tags`、`contains`、`prefixes`、`equals`、`fields` 一项不读，包的判定就进不了预期。导入 `gold/cases.ts` 不造成循环：它是另写的规则，不引用被核的代码。
   - 一项不靠 Hub 的核对（类型名标签）：单用例副本里有按独立规则算作用例、`resource` 里有一项不分大小写恰好是 Functional、Configuration、Integration、Compatibility、Negative 或 Stress 的节点时（架构 6a 120 行的六种类型，名字写在脚本里），对应类别必须是“有”。

3. **场景**（`scripts/real/accept/template-gap-metamorphic-circle.ts`，默认导出 `(gold) => Scenario`，照 `case-compile.ts` 25 行起的分段写法）
   - gold 放在仓库外：`{"documents":[{"file":"<原始脑图 JSON>"},…],"maxCases":80,"batch":20}`。不到两份，或者某份的最外层用例超过 `maxCases`，不开始，记不符。
   - 分三段：① 每份文档的 a、b；② 原件用例数和独立数法一致的文档的全部 c；③ d、e、f，用 ② 的答案造好、写进工作目录再上传。每段先 `hub_upload_file`（`file_path` 写工作目录里的相对路径，文件名只用序号；`media_type` 写 `application/json`），每个回复最多 `batch` 个调用；再 `hub_start_run`（`pack: "template-gap"`，`inputs.documents` 是引用数组，每次最多 `batch` 份，每个回复一次）。
   - 读答案，不靠结果的次序对：
     - 上传按 `src:<sha256>` 对，它必须等于写下的字节的 sha256；开始运行按条目编号 `upload-<前 12 位>` 对，条目数要等于这一批的份数；
     - 条目行按“ | ”拆，去掉以“位置 ”开头的最后一栏，剩下的最后一栏是摘要（摘要里没有“ | ”，标题里可能有）；解析用例数和缺失的类别编号，认“（只列编号）”和“24 个模板类别都已覆盖”；
     - 摘要被截断时，用 `hub_get_nodes` 读截断处给的引用加 `/summary`，按回答第一行的引用对上（回答是 JSON 字符串就先解码）；
     - 上传或开始运行被拒（例如 `CREDENTIAL_IN_UPLOAD`、`no_case`）、全文读不到的副本记未知，写明原因，不算相符。
   - 开始以后再收到没有工具结果的请求（Circle 压缩对话时就是这样），只回一句文字、不重新开始、不推进，并让“对话没有被压缩”一项记不符。
   - 核对，每份文档每种一项，比整个缺失集合，相等才相符；不符时写出副本 sha256 的前 12 位和多出、少掉的类别编号：上传字节、原件用例数、单用例副本用例数、换序、拆分（a 等于全部 c 的交集）、类型名标签、删去（目标类别都变成缺）、加回和加入（目标类别都变成有）。另加三项：至少两份文档走完三段；类型标签类别和关键词类别各至少一类当过 d 或 f 的目标；对话没有被压缩。某种副本一份都没有时，这一项不算核对，写进“没做”那一节（不算通过）。
   - `sections`：按类别一行，写编号、类型标签或关键词、每种副本上相符和不符的次数（每份副本 24 个类别各记一次）、当目标的次数；再一节按原因列没做的副本数。`limits` 写明：只证明查缺结果随变换变得对，不证明某个用例按关键词归的类对不对；按命令的覆盖（架构 6a）没核；副本作为上传的源文件留在已部署的 Hub 里。
   - 报告、进度行和屏幕上只有段号、类别编号、计数和 sha256 前 12 位，不写标题、节点文字、节点编号和文档编号。

4. **测试**（合成脑图，文字全是编造的；不连 Circle，不连 Hub）
   - 副本：每种的结构（新根编号、祖先链、子树、放回原处、加入的位置）；嵌套用例只算进最外层；带标签、优先级 1、只装着 X 的用例的分组，d 被认出不做；X 在每个用例上都有时不做。
   - 预期：假 Hub 按合成脑图写明的答案作答（每个合成用例写明它显示哪些类别，按节点编号查，不看文字），全部核对相符。再各造一个错的假 Hub，让对应那一项不符：换序后少一类；单用例副本丢了祖先文字带来的类别；用例数少一个；加入以后目标类别仍缺；上传引用的 sha256 不对。
   - 解析：摘要的两种写法和全覆盖；截断带引用和不带引用；标题里有“ | ”。
   - 场景：照 `capability-scenarios.test.ts` 用合成的工具结果走完三段，断言每个回复的调用数不超过 `batch`、开始运行被拒时那一批记未知、开始以后收到没有工具结果的请求不重新开始；那个文件 199–215 行的扫描照过。
   - 独立性：`gap-metamorphic.ts` 和场景的源码不导入 `hub/`、`packs/`（测试读源码核对 import），`template-v3.json` 只按路径读。
   - `writeHome`：不给那个可选项时，`settings.json` 和现在一样。

5. **集成者之后跑**（终端不跑；真实 Circle 客户端，已部署的 Hub，至少两份真实文档，其中至少一份有关键词类别为“有”）：

   `HUB_REAL_TOKEN=… node scripts/real/accept-circle.ts --scenario scripts/real/accept/template-gap-metamorphic-circle.ts --gold <仓库外的 gold.json> --out <仓库外的目录> --timeout-ms 1800000`

   屏幕上只应出现：每段上传和开始运行的次数、每项核对的相符或不符、按类别的计数、没做的副本按原因的计数，以及“共 N 项核对，P 项相符，F 项不符”。模型日志和屏幕记录只写进 `--out`。

完成后在终端里回报：提交号、测试数量、合成脑图上每种副本各几份、Circle 上下文窗口那条路确认了没有、没做完或拿不准的地方。

## 集成者对待定问题的答复（2026-10-23）

1. 按命令的覆盖（架构 6a）这一件不做：要先有产品包的命令抽取，记为查缺能力的功能缺口，等手册和用例的命令都进树以后再排。
2. 哪些类别必选，转给所有者（待定列表）；蜕变核对比的是缺失集合，不受影响。
3. 上传副本可以接受：用现在的评审用户令牌，副本只有本人和管理员可见。
4. 含凭据写法的文档会被上传拒收：由集成者挑没有命中的文档来跑。
5. Circle 自动压缩：集成者第一次真跑时看屏幕，确认没有出现压缩；不行再拆成几次运行。
6. 删去后带标签的分组变成用例这种情况，按原因计数，不算不符；它在 6b 下怎么算，转给所有者（待定列表）。
7. 回答文字只在截断时给运行记录的引用，这个场景够用。
8. 旧的 SDK 版核对先留着，新场景在真实数据上通过以后再删；包 README 和 project.ts 的不一致记为包的待修项。
9. `scripts/real/accept-circle.ts` 这一轮归你：屏幕上只打汇总行，报告写文件。另外两件（gold-case-commands、gold-trace）不改这个文件，要注册场景的先回报，由集成者按顺序合并。
