---
nav_order: 4
---

# Hub r4 交接：做到哪了，还剩什么，怎么接着做

给接手的代理（和所有者）。先读 `AGENTS.md`，再读这一页。使用者指南（给在 Circle 里用 Hub 的人）见 [Hub r4 使用指南](hub-r4-guide.md)。进度和已定的决定仍记在 [Hub r4 进度](hub-r4-progress.md)，设计和做法在 [Hub r4 架构](hub-r4-architecture.md)。

## 现状（2026-10-22 更新）

分支 `hub-redesign`，全部提交都带 `-s` 和署名行，最新提交以 `git log` 为准。

| 部分 | 状态 |
| --- | --- |
| 合约（词表轴、记录与任务包格式、三种知识视图） | 完成并生成 |
| records、config、refs、rules、platform、knowledge、runs、connectors、server | 完成，各经两位独立复核和一轮修复 |
| jev | 对外调用（HTTP 客户端、密钥、配置、命令）已拆除；脚本化判断器与核验形状保留，供以后核验 bot 的归位提议 |
| 装配、管理员命令（含命名文档 `doc put/list/show`）、答案文本预算、真实测试 Hub | 完成 |
| 任务包：用例评审初评与复核、模板缺口、用例定位、回归范围、维护巡检、追溯矩阵、质量看板、缺陷转用例、FAMX/FAMY 产品包、5 个系统包 | 完成，各包当前版本见使用指南 |
| 持久部署（这台 Mac，只监听本机，LaunchAgent，钥匙串里的钥匙和操作令牌） | 在运行（2026-10-22 的记录） |
| 知识库 | 6 条版本线、84 个构建已产出根（2026-10-22 的记录）；CLI 手册已入树 |
| Circle 一侧（本地分支 `hub-mcp-client`，不推送） | 完成，`npm run check` 通过（2026-10-22 的记录） |
| 用例索引与用例节点规则 | 完成：默认值统一为“带标签或带标记”（`marked`），`case_rule: tagged` 限制为只认标签；评审摘要带规则说明行与 `marked_only` 计数；验收场景已按新规则更新 |
| 判断服务拆除 | 完成：Hub 不调用任何模型；没有路径的条目留在根下标为未归位；结构性保险测试防回潮 |
| 引擎三处读法 | 完成：修复只用于待判定产物上的检查；`unknown` 不改终态；每个检查必须声明档（旧版本兼容缺省） |
| 构建候选与运行上下文 | 完成：每个候选写制作时间和“基于”的构建，按制作时间从新到旧，发布状态另写；运行上下文 builds 冻结带 `built_at`、`base`、`has_root` |
| 判定规则参照实现与差分测试 | 完成（`tests/acceptance/oracle/`；发现的引擎缺陷已记录并逐条处理） |
| 端到端验收（22 个场景）与覆盖审计 | 完成（`tests/acceptance/`、`docs/hub-r4-coverage.md`） |
| 设备管理包核心 | C1（合约与词表）、C2（租约服务 `hub/leases`）、C4（命名文档 `hub/server/docs.ts`）完成并合并，平台归属检查覆盖 leases 表；C3（start_run 接线）未合并 |
| 设备管理包本体 | P1 纯函数完成（清单校验、环境事实、选台架，`packs/workflow/test-bed`）；P2–P4 包装成工作流未做 |
| 真实 Circle 客户端逐项验证 | 用例定位和模板缺口已通过（2026-10-22 的记录）；其余没做，脚本任务页 `docs/hub-r4-tasks/real-acceptance.md` 在仓库里 |
| 转自动化 | 设计已定（[设备管理包设计](hub-r4-device-pack.md)）；上机部分要所有者给台架、账号和允许的命令类；用例转工作簿的编译部分还没有设计 |

## 怎么确认现状

```
npx tsc --noEmit
node tools/gen-contracts.ts --check
node --test --test-concurrency=3 "hub/**/*.test.ts" "packs/**/*.test.ts" "contracts/**/*.test.ts" "scripts/**/*.test.ts" ".github/checks/*.test.ts"
node bin/circle-hub status          # 持久部署的状态；其他命令见 node bin/circle-hub help
```

跳过的用例和 `todo` 用例要如实报，不算通过。包内函数的沙箱和断网在 Linux CI 的 `Linux isolation` 任务里以 bubblewrap 与 AppArmor 运行；需要 macOS 的路径（`sandbox-exec`、钥匙串、launchd）在 Linux CI 上跳过。

## 规则（摘要，全文在 AGENTS.md）

- 逐个列出路径暂存，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，后面空一行写署名行。不推送，不建 PR。
- 环境配置文件只由 `scripts/real/` 下的脚本在运行时读，屏幕上只写键名、是否找到和长度；不要自己打开它，也不要把任何值写进文件、日志或命令行。
- 真实系统只读；失败的敏捷平台登录不重试（Hub 自己只试一次就停，管理员用 `resource reset-login` 或 `secret set` 解除）。
- 仓库里不放内部地址、真实编号、真实文档内容；夹具只仿结构。真实文档的编号和金标准放在仓库外（`--gold` 文件）。
- 任务包目录里有测试和说明，发布时用 `pack publish <目录> --stage`；改了包里的文件要重新签：`node packs/workflow/case-review/packaging.ts sign <包名>`；已发布的版本不能改内容，再发布要先升版本号。
- 资源绑定的是系统包的某个版本：发布新版本后用 `resource update <资源> --system-pack <包名>` 改绑。

## 分工（2026-10-22 起）

所有者的决定：代码全部由 Otty 里的其他终端（circle、agy、kimi、grok）写，监督者（Claude）只监控结果、安排工作、复核合并、发布部署、跑真实 Circle 验收。每项任务一个工作树和分支（都从 `hub-redesign` 开出，工作树是仓库旁边名为 `circle-hub-<名字>` 的兄弟目录），任务页在 `docs/hub-r4-tasks/`，改完在终端里回报，监督者独立跑测试、安排另一个终端复核，再合并进 `hub-redesign`。

| 任务 | 状态 |
| --- | --- |
| 回归范围、维护巡检（grok）、追溯矩阵、质量看板（kimi） | 完成并合并（包在 `packs/workflow/`） |
| 用例索引收尾（circle） | 完成并合并（用例规则默认值统一，`c41d709`） |
| 缺陷转用例（agy） | 完成并合并（含紧凑索引与沙箱保护） |
| 运行上下文带构建、构建候选带制作时间（builds-context、candidates-times） | 完成并合并（`a35c349`、`f39ec5a`） |
| 判断服务拆除（kimi） | 完成并合并（`7c1ecaa`，含两条结构性保险测试） |
| 引擎三处读法（hub-engine3） | 完成并合并（`e5cd0bd`） |
| 端到端验收与覆盖审计（hub-accept） | 完成（场景套件与 `docs/hub-r4-coverage.md` 在仓库里） |
| 判定规则参照实现与差分测试（hub-oracle） | 完成并合并（`8489409`；缺陷记录后已由引擎三处读法等任务逐条处理） |
| 设备管理包核心 C1（合约）、C2（租约服务）（agy，hub-leases） | 完成并合并 |
| 设备管理包核心 C3（start_run 接线） | 未合并（按监督者安排在做，待核实） |
| 设备管理包核心 C4（命名文档）（kimi） | 完成并合并（`6533092`） |
| 设备管理包本体 P1 纯函数 | 完成并合并（`42ba61e`）；P2–P4 待做 |
| 真实验收脚本（`real-acceptance.md`） | 待开 |
| 转自动化上机部分 | 等所有者给台架、账号和允许的命令类；编译部分还没有设计 |

监督者独有的事（需要真实凭据或持久部署）：发布新版本的任务包、`resource update` 改绑、`knowledge sync`、重新部署、用真实系统和真实模型的验收。

## 已知问题和待所有者决定的事

- **独立复核需要另一个模型家族**：环境配置里现在只有千问家族的端点（`qwen3.7-max`、`qwen3.7-plus`、`qwen3.8-flash`），Hub 把名字里有共同词的模型算同一家族，不认作独立。初评可以用千问，复核要换成 Kimi 或 Grok 的端点（在环境配置里再加一组）。
- 用例节点规则的默认值已定（2026-10-22 决定 13）：统一为“带标签或带标记”（`marked`），`case_rule: tagged` 留作只认标签的开关。
- 第一份评审文档对应的构建（一个 FAMY 构建）还没有出现在构建站；现在用同一版本线里最新的构建（2026-10-22 的记录，未再核实）。
- 4 份 CLI 手册的凭据扫描命中（ftp 示例地址）已由管理员接受，应用手册里的加密私钥示例仍被只保留；不同意可以 `source withdraw <摘要>` 撤回。
