# 任务：发布状态与查重按结构身份

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 R7、R4、R9、R10；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts K02 C07 W01 W05 W08 B03 A06`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A61：`packs/product/famx/functions/release-notes.ts:14`；分类：章节标题词表判 known/fixed。
- A62：`packs/product/famx/functions/release-notes.ts:23`；抽取：表头同义词猜缺陷号、模块和序号列，另有无表头数字兜底。
- A77：`scripts/real/gold/dup-recount.ts:44`；抽取/计数：statement 自由文字前缀定位某草稿的查重主张。
- A85：`packs/workflow/defect-to-case/functions/compact-index.ts:50`；分类/检查：正文标题正规化后相等并配命令集/正反向就判业务重复；缺少作者精确身份声明。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-defect-to-case-structure`，目录 `circle-hub-kw-defect-to-case-structure`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`packs/workflow/defect-to-case/**`；`packs/product/famx/functions/release-notes.ts`、发布状态/表结构读取测试及 README/pack.json；如权威缺陷字段确需接线，`packs/system/plm/functions/plm.ts` 的已声明 status 字段投影及其测试/清单（不做 U23 alias 改动）。gold/dup-recount 留给 R9。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M7：W05/K02/表 schema 冻结发布状态字段/闭集、规范化命令参数与期望引文身份的重复结构，新增所需结构引用字段及码；当前无专用 duplicate key 轴，不能把 V07“重复策略”（运行重复次数）当用例查重模型。状态未提供复用 unchecked+missing_input 和出口，不按 unknown 猜 fixed/known。

## 要做的

1. 删 A61/A62 的 fixed/known 标题关键词和表头同义推列、无表头裸数字兜底。只取发布页/缺陷系统结构化字段与明确 schema 位置；没有状态字段就未核对，不从章节名或说明文字补状态。

2. 查重键改为规范化结构：锁定构建完整命令路径、按正式类型 canonical 的参数、期望引文身份（源摘要+parser/路径+必要跨度）。逐字段声明规范化语法，不能去大小写/标点/空白合并任意自由文本。相同命令头+正反向+标题不再判重复。

3. 拆除 A85 标题相等决定重复与 A77 消费端 statement 前缀定位；生产主张直接带草稿 item id、被重复 case 身份、结构 key 和规则版本。缺参数/引文身份、索引不全时未知并给补取出口，不能把不完全键当空集合。

4. 更新 shape/commands/grounded/not_duplicate 与 SKILL:47，统一 R2 精确标签；期望语义相似不等于结构重复。多个 expects 顺序、重复、after 和参数类型的等价范围必须写进规则，由冻结 schema 判。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 同标题同命令头但参数或期望引文身份不同不得报重复；标题不同而结构 key 相同应报结构重复。改前失败，改后通过。
- 固定状态字段与散文说明矛盾时只按字段；无字段即未核对，cannot guess fixed from heading。
- 重复的期望文字来自不同源/不同位置不自动等价；摘要变更、索引截断、缺参数都走未知出口。
- 主张 statement 换措辞或多草稿同标题，不影响按 item/requirement/code 查重计数；gold 独立按结构读。

## 验证与交付

`npm run typecheck`；defect-to-case 全包、release-notes/PLM status 合成测试、独立结构 key 回归；包清单及 `npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

先 M7、R2、R4 和 R6 发布/构建身份契约；R5 若期望替换带 after/跨度，先约定原始引文身份与替换后文字的区别。R9 独占 dup-recount，交接新结构字段，不能再解析 statement。R6 修改 release 相关定位后再交本页，FAMX pack.json 逐页交接。
