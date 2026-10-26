# 任务：新能力的真实验收脚本（独立的标准答案 + 真实 Circle 客户端的场景）

回归范围、维护巡检、追溯矩阵、质量看板、缺陷转用例要在真实数据上证明结果正确（架构第 6b 节）：标准答案由另一份、独立的代码从原始材料算出，再和 Hub 经真实 Circle 客户端给模型看到的结果比对。这个任务写这些脚本（TypeScript，放 `scripts/real/`）；脚本由监督者在已部署的 Hub 上运行，终端里只用合成数据测试。

- 分支和工作树：`hub-real`，目录 `circle-hub-real`
- 可以改的路径：`scripts/real/**`（及其测试）、`hub/server/cli-admin.ts` 与 `bin/circle-hub` 里加的第 1 件事所需的最小改动（及其测试）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`docs/hub-r4-architecture.md` 第 6a、6b、8 节、`scripts/real/accept-circle.ts`、`scripts/real/accept/case-location.ts` 和 `template-gap.ts`（场景的写法）、`scripts/real/lib/accept.ts`、`scripts/real/hub-call.ts`、`scripts/real/lib/env-file.ts`、四个新包的 README（`packs/workflow/regression-scope`、`maintenance-sweep`、`traceability`、`quality-board`）和 `packs/product/famx/README.md`（用例条目、缺陷条目的字段）。
- 规则：环境配置文件只由 `scripts/real/` 下的脚本在运行时通过 `lib/env-file.ts` 读，屏幕、日志、测试夹具里只能有键名、是否找到和长度；不要自己打开它，也不要把任何值或地址写进文件。仓库里不放内部地址、真实编号、真实文档内容；真实的编号和标准答案放在仓库外（`--gold` 文件）。写标准答案的代码**不得导入** `hub/`、`packs/` 下的任何模块（独立性是它的全部价值）；产品的路径写法等约定可以读各包 README 后自己实现，两边不一致时由监督者查。
- 提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行；不推送、不建 PR；不碰 7420 上的持久部署、钥匙串和任何真实系统，也不运行真实评审。完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。

## 第 1 件事：管理员能导出存下的原件

标准答案要用 Hub 已经读到的原件（脑图、发布说明页、命令树）当输入，不能让脚本自己再去登录业务系统（敏捷平台登录失败会锁账号）。加两个只读的管理员命令：
1. `circle-hub original list [--external <外部标识的前缀>] [--limit <条数>]`：列出读记录里的外部标识、原件的 SHA-256、大小、读取时间（不显示内容）。
2. `circle-hub original export <sha256> --out <文件>`：把一个原件写到文件（权限 0600，文件已存在则拒绝），屏幕上只写大小和摘要。只有管理员能用；非管理员得到和不存在相同的回答。
读 `hub/server/cli-admin.ts` 里 `source`、`resource` 命令的写法照做，补测试（合成数据：存在、不存在、非管理员、文件已存在、路径不可写）。

## 第 2 件事：独立的标准答案脚本

1. `scripts/real/gold/command-diff.ts`：输入两个构建的命令树 XML 文件（由 `original export` 导出），输出 `{added, removed, modified}` 三个路径列表，路径写法与产品包 README 里写的树路径约定一致；XML 用脚本里自己写的小解析器读（不导入 Hub 的解析器），“修改”指同一路径上的定义内容（签名、参数、取值范围）不同，只改帮助文字不算。
2. `scripts/real/gold/cases.ts`：输入一批脑图文件（导出的敏捷平台文档）和构建的 `case_documents` 清单，按脚本自己实现的用例节点规则（带资源标签的节点是用例；规则的文字依据是 `packs/workflow/case-review/README.md`）逐文档数出：用例数、有无期望结果、含糊期望（短语表在 `packs/workflow/case-review/tables` 里，照抄表而不是照抄代码）、反向用例、各分组计数，以及标题和祖先里的缺陷编号。
3. `scripts/real/gold/join.ts`：缺陷（发布说明页里这个构建修复的和已知的缺陷编号）与用例文档里缺陷编号的双重循环连接，不用任何索引结构。
每个脚本的单元测试用合成的小输入，并写一条“故意和实现不一致时能发现分歧”的测试（脚本的输出和手算的答案逐项相等）。

## 第 3 件事：真实 Circle 场景

照 `scripts/real/accept/case-location.ts` 的写法，为下面每项写一个场景模块（脚本化的模型发工具调用，用真实 Circle 客户端经 Otty 驱动已部署的 Hub，检查模型看到的结果文字与标准答案一致）：
- `regression-scope`：用 `knowledge:impact:<产品>:<前一个构建>..<后一个构建>` 开始运行；检查：Hub 报出的变更路径（范围里的原因路径加未覆盖的路径）等于 `command-diff` 的 added+modified；范围里的每个用例确实放在变更路径上，没有放在变更路径上的用例不在范围里。
- `maintenance-sweep`：同一对构建；检查：被标为命令已删除的用例都放在 removed 路径上，被标为命令已改的放在 modified 路径上且有字段差异。
- `traceability`：对一个构建；检查：矩阵和 `join` 的结果逐缺陷相等（有用例的缺陷列出的用例相同，没有用例的缺陷是“未知”）。
- `quality-board`：对一个构建；检查：各组的用例数、无期望数、含糊数、反向数与 `cases` 的计数逐组相等（Hub 的看板描述的是索引里的用例，说明里写的限制照读）。
场景的“期望”从 `--gold` 文件读；`--gold` 文件由监督者用 `gold/*` 脚本生成，放在仓库外。缺陷转用例需要真实模型，另外做（监督者用 `review-circle.ts`），这里不写。
