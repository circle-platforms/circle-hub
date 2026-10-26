# 任务：重建无关键词的独立金标准

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 R9、R1–R7、R10；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts A04 A05 B03 V02 W05 W08 K02 C07`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A43：`scripts/real/gold/cases.ts:85`；检查/分类/计数：短语相等即含糊期望，全部期望命中则 vague_expected。
- A46：`scripts/real/gold/case-commands.ts:14`；抽取：短词、STOP 表、中英上下文和前缀缩写产生独立命令答案。
- A47：`scripts/real/gold/regression-doc.ts:33`；抽取/分类：值词表、CJK、数字符号区分命令头和参数，含有目录分支仍复用文字分词。
- A50：`scripts/real/gold/catalog-marks.ts:119`；检查/分类：help 的 or/hostname/URL 将 DOTTEDIP 放宽到 STRING。
- A51：`scripts/real/gold/command-domains.ts:16`；检查/分类：help 的 or/hostname/URL 标记 otherForm 约束未核。
- A54：`scripts/real/gold/locations.ts:65`；分类：以模块排除词和数字约束构造定位答案。
- A55：`scripts/real/gold/board-locate.ts:10`；分类：模块排除词、长数字和 bugIdsOf 决定看板分组。
- A77：`scripts/real/gold/dup-recount.ts:44`；抽取/计数：statement 自由文字前缀定位某草稿的查重主张。
- A78：`scripts/real/gold/compile-check.ts:587`；检查：按原因句前缀把台架外失败改 unknown。
- B07：`scripts/real/gold/cases.ts:93`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B08：`scripts/real/gold/board.ts:15`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- B09：`scripts/real/lib/inject.ts:94`；分类/检查/计数：标签别名、边缘字符或后缀折叠为规范测试类型/反向标记。
- U02：`scripts/real/gold/command-diff.ts:120`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U03：`scripts/real/gold/compile-check.ts:406`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U04：`scripts/real/gold/catalog-marks.ts:116`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U05：`scripts/real/gold/command-domains.ts:43`；检查/分类：optional 字段 yes/y/true/1 同义映射，未知按必填或 false。
- U08：`scripts/real/gold/locations.ts:67`；待核：独立编号 oracle 同样带错拼与活动前缀、单位/CJK 排除，不能仅因不 import pack 就独立正确。语法外用独立标注。
- U09：`scripts/real/gold/trace-stories.ts:9`；待核：同上；影响能力 6 的需求追溯。需版本化正式编号语法或独立带引文标注。
- U10：`scripts/real/gold/cases.ts:95`；待核：bug-to-case 错拼扩展不能凭函数注释认定正式 grammar；影响缺陷 join。与 vague/negative 两项独立计数。
- U11：`scripts/real/gold/id-text.ts:10`；待核：数字长度和边界是 grammar；跳日期/年月/字母等约束是否是作者声明未核准，需语法来源，不直接判 C。
- U14：`scripts/real/gold/catalog-marks.ts:63`；待核：XML 属性引号的 tail 外形恢复可能接受非完整真实语法，需对比来源声明的受支持 XML grammar；失败应报结构缺口，不能靠猜属性边界提升目录准确率。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-gold-independence`，目录 `circle-hub-kw-gold-independence`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`scripts/real/gold/**`、`scripts/real/lib/inject.ts`、`score.ts` 及其测试；`scripts/real/accept/**` 中模板/定位/命令/看板/追溯/查重/编译场景及对应测试，只接已冻结新协议。`scripts/real/lib/accept.ts` 和 `scripts/real/accept-circle.ts` 若需注册由集成者串行接线；本页不碰驱动凭据/环境读取、circle-home 或真实运行输出。禁止 import hub/packs（含 type import、动态 import、重导出）。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M1–M7、M9 的冻结契约后再定 gold schema；“未标注/未分类/未判断/参数未核”等缺口不能由 gold 私造枚举。复用 independence_declared/semantics_unasserted/partial，按受理来源保留限定。R9 不授予真实标注/真实模型调用许可；真实标注来源由集成者另交。

## 要做的

1. 先冻结标注协议和原件集合身份：每条 semantic label 由人工或独立模型事先给出、带 source sha/parser/path/逐字引文、标注来源/身份/模型族/复核者；测试只放合成标注。不得由待测 Hub 的首次答案决定类别/目标或生成期望。

2. 删 gold/cases、board 的 VAGUE/NEGATIVE/TAG_SPELLINGS，case-commands/regression-doc 的 STOP/SHORT/VALUE_WORDS/CJK 边界猜测、catalog-marks/command-domains 的 help 词推类型、locations/board-locate 的 NOT_MODULE。结构 parser 照原件 grammar 独立写；schema/声明来自冻结协议而非被测输出。

3. 不 import hub/packs 或取其计算结果；也不读取包的匹配词表照抄答案。独立标注产物带协议/类别闭集快照身份，人工复核与算法不同实现分别记录；gold 可检查完整身份和引用，但不能自己又用词找语义标签。

4. 模板蜕变按冻结逐用例标注预先选删/加目标；有完整标注才允许“缺类别”，未分类/未判断单列。召回分母、已标注覆盖率、未标注数同时披露，不能通过缩小分母制造高召回。

5. 查重对结构 key，编译对新版 runtime 合约+typed address；删除 A77 的 statement 前缀和 A78 的 reason 前缀。catalog、trace 和 board 的正确性来自独立结构答案和预标语义，不把“不导入 pack”当全部独立性证明。

6. U19/U20 已由所有者裁定：关键词检索不得选任何候选来源，其结果不进入 gold 输入或查全依据；输入只接受显式声明 source id 或模型带逐字引文提出并经 Hub 核验的候选。U24 的版本线前导零/末尾 .0 等价按 FAMX 已声明语法独立解析，不作文字启发式。逐能力给旧 gold 与新 gold 的协议差异、可证明范围和未覆盖项；R10 实际重跑仅集成者做。客户端 accept 场景用受理结果结构字段，不能再靠结论摘要关键词判断通过。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 已预标含/不含关键词的正反例，改前旧 gold 错标，改后只按冻结标签；破坏引文、路径、原件身份必须失败。
- 故意改变 Hub 分类答案，gold 期望保持不变且报差异；执行顺序不改变冻结答案。标注缺失不能自动按否定补零。
- 独立 parser 用另一种实现核原始树/目录/新版合约；未知 grammar 不当通过；没有 type 和 effect 结构时编译 oracle 同样不准派发。
- 合成来源身份完整性及导入边界检查（TS AST），禁止 hub/packs 的 value/type/dynamic import 和间接运行依赖；该检查检查代码结构，不能用业务关键词扫描替代。
- 注入负面组通过精确声明身份选择，别名不被当 Negative；多个同标题草稿的查重不受 statement 换措辞影响。

## 验证与交付

`npm run typecheck`；`node --test --test-concurrency=1 "scripts/real/**/*.test.ts"`（只跑合成测试，不执行 real CLI）；`npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

本页可先写独立标注 schema 草案/合成 failing tests，语义/结构答案实现等 R1–R7 协议冻结和 M9 身份合入后串行接入。所有 gold/*.ts、lib/inject.ts 均只由本页改，避免 R2/R4/R6/R7 重叠；生产负责人只交协议与原件 grammar，不交计算答案。accept 注册文件由集成者最后接线。
