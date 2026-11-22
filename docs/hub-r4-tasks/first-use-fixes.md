# 新账号第一次做脑图编译碰到的问题

分支 `wp/claude/judge-option`（接在判断方式选项之后）。所有者 2026-11-22 的目标和决定见进度文档决定 188。

## 要做的

一个新建的账号在一台没配过的机器上连 Hub 做脑图编译，途中每停一次记一条；能由 Hub 一侧改好的在这里改：

- `tools/open-compile.ts`：本机没就绪的项目一次说全，缺技能和缺 Plumb 密钥的下一步写明找谁、从哪里装。
- 返工时的长名字：`functions/length-literals.ts` 加 `collapseText`，`tools/pipeline.ts` 把还原了占位的上一轮计划交给编写；`tools/check-plan.ts` 提示固定部分相同而长度不同的定长名字；回传索引给出被拒命令和应答里长名字的字符数，失败分析的角色说明按它取长度。
- 命令行里要写团队的地方接受团队名字；撤回个人分配的回答照实说。
- 成员手册和管理员手册补上 Plumb 的配置、判断方式、按团队一次配齐工作流、通用技能要安装。

不做：不改 Hub 的核对规则、合约和六个 MCP 工具；不在角色说明或提示里写某条用例、某个产品命令的做法。

## 第二轮（决定 189）

第一轮留下的几项在这里补完：

- 历史上机记录：别的包版本写的运行，被设备拒绝执行的命令照样列出（`tools/download-returns.ts`、`tools/generate-workbook.ts` 的 `contractFailureMarkers`）。
- Plumb 客户端：后端已经失败时唤醒立即结束并带出网关的原话（`packs/skill/plumb`，1.0.4；`case-compile` 里的生成副本跟着更新）。
- 编写循环：Plumb 不判断时命令里不带它的地址（`pipeline.ts judge`、`workflows/compile-loop.js`）。
- 本地工具下载：不存在、已退役、技能包没有安装各答一句（`hub/server/local-tools.ts`、`pack-words.ts`、`tools.ts`）。

## 可以改的路径

- `packs/workflow/case-compile/`、`packs/skill/plumb/`
- `hub/server/cli-team.ts`、`hub/server/cli-pack.ts`、`hub/server/cli-resource.ts`、`hub/server/local-tools.ts`、`hub/server/pack-words.ts`、`hub/server/tools.ts`、`hub/server/README.md` 和它们的测试
- `scripts/real/testing/local-cli-probes.ts`、`scripts/real/verify-case-compile-cli.test.ts`（新子命令的探针和计数）
- `docs/member-guide.md`、`docs/admin-guide.md`、`docs/quickstart.md`、`docs/hub-r4-progress.md`、`docs/compatibility.md`、`docs/compatibility.en.md`、`CHANGELOG.md`、`.github/checks/doc-set.json`、本页

## 留下的

- 同一条用例以前上机的结果已经进编写简报（决定 182），第二轮修好了其中被拒命令丢失的问题。别的用例、别的成员观察到的设备行为仍进不来：把贡献层（决定 73、172）接进编写简报没有做，要所有者先定别的成员读不读得到、无人值守时由谁提出、条目是否只作提示。
- `model` 方式下编写循环的标准输入仍是声明的两行，第二行是 Plumb 密钥的占位（流水线这时不读它）：声明和命令守卫只收客户端占位符，改成可选的一行要动 `tool-cli@2` 和守卫，没有做。
- 后台任务连续唤醒的上限在 Circle 一侧改（circle#601），不在这个仓库。

## 验证

见决定 188、189 的验证一行。真实环境上的检验是第二实例上以这个新建账号做的整份编译，结果记在验收目录。
