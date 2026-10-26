# 任务：定位只按声明目录与构建语法

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 R6、R4、R9、R10；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts C07 K01 K02 W01 W03 W05 A05 A06`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A52：`packs/product/famx/functions/locate.ts:14`；分类：排除活动词、数字长度来猜目录层是模块。
- A53：`packs/workflow/case-location/functions/convention.ts:31`；分类：排除活动词、长度、编号/版本来判断模块。
- A54：`scripts/real/gold/locations.ts:65`；分类：以模块排除词和数字约束构造定位答案。
- A55：`scripts/real/gold/board-locate.ts:10`；分类：模块排除词、长数字和 bugIdsOf 决定看板分组。
- A56：`packs/workflow/case-location/functions/convention.ts:107`；分类/抽取：协议名表及单位表猜数字不是产品版本。
- A57：`packs/product/famx/functions/documents.ts:13`；抽取/分类：从任意文档文字捞版本号决定版本关联。
- A58：`packs/product/famx/functions/cases-sync.ts:119`；分类/选择：产品名文字前缀决定目录根候选。
- A59：`packs/product/famx/functions/listing.ts:164`；分类：文件名包含 command-tree/bugs-fixed/mib 等猜资产角色。
- A60：`packs/product/famx/functions/naming.ts:191`；分类：patch 前缀、mainlineWords 和剩余词兜底 customer 判页面类别。
- A63：`packs/product/famx/functions/release-notes.ts:19`；抽取/分类：文字标签或裸版本、日期推断发布适用性。
- A87：`packs/workflow/case-review/functions/expected-sources.ts:36`；抽取/分类：回归/test 等前缀决定裸编号从哪开始；这段不是编号数字本身的语法。
- A88：`packs/workflow/case-review/functions/expected-sources.ts:168`；抽取/排序：功能词、停词、汉字连词、作者名和数字排除控制 spec/策略/历史来源。
- A89：`packs/workflow/case-review-verify/functions/expected-sources.ts:36`；抽取/分类：回归/test 等前缀决定裸编号从哪开始；这段不是编号数字本身的语法。
- A90：`packs/workflow/case-review-verify/functions/expected-sources.ts:168`；抽取/排序：功能词、停词、汉字连词、作者名和数字排除控制 spec/策略/历史来源。
- U06：`packs/product/famx/functions/ids.ts:14`；待核：编号数字及分隔语法可以是 C；但该正则显式容错 but/bugt/ro/c[a-z]{0,5}，注释仅说从真实标题见过，未见作者授权的正式 grammar。先不把整段列为允许。删除错拼猜测，给版本化 grammar；超出 grammar 的由模型带引文提编号，重算 3/6 及来源绑定。
- U07：`packs/workflow/case-location/functions/ids.ts:1`；待核：同样混有声明编号 grammar、回归前缀、年份/单位/CJK 排除；语法与启发式需拆分，不能整文件许可。影响能力 3/6。
- U08：`scripts/real/gold/locations.ts:67`；待核：独立编号 oracle 同样带错拼与活动前缀、单位/CJK 排除，不能仅因不 import pack 就独立正确。语法外用独立标注。
- U09：`scripts/real/gold/trace-stories.ts:9`；待核：同上；影响能力 6 的需求追溯。需版本化正式编号语法或独立带引文标注。
- U10：`scripts/real/gold/cases.ts:95`；待核：bug-to-case 错拼扩展不能凭函数注释认定正式 grammar；影响缺陷 join。与 vague/negative 两项独立计数。
- U11：`scripts/real/gold/id-text.ts:10`；待核：数字长度和边界是 grammar；跳日期/年月/字母等约束是否是作者声明未核准，需语法来源，不直接判 C。
- U23：`packs/system/plm/functions/plm.ts:235`；待核：产品名称 NFKC、大小写、斜杠别名匹配；有显式 aliases 语法来源可 D，否则为声明字段同义映射 B。最稳用产品 id 精确绑定。
- U24：`packs/product/famx/functions/naming.ts:86`；待核：去前导零/末尾 .0 合并版本身份需要权威版本规范；它不是简单的身份完全相等。列为待核，不能把该合并当 C 的自动许可。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-location-grammar`，目录 `circle-hub-kw-location-grammar`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`packs/workflow/case-location/**`；`packs/product/famx/functions/locate.ts`、`documents.ts`、`cases-sync.ts`、`listing.ts`、`naming.ts` 的定位/资产语法段（含 U24 版本线规则文件头）及相应测试；case-review 与 case-review-verify 的 `functions/expected-sources.ts`、`expected.ts` 和来源选择测试；相关 README/SKILL/pack.json。gold、PLM 系统包、Hub 通用 parser 不在本页路径，需裁定后另分派。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M6：W01/K01/C07 定义目录层角色、grammar id/version/origin 与身份字段；当前无“目录层未知/语法未声明”专用值，优先复用 unknown+missing_input+出口，若要新限定先生成。产品/资产角色及 alias 不得私造枚举；既有 family/page-kind 的包内声明与生成边界需统一。来源关联模型主张必须保留 judgment。

## 要做的

1. 替换 A52/A53/A56–A60/A63 的 NOT_MODULE、协议/单位排除、自然语言版本捞取、产品名文字前缀、文件子串角色和 patch/customer 猜类。把产品线/版本线/列车/模块各层及构建资产的 grammar 写进产品包，给结构层级和来源；按整段真实语法/节点身份解析。

2. 语法不识别、层级缺失或身份不唯一时记未知，缺具体哪层的语法/目录身份，出口包作者补 grammar 或作者改目录名。不能用“看起来不是活动名”把剩余文本认成模块，不让 unknown 进入已定位分组。

3. 编号只按已声明 defect/story/build grammar 提身份；U06–U11 已由集成者按 A 要改裁定，删除错拼容错、活动前缀和数字语义排除。标题不是正式编号字段时不推来源种类；优先作者显式编号，结构外由模型引用提出关联。

4. A87–A90 的 featureTerms/中英前缀抽取不再自动制造期望来源清单：采用显式来源 id，或模型带逐字引文提出候选并经 Hub 核验；所有者已裁定 U19/U20：关键词检索连候选来源也禁止，其结果不作任何输入或查全依据，删除检索评分/排序入口。

5. 对接 case-location location/build_candidates、FAMX 索引的版本/模块及 trace/board 分组；U23 已按 B 要改裁定，产品 alias 不做同义映射；U24 已由所有者裁定为 C：版本线前导零和末尾 .0 不改变版本线，将这一显式命名规则写进 FAMX README 和 naming.ts 文件头，再按语法解析。该规则不改变构建 id。完整构建名 C 类 grammar 保留其声明范围，不扩成任意正文扫描。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 模块名含“测试/bug/回归”但符合声明层级/grammar 时正常定位；活动名不符合语法时未知。去除语义排除后结果不能由关键词决定。
- 标题夹带版本/协议/数字不会改变目录的版本；目录层未知带 missing/exit；字面相似文件名但不符整名 grammar 不判资产角色。
- 显式目录 id 与产品名正文冲突只披露，不按标题改产品；不同 build id、未声明产品 alias 不合并；版本线仅前导零或末尾 .0 不同则按 U24 同线处理，非零数字段不同仍不同线。
- 编号/来源分支用合成编号 grammar、显式 source id 与脚本化模型引用测遗漏/误关联；金标准不得复制 NOT_MODULE 或 featureTerms。

## 验证与交付

`npm run typecheck`；case-location 全包及 FAMX 定位/目录/sync、两个 review 包 expected-sources 测试；包清单及 `npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

先 M6，R4 的命令身份先合入 FAMX，再由本页改定位/同步；R2 的 cases 标签也先交接。R3 等本页版本/模块身份契约后聚合看板。本页拥有 expected-sources.ts，不让 R1/R3/结构证据任务并发修改。R7 在本页 release 日期/构建结构先定好后消费；R9 最后独立解析定位。U19/U20/U23 的系统适配器实现路径由集成者明确分派；U24 的 FAMX README/naming.ts 规则在本页范围内落实。
