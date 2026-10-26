# 任务：按模板查缺：24 个类别照旧全必选，另按命令出覆盖

依据：

- 决定 35 第 19 项：24 个类别都必选，另外按命令出覆盖。
- 架构 6a 第 2 条：模板里有一组类别是按每个 CLI 命令说的（增删改查、最大配置下的 show、no 与 clear、操作日志、审计日志），就是 `packs/workflow/template-gap/tables/template-v3.json` 里 group 为 `command` 的 9 个类别。6b：去掉一个类别的全部用例就缺、加一个就有、和用例的顺序无关。
- 命令从哪来：知识树里的用例条目（K02）已经带着按代码解析出的命令。产品包的用例生产器 `packs/product/famx/functions/cases.ts` 给每个用例写 `data.document`、`data.node`、`data.commands`（标题和上级节点里的命令短语，对这个构建的命令目录解析出的路径）；条目键和 case-review 的条目编号是同一条规则（`cases-nodes.ts` 的 `caseKeys`）。T01 R[0] 要求只有一份实现，所以本包不自己解析命令，读这份索引。`gold-template-gap.md` 第 71 行把这件记成“要先有产品包的命令抽取”，现在已经有了。
- 读法照 defect-to-case：它把 `knowledge:index:…` 绑成输入槽，投影把视图收进 groups（`packs/workflow/defect-to-case/functions/projection.ts`，`subjects.ts` 的 `duplicateSubject`）。索引视图的形状和完整性字段见 `contracts/src/views.ts` 的 `IndexView`（`truncated`、`cut_keys`、`skipped`）。
- 现在用例的命令只从标题和上级节点解析。从步骤行和期望行也解析，是 hub-view-scope 第 3 条；在那件合入之前，索引须提供覆盖生产器所有扫描文字的逐用例修订事实；本包须同步冻结并核验该事实，增加“同步后仅改步骤即未匹配”的测试，不能只凭标题和祖先标签接收扩展索引。该跨包合并依赖见包 README。
- 模型元素：W01、W02、C04、C05、K02、T01。`node tools/show-element.ts W02 C05 K02 T01`。模型文字不用改；架构 6a、6b 的说法由集成者在合并时对齐。

- 分支和工作树：`template-gap-categories`，目录 `circle-hub-template-gap-categories`。现在就能从 hub-redesign 开出：在做的分支都没有改这个包，gold-template-gap 只改 `scripts/real/**`。views-and-notes 改了 `contracts/src/views.ts`，它合并以后若 index-view@1 的形状有变，合成索引跟着改。
- 可以改的路径：`packs/workflow/template-gap/**`（workflow.json、requirements.json、checks.json、tables、functions、samples、examples、testing、SKILL.md、README.md、api.ts、pack.json 和测试）。别的包不动；case-review 的模板表和 `parity.test.ts` 的对照照旧。
  - hub-pack-findings 第 8 条也改这个包（未打标签的用例单独计数、covered 一律给出）。集成者让两件先后做：本页先合并。
  - gold-template-gap 的蜕变核对只比第一个要求项（24 个类别）；上传的副本在第二个要求项上一律是“不在用例索引里”。两边都合并以后，由集成者对齐那边的脚本。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 未知只能是过渡状态，写明缺的事实和下一步动作；
  - 枚举只来自生成的词表；
  - Hub 只核验，不生成内容：用例的命令只用索引里已经解析出的，不另猜；
  - 包里不写产品名。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 "packs/workflow/template-gap/**/*.test.ts"`；`node packs/workflow/template-gap/api.ts check`。

## 要做的

1. **24 个类别**：照现在全必选，代码不改。README 开放问题 1 改成“已定（决定 35 第 19 项）”。
2. **绑定和输入**（workflow.json、SKILL.md、`functions/project.ts`）：
   - 工作流按命令目录绑产品线：`"product": { "catalogs": ["commands@1"] }`，和 case-review、defect-to-case 一样，包里不写产品名。
   - 加输入槽 `case_index`：角色 expected，接受 `knowledge:index`，可选，一份。写法：`knowledge:index:<产品>:<构建>?kind=case&key=document&only=<这次的敏捷平台文档编号，逗号分隔>&fields=document,node,commands,title,path_labels`。
   - SKILL：开始运行时写 product 和 build；case_index 写同一个构建；上传的文件不在索引里，不写进 only。原来“不要写 product、version、build”那句删掉。
   - 投影核对：视图的根就是运行锁定的根；only 正好是这次的敏捷平台文档，不多不少。不对就整次不受理，修正说明写出锁定的构建和该写的 only。新拒绝码写进 `tables/codes.json`。
   - 测试：根不同；only 多一份、少一份；不是 index-view@1；上传和敏捷平台文档混在一起。
3. **按命令的覆盖**（新函数，例如 `functions/commands.ts`；投影把结果写进条目字段）：
   - 用（文档，条目键）把这次脑图里的用例和索引里的用例条目对上，再核标题和上级标签：同步以后用例的标题或上级标签改了，`data.id` 还在，索引里的命令就是旧的。所以索引条目的 title、path_labels 要和用例规范化以后的标题、标签相等，不等就算“索引里没有这个用例”（下一步是知识同步以后重跑）。一个用例在索引里有几条（每个命令一条），只算一次。
   - 条目键只在生产器的用例规则下对得上：FAMX 的 caseKeys 是按标出的（并集的）用例集编号的，包的 case_rule 换成 tagged 时 `#k` 的编号就变了。按命令的覆盖只在默认的 case_rule 下算；规则不一致时如实写明不一致，下一步是用默认规则重跑，不说成“索引里没有”。
   - 每个命令写：用例数；9 个类别各自有没有、用例数、证据用例（排序，最多 20 个）和它们在索引里的 `tree:` 引用；缺哪几个。类别怎么认，用现有的 `categoryFacts`，不另写一套。
   - 这 9 个类别从模板表取，不从条目取：投影丢了一个命令或一个类别，也不会让它变成“不必选”。
   - 跳过：参数 `skipped` 的一项可以加可选的 `command`（命令路径），只对那个命令跳过；不写 command 的跳过照旧对整份文档，也对它的每个命令生效。写不进的照旧整次不受理（`skip_invalid`）。
   - 测试：合成脑图（`testing/mindmap.ts`）配一份合成索引（新写 `testing/index.ts`：给用例分配命令，照 index-view@1 的形状出视图）；一个用例有几个命令；两个用例同一个命令；只对一个命令跳过一个类别；键没变、标题变了的用例算不在索引里；case_rule 不是默认的时写明不一致。
4. **第二个要求项 `command_coverage`**（requirements.json、checks.json、新的检查函数）：条目是文档，事实，静态层，记账型，提示档。每个（文档，命令）给一个结论，依据是这个命令下的用例条目：
   - 9 个类别都有，或写明了跳过：支持；
   - 缺了：反驳，新码 `template-gap.command_shortfall`，data 列出缺的类别；
   - 索引完整（跳过为 0、没截断、这份文档的键没被砍）却没有这份文档：文档级反驳 `template-gap.not_indexed`，写明根和构建；下一步是用收了它的构建（文档所在的版本线不晚于这个构建）重跑，或等知识同步收进它。上传的文件也记这一条，下一步是用敏捷平台的文档编号重跑。kb-unversioned 落地以后，文档在产品线不分版本的范围里的，下一步改写成怎么读那个范围（那一件更新这句，README 记一笔）；
   - 这份文档的用例都没解析出命令：文档级反驳 `template-gap.no_commands`，写明用例数；下一步是把命令写进用例标题或上级节点；
   - 没绑 case_index：未知（缺输入），陈述和 `data.missing` 写缺的是用例索引，下一步是带 case_index 重跑；
   - 索引不完整（跳过大于 0、截断、键被砍），或者这次脑图里有用例在索引里找不到（文档在同步以后改过）：已经算出的支持照给（用例多了覆盖只会多，不会少）；本来会是反驳的改记未知（缺输入），写明缺哪些条目，下一步是知识同步以后重跑。
   - 新码写进 `tables/codes.json`；每种结论至少一对正反样例（`samples/`）；摘要加一句“按命令：N 个命令，K 个缺类别”，仍在 480 字以内（最坏情况测一次）。
5. **蜕变关系（架构 6b）对按命令的覆盖也测**：去掉某命令下某类别的全部用例（脑图和合成索引一起去）就缺；加一个就有；打乱用例和索引条目的顺序，条目和结论的字节都不变；给一份文档加一个不在索引里的用例，支持不会变成反驳。
6. **engine.test.ts**：在真实注册表和引擎上跑一次生产运行，几份敏捷平台文档加一份上传，绑合成索引。`testing/bed.ts` 现在没有知识假件，照 `packs/workflow/case-location/test-hub.ts` 加一个构建、一个带 commands@1 目录的根，再加一个 `knowledge:index` 的合成读者。断言两个要求项的终态和计数。原来“没有产品绑定”的那条测试照新绑定改写。
7. **README 和版本**：README 写明按命令的覆盖从哪来、限制（命令只从标题和上级节点解析；上传的文件不在索引里）、开放问题 1 已定。包升到 1.1.0，`node packs/workflow/template-gap/api.ts sign` 重签，`node packs/workflow/template-gap/testing/examples.ts` 重写范例。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
