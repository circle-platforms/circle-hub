# 执行器规则按测试环境绑定

基线为主线提交 `23dfe51a3e`，工作分支为 `wp/codex/runner-rules-per-bed`。来源为所有者 2026-11-26 的安排及集成者同日任务书。

目标是按预订的测试环境选择执行器声明的命名文档，在开编译前发现绑定不符，并在效果边界复核同一槽位绑定的文档摘要。

## 本项允许修改的路径

- `contracts/src/{resources,pack,tools}.ts`、相关合约测试、`contracts/generated/`（生成器输出），涉及工具或工作流声明的现有形状按模型裁定实施。
- `hub/dispatch/` 的执行器登记、按预订选择与效果前核对，`hub/server/`、`hub/runs/` 和 `hub/ports.ts` 中对应的运行或文档读取接线及相关测试。
- `packs/workflow/case-compile/` 中开编译、后续沿用输入的工具、包内说明、包版本与发布清单、合成测试；`tests/acceptance/` 中受影响的合成验收。
- 本任务页、`.github/checks/doc-set.json` 中本页的条目、`hub/dispatch/README.md`、`docs/admin-guide.md`、中英文兼容性记录和 `CHANGELOG.md`。

验证包括类型、生成合约、受影响包的测试、UTC 全量单元测试、相关验收和文档检查。实际部署配置由集成者维护。

集成者 2026-11-26 裁定新声明保存文档字面名；清单沿用已有摘要。冻结来源按槽位核对名字，兼容同名文档在开运行后发布新修订。集成者同日 14:54 裁定，返工沿用本次编译最初冻结的文档修订，后续发布只影响新开的编译。
