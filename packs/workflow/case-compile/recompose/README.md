# recompose 1.2.6

本地修正 1.2.6（2026-11-14）：将内嵌 `mindmap-format` `case-structure` 版本由 `1.0.25` 对齐为 `1.0.26`（内嵌模块字节不变），并同步 `testing/gen-recompose.ts` 生成的共享 `functions/recompose-evidence.ts`（接受 recompose `1.2.6` 与 authority/adjudicate `1.1.10`）；能力与核对规则相对 1.2.5 不变；未发布或部署。

# recompose 1.2.5

本地修正 1.2.5（2026-11-14）：将内嵌 `mindmap-format` `case-structure` 版本由 `1.0.24` 对齐为 `1.0.25`（内嵌模块字节不变），并同步 `testing/gen-recompose.ts` 生成的共享 `functions/text.ts` 与 `functions/recompose-evidence.ts`（接受 recompose `1.2.5` 与 authority/adjudicate `1.1.9`）；`SKILL.md` 另按用词把关补清开始重组运行前须传入 `full_set`（整份重组）。能力与核对规则相对 1.2.4 不变；未发布或部署。

本地修正 1.2.4（2026-11-14）：收紧 `SKILL.md` 的工作目录相对路径、`execute` 单行命令、`%HUB_TOKEN%` 三行 here-doc、必含目标 IP 字段不自造 `<中文>` 占位，以及跨会话沿用重组结果时从下载目录 `references.json` 或导出顶层取 `run_reference` 的约束；`tools/download-run.ts` 在运行导出含 `run_reference` 时写入 `<目录>/references.json` 并随标准输出返回（未改 `run-tools@1.0.2`）；按《hub-terms》将 `tools/` CLI 调用失败口径对齐为五类封闭 `<类别词>：<事实>。<下一步>。`（同步共享 `functions/text.ts` 与 `functions/recompose-evidence.ts` 接受 1.2.4 / 1.1.8）；经共享 `recompose/functions/hub-retry.ts` 为 `download-run.ts` 与 `submit-records.ts` 接入读取自动重试（503/`ECONNREFUSED` 按 `Retry-After` 或 `2/4/8` 秒最多等 `60` 秒）与提交仅在 503 明确写明「这次调用没有执行」时重试、其余异常要求先查回原调用（仍未改 `run-tools@1.0.2`）。能力相对 1.2.3 不变；未发布或部署。

本地合并候选 1.2.3（2026-11-12）：内嵌 mindmap-format 升至 1.0.24 并重签；acceptsPack 接受 stage 1.2.3。能力相对 1.2.2 不变。本次不发布。


本地合并候选 1.2.2（2026-11-12）：acceptsPack 接受 authority/adjudication 1.1.5/1.1.6 与 stage 1.2.2；能力相对 1.2.1 不变。本次不发布。
本地合并候选 1.2.1（2026-11-12）：内嵌 mindmap-format 升至 1.0.23 并重签；读取已存重组结果时明确接受 1.1.3、1.2.0 和 1.2.1。能力相对 1.2.0 不变。本次不发布。

本地版本 1.2.0（2026-11-12）：原始用例与手册冲突交使用者决定，说明及本地工具采用统一措辞，内嵌 command-tools 1.1.0。读取已存重组结果时明确接受 1.1.3 和 1.2.0。本次只提交本地，不发布。

case-compile 的独立工作阶段。共享规则来自父目录 tables 和 functions，由 testing/gen-recompose.ts 生成副本；运行发布时单独 stage，不把父目录 README、api.ts 或测试文件带入包。
