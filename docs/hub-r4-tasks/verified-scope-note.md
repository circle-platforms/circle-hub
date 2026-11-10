# B6：“已验证”旁就近写明验证范围（#227）

来源：所有者全量计划 #227/#199；基线 aded2ffd，`fix/verified-scope-note`。

## 允许路径

- `hub/server/console/{knowledge-display.ts,knowledge-display.test.ts,spaces.ts}`
- `tests/acceptance/48-knowledge-console-memory.test.ts`
- 本任务页、`CHANGELOG.md`

## 决定

“已验证”单独出现容易被读成陈述已被证实，限制只写在新建/编辑提示里。保留正式标签（词表 `knowledge_entry_status` 的 `ui: 已验证`，不改词表、不改协议状态名），在它旁边写明实际核对了什么：

- 常量 `VERIFIED_SCOPE`：“已逐字核对来源引文与路径，不代表陈述已获事实确认。”，措辞按编辑提示里已有的核对范围（“提供来源时逐字核对引文与路径”）写，不夸大也不缩小。
- 列表里的状态标记经 `tooltip` 带上这句（悬停或聚焦可见，也进 `aria-description`）；条目自己的页面里写成一行可见文字。待验证、已撤回、已取代的状态不变。

编辑提示里的原句“验证不代表陈述内容已被判为事实”保留，不动。

## 验收

- 单元：已验证带说明，其余三个状态不带；说明出现在 `title` 与 `aria-description`。
- 验收（48）：目录页含这句说明，条目页含 `data-verified-scope` 那一行；改动前这两处断言失败（已实证）。

## 不做

#228、#229 涉及的“声明”“未署名”“记账型”等术语的解释需要先与词表维护方协调，本批不动。
