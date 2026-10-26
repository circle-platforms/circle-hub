# 任务：含糊期望由受理判断供给看板

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 R3、R9、R10；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts V02 W02 W05 W08 A05 A06 K02`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A42：`packs/product/famx/functions/cases-rules.ts:111`；检查/分类/计数：短语相等即含糊期望，全部期望命中则 vague_expected。
- A43：`scripts/real/gold/cases.ts:85`；检查/分类/计数：短语相等即含糊期望，全部期望命中则 vague_expected。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-vague-judgment`，目录 `circle-hub-kw-vague-judgment`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`packs/product/famx/functions/cases-rules.ts` 的 VAGUE 段与 `cases.ts` 的期望质量字段；`packs/workflow/case-review/**` 中新增期望质量主张槽位/核验及 requirements/工作流/表/测试；`packs/workflow/quality-board/**`。不改 case-review 标签、模板工具、expected-sources；不改 FAMX command/manual；gold/cases、gold/board 由 R9 改。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M3：定义 W05 期望质量判断值和受理引用字段（当前无此轴），“未判断”无现成词表值，先定模型维度与生成标签；明确与 static_terminal.unchecked/nature.unknown 的映射，不新造终态。V02 的 semantics_unasserted 已有；比率是 judgment 输入上的 rule_over_claims，不升级含糊语义为 fact。W02 必须接受判断且保留独立复核要求。

## 要做的

1. 移除 A42 的 VAGUE_EXPECTED/VAGUE_KEYS、任何成功/正常等词表或长度兜底；索引只保留原始期望和声明结构，不能在生产器重新产生语义布尔事实。

2. case-review 明确逐用例含糊期望主张 schema，带逐字引文、用例身份、判断者/版本和 accepted validation_result 引用；Hub 核引文路径、归属、闭集判值与受理身份。没有对应受理判断就没有语义结论。

3. quality-board 只聚合锁定版本和所读范围内的已受理评审主张；分别输出总用例数、已判断数、含糊数、未判断数。含糊率分母为已判断数，零分母不显示 0% 或通过，阈值无法核对时给补评审出口。无期望的结构计数与含糊判断分开。

4. 定义多期望、多轮修订和相互冲突判断的聚合范围/选择规则，使用冻结的结构身份与明确 policy；不能挑有利的最后一句文字。更新 board/thresholds/totals 描述、SKILL 和分组摘要，判断性质及分母必须可见。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- “操作成功”但声明并引用可量化判据、以及不含 VAGUE 词的模糊期望，按独立预标判断得到相反结论；改前失败，改后按主张受理。
- 没有评审、未受理、过期版本、别的用例引文、引文不逐字均不计已判断；未判断数量与补评审动作完整。
- 3 个用例仅 2 个有判断且 1 个含糊：含糊率必须是 1/2 而非 1/3，未判断 1；零已判断不能判阈值支持。
- 冲突/同一主张重复引用/多期望按冻结政策计数，不按文本词或数组偶然顺序裁定。

## 验证与交付

`npm run typecheck`；case-review 期望主张测试、quality-board 全包测试、FAMX 对应期望投影测试；脚本化客户端加临时 PostgreSQL 合成串联；包清单及 `npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

先 M3，后 R2 标签合入；R1 对 case-review/quality-board 的共享清单先交接再改，不并发写 pack.json。R6 交模块/版本分组身份，R9 最后提供冻结语义 gold。contracts/src/views.ts 或 Hub 读取 accepted 主张的通用接口如不足，先由集成者补，不越过本页路径去接私有库。
