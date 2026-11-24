# T6：整合最后三个候选分支

依据：所有者 2026-11-16 的 T6 裁定。在已完成 T2 的 `hub-next-7`（`8a06769df8`）上依次合并 `wp/codex/guard-rulings`、`wp/claude/kimi-port`、`wp/claude/session-replay`，每次使用签署的非快进合并。此任务直接使用所有者指定的整合分支，不推送、不部署、不改真实主目录。

## 可改路径

- T5 的 `scripts/real/{guard-lib,circle-home,circle-guard.test,guard-process-proofs.test,guard-rulings.test}.ts` 与 `tools/run-unit-tests.ts`。
- Kimi 的 `hub/dispatch/**`、`hub/runs/engine/**`、`hub/server/{docs,text}.ts`、对应测试与 README；变更仅限分支已有修复及整合所需调整。
- 重放工具的 `scripts/real/replay-circle.ts`、`scripts/real/replay/**` 与两份 session-replay 任务页。
- `CHANGELOG.md`、`docs/compatibility.md` / `.en.md`、`.github/checks/{doc-set.json,exceptions.json,test-suites.ts}` 与本页。

## 取舍与验收

协议保留 T2 的 Circle 1.18 `PreToolUse`、MCP 工具名、代理身份与大结果支持；判定和文字采用 T5。结构化错误、归因和机读选项保留整合分支，接入 Kimi 的答复去重和可读名字。名字提示不改标识，不替调用者选择；命名文档提示仅使用实际核验可读的选项，截断范围仍披露。包版本和清单维持 T2。

执行类型、合约、case-compile、plumb、scripts/real、dispatch、runs/engine、server 与文档检查；含临时数据库的检查启动前遵守外部测试锁。以候选完整技能安装运行 1.18 决定重放，逐项核对四条裁定与十二条拒绝文字。不跑全量回归，真实编译与设备验收由整合者后续执行；合成通过与决定重放不证明真实业务结果。私有进度和最终交接按所有者指定位置保存，不将会话原件带入 Git。
