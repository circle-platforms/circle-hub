# Hub 答复措辞的既有断言同步

分支 `codex-1112-server-assertions`，承接所有者 2026-11-12 任务书 B1。只同步既有测试的正文断言，保留原场景、机器可读数据、历史字节和实际引用读取要求。

可改路径：

- `hub/server/assemble/testing-real.test.ts`
- `hub/server/historical-exits.test.ts`
- `hub/server/source-readable-display.test.ts`
- `hub/server/text-history.test.ts`
- `tests/acceptance/support/mcp.ts`
- `tests/acceptance/16-agile-mindmap-review.test.ts`
- `tests/acceptance/17-hub-restart.test.ts`
- `packs/workflow/case-compile/functions/workbook-input.test.ts`
- `packs/workflow/case-compile/functions/workbook.test.ts`
- `docs/hub-r4-tasks/codex-1112-server-assertions.md`

不修改生产代码，不新增测试或删除场景。此项只静态同步，不运行测试、类型检查或安装；由集成分支最后唯一一次 `npm test` 验证。

按所有者同日补充要求，第一段保留白话答复，第二段以“供模型引用”开头，保留完整机器数据和原始用例对应关系。
