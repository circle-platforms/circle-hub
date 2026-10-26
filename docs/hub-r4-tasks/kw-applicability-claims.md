# 任务：适用条件由显式结构或带引文主张供给

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 所有者总规矩；R4 的结构优先、R9、R10（R1–R10 未单列此批，待集成者确认分派）；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts K02 K04 W05 V02 C04 A06`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A64：`packs/product/famx/functions/manual.ts:393`；抽取：从自然语言条件中按连词切部件/许可/部署列表。
- A65：`packs/product/famx/functions/manual.ts:407`；抽取/检查：否定、含糊词过滤决定是否提取条件。
- A66：`packs/product/famx/functions/manual.ts:420`；抽取/分类：装有/没有/需要/适用于/仅只 模式赋予条件意义。
- A67：`packs/product/famx/functions/manual.ts:455`；抽取：内存关系词映射成上下界和包含性。
- A68：`packs/product/famx/functions/manual.ts:511`；抽取/检查：例外、否定、也亦还等词决定平台/型号条件可读性。
- A69：`packs/product/famx/functions/manual.ts:517`；抽取：适用于、仅、只触发平台和型号范围。
- A70：`packs/product/famx/functions/manual.ts:602`；分类/抽取：平台/系列/机型/型号及自然语言尾巴判断条件列表。
- A71：`packs/product/famx/functions/manual.ts:773`；分类：章节开头按话题词决定哪些字段不可继承；影响条件覆盖和冲突。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-applicability-claims`，目录 `circle-hub-kw-applicability-claims`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`packs/product/famx/functions/manual.ts` 的 applicability 提取/继承段与相应测试；该包 README、pack.json。不改命令 grammar 或 adoc 错误段；Hub/contracts 由集成者先做。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M8：修改 K02 F[6]、W05 条件主张和 C04 适用规则。applicability_field 已有 models/platforms/builds/components/memory/licenses/deployment_forms；具体闭集词来自产品/部署声明，不写同义词。“条件未判断/未声明”无相应精确状态轴，需先定，不能把缺判断作未声明事实。保留 semantics_unasserted/conditional_on_judgment。

## 要做的

1. 删除自然语言连词、否定/含糊词、装有/没有/需要/仅只、内存关系和话题词决定条件/继承阻断的分支（A64–A71）。闭集词命中不等于作者显式声明字段。

2. 优先读作者结构化条件；否则客户端模型逐字段提出适用范围主张，引用原条件和章节路径，Hub 核引文、闭集值与数值声明。机械继承只对明确结构化范围进行；未判断不能解释为无条件适用。

3. K02 F[6] 仍允许旧文字提取，必须由模型负责人先改；记录每字段直接/继承、来源身份和冲突，判断不升级为 fact。不能以保守排除词自称消除误判。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 同数值但“至少/大约/例外”等正文换词不驱动 Hub 自行提取；脚本化模型给合法结构主张和引文后才可见对应条件。
- 不含触发词但有显式结构声明正常生效；混合未知词、无主张、错字段/错引文都不当无条件适用。
- 继承/覆盖/冲突按结构范围测试，独立 gold 预标字段范围而非复制连接词表。

## 验证与交付

`npm run typecheck`；FAMX manual/adoc applicability 合成测试、包清单与 `npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

这是建议补充分工，待集成者确认后才实施。R4 先交 manual.ts，R6 先定 build/产品身份，再改适用条件；R9 提独立标注。与 kw-structured-evidence 共用 FAMX 清单时顺序交接。
