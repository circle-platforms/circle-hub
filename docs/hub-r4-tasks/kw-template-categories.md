# 任务：模板类别改为显式类别或逐用例判断

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 R1、R9、R10；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts W01 W02 W05 V02 A05 A06 C04 B03`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A01：`packs/workflow/case-review/tables/template-v3.json:18`；检查/分类/计数：类别 command_add（命令的添加）的出现、证据用例数和缺口。
- A02：`packs/workflow/case-review/tables/template-v3.json:27`；检查/分类/计数：类别 command_delete（命令的删除）的出现、证据用例数和缺口。
- A03：`packs/workflow/case-review/tables/template-v3.json:36`；检查/分类/计数：类别 command_modify（命令的修改）的出现、证据用例数和缺口。
- A04：`packs/workflow/case-review/tables/template-v3.json:45`；检查/分类/计数：类别 command_query（命令的查询）的出现、证据用例数和缺口。
- A05：`packs/workflow/case-review/tables/template-v3.json:54`；检查/分类/计数：类别 show_at_maximum（最大配置下的 show）的出现、证据用例数和缺口。
- A06：`packs/workflow/case-review/tables/template-v3.json:62`；检查/分类/计数：类别 no_command（no 命令）的出现、证据用例数和缺口。
- A07：`packs/workflow/case-review/tables/template-v3.json:72`；检查/分类/计数：类别 clear_command（clear 命令）的出现、证据用例数和缺口。
- A08：`packs/workflow/case-review/tables/template-v3.json:77`；检查/分类/计数：类别 operation_log（操作日志）的出现、证据用例数和缺口。
- A09：`packs/workflow/case-review/tables/template-v3.json:78`；检查/分类/计数：类别 audit_log（审计日志）的出现、证据用例数和缺口。
- A10：`packs/workflow/case-review/tables/template-v3.json:79`；检查/分类/计数：类别 configuration_sync（配置同步）的出现、证据用例数和缺口。
- A11：`packs/workflow/case-review/tables/template-v3.json:80`；检查/分类/计数：类别 configuration_save（配置保存）的出现、证据用例数和缺口。
- A12：`packs/workflow/case-review/tables/template-v3.json:81`；检查/分类/计数：类别 configuration_restore（配置恢复）的出现、证据用例数和缺口。
- A13：`packs/workflow/case-review/tables/template-v3.json:82`；检查/分类/计数：类别 configuration_clear（配置清除）的出现、证据用例数和缺口。
- A14：`packs/workflow/case-review/tables/template-v3.json:88`；检查/分类/计数：类别 upgrade_new_to_new（升级兼容：新版本之间）的出现、证据用例数和缺口。
- A15：`packs/workflow/case-review/tables/template-v3.json:96`；检查/分类/计数：类别 upgrade_old_to_new（升级兼容：老版本到新版本）的出现、证据用例数和缺口。
- A16：`packs/workflow/case-review/tables/template-v3.json:104`；检查/分类/计数：类别 upgrade_new_to_old（升级兼容：新版本到老版本）的出现、证据用例数和缺口。
- A17：`packs/workflow/case-review/tables/template-v3.json:107`；检查/分类/计数：类别 security（安全）的出现、证据用例数和缺口。
- A18：`packs/workflow/case-review/tables/template-v3.json:108`；检查/分类/计数：类别 database（数据库）的出现、证据用例数和缺口。
- A19：`packs/workflow/template-gap/tables/template-v3.json:13`；检查/分类/计数：类别 command_add（命令的添加）的出现、证据用例数和缺口。
- A20：`packs/workflow/template-gap/tables/template-v3.json:14`；检查/分类/计数：类别 command_delete（命令的删除）的出现、证据用例数和缺口。
- A21：`packs/workflow/template-gap/tables/template-v3.json:15`；检查/分类/计数：类别 command_modify（命令的修改）的出现、证据用例数和缺口。
- A22：`packs/workflow/template-gap/tables/template-v3.json:16`；检查/分类/计数：类别 command_query（命令的查询）的出现、证据用例数和缺口。
- A23：`packs/workflow/template-gap/tables/template-v3.json:17`；检查/分类/计数：类别 show_at_maximum（最大配置下的 show）的出现、证据用例数和缺口。
- A24：`packs/workflow/template-gap/tables/template-v3.json:18`；检查/分类/计数：类别 no_command（no 命令）的出现、证据用例数和缺口。
- A25：`packs/workflow/template-gap/tables/template-v3.json:19`；检查/分类/计数：类别 clear_command（clear 命令）的出现、证据用例数和缺口。
- A26：`packs/workflow/template-gap/tables/template-v3.json:20`；检查/分类/计数：类别 operation_log（操作日志）的出现、证据用例数和缺口。
- A27：`packs/workflow/template-gap/tables/template-v3.json:21`；检查/分类/计数：类别 audit_log（审计日志）的出现、证据用例数和缺口。
- A28：`packs/workflow/template-gap/tables/template-v3.json:22`；检查/分类/计数：类别 configuration_sync（配置同步）的出现、证据用例数和缺口。
- A29：`packs/workflow/template-gap/tables/template-v3.json:23`；检查/分类/计数：类别 configuration_save（配置保存）的出现、证据用例数和缺口。
- A30：`packs/workflow/template-gap/tables/template-v3.json:24`；检查/分类/计数：类别 configuration_restore（配置恢复）的出现、证据用例数和缺口。
- A31：`packs/workflow/template-gap/tables/template-v3.json:25`；检查/分类/计数：类别 configuration_clear（配置清除）的出现、证据用例数和缺口。
- A32：`packs/workflow/template-gap/tables/template-v3.json:26`；检查/分类/计数：类别 upgrade_new_to_new（升级兼容：新版本之间）的出现、证据用例数和缺口。
- A33：`packs/workflow/template-gap/tables/template-v3.json:27`；检查/分类/计数：类别 upgrade_old_to_new（升级兼容：老版本到新版本）的出现、证据用例数和缺口。
- A34：`packs/workflow/template-gap/tables/template-v3.json:28`；检查/分类/计数：类别 upgrade_new_to_old（升级兼容：新版本到老版本）的出现、证据用例数和缺口。
- A35：`packs/workflow/template-gap/tables/template-v3.json:29`；检查/分类/计数：类别 security（安全）的出现、证据用例数和缺口。
- A36：`packs/workflow/template-gap/tables/template-v3.json:30`；检查/分类/计数：类别 database（数据库）的出现、证据用例数和缺口。
- A37：`packs/workflow/case-review/functions/template-coverage.ts:124`；检查/分类/计数：执行或传播文字类别匹配；按命令分组不会使类别依据变成结构。
- A38：`packs/workflow/template-gap/functions/template.ts:116`；检查/分类/计数：执行或传播文字类别匹配；按命令分组不会使类别依据变成结构。
- A39：`packs/workflow/template-gap/functions/commands.ts:8`；检查/分类/计数：执行或传播文字类别匹配；按命令分组不会使类别依据变成结构。
- A40：`packs/workflow/template-gap/tables/template-v3-coverage.json:4`；检查：将关键词产出的覆盖数当事实判定。
- A41：`packs/workflow/template-gap/SKILL.md:9`；指导模型转述关键词分类为缺失/覆盖结论。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-template-categories`，目录 `circle-hub-kw-template-categories`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`packs/workflow/template-gap/**`；`packs/workflow/case-review/functions/template-coverage.ts`、`packs/workflow/case-review/tables/template-v3.json`、`packs/workflow/case-review/tables/template-v3-coverage.json`、对应模板测试及 README、pack.json。禁止改 case-review 的 tags/project/expected-sources；gold 和 contracts 由各自负责人改。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M0、M1：W02/W05 定义作者声明与模型分类的两种来源、受理引用形状、类别 id 闭集生成来源；“未分类”当前无词表值，需先裁定为专用状态字段/限定的模型表达与代码，不由包私造。V02 判断保留 semantics_unasserted；集合运算可记主张上的规则，但不得升级类别语义。明确完整范围及未分类对缺口的阻断语义。

## 要做的

1. 两份 template-v3（A01–A36）类别只留 id、label、group 和模型可读说明，移除 contains/prefixes/equals/tags、字段搜索配置；必选范围、跳过政策移到明确的要求项/政策，不能因删字段丢掉原约束，也不能把中文说明再编译为关键词。

2. 把 A37–A41 的分类入口替换为两条：作者显式类别标签精确等于表 id；或模型逐用例 category+quote+reference 主张。引文必须在该用例节点内部可解析；兄弟用例、祖先标题、文档别处有同词均不算该用例证据。

3. template-gap 不再是全事实包：将类别判断的 W02 生产者与 Hub 的引用/闭集核验、集合运算分开。修改 coverage/command_coverage、workflow、slots 和 SKILL；Hub 本身不调用模型。无作者声明也无受理判断时记未分类，缺类别判断，下一步客户端判断或作者补标签，不算缺类别。

4. 先逐用例分类，再在声明完整范围内求覆盖/缺口。只要有未分类用例，不能把未见类别断言为文档缺类别；已找到的覆盖可据证披露，未见部分给补证出口。显式跳过与未分类分栏。按命令覆盖只消费 R4 的完整命令身份，不能借分组恢复文字匹配。

5. case-review 旧模板表当前未接入 checks（README:168、338；api.ts:21 导出工具），清理其工具和说明但不虚构它污染了 literal/catalog/level。将生效范围、调用方和历史直接调用结果写清。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- “没有审计日志测试”或标题写 audit 但无类别声明/主张，旧实现会命中，修复后是未分类而非 audit_log 已覆盖；相反，不含任何关键词但有合法声明 id 的用例可以归类。
- 错大小写、前后空格、同义中文及未知 id 是结构违规；合法 id、多类别、重复 id 去重行为按声明 schema 校验。
- 模型引用不存在、引用兄弟或祖先节点、没有引文时不受理；同用例内部逐字引文可受理且仍是 judgment。空主张列表不能冒充完成分类。
- 未分类不进入缺类别计数；完整分类后删除/加回/换序符合冻结独立标注；按命令结果与 R4 精确命令集合一致。

## 验证与交付

`npm run typecheck`；`node --test "packs/workflow/template-gap/**/*.test.ts"` 和 case-review 中改到的模板测试；包清单检查；`npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

先 M0/M1，和 R2 协商 resource 中“测试类型”与“模板类别 id”的独立字段；不能把 Functional 自动映射成 functional。template-gap/functions/tags.ts 由 R2 先删别名并交接，本任务只接新显式类别字段。case-review 模板文件归本任务；R2 只改标签链。等待 R4 命令契约后接 command_coverage。最后交 R9 重建金标准和客户端场景。
