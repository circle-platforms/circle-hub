# 新账号第一次做脑图编译碰到的问题

分支 `wp/claude/judge-option`（接在判断方式选项之后）。所有者 2026-11-22 的目标和决定见进度文档决定 188。

## 要做的

一个新建的账号在一台没配过的机器上连 Hub 做脑图编译，途中每停一次记一条；能由 Hub 一侧改好的在这里改：

- `tools/open-compile.ts`：本机没就绪的项目一次说全，缺技能和缺 Plumb 密钥的下一步写明找谁、从哪里装。
- 返工时的长名字：`functions/length-literals.ts` 加 `collapseText`，`tools/pipeline.ts` 把还原了占位的上一轮计划交给编写；`tools/check-plan.ts` 提示固定部分相同而长度不同的定长名字；回传索引给出被拒命令和应答里长名字的字符数，失败分析的角色说明按它取长度。
- 命令行里要写团队的地方接受团队名字；撤回个人分配的回答照实说。
- 成员手册和管理员手册补上 Plumb 的配置、判断方式、按团队一次配齐工作流、通用技能要安装。

不做：不改 Hub 的核对规则、合约和六个 MCP 工具；不在角色说明或提示里写某条用例、某个产品命令的做法。

## 可以改的路径

- `packs/workflow/case-compile/`
- `hub/server/cli-team.ts`、`hub/server/cli-pack.ts`、`hub/server/cli-resource.ts` 和它们的测试
- `docs/member-guide.md`、`docs/admin-guide.md`、`docs/quickstart.md`、`docs/hub-r4-progress.md`、`docs/compatibility.md`、`docs/compatibility.en.md`、`CHANGELOG.md`、`.github/checks/doc-set.json`、本页

## 留下的

- 成员取不到通用技能时，本地工具接口的回答没有把没有分配、已退役和不存在分开。
- 设备上观察到的产品行为进不了后续编译的编写简报。
- 一份编译最坏要 11 个后台任务，超过 Circle 默认的连续唤醒次数。

## 验证

见决定 188 的验证一行。真实环境上的检验是第二实例上以这个新建账号做的整份编译，结果记在验收目录。
