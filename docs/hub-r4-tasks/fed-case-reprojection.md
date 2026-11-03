# 任务：树苗指针移动后重投影喂入用例，收窄索引给出确定完整性

## 起因

一位客户端问某个需求有没有脑图用例。索引视图 `knowledge:index:<产品>:<构建>?kind=case&key=stories&only=<编号>` 被拒（SUBMISSION_SCHEMA_VIOLATION），说明是“40 个用例缺所查树苗的投影…下一步用绑定树苗的运行重读原件”。这 40 个喂入用例都来自同一份脑图，没有一个声明了需求号。原因有四个：

1. 喂入用例只在运行里重读原件时才按根投影；版本线的树苗指针移动时（`produceSeedling` 写 seedling@1 记录、再移动指针），没有任何步骤把已有的喂入用例投影到新根上。
2. `rootlessCases` 只在 key 为 document 时才按 `only` 筛选，与根无关的键（stories、defects、document、title）上无根投影明明说了取值，也被一律算成未知。
3. `keySpaceComplete` 要求没有 only，story-traceability 的 `absenceComplete` 也要求没有 only，收窄视图永远不可能完整。
4. 未知说明不点出原件，视图范围只列组成来源，不列喂入层的原件。

## 改了什么

- **A 育苗时重投影。** `produceSeedling` 在写 seedling@1 记录之后、移动指针之前调 `FeedingLayer.reproject`：按版本绑定（绑定只对读出它的那份来源算数，版本线用产品包的 `normalize_line` 规范化比较）和来源的当前头（撤回或被新读取取代的记录不选）挑出这条版本线的喂入用例，不按“上一个根下有哪些投影”挑。每份原件只经现有的 `observeCaptured` 路径重读一次（`projection()`、`put(judgment=false)`、`bindings()`），写入人是育苗的管理员，依据里加生产动作和树苗记录。不走 planAppend/appendPrepared（那条路写模型判断注释，`cut()` 只认 producer 为 function 的投影）。育苗报告给出选中、已在新根、重读原件数和投影数，以及缺失事实。重投影失败不挡指针移动，报告写原因和下一步。新增管理员命令 `circle-hub knowledge reproject <产品> <版本线>`，对已有积压做同样的事，目标是这条线当前的树苗。
- **B 可见性跟原件走。** 重投影的每一行在 `reprojection_of` 记下它重投影的原始记录（并把它放进 bound，撤回原条目时一并撤回）。`recordVisible` 与 `recordsVisible` 一起改：重投影按原始记录判断，原始记录可见它才可见；指向别的来源或指向另一条重投影的一律不可见。测试逐条比较两者结果相同。
- **C 核心标出与根无关的字段。** fed-case@1 是核心的结构；`hub/knowledge/fed-case-fields.ts` 标出 stories、defects、document、title 与根无关，commands、command_tree_root、path 与根有关。对这几个键，`rootlessCases` 用无根投影判断是否在 `only` 里；投影没写这个字段的仍算未知。不改包，不改这部分契约。
- **D 收窄视图的完整性。** 索引视图加 `only_complete`（`contracts/src/views.ts`，已运行 `npm run gen:contracts`，模型版本不变）：stories、defects 按规范化编号匹配（全数字去前导零，原始键原样保留），其他字段逐字匹配；没有跳过的来源、未完成的投影、版本层冲突、缺索引字段的用例，且来源范围完整时为 true。`key_space_complete` 在收窄视图上仍为 false。分页续读的合并和引擎按 only= 分段读取的合并，都只在每一部分完整时才保留 true。视图范围加 `scope.fed`，列出喂入层原件和各自的用例数、已投影数、无根数。story-traceability 升到 1.0.16，只对视图 `only` 里请求过的编号接受这一事实，按包自己的工具重签。
- **E 说明。** 仍有未知时，说明点出原件（外部标识、文档和用例数，最多 20 份，其余计数），以及确切的下一步调用（`start_run`，pack 写 source-read，顶层写视图的 product 和 build）。同时经现有的有界读取路径 `observeSourceBounded`，以读者自己的账号排队重读这些原件，留下记录；读取时不在内存里算投影，本次视图仍把它们算作未知。“请管理员同步这条产品线”只在缺不分版本的根时出现，用例视图上注明它不影响用例投影。

## 改动的路径

- `hub/knowledge/seedling.ts`、`feeding.ts`、`views.ts`、`complete-view.ts`、`seed.ts`、`cli.ts`、`api.ts`、`README.md`；新文件 `fed-case-fields.ts`、`reproject.ts`
- `hub/server/cli-admin.ts`（`knowledge reproject` 子命令和用法），`hub/server/assemble/README.md` 的命令清单一行
- `hub/runs/engine/index-default.ts`（only= 分段合并时的 `only_complete`）
- `contracts/src/views.ts` 和重新生成的 `contracts/generated/schemas/{index,facet,impact}-view.v1.schema.json`
- `packs/workflow/story-traceability/`（1.0.16）
- 测试：`hub/knowledge/feeding-reprojection.test.ts`、`fed-case-root-independence.test.ts`，`hub/server/knowledge-reproject-cli.test.ts`，`packs/workflow/story-traceability/functions/narrowed-completeness.test.ts`，`tests/acceptance/55-fed-case-reprojection.test.ts`；`hub/knowledge/review.test.ts` 固定的说明文字和 `seedling.test.ts` 一条断言随之更新

没有新的数据库迁移，没有改 `contracts/model.json` 的版本。

## 限制

- 无根的、绑定到别的版本线的用例，在这个根的视图里仍算未知（视图不按绑定筛无根用例）；重投影只覆盖被育苗的那条线。
- 重投影在育苗里同步执行，耗时随这条线的原件数增长；一份原件重读失败时写进报告的缺失事实，不重试。
- 读取时排队的重读一次最多 20 份原件，队列满时按现有有界路径回执，稍后再读会再排。
- 验收场景直接调用 story-traceability 的投影和核验函数，绑定的是 `completeKnowledgeView` 产出的视图；没有经 MCP 的 start_run。合成数据只证明机制，不证明真实系统上的结果。
