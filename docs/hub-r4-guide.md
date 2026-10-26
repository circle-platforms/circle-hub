---
nav_order: 5
---

# Hub r4 使用指南：七项用例能力

写给出任务的模型（在 Circle 里）和看它工作的人。Hub 是一个标准的 MCP 服务器：它核对结果、从不生成内容；能算的由它直接算，要判断的由模型判断、Hub 在边界上核对证据。每项能力一节；细节（决定、限制、对其他包的需求）以各任务包的 README 为准，本文只指路。

先读这三条，再按能力查：

- **结果在哪里看**：`start_run` 和 `submit_result` 的回答（回执）里有运行编号、条目摘要和计数；存下的校验结果用 `get_nodes` 按 `rec:` 引用读，条目多时分页（照回答末尾的说明接着读）。只读的控制台也能看运行、知识树和任务包。分区回答“交付了什么”（已交付、已拒收、已隔离、未完成，未知单独计数），终态回答“判定是什么”；未知保持未知，从不显示成通过或不通过。
- **Hub 核对的与模型判断的**：Hub 自己算的（事实检查）标“事实”，模型写的（判断）标“判断”并写声明的模型；独立复核要求换一个会话和一个不同家族的模型，否则 Hub 记“独立性未知”，复核不成立。
- **空是合法答案**：没有变更、没有要维护的用例、没有要追溯的缺陷时，结果是空的条目集，不是出错。

## 运行前要知道的

- **管理员**（详见 [交接页](hub-r4-progress.md)的部署与规则部分）：发布任务包（`pack publish <目录> --stage`）并把工作流包分配给要用的用户、激活产品包；用 `knowledge sync` 同步知识库（两个名称族的每个已发布构建各产出一个根；Hub 不调用任何模型，没有路径的条目留在根下标为未归位）；发布和维护命名文档（`doc put <名字> <文件>` 发布或替换、`doc list`、`doc show <名字>` 查看，名字、摘要、大小；只有管理员，非管理员得到和不存在相同的回答）；系统包发布新版本后用 `resource update <资源> --system-pack <包名>` 改绑。包内容改了要先升版本号再发布，已发布的版本不改内容。
- **用户令牌**：Hub 只监听本机，调用带 Bearer 令牌；钥匙和操作令牌在钥匙串里，由管理员用 `circle-hub key …` 等命令管理。没有分配给你的任务包，和不存在看起来一样（对你不可用）。
- **模型家族**：初评和复核要用不同家族的模型（现在只有千问家族的端点时，Hub 不把名字里带共同词的模型认作独立；复核要换另一个家族的端点，由所有者配置）。这决定复核能不能成立。

## 用例评审（case-review、case-review-verify、case-review-report）

模型按团队方法初评一份测试脑图；另一个会话、另一个家族的模型独立复核。每次评审最后都开终稿运行，不分块也一样，由 Hub 按已受理记录排出逐例对照表，模型只写简短总体意见和等级理由。

- **输入与参数**：
  - `case-review`（初评，版本以当前分配为准）：必填 `subject`，绑定 `agile:mindmap:<文档编号>` 或上传文件的 `src:<sha256>`；超过 100 例用 `block` 分子树，或 `slice: {"from": 1, "to": 100}` 分段，辅助参数有 stories、bugs、id_ranges、bare_ids 等。
  - `case_rule` 默认 marked，认带标签或团队标记的用例；tagged 只认带标签。摘要写出规则及只靠标记识别的数量 marked_only。
  - `case-review-verify`（独立复核）：target 绑定初评的同一源脑图，draft 为初评已受理结果的 rec: 引用，predecessor 指定初评运行。处置写问题本身及原因；建议按“补：<用例>；因为：<原因>；期望：<结果>”写全，grounds 指向目标用例或测试子项，否则退回修复。
  - `case-review-report`（终稿）：verifications 每块给一条复核已受理结果的 rec: 引用，target 必填且与各块源摘要相同，precondition_priority 与初评一致（默认 3，null 关闭）。
- **提示这样写**（编号是占位）：「用 Hub 评审脑图 <文档编号>，先初评，换会话和模型家族独立复核；最后开终稿运行，把 Hub 排出的表原样贴出，再写简短评审意见。」
- **读表与最终回答**：终稿条目固定在序号 0；从回答“完整的槽位模式”一行复制运行记录引用，用 get_nodes 读 `<运行记录>#/items/0/fields/review_tables`。有下一页就接着读完；每页只取“原文…”之后、页末说明及追踪之前的内容，原样逐页贴出，不改字、不合并格；排除“接上页”协议提示，行中续读不要额外换行。然后写“## 评审意见”，贴已提交并受理的简短正文及证据缺口，最后一行给控制台运行页。终稿不再另写建议或逐条转录发现。
- **回答放不下时**：按冻结的 review_counts.characters 边界只贴可容纳的完整子项，明确“部分：已贴 X/N 张子项表，C/T 个原文字符”，空行结束表格并给控制台运行页及完整原记录；不要静默丢掉其余内容，也不要声称未读页已读完。
- **表的范围与性质**：按用例上一层的测试子项分表，嵌套用例跟随外层用例的子项；没有发现的子项折成一行，有问题或建议的保留整表。完整表与折叠表不同时另存 review_tables_full；否则 review_tables 本身即完整表。两者都可从控制台运行页的通用字符串字段区读取。原文来自目标脑图，模型发现与建议原样列出且标明未经平台验证；“Hub 核对”另列已存、归责作者输入的字面与目录事实。
- **已知边界与下一步**：只排各块已交付用例，不等于整份脑图都覆盖。缺块结论、等级、条目或 Hub 快照时不排表；先按摘要指示补齐、重新初评或复核，再开终稿，不在未完成状态交出结论。实际业务执行事实（足迹）不由这份评审证明；真实 Circle 展示由集成者验收。
- 详见：[case-review](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/case-review/README.md)、[case-review-verify](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/case-review-verify/README.md)、[case-review-report](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/case-review-report/README.md)。

## 模板缺口（template-gap）

按团队的用例模板 v3 查出每份脑图缺哪些类别（24 个类别：六个测试类型加命令增删改查、日志、配置同步、升级兼容、安全、数据库等），以及每个类别的证据用例。全是事实，开始运行时直接算出，不用模型提交。

- **输入与参数**：任务包 `template-gap@1.0.1`；输入槽 `documents`（必填，多项，绑定 `agile:mindmap:<文档编号>` 或上传文件的 `src:<sha256>`）；用例规则参数 `case_rule`（默认 `marked` 认标签和团队模板标记，`tagged` 限制为只认标签）；可选参数 `skipped` 记录用户明确声明不适用的类别（每项含 `category` 与用户原话 `reason`，可选限定 `document`），不按模型主观推测填写。
- **提示这样写**：「用 Hub 检查脑图 `<文档编号>` 的模板缺口。」可以给多份，一次最多约 30 份。
- **Hub 自己核对**：24 个类别的覆盖事实（测试类型按标签，其余按关键词）——全部是事实；**模型判断**：无；仅用户明确声明跳过时记录跳过理由；模型补充看法标“模型转述，未经校验”。
- **已知限制**：关键词判定可能误报；靠标记识别的用例没有标签，按标签判定的测试类型对它们如实报缺；摘要写明用例数（含用例规则与只靠标记识别的用例数），限制为 `tagged` 时未计入的未打标签节点数也写明。
- 详见 [template-gap 的 README](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/template-gap/README.md)。

## 用例定位（case-location）

按敏捷平台的目录树定出每份脑图（或每个用例）的产品线、版本、版本线、发布火车和模块，列出定位到的版本线在两个名称族的已知构建候选（别名解析到它所依据的构建），核对目录和标题里写出的构建名，并列出标题关联的需求与缺陷编号。全是事实，不用模型提交。

- **输入与参数**：任务包 `case-location@1.1.3`；输入槽 `documents`（必填，多项，绑定 `agile:mindmap:<文档编号>`）；参数 `granularity`（`"document"` 默认，或 `"case"` 按用例定位）；辅助参数 `product`、`line`、`id_ranges`。
- **提示这样写**：「用 Hub 定位脑图 `<文档编号>`。」按用例定位时加参数 `granularity: "case"`，一次一份。
- **Hub 自己核对**：定位规则、构建候选（按运行开始时冻结的已知构建列表逐一列出：每个候选写制作时间和“基于”的构建，按制作时间从新到旧，发布状态另写——已发布给日期，未发布写未发布）、写出构建名的对照、关联需求与缺陷编号提取；**模型判断**：无（模型的评论只记为判断）。
- **已知限制与未知**：目录树定不准或自相矛盾时记未知并写明缺什么，从不记为不通过；知识库不认识的构建名记未知（知识库只收录构建站列出的构建）；写出的构建名属于另一条版本线时记提示档的不通过，写明属于哪条线。一次最多约 40 份（按用例定位一份），更多照回答末尾的说明分页读。
- 详见 [case-location 的 README](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/case-location/README.md)。

## 回归范围（regression-scope）

给出两个构建之间变了什么、哪些已索引用例落在变更的路径上：回归范围。全是事实，不用模型提交。

- **输入与参数**：任务包 `regression-scope@1.0.2`（不绑定产品线）；输入槽 `impact`（必填，单项，绑定带瘦身参数的影响视图 `knowledge:impact:<产品>:<起始构建>..<目标构建>?attached_fields=document,node,title,priority,negative`，附着条目仅带 5 个字段，避免跨大版本线对比时沙箱内存超限）；可选参数 `priorities`（数字数组，只保留指定优先级用例，最多 64 项）、`include_added`（默认 `true`，`false` 时新增路径不进范围）。
- **提示这样写**：「用 Hub 算从 `<起始构建>` 到 `<目标构建>` 的回归范围。」（构建名写两个名称族里任一个的写法都可以。）
- **Hub 自己核对**：范围按两个构建知识树根条目级差异直接算出（范围内用例为支持，无用例路径为未知）；**模型判断**：无。
- **已知限制与未知**：变更路径上没有用例记为未知（缺输入）——用例索引本来就不完整，没有列出不等于没有；后一构建的索引有列出的文档没读到时，结论写明句数。单次运行最多容纳 4,000 条用例（超出时被拒绝并提示用 `priorities` 收窄）。**没有变更时范围是空的，是合法答案**。
- 详见 [regression-scope 的 README](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/regression-scope/README.md)。

## 维护巡检（maintenance-sweep）

对一个新构建巡检较早构建的已索引用例：命令已删除的用例要维护（阻断档：改写或停用），命令定义有差异的是提示（按字段给出两边的值）。全是事实，不用模型提交。

- **输入与参数**：任务包 `maintenance-sweep@1.0.1`；输入槽 `impact`（必填，单项，绑定影响视图 `knowledge:impact:<产品>:<起始构建>..<目标构建>`，因巡检需比对完整定义差异，故不使用 `attached_fields` 参数）；可选参数 `ignore_fields`（比较定义时跳过的顶层字段名列表，最多 40 项）。
- **提示这样写**：「用 Hub 巡检 `<起始构建>` 到 `<目标构建>` 之间要维护的用例。」
- **Hub 自己核对**：命令是否还在（已删除记阻断档维护项）、定义差异逐字段比对（提示档）；**模型判断**：无。
- **已知限制与未知**：只改了行为说明、或路径是新增的，不是维护项；索引没有收录的用例不作结论；较早构建有没读到的文档时，没有维护项并不能证明没有过期的用例（结论照写句数）。**没有维护项是合法的空结果**。
- 详见 [maintenance-sweep 的 README](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/maintenance-sweep/README.md)。

## 追溯矩阵（traceability）

构建的缺陷到用例的追溯：release notes 列出的每个缺陷，有没有已索引的用例携带它的编号。全是事实，不用模型提交。

- **输入与参数**：任务包 `traceability@1.0.2`（不绑定产品线，不锁定无关构建）；输入槽 `defects`（必填，单项，绑定 `knowledge:index:<产品>:<构建>?kind=defect&key=bug`）与 `cases`（必填，单项，绑定瘦身视图 `knowledge:index:<产品>:<构建>?kind=case&key=defects&fields=document,node,title`，避免全量视图超限截断）；可选参数 `statuses`（`["fixed"]`、`["known"]` 或两者都看，默认均计入）。
- **提示这样写**：「用 Hub 算 `<构建>` 的缺陷追溯矩阵。」（两个输入视图指向同一个构建，构建名写任一名称族均可。）
- **Hub 自己核对**：矩阵按两个索引视图自然连接算出，已索引关联为事实支持；同一缺陷既修复又已知记提示档冲突；跨条目输出缺陷总数、已追溯数与未追溯数；**模型判断**：无。
- **已知限制与未知**：没有已索引用例的缺陷记未知（缺输入）——用例索引按构造不完整，绝不显示为失败；**若构建无缺陷或过滤后无缺陷，结果为空条目集，是合法答案**。
- 详见 [traceability 的 README](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/traceability/README.md)。

## 质量看板（quality-board）

按（版本线、模块）分组的质量指标：用例数、无期望结果占比、只有含糊期望结果占比、负面用例占比，以及整个构建的合计；阈值越界是提示档的管理信号，从不是阻断。全是事实，不用模型提交。

- **输入与参数**：任务包 `quality-board@1.0.1`（不绑定产品线，不锁定无关构建）；输入槽 `facets`（必填，单项，绑定 `knowledge:facets:<产品>:<构建>?kind=case&by=line,module,has_expected,vague_expected,negative`）；阈值参数 `max_missing_ratio`、`max_vague_ratio`（默认 0.05）、`min_negative_ratio`（默认 0.02），等于阈值不算越界。
- **提示这样写**：「用 Hub 看 `<构建>` 的质量看板。」
- **Hub 自己核对**：指标按计数视图精确分数计算（无期望 = `has_expected` 假；含糊期望 = `has_expected` 真且 `vague_expected` 真；展示值四舍五入仅用于呈现）；阈值越界提示；**模型判断**：无。
- **已知限制与未知**：看板覆盖已索引文档的每一个用例（没有解析出命令的用例是未归位条目 `unplaced`，同样计入合计），只有未读到的文档不在看板中；视图有列出的来源没读或被截断时，合计的说明里照写。
- 详见 [quality-board 的 README](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/quality-board/README.md)。

## 缺陷转用例（defect-to-case）

模型从缺陷（现象、修复说明）起草回归测试用例，Hub 在边界与运行期核对。**模型起草（判断），Hub 核对（事实）**。

- **输入与参数**：任务包 `defect-to-case@1.0.1`；输入槽 `defects`（必填，1 到 20 项，绑定 `plm:bug:<缺陷编号>`）与 `indexed_cases`（必填，单项，绑定精简字段视图 `knowledge:index:<产品>:<构建>?kind=case&key=commands&fields=document,node,title`，避免 12 至 15 MiB 全量索引超出 8 MiB 沙箱输入上限）；可选参数 `max_cases`（每缺陷最多起草数 1-20，默认 6）和默认优先级 `priority`（1-3，默认 2）。
- **提示这样写**：「用 Hub 从缺陷 `<缺陷编号>` 起草回归用例。」
- **Hub 自己核对**：用例结构合规（`draft_shape`）、命令与参数按目录校验（`commands_catalog` 及反向用例反驳 `commands_refutation`）、期望结果引文依据（逐字引文 `grounded_quotes` 与精简阅读 `grounded_reading`）、与紧凑索引的用例去重（`duplicate_check`）；**模型判断**：起草的用例内容；起草不了的缺陷（如无外部可测行为）由模型声明跳过并写明理由，不是失败。
- **已知限制与运行期保护**：投影函数将用例索引重组为紧凑索引（`compact-case-index@1`），整体输出受控在 4 MiB 预算内；用例极多导致超预算时按命令键顺序截断并标记 `complete: false`，去重检查未见重复时判定未知（说明丢弃数量），保留项命中重复仍记录提示违规；无命令的未归位用例不参与去重并在说明中单独计数。
- 详见 [defect-to-case 的 README](https://github.com/circle-platforms/circle-hub/blob/main/packs/workflow/defect-to-case/README.md)。

## 转自动化

设备管理包：设计见 [设备管理包设计](hub-r4-device-pack.md)，核心的租约（`hub/leases`：唯一约束取得、过期抢占、围栏令牌）和管理员命名文档（`doc put/list/show` 发布与替换，`doc:doc:<名字>` 由 Hub 内部读取器作答、运行开始时冻结摘要）已落地，包本身在做（清单校验、环境事实、选台架的纯函数已在 `packs/workflow/test-bed`）；上机部分要所有者给台架、账号和允许的命令类；用例转工作簿的编译部分还没有设计，缺执行用的函数合约和入口。

## 读结果的手法（六项通用）

1. 开始运行的回答里，条目按摘要列出；完整结论在 `result.reference` 指向的校验结果里，用 `get_nodes` 按 `rec:` 引用读，条目多时分页。
2. 事实与判断分开列：检查算出的结论标“事实”，模型写的标“判断”并带声明的模型名；模型的补充看法用 `submit_result` 提交后只记为判断，不改变 Hub 算出的结果。
3. 未知永远写明原因（缺输入、检查出错等），不显示成通过或不通过；证据缺口（没读到、没绑定的来源）在回答和运行记录里单列。
4. 每个条目落在且只落在一个分区：已交付、已拒收、已隔离、未完成；计数如实，不写“全绿”。
5. 控制台是只读页面：运行、知识树、任务包都在那里能看。
6. 答非所问时不猜：目标没给（文档编号、构建名）先问用户。

## 与代码的核对记录

逐项核对指南与各任务包代码（`workflow.json`、`SKILL.md`、`README.md`、`pack.json` 等）的现状如下：

1. **用例评审 (`case-review` / `case-review-verify`)**：
   - 核对项：包名、版本（均为 `1.0.1`）、输入槽、外部标识、参数、核对与判断边界、示例提示占位符。
   - 修改点：补充了初评输入槽 `subject`（`agile:mindmap:<文档编号>` 或 `src:<sha256>`）及分块参数 `block` 与 `slice`；明确了复核包输入槽 `target`、`draft`（`rec:<摘要>`）和前驱必填参数 `predecessor`。示例提示使用 `<文档编号>` 占位符无硬编码。
   - 拿不准：无。
2. **模板缺口 (`template-gap`)**：
   - 核对项：包名、版本（`1.0.1`）、输入槽、外部标识、参数 `skipped`、全事实运行特性。
   - 修改点：补充了输入槽名 `documents`（`agile:mindmap:<文档编号>`）与参数 `skipped` 的结构说明。示例提示使用 `<文档编号>` 占位符。
   - 拿不准：无。
3. **用例定位 (`case-location`)**：
   - 核对项：包名、版本（当前为 `1.1.3`）、输入槽 `documents`、参数 `granularity` 及辅助参数 `product` / `line` / `id_ranges`。
   - 修改点：明确了包版本为 `1.1.3`；补充了输入槽名 `documents`；列出辅助参数。示例提示使用 `<文档编号>` 占位符。
   - 拿不准：无。
4. **回归范围 (`regression-scope`)**：
   - 核对项：包名、版本（`1.0.1`）、输入槽 `impact`、外部标识语法、参数 `priorities` / `include_added`、沙箱保护与空结果合法性。
   - 修改点：外部标识更新为带瘦身参数的语法 `knowledge:impact:<产品>:<起始构建>..<目标构建>?attached_fields=document,node,title,priority,negative`，避免大版本差导致沙箱内存超限；补充输入槽名 `impact`；补充单次运行上限 4,000 条用例的限制；重申无变更时结果为空是合法答案。示例提示使用 `<起始构建>` 和 `<目标构建>` 占位。
   - 拿不准：无。
5. **维护巡检 (`maintenance-sweep`)**：
   - 核对项：包名、版本（`1.0.1`）、输入槽 `impact`、外部标识（保持完整定义，不带 attached_fields）、参数 `ignore_fields`、空结果合法性。
   - 修改点：补充输入槽名 `impact` 与外部标识语法；确认不使用 `attached_fields`（因需要完整定义做差异对比）；重申无维护项时为空是合法答案。示例提示使用 `<起始构建>` 和 `<目标构建>` 占位。
   - 拿不准：无。
6. **追溯矩阵 (`traceability`)**：
   - 核对项：包名、版本（`1.0.1`）、输入槽 `defects` 与 `cases`、外部标识语法、参数 `statuses`、产品线解绑与空结果合法性。
   - 修改点：明确用例输入槽 `cases` 采用瘦身视图 `?kind=case&key=defects&fields=document,node,title`，避免 15 MB 全量索引超限截断；明确输入槽名 `defects` 与 `cases`；注明包不绑定产品线（不锁定线上无关构建）；重申无缺陷时为空是合法答案。示例提示使用 `<构建>` 占位。
   - 拿不准：无。
7. **质量看板 (`quality-board`)**：
   - 核对项：包名、版本（`1.0.1`）、输入槽 `facets`、外部标识、参数阈值、产品线解绑、用例覆盖现状。
   - 修改点：补充输入槽名 `facets`；注明包不绑定产品线；修正关于用例覆盖的过时描述：索引已收录已索引文档的全部用例，无命令解析的用例作为未归位条目（`unplaced`）同样计入合计。示例提示使用 `<构建>` 占位。
   - 拿不准：无。
8. **缺陷转用例 (`defect-to-case`)**：
   - 核对项：包名、版本（`1.0.1`）、输入槽 `defects` 与 `indexed_cases`、外部标识（含推荐 `fields=document,node,title`）、参数 `max_cases` / `priority`、紧凑索引与沙箱资源余量。
   - 修改点：明确输入槽名 `defects` 与 `indexed_cases`；用例索引补充推荐的 `fields=document,node,title` 参数；补充投影函数 4 MiB 紧凑索引截断与未知判定保护规则；确认版本已发布为 `1.0.1`。示例提示使用 `<缺陷编号>` 占位。
   - 拿不准：无。

第二轮（2026-10-22，用例规则统一、构建候选带制作时间、判断服务拆除与命名文档之后）：

9. **用例节点规则（`case-review`、`template-gap`）**：
   - 核对项：`case_rule` 参数与默认值（`workflow.json`、各包 `SKILL.md`、`README.md`、`functions/projection.ts`、`functions/project.ts`）。
   - 修改点：写明默认 `marked`（带标签或带标记），`case_rule: "tagged"` 限制为只认标签；评审摘要的规则说明行与 `marked_only` 计数；模板缺口摘要的用例数、只靠标记识别的用例数与 `tagged` 时未计入节点数。
   - 拿不准：无。
10. **构建候选（`case-location`）**：
   - 核对项：版本（`1.1.3`）、候选的字段与排序（`functions/candidates.test.ts` 钉住的行文）。
   - 修改点：每个候选写制作时间和“基于”的构建，按制作时间从新到旧，发布状态另写（已发布给日期，未发布写未发布）。
   - 拿不准：无。
11. **转自动化一节、管理员命令与知识库说明**：
   - 核对项：`hub/leases`、`hub/server/docs.ts`、`packs/workflow/test-bed/README.md`、`docs/hub-r4-device-pack.md`。
   - 修改点：转自动化一节改写为设备管理包现状（租约与命名文档已落地、包本身在做、上机与编译部分的缺口）；管理员命令补 `doc put/list/show`；`knowledge sync` 说明补“Hub 不调用任何模型，没有路径的条目留在根下标为未归位”。
   - 拿不准：无。
