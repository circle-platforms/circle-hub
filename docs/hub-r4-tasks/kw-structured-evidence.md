# 任务：错误原因与引用对象按结构字段读取

依据：

- 所有者 2026-10-24 的规矩：所有者 2026-10-24 的规矩：编译、评审等过程中，不用关键词表、词典、同义词表、前缀表、自由文本正则或模糊文字启发式做检查、判断、分类、抽取。优先按权威来源真实结构解析并精确核身份；其次校验作者显式闭集字段；语义交客户端模型主张并逐字引用，由 Hub 核引用存在和路径，独立复核补召回。标识符按声明语法解析时必须给语法出处。
- 集成者（模型负责人）2026-10-24 口径 所有者总规矩；R4、R9、R10（R1–R10 未单列此批，待集成者确认分派）；来源与摘要身份见 [整改总纲](kw-overview.md)。这是新规对历史任务页的限定，不能沿用旧关键词验收。
- 模型：`node tools/show-element.ts D05 B03 W05 W08 K04 A06 V04`；要求项从本页列出的包 `requirements.json` 核对。
- 普查证据（行号冻结在总纲的基线；实施前对分派 tip 重定位，保留条目号）：

- A79：`hub/rules/sandbox/sandbox.ts:425`；分类：stderr 文本猜内存耗尽错误类。
- A80：`packs/product/famx/functions/adoc/index.ts:89`；检查：引擎日志自由文本触发整组拒绝（同文件第二处同规则）。
- A81：`packs/workflow/knowledge-contribution/tools/jev/lib/http.ts:252`；分类：错误文本包含 token limit 标记决定错误原因，后续 texts.some 同规则。
- A82：`packs/workflow/knowledge-contribution/tools/jev/lib/judge.ts:53`；抽取：从 instructions 的反引号自由文字猜 piece id。
- U17：`hub/knowledge/calibration.ts:149`；待核：正则遮蔽影响模型输入和校准，但本身不输出语义判定；是否纳入这次禁止范围须明确。建议使用权威 AST/精确跨度遮蔽，并重新校准；packs/workflow/knowledge-contribution/tools/jev/lib/calibration.ts 有同类副本。
- U18：`scripts/real/lib/circle-session.ts:13`；待核：终端画面正则猜 busy/composer 属运行状态观察，非业务文本，但用于验收等待而非权威完成回执；不可据此证明任务完成。应改结构化状态/结果身份，不能把 UI 可见当结果。
- U21：`tools/gen-contracts.ts:221`；待核：用有无 CJK 字符检查“Chinese text”是语言外形启发式，不是内容语义；如规矩涵盖文案语言检查，改作者 locale 声明/模型评审。STAR_EXPORT/TYPE_DECLARATION 正则也不是完整 TS grammar，宜用已有 TS AST。
- U25：`hub/rules/quote-width.ts:45`；待核：现有引文宽窄/空白正规化是否满足本次“逐字”要求未得到新规则豁免；case-compile/quote-width.ts、gold/quote-widths.ts 有独立副本。需冻结原字节+精确跨度，比对时不能吞掉有意义差异。

- 分支和工作树：待集成者从合入模型前置项后的 `hub-redesign` 开 `kw-structured-evidence`，目录 `circle-hub-kw-structured-evidence`；本次只编写任务页的分支是 `keyword-remediation-pages`，目录 `circle-hub-keyword-pages`。
- 可以改的路径（实施分支）：`hub/rules/sandbox/sandbox.ts` 的错误原因分支及测试；`packs/product/famx/functions/adoc/index.ts` 的引擎错误分支及测试；`packs/workflow/knowledge-contribution/tools/jev/lib/http.ts`、`judge.ts` 的结构错误/片段身份分支和测试；这些包 README/pack.json。U17/U18/U21/U25 的跨目录改动已按 A 要改裁定，实施路径仍由集成者明确补充分派后执行；不改校准/CLI/引文通用核心以越权收口。
- 规则：本页是待分派的实施任务，不是本次文档分支已经实现的能力。实施者只在下列范围改动，模型和共享契约先由集成者另行提交。只用合成资源、脚本化模型；不碰 7420、钥匙串、环境配置文件、真实数据、设备和任何真实系统。不推送、不建 PR、不发布、不部署；不改 Circle、foundation/circle、references。显式路径暂存、`git commit -s`。未知必须给 missing 和出口（动作、具名受众、期限），不能停在未知，也不能转成支持或反驳。

## 集成者先做：模型与词表

基线词表已核对：`nature` 有 `fact/judgment/unknown`；`static_terminal` 有 `unchecked`；`reason` 有 `missing_input/not_covered/check_error`；`qualifier_mark` 有 `semantics_unasserted/conditional_on_judgment/partial/independence_declared`；`exit_action` 已有补证出口。不存在“未分类”“未判断”“类型未声明”“旧规则（关键词）”“可能含凭据”这些精确词表值；不能用相近值暗中充当同一状态，也不增加新终态。

集成者先做 M10：D05/W05 统一结构化错误观测与 question→piece 引用字段；已有 check_error/missing_input/unknown 可复用，不新造“猜测内存不足”等原因。新增错误码须登记。U17/U18/U21/U25 均已按 A 要改裁定，不能添加文字启发式豁免。

## 要做的

1. 将 A79–A81 的 heap/unterminated/token marker 自由文字分类替换为进程资源观测/退出信息、上游结构化 severity/code。结构码不具备对应含义时记 check_error/unknown 并指明缺观测，不从日志推根因。

2. A82 不从 instructions 反引号内容猜 piece；在受限 question schema 里显式带 piece id/ref，校验存在、作用域和引文，记录原始 request/response 身份。

3. U17 校准遮蔽、U18 UI busy、U21 语言外形/源码 regex、U25 引文正规化的建议分别见未定页；裁定已定，但不据此自动扩充本页实施路径，也不借它们补证业务完成。

## 必须有的测试

先写能复现旧问题的合成回归用例，记录改前失败的测试名与断言；再实现，原测试改后通过。不能删断言、降低召回门槛或把实际输出倒写为标准答案。下列是实施验收，本文档起草没有执行这些业务测试。

- 相同结构错误码换错误文案不改变原因；文案有 heap/token 字样但没有结构观测不得报具体原因。
- instructions 提及多个反引号 id，显式 piece id 只选该对象；缺字段/对象不存在/跨作用域均报结构问题，不能找第一个匹配词兜底。
- 每条错误留 raw identity、缺事实和出口；unknown 不静默变成成功，结构 severity 的真正 ERROR/FATAL 仍按上游定义拒绝。

## 验证与交付

`npm run typecheck`；沙箱结构错误、FAMX/adoc 日志、jev question/http 对应合成测试；包清单与 `npm run test:docs`。 业务检查只能用临时回环 PostgreSQL、合成文档和脚本化模型。无条件或依赖缺失的检查记未做/跳过及原因，不当通过。包改动后更新包 README、版本/清单和样例；不改 root README。按 R10 保留旧记录，追加受影响字段和新版本血缘；真实重跑由集成者在另行授权下做。

回报：提交号、改前失败/改后通过的测试名与数量、未做项、模型提交身份、受影响要求项、新包摘要和碰头文件。实际未实现的主张不得写成已证明。

## 先后与碰头文件

建议补充分工，待集成者确认。先 M10，R4 交 FAMX 后本页只接日志分支；R9 按结构字段评分。U17/U18/U21/U25 已经按 A 要改裁定，由集成者补路径或另开实现任务，不在当前分工中混写。
