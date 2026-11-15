# recompose 1.2.7

本地修正 1.2.7 补充（2026-11-15）：将 `recompose/SKILL.md` 及 `recompose/tools/{check-record,download-run,submit-records}.ts` 中的命令行脚本路径与参数值示例及出错提示统一改写为英文单引号形式（`'…'`），与 `scripts/real/guard-lib.ts` 放行清单及 `circle-guard.test.ts` 带空格主目录自动提取回放对齐，并重签 `recompose/pack.json`；未发布或部署。

本地修正 1.2.7（2026-11-15）：对齐 `InfoTest_Engine` `compile-worker.md:44-45,70` 补充 `recompose/SKILL.md` 用例重组要求（在不替换作者被测对象/动作/约束、也不将“前置不存在”反向测试改配为正向前置的前提下，必须完整抽出手册正文与配置示例要求的命令运行前置写入 `sources.states` `missing_prerequisite`，并明确 `submit-records.ts` 前写回 `settled` 裁定、封批后界面决定转记入 `scope.md`），并同步 `testing/gen-recompose.ts` 生成的共享 `functions/recompose-evidence.ts`（接受 recompose `1.2.7` 与 authority/adjudicate `1.1.11`）；未发布或部署。

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
