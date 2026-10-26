# 任务：测试类型与反向标签只收声明精确值

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 R2、R1、R9、R10；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts W01 W05 C04 C07 V02 A06`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- B01：`packs/workflow/case-review/functions/tags.ts:18`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B02：`packs/workflow/template-gap/functions/tags.ts:17`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B03：`packs/workflow/quality-board/functions/tags.ts:20`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B04：`packs/workflow/quality-board/functions/tag-table.ts:4`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B05：`packs/product/famx/functions/cases-rules.ts:34`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B06：`packs/workflow/defect-to-case/functions/checks.ts:19`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B07：`scripts/real/gold/cases.ts:93`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B08：`scripts/real/gold/board.ts:15`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B09：`scripts/real/lib/inject.ts:94`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-tags-exact`，目录 `circle-hub-kw-tags-exact`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`packs/workflow/case-review/functions/tags.ts`、`functions/project.ts`、`functions/subject.ts`、标签测试和结构表；`packs/workflow/template-gap/functions/tags.ts` 及标签测试；`packs/workflow/quality-board/functions/tags.ts`、`functions/tag-table.ts`、标签覆盖消费点与测试；`packs/product/famx/functions/cases-rules.ts` 的标签段、`cases.ts` 的标签投影及对应测试；`packs/workflow/defect-to-case/functions/checks.ts` 的标签段、对应测试；这些包的 requirements/SKILL/README/pack.json 清单。只改上述标签行为；gold/cases、gold/board、lib/inject 留给 R9。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M2：当前 AXES 没有 test_type/模板类别闭集轴（六类是包手写数组），需确定唯一声明值、字段位置和允许的非类型资源标签边界，再生成包快照。结构违规采用现有 violation/advisory 语义；若需新违规码由 contracts/codes 负责人登记。新增“类型未声明”与类型无效的表达由 M2/M4 一起定，不能把未知标签当非反向。

## 要做的

1. 删除 B01–B06 的 SPELLINGS/CATEGORY_MAP、去括号/后缀、大小写/NFKC 合并及 startsWith/endsWith 回退。只比较作者声明标签与模板闭集值完全相等；原始标签保留以便修复。R1 类别 id 与测试类型值不能串用。

2. 反向身份只来自明确的精确声明；不能命中 neg、负向、异常就推 Negative 或把没有识别出的变体当正向。非法变体是提示档结构违规并点名允许值；无法机械确定应改哪一项时列出闭集供作者选择，不靠同义映射推荐某一个值。

3. 将标签结构违规接入 case-review literal、template-gap 类别输入、quality-board 的类型/负面聚合、defect-to-case shape/commands；非法类型不参与正负分母。标签未知与空标签、原始非类型资源标签分清，模型负责人先定字段 schema。

4. 消除 SKILL 中 Boundary/Performance/Security 与实现六类词表不一致；不擅自新增或删测试维度，提交模型负责人确定唯一闭集并生成。禁止测试把旧别名等价当正确答案。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 每个闭集值一个正例；小写、全角、空格、未闭合括号、中英别名、添加 test/case 后缀各是提示档违规，改前错误地通过、改后拒作等价。
- 同一中文说明不变，只换精确标签，结果只随声明变化；变体不变成 positive，未声明也不变成 false。
- 非法标签不触发 catalog 的反向参数越界例外，不改变看板负面比例；修成精确值后才纳入。合成发布/读取与索引不重新归一。

## 验证与交付

`npm run typecheck`；各已改包的标签/投影/结构测试与合成发布测试；包清单检查；`npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

先 M2；先提交 case-rules 标签段，交 R3 改该文件 VAGUE 段。R1 与本页顺序合并 template-gap/functions/tags.ts；R3 待本页合并后修改看板 requirements/pack.json。R7 在标签接入后修改 defect-to-case checks.ts 的查重段。R6 修改 FAMX 同步定位，R4 修改命令链，均不得重写标签段。R9 最后改 B07–B09（本页给 schema，不给别名表）。
