# 任务：模型族独立性按显式身份声明

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 所有者总规矩；R9、R10（R1–R10 未单列此批，待集成者确认分派）；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts A04 W02 W06 W07 W10 V02`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A76：`hub/runs/engine/independence.ts:30`；检查/分类：模型名字分词重叠判同族，反之判独立。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-independence-exact`，目录 `circle-hub-kw-independence-exact`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`hub/runs/engine/independence.ts` 及独立性测试；调用该身份核验的 engine 测试。模型/提交/运行契约字段由集成者先做，本页不修改其他包、contracts 或 Circle。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M9：A04 原则已有，independence.model_family_declared/unknown 和 qualifier_mark.independence_declared 也已有，不再新增同义标记；W06/W07 缺显式 family id 形状时由集成者加，并给历史缺字段的只读解析/补证语义。不得用“不同模型名”代替身份声明。

## 要做的

1. 删除 familyWords/sameModelFamily 的名字分词、NFKC/大小写和共享单词推族。只按客户端显式 model_family_id 精确相等比较，精确 model_id 与 family 身份分开存。

2. 观察到相同 session 仍不独立；缺模型族声明就独立性未知，给补声明出口；不同名字不能推出不同族。同族不同配置不独立；跨族只记客户端声明级别。

3. W10 按账号核独立的特殊边界保留，不能用客户端 family 声明满足判据变更接受；旧模型字符串不可后台猜补 family。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 同族声明但名字无共同词仍不独立；不同族声明但名字共享 provider 词只属声明级独立；改前结果相反，改后通过。
- 缺 family、空 family、同 session、作者来源不完整分别不得报独立；旧记录没有 family 不补造。
- W10 同账号或未知账号不得因 family 不同被接受；要求项未声明接受客户端独立时也不满足。

## 验证与交付

`npm run typecheck`；engine 独立性、前驱和 W10 对应合成测试；`npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

建议补充分工，待集成者确认。先 M9；R9 的独立模型标注必须等本页身份契约；各包 W02 接受声明独立性的选择由集成者/包负责人核对。
