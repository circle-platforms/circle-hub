# 任务：预订沿用到重跑、做完即释放，装构建失败照实归因，照 CES

依据：决定 119。两次复现会话都没有释放整台预订，都是集成者去释放的：case-compile 第 1 步预订，第 9 步写"按第 1 步重新预订"，与 test-bed 不符（计划、核验和派发沿用预订的同一份租约），两个包都没有释放这一步；CES 第 8 条是做完即释放。bed-install 第 6 步只写"看日志和设备会话找原因"，没有 case-compile 第 9 步的归因规则（决定 118），也没写什么时候带 attempt 再装。

- 分支和工作树：`release-after-work`（从 hub-redesign 2bf73fc45 开出）。
- 可以改的路径：`packs/workflow/case-compile/SKILL.md`、`README.md` 与升 3.9.13 的版本文件（`pack-files.ts`、`pack.json`、`tables/workbook-format.json`、`pack.test.ts`、`publish.test.ts`、`samples/**`）；`packs/workflow/bed-install/SKILL.md`、`README.md` 与升 1.0.3 的版本文件（`pack-files.ts`、`pack.json`、`pack.test.ts`）；`docs/hub-r4-progress.md`（决定 119）；本页。
- 规则：同前；SKILL 不超过 8000 字，不删规则。

## 做了什么

1. case-compile 第 1 步：已持有整台预订（如刚装过构建）就沿用；第 9 步：沿用第 1 步的预订重跑，作业都有终态后用 test-bed release 释放。
2. case-compile 确认对话一条去掉某个产品的命令、提示符和应答示例（工作流包不写产品命令），照产品声明的提示符和应答写；省下的字数容纳上面两句，SKILL 仍在 8000 字以内。
3. bed-install 第 6 步：没过的升级用例照实归因（日志点名的步骤、文件或报错），说明不了的推断写预测；说得出这次和上次哪里不同才带 attempt 再装，否则交用户决定。第 8 步：装构建和随后的用例沿用同一个预订，不接着跑用例时作业有终态后释放。

## 不做

- Hub 不核对运行者有没有释放预订（预订不限时长，由运行者释放，见 test-bed）；Hub 不核对归因内容（V08 的假设集尚未实现，见暂缓清单）。
