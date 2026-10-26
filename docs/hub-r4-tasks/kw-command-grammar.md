# 任务：命令与参数仅按锁定树完整语法认定

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 R4、R9、R10；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts C07 K01 K02 K04 W01 W05 A06`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A44：`packs/product/famx/functions/commands.ts:18`；抽取：停止词、命令称呼及上下文字符决定自由文本里的命令边界。
- A45：`packs/product/famx/functions/cases-commands.ts:35`；抽取/分类：英语排除表和唯一前缀缩写把标题/祖先文字归到命令。
- A46：`scripts/real/gold/case-commands.ts:14`；抽取：短词、STOP 表、中英上下文和前缀缩写产生独立命令答案。
- A47：`scripts/real/gold/regression-doc.ts:33`；抽取/分类：值词表、CJK、数字符号区分命令头和参数，含有目录分支仍复用文字分词。
- A48：`packs/product/famx/functions/command-tree.ts:33`；检查/分类：help_string 的 or/hostname/URL 等词改变参数域。
- A49：`packs/product/famx/functions/command-tree.ts:190`；检查/分类：hostname、URL/list/empty、IP/address 决定 hostname/union/string 类型。
- A50：`scripts/real/gold/catalog-marks.ts:119`；检查/分类：help 的 or/hostname/URL 将 DOTTEDIP 放宽到 STRING。
- A51：`scripts/real/gold/command-domains.ts:16`；检查/分类：help 的 or/hostname/URL 标记 otherForm 约束未核。
- A72：`packs/product/famx/functions/manual.ts:1206`；抽取：命令表头同义词决定某列作为签名抽取源。
- A83：`packs/product/famx/functions/manual.ts:280`；抽取/分类：强调或引号中的文本以英文开头、无 CJK 就作为命令 literal；并非完整权威语法。
- A84：`packs/product/famx/functions/manual.ts:1362`；分类：head_tokens 里出现数字/非 WORD 就将签名改判示例并找最长前缀归位。
- U01：`packs/product/famx/functions/command-tree.ts:117`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U02：`scripts/real/gold/command-diff.ts:120`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U03：`scripts/real/gold/compile-check.ts:406`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U04：`scripts/real/gold/catalog-marks.ts:116`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U05：`scripts/real/gold/command-domains.ts:43`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U12：`packs/product/famx/functions/manual.ts:154`；待核：粗体/斜体、占位符和完整命令树身份部分是结构；但 CJK 拒绝和样式猜测是否构成完整权威签名 grammar 尚缺证据，不能把整段抽取等同权威结构。
- U13：`packs/product/famx/functions/adoc/k1-model.ts:143`；待核：AsciiDoc AST 是 D；命令签名的 GROUP/WORD 与强调/字面 code 到命令身份的规则仍须补手册正式 grammar。不能靠英文外形证明命令。
- U14：`scripts/real/gold/catalog-marks.ts:63`；待核：XML 属性引号的 tail 外形恢复可能接受非完整真实语法，需对比来源声明的受支持 XML grammar；失败应报结构缺口，不能靠猜属性边界提升目录准确率。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-command-grammar`，目录 `circle-hub-kw-command-grammar`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`packs/product/famx/functions/commands.ts`、`cases-commands.ts`、`command-tree.ts`、`manual.ts` 中命令签名/literal/列结构读取段、`adoc/k1-model.ts` 中命令语法段及对应测试；`packs/workflow/case-review/functions/lines.ts` 的结构命令引用边界及测试；受影响包的表、README、SKILL、pack.json。gold 仅由 R9 改；manual applicability、adoc 日志错误段留给各页；contracts/hub 由集成者另做。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M4：C07 明确完整命令 grammar、身份精确性和“类型未声明/参数未核/不是命令”的结构结果（当前没有这些精确词表值）；缺类型映射到已有 unchecked+missing_input 和出口，严禁把类型未知放宽成 string。冻结类型定义、case/编码规则、optional grammar 来源；W05/表 schema 增可核验语法版本与来源。需要新增类型/码先经模型生成。

## 要做的

1. 移除 A44/A45/A83/A84 的 stop words、NOT_ABBREVIATIONS、唯一前缀缩写、英文/CJK 外形、数字出现就判示例等语义认定。输入的命令范围来自显式槽/声明命令块语法；完整 token 逐词对锁定树路径，参数按树结构化类型/重载完整消费，不扫描散文捞最长匹配。

2. no、clear 等必须在权威命令语法里声明，不能去 no 前缀后用正命令补足。完整命令合法才产生命令身份；词相似、缩写、参数中出现另一条命令，都不等于新命令。无法完整解析为“不是命令”或“参数未核”，不宣称目录不存在某功能。

3. 删除 A48/A49 help_string 决定类型的全部分支；只消费原件结构化 type 和版本化类型定义。不认识/未声明类型记类型未声明、未核对，缺类型证据，出口包作者或命令树补类型；不能 fallback STRING。已有 origin-bearing 声明仅在权威 schema 授权的精确身份覆盖下可用。

4. 表头列角色只认手册明确 schema/列标识；自然语言表头不是语法授权。命令引用范围和签名 parsing 先给出正式 grammar 及原文出处，U12/U13 已按 A 要改裁定：格式不证明命令，不扩充容错。

5. optional 和 XML 容错 U01–U05 已按 B 要改、U14 已按 A 要改裁定；在没有明确权威语法时不接受 yes/y/true/1 alias、未知默认必填或引号外形恢复。把 syntax invalid 与 type absent 分开。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 完整路径+完整参数正例；同头散文、sh/SH 缩写、英语停词、全角变体、[no] 缺实际 no 路径、夹带尾词、参数值恰好为命令词分别有反例。
- 只改 help 的 or/hostname/URL/empty 不改变类型和判定；删结构化 type 得类型未声明/未核对，不能 STRING 放行；补合法声明后通过。
- 手册表头写“命令”但未声明列角色不能归位；已声明结构块不含这些词仍按完整树解析。JSON 过渡路径也覆盖，说明其当前仅直接调用可达。
- 未知 optional/畸形 XML 不生成看似完整目录；金标准的独立 raw XML parser 及 typed 参数反例由 R9 接手，不 import 被测 parser。

## 验证与交付

`npm run typecheck`；FAMX 命令/目录/手册/adoc 命令相关测试、case-review lines 测试；合成完整 XML 至 catalog/索引串联；包清单、`npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

先 M4；R5 依赖本页命令树 typed 参数，R7 依赖本页 canonical 命令路径/参数。R6 在本页提交后改 naming/documents/cases-sync 的定位段；补充任务 kw-applicability-claims随后改 manual.ts 条件段，补充任务 kw-structured-evidence随后改 adoc/index.ts 错误段，避免同包清单冲突。R9 重写 A46/A47/A50/A51，不让生产代码替它给答案。
