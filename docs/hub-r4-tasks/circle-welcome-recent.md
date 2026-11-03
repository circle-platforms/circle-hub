# 任务：欢迎页最近会话预览（circle-welcome-recent）

目标：最近会话显示标题、时间和当前分支最后一条可见回复，不调用模型，不生成任务状态。

分支：`circle-welcome-recent`，从 `hub-redesign` 创建。

允许修改：

- `foundation/circle/src/ink/components/welcome.ts`
- `foundation/circle/src/tui/welcome_state.ts`
- `foundation/circle/tests/status-surfaces.test.ts`
- `foundation/circle/docs/interface.md`
- `foundation/circle/docs/development/tui-contract.md`
- `docs/hub-r4-tasks/circle-welcome-recent.md`

范围：仅欢迎页；不修改 `/resume`、会话标题生成和数据库结构。
