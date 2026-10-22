---
nav_order: 4
---

# Hub r4 交接：做到哪了，还剩什么，怎么接着做

给接手的代理（和所有者）。先读 `AGENTS.md`，再读这一页。进度和已定的决定仍记在 [Hub r4 进度](hub-r4-progress.md)，设计和做法在 [Hub r4 架构](hub-r4-architecture.md)。

## 现状（2026-10-22）

分支 `hub-redesign`，全部提交都带 `-s` 和署名行，最新提交以 `git log` 为准。

| 部分 | 状态 |
| --- | --- |
| 合约（53 个词表轴、记录与任务包格式、三种知识视图） | 完成并生成 |
| records、config、refs、rules、platform、jev、knowledge、runs、connectors、server | 完成，各经两位独立复核和一轮修复 |
| 装配、管理员命令、答案文本预算、真实测试 Hub | 完成 |
| 任务包：用例评审初评与复核、模板缺口、用例定位、APV/NSAE 产品包、5 个系统包 | 完成，在真实 Hub 上跑通 |
| 持久部署（这台 Mac，只监听本机，LaunchAgent，钥匙串里的钥匙和操作令牌） | 在运行 |
| 知识库 | 6 条版本线、84 个构建已产出根；CLI 手册已入树 |
| Circle 一侧（本地分支 `hub-mcp-client`，不推送） | 完成，`npm run check` 通过 |
| 用例索引（产品包的 `cases` 生产器、敏捷平台包读目录树） | 实现完成，复核和修复在进行（工作流代理，结束后要集成：跑测试、提交） |
| 回归范围、维护巡检、追溯矩阵、质量看板 | 没开始，规格在 `docs/hub-r4-tasks/` |
| 缺陷转用例、转自动化 | 没开始（后者的设备部分要所有者先确认台架、账号和允许的命令类） |
| 验收（合成数据上的 22 个场景、判定规则的独立对照测试、覆盖审计） | 没开始，见架构第 9 节 |
| 用 Otty 里真实的 Circle 客户端逐项验证七项能力 | 用例定位和模板缺口已通过；其余没做 |

## 怎么确认现状

```
npx tsc --noEmit
node tools/gen-contracts.ts --check
node --test --test-concurrency=3 "hub/**/*.test.ts" "packs/**/*.test.ts" "contracts/**/*.test.ts" "scripts/**/*.test.ts" ".github/checks/*.test.ts"
node bin/circle-hub status          # 持久部署的状态；其他命令见 node bin/circle-hub help
```

跳过的用例和 `todo` 用例要如实报，不算通过。需要 macOS 的路径（沙箱断网、钥匙串、launchd）在 Linux CI 上跳过。

## 规则（摘要，全文在 AGENTS.md）

- 逐个列出路径暂存，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，后面空一行写署名行。不推送，不建 PR。
- 环境配置文件只由 `scripts/real/` 下的脚本在运行时读，屏幕上只写键名、是否找到和长度；不要自己打开它，也不要把任何值写进文件、日志或命令行。
- 真实系统只读；失败的敏捷平台登录不重试（Hub 自己只试一次就停，管理员用 `resource reset-login` 或 `secret set` 解除）。
- 仓库里不放内部地址、真实编号、真实文档内容；夹具只仿结构。真实文档的编号和金标准放在仓库外（`--gold` 文件）。
- 任务包目录里有测试和说明，发布时用 `pack publish <目录> --stage`；改了包里的文件要重新签：`node packs/workflow/case-review/packaging.ts sign <包名>`；已发布的版本不能改内容，再发布要先升版本号。
- 资源绑定的是系统包的某个版本：发布新版本后用 `resource update <资源> --system-pack <包名>` 改绑。

## 待做（按价值排序，每项一个目录，互不重叠）

1. **集成用例索引**：等工作流 `hub-phase6c` 结束（`wf_7ee2f928-844`；也可以直接看 `git status` 里 `packs/product/apv`、`packs/system/agile-platform` 是否还在变），然后跑 packs 的测试、提交，发布新版本，重新同步知识（`knowledge sync --product apv --line <线>`），确认用例条目在树里（`knowledge roots apv`、`get_nodes`）。
2. **四个事实型包**：`docs/hub-r4-tasks/regression-scope.md`、`maintenance-sweep.md`、`traceability.md`、`quality-board.md`。每个一个目录，可以分给不同代理同时做。真实读取器可用后，各补一条端到端测试（`knowledge:impact|facets|index` 的外部标识写法见 `contracts/src/views.ts` 开头）。
3. **用例定位的构建候选**：`case-location` 的 `build_candidates` 现在记“未核对”。要加第四种知识视图 `knowledge:builds:<产品>:<版本线>`（两族名字的构建、别名指向、发布日期）和对应检查，范围是 `contracts/src/views.ts`、`hub/knowledge/views.ts`、`packs/workflow/case-location`。
4. **验收**：架构第 9 节的 22 个场景写成 `tests/acceptance` 下的测试，再写一个只从模型元素推出的判定规则对照实现（`tests/acceptance/oracle`），随机场景上和引擎比，分歧逐条查。
5. **缺陷转用例**：模型从缺陷（现象、修复说明）起草回归用例，Hub 核对命令和参数存在且在目标构建范围内、期望结果逐字取自修复说明或手册、结构符合用例形状、不与已索引的用例重复。需要先设计（架构第 6a 节第 5 项）。
6. **逐项能力的真实客户端验收**：沿用 `scripts/real/accept-circle.ts` 和 `scripts/real/accept/*.ts` 的写法，每项能力一个场景和一份仓库外的金标准文件；真实模型的评审用 `scripts/real/review-circle.ts`。
7. **收尾**：进度文件、设计文档标签页、最终报告写明证明了什么、没证明什么。

## 已知问题和待所有者决定的事

- **独立复核需要另一个模型家族**：环境配置里现在只有千问家族的端点（`qwen3.7-max`、`qwen3.7-plus`、`qwen3.8-flash`），Hub 把名字里有共同词的模型算同一家族，不认作独立。初评可以用千问，复核要换成 Kimi 或 Grok 的端点（在环境配置里再加一组）。
- 用例节点规则的默认值（带标签才算用例，还是按团队模板的标记）：见进度文件的决定 13。
- 第一份评审文档对应的构建 `Rel_NSAE_10_4_6_11` 还没有出现在构建站；现在用同一版本线里最新的构建。
- 4 份 CLI 手册的凭据扫描命中（ftp 示例地址）已由管理员接受，应用手册里的加密私钥示例仍被只保留；不同意可以 `source withdraw <摘要>` 撤回。
- 回答末尾“部分”的说明有时把 200 字的摘要上限说成 30000 字的预算，措辞要改（`hub/server/text.ts`）。
