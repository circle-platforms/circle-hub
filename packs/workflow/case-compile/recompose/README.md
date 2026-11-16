# recompose 1.2.7

本地修正（待升版本号，2026-11-17，未发布）：下载写的文本文件每条一行标注 `· 引用 tree:…`、下面是原文（渲染是 `functions/knowledge-text.ts`，由 case-compile 的 `testing/gen-recompose.ts` 镜像进来，`hub-retry.ts` 随之改用它；内嵌的 `run-tools` 字节不变）；`SKILL.md` 与重组角色相应说明（引用取标注行、条目先后不是手册先后）。

本地修正 1.2.7（2026-11-15）：对齐 `InfoTest_Engine` `compile-worker.md:44-45,70` 补充 `recompose/SKILL.md` 用例重组要求（在不替换作者被测对象/动作/约束、也不将“前置不存在”反向测试改配为正向前置的前提下，必须完整抽出手册正文与配置示例要求的命令运行前置写入 `sources.states` `missing_prerequisite`），并同步 `testing/gen-recompose.ts` 生成的共享 `functions/recompose-evidence.ts`（接受 recompose `1.2.7` 与 authority/adjudicate `1.1.11`）；未发布或部署。

# recompose 1.2.6

本地修正 1.2.6（2026-11-14）：随合约协议生成拆分与格式技能包仅镜像自身声明子集，将内嵌 `mindmap-format` `case-structure` 版本由 `1.0.25` 对齐为 `1.0.26`，同步共享 `functions/text.ts`、`functions/hub-retry.ts`、`functions/recompose-evidence.ts`（接受 recompose `1.2.6` 与 authority/adjudicate `1.1.10`），修复 `download-run.ts` H1 读令牌误报与 `submit-records.ts` H3/H4，新增只读离线预检工具 `tools/check-record.ts`（检出 UTF-8/JSON 错误、完整 `recompose-record@1` 误用、缺 `item`/`method`、同 `item` 重复及可选 `--run` 覆盖校验），并更新 `recompose/SKILL.md` 在 `submit-records.ts` 前先运行 `check-record.ts`、同行 `<<'EOF'` 与单一简写形状。未发布或部署。

# recompose 1.2.5

本地修正 1.2.5（2026-11-14）：将内嵌 `mindmap-format` `case-structure` 版本由 `1.0.24` 对齐为 `1.0.25`（内嵌模块字节不变），并同步 `testing/gen-recompose.ts` 生成的共享 `functions/text.ts` 与 `functions/recompose-evidence.ts`（接受 recompose `1.2.5` 与 authority/adjudicate `1.1.9`）；`SKILL.md` 另按用词把关补清开始重组运行前须传入 `full_set`（整份重组）。能力与核对规则相对 1.2.4 不变；未发布或部署。

本地修正 1.2.4（2026-11-14）：收紧 `SKILL.md` 的工作目录相对路径、`execute` 单行命令、`%HUB_TOKEN%` 三行 here-doc、必含目标 IP 字段不自造 `<中文>` 占位，以及跨会话沿用重组结果时从下载目录 `references.json` 或导出顶层取 `run_reference` 的约束；`tools/download-run.ts` 在运行导出含 `run_reference` 时写入 `<目录>/references.json` 并随标准输出返回（未改 `run-tools@1.0.2`）；按《hub-terms》将 `tools/` CLI 调用失败口径对齐为五类封闭 `<类别词>：<事实>。<下一步>。`（同步共享 `functions/text.ts` 与 `functions/recompose-evidence.ts` 接受 1.2.4 / 1.1.8）；经共享 `recompose/functions/hub-retry.ts` 为 `download-run.ts` 与 `submit-records.ts` 接入读取自动重试（503/`ECONNREFUSED` 按 `Retry-After` 或 `2/4/8` 秒最多等 `60` 秒）与提交仅在 503 明确写明「这次调用没有执行」时重试、其余异常要求先查回原调用（仍未改 `run-tools@1.0.2`）。能力相对 1.2.3 不变；未发布或部署。

本地合并候选 1.2.3（2026-11-12）：内嵌 mindmap-format 升至 1.0.24 并重签；acceptsPack 接受 stage 1.2.3。能力相对 1.2.2 不变。本次不发布。


本地合并候选 1.2.2（2026-11-12）：acceptsPack 接受 authority/adjudication 1.1.5/1.1.6 与 stage 1.2.2；能力相对 1.2.1 不变。本次不发布。
本地合并候选 1.2.1（2026-11-12）：内嵌 mindmap-format 升至 1.0.23 并重签；读取已存重组结果时明确接受 1.1.3、1.2.0 和 1.2.1。能力相对 1.2.0 不变。本次不发布。

本地版本 1.2.0（2026-11-12）：原始用例与手册冲突交使用者决定，说明及本地工具采用统一措辞，内嵌 command-tools 1.1.0。读取已存重组结果时明确接受 1.1.3 和 1.2.0。本次只提交本地，不发布。

case-compile 的独立工作阶段。共享规则来自父目录 tables 和 functions，由 testing/gen-recompose.ts 生成副本；运行发布时单独 stage，不把父目录 README、api.ts 或测试文件带入包。

## 本地自检与 Hub 检查（check-record，第 33 轮）

第 33 轮的缺陷：模型把 `method.sources` 写成原句文字，`check-record.ts --file records --run recompose-run` 报 `ok`，Hub 对三条记录共 10 处给出「缺可解析且本轮可读的声明片段」。原因是 `check-record.ts` 只跑形状检查（`assertValidRecomposeShape`）和覆盖检查，从不运行 Hub 对重组记录跑的检查函数；`SKILL.md` 的示例和 `submit-records.ts` 的形状提示又都把 `sources` 写成「原句或手册引用」，没有说明它们必须是引用（现统一写成 `<引用>`，并在 `SKILL.md` 补一行说明从哪里取）。第二次提交只改了这 10 个值（原句文字改为原句的 `src:…` 引用），其余字节相同，Hub 全部接受。

现在带 `--run` 的 `check-record.ts` 用 `functions/local-checks.ts` 在冻结的下载上按 Hub 的方式核对，本地没有第二份规则：

- `checks.json` 里的函数检查（`record`、`full_set`）调用的就是 Hub 调用的函数（`functions/recompose-check.ts`、`functions/subject.ts`、`functions/seal.ts`）；每条记录的输入由冻结的 `run.json`（条目、运行上下文、分组）、`knowledge/nodes.jsonl`（锁定命令树，按条目选出命令目录，规则、上限和措辞与 `hub/knowledge/catalog-selection.ts` 相同）和 `submit-records.ts` 的 `itemSubmission`（与提交给 Hub 的字节相同）拼成。`checks.json` 声明了而本地没有接线的函数，和核心解释器 `quote@1`，在结果的 `hub_checks.not_run` 里写明原因，不当作通过。
- Hub 在任何检查之前先按 `slots.schema.json` 核对槽位记录的 `data` 形状，不合则整条记录拒收（`SUBMISSION_SCHEMA_VIOLATION`）；`functions/record-shape.ts` 读同一份模式，指出不合处的位置、找到的值和允许的取值（位置与 Hub 相同，措辞比 Hub 的「收到的是未知类型」多说出实际的值）。
- 不带 `--run` 只核对形状，`hub_checks.ran` 为 `false`，退出码仍是 0（`scripts/real` 的探针按这个契约调用）。

以前本地没有运行、现在运行的 Hub 侧检查：`record`（`recompose-check.ts` 的全部规则：原文逐字、覆盖、方法与来源、改写命令的命令树核对、可读引用等）、`full_set`（`seal.ts`，整批与冻结条目一一对应）、槽位 `data` 形状。仍然只在 Hub 里运行的：`quote@1`（引文是否逐字出现在所引片段里；本工具交给 Hub 的引文只取自下载里冻结的原句，`record` 检查另核对记录里的原句逐字等于它们）、引用解析与权限（`exact.ts`）、重试轮次和终态计算。

核对「本地结果等于 Hub 结果」的测试：`tools/check-record-hub.test.ts`（真实运行引擎、注册表、沙箱和临时 PostgreSQL，九组共 18 条记录，逐条比较本地问题与 Hub 的错误）；`functions/local-checks.test.ts`（本地照 Hub 代码重做的几处，每处与 Hub 自己的函数在同一数据上对照：命令目录选择及上限、检查输出的处理、运行上下文）；`functions/recompose-check.test.ts`（拒绝措辞）。

已知限制：

- 下载里没有产品声明的命令目录是否「完整」（`catalog_complete`），本地按完整核对（`hub_checks.assumed` 写明）；若锁定根没有声明完整，Hub 会另外指出缺口，本地不会。需要的话由 Hub 的运行导出把目录声明写进 `knowledge/index.json`。
- 命令目录条目只取 `kind=definition` 且 `data.words`/`data.signatures` 是数组的；Hub 另用 `catalog-entry@1` 校验每个条目并按声明的产出者过滤，下载里没有产出者。
- 证据行 `evidence` 的文字由条目自己的原句拼回节点原文（只在存在性和授权取值的字面比较里用到）；Hub 读的是脑图节点原文。运行上下文不含租约和观察。
- `recompose-check.ts` 里有六处 `bad('', …)`（第 271、303、330、411、413、444 行）给出没有码的反驳，Hub 会把整份输出换成一条 `check_error` 未知（「输出无效：第 N 项是反驳却没有码」）。对 `submit-records.ts` 生成的记录，第 271、303、330、444 行被 Hub 先做的槽位形状检查挡在前面，第 411、413 行只在绑定了产品授权的冲突里到达；本地 `hubOutcomes` 与 Hub 一致，未改这些调用，是否给它们登记代码由包作者决定。
- 共享的 `functions/text.ts` 在 `authority`、`adjudicate`、`recompose` 三个子包里的生成副本落后于 `case-compile` 的版本（缺 `reportStatement`、`localMinute`），本次没有重新生成。
