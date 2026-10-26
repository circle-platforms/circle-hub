# 任务：A4 合入后的包版本重签

来源：所有者 2026-10-27 指定的 `resign-after-a4` 收尾。`.github/checks/pack-version.ts` 按 Git 结构发现四个包在设定当前版本的提交之后，清单或所列文件又随 A1/A4 合入改变；不能复用原版本的身份。

## 判定与边界

- 这是版本溯源问题，不是新的评审规则改动。四个包各递增一个补丁版本，并在同一提交重签：`case-review@1.1.26`、`case-review-verify@1.1.11`、`case-review-report@2.0.9`、`knowledge-contribution@1.2.4`。
- 保留 A1 的技能包依赖和类型导入、A4 的规则与生成词表。除生成词表的版本号外不改已发布文件内容，不删或改测试，不改 `foundation/circle`、`references`，不接触真实系统、凭据或环境文件。
- 旧版本记录不改。README 只补当前版本的不可变重发说明，不声称新增业务行为。

## 可改路径

- 本任务页。
- `packs/workflow/case-review/{pack.json,README.md}`。
- `packs/workflow/case-review-verify/{pack.json,README.md}`。
- `packs/workflow/case-review-report/{pack.json,README.md}`。
- `packs/workflow/knowledge-contribution/{pack.json,pack-files.ts,README.md,tools/jev/generated.json}`；生成文件只由官方生成器更新。

## 验证

用各包官方命令重签并检查清单，运行类型检查、契约检查、受影响的包测试、完整单元测试、文档、验收和归档测试。测试并发不超过 2，记录每项真实计数及跳过项。合入只使用所有者指定的 `merge-locked.sh`，不在 `hub-redesign` 工作树直接提交或手工合并。
