# 兼容矩阵

英文译文在 [compatibility.en.md](compatibility.en.md)，两者有出入以中文为准。

三个仓库各自版本化：circle（harness）、circle-hub（平台）、circle-packs（包）。谁依赖谁、以什么为准，都写在这里；改动任何一行都是一次有意识的升级，不是顺手为之。

## 现状（2026-10-15）

| 部件 | 版本 / 提交 | 以什么为准 | 说明 |
|---|---|---|---|
| circle-hub | **0.2.0**（原生执行退役；首个仓库发行是 0.1.0） | 版本化发行、`docs/design` | 现场部署另见进度记录与实际提交核对；发行元数据不代表生产可用 |
| `foundation/circle` | Circle **1.0.4** 源基线，冻结 | `references/README.md` 的来源记录 | 只是源码参考，不装、不跑它的安装器；不是 hub 的运行依赖 |
| 验收用的 Circle 运行时 | Circle 主线提交 **fd8524a**（用户确认，Circle 1.7.0，hub 协议） | `CIRCLE_BIN` / `CIRCLE_COMMIT`，严格 Git 门禁 | **这是真实的测试依赖**：验收 RPC 用例只接受这个提交，换提交要用户确认并更新门禁 |
| Circle 发行绑定 | **v1.7.3 → ae0b0d5** | circle 仓库的 tag 与 Release | 完整构建与正式发布状态以发行页为准；本次 RPC 实测仍固定 fd8524a，发行成功不替代 Hub 验收 |
| hub 的 Circle 侧扩展目标基线 | 1.7.3（命名集成 96702fa、刷新修复 9afe812，另含冷启动、视图预算与初始化关闭保护） | 维护者授权的 hub 扩展改名 | hub 与 /hub 不保留旧别名；与上面的固定 RPC 验收提交分列 |
| circle 的 hub 扩展 | 发行提交 ae0b0d5；可信启动、64 KiB 界面投影及关闭后写入保护 | hub 的 `docs/client-api-handoff.md` | 当前 Circle 使用 hub、/hub、hub_* 与 hub_tool_*，无旧别名；运行时协议与历史验收 pin 须显式绑定 |
| circle-packs `main` | 见其 CHANGELOG | hub 的包装载器与 schema | 产品线包测试使用 hub 提交 `dc93c69826f73f16d2f20f7520ba4c6663d014ac` 的锁定依赖集；circle-packs 的 `.github/workflows/checks.yml` 固定此提交，不跟随 main 漂移；仅为测试依赖，不声明生产兼容 |
| hub 验收用的 circle-packs 原件 | **1f8948c07a9756a3e5dec66f15c25a670fd1e4c2**，APV **1.4.1** | 该提交的 `modules.json` 与原字节 SHA | 包仓库完整合成套件 143/143，无 skip；Hub 的产品模块 / provider 协议选装验收另见进度记录，不以包内测试替代；发行不表示自动激活或批准 |
| 执行网关 cexg | 0.3.1（静态密钥） | compile-excel-server 仓库 | hub 的 worker 需要 §7 的 static-secret 凭据模式才能调用它 |

## 进程隔离与验收平台

执行产品包 Tool/Hook 的受保护设备执行链，以及无界面 Circle 技能运行，目前依赖 **macOS seatbelt**（`sandbox-exec`）。Linux 尚无进程隔离 adapter，走这些隔离路径时运行返回 `SANDBOX_UNAVAILABLE`；不回退到普通进程，也没有测试开关放宽生产隔离。零规则的内建合成派发不经过 Tool/Hook 子进程，不能据它通过推称具备 seatbelt 保护。

| 验收路径 | 所需前提 | 前提缺失时的报告 |
|---|---|---|
| 产品包 Tool/Hook 子进程、依赖这些规则的设备执行 | 可用的 macOS seatbelt adapter | 每个实际执行用例通过统一 harness 标明隔离前提缺失并 skip，不计为通过 |
| Circle 技能执行、取消、运行修订与脚本隔离 | seatbelt，加明确提供的固定 Circle 构建与 Git 提交 | 统一 harness 报告缺失前提；提供了前提后的真正执行失败仍失败 |
| 上传、鉴权、来源/资产登记与批准、列表查询、静态模块校验、内建只读连接器 | 临时 PostgreSQL 和相应合成来源 | 继续运行；不因同文件中另一用例需要隔离而整文件跳过 |
| 不支持宿主的隔离拒绝负例 | 不支持的 adapter 环境 | 继续断言 `SANDBOX_UNAVAILABLE`；单独记录，不能当作隔离阳性路径通过 |

包自身纯单测与 hub 的 Tool/Hook 装载执行验收也分开：前者通过不证明后者能在当前宿主运行。`module-install` 的前四个登记/校验/CLI 用例无隔离依赖，最后一个实际 RPC 用例有；`r3-product-hooks` 的直接 Tool/Hook 调用同样有依赖。公开 Ubuntu CI 的隔离 skip 只声明该平台未验证这些路径；完整执行验收仍需在具备隔离前提的 macOS 上，使用临时数据库、合成网关与脚本模型完成。它不代表真实设备或付费模型验收。

## schema 与契约

| schema | 定义方 | 使用方 |
|---|---|---|
| `circle-packs/modules/1`（modules.json） | circle-packs `tools/modules.ts` | hub 安装器 |
| `product-line/1` | hub 设计 `docs/design/product-line-pack.md` | 包的 `product-line.json`；hub 装载器 |
| `hub-hook/1`、`hub-skill/1`、`hub-tool/1`、`hub-provider/1`、`hub-instruction/1`、`hub-agent/1`、`hub-command/1`、`hub-permission/1` | hub 设计 `docs/design/harness-primitives.md`、`permission-export.md` | 包的 hooks、技能登记、`packages/harness-adapters` |
| 包 Tool 实现的依赖集 | hub 的 `package.json`：exceljs 4.4.0、read-excel-file 9.3.12、fflate 0.8.3、zod 4.6.5、saxes 5.0.1、parse5 8.0.1 | 包的 `tools[].imports`；装载时核对，声明外 import 报 `IMPORT_NOT_DECLARED`，Node 内建模块也不许 |
| hub 客户端 API | `docs/client-api-handoff.md` | circle 的 hub 扩展 |
| `/mcp` 端点 | `docs/design/harness-primitives.md` | 任何 MCP 客户端 |

## 发布顺序

1. hub 先：schema 或客户端 API 变化时提升对应 schema 版本，打 tag，更新本页。
2. circle 的 hub 扩展随后：对着 hub 的 tag 合并，声明支持的 hub 版本区间。
3. packs 最后：按 hub 的 schema 版本更新 `product-line.json` 与 hooks，各包自带版本。

升级验收用的 Circle 提交、更换 `foundation/circle` 基线和各仓库的标识改名都是单独的决定，各留一条记录在本页的「历史」里。Hub 本轮的 CLI/配置改名不替 Circle 改扩展协议，也不替独立包升级版本。

## 历史

- 2026-10-13：建立本页。改名尚未开始；验收 Circle 提交 8b2ceb6；foundation/circle 1.0.4；circle 主线 1.1.1。
- 2026-10-13 晚：7420 就地升级到 server-s2 8e212a6（§5，迁移 28）；circle 主线 1.2.1；circle-hub 与 circle-packs 改为 Apache-2.0，提交需签署；circle-packs 验收固定提交 316760a（products/apv 1.2.0）。

- 2026-10-14：将 Circle 最新公开发行 1.4.1、扩展目标基线 1.2.1 与固定 RPC 验收提交分列；原验收提交与冻结参考均未升级。circle-packs CI 的 hub 依赖集固定为 dc93c69826f73f16d2f20f7520ba4c6663d014ac；本地合成测试结果另行记录，不作为真实产品或生产验收。
- 2026-10-14：Hub CLI 改为 `circle-hub`，部署变量改为 `CIRCLE_HUB_*`；旧 `CIRCLE_SERVER_*` 仅在新键不存在时作弃用回退，新键空值也不回退。Circle 的扩展标识、命令与注入协议保留，路由/schema、旧工作树路径与历史来源不改；Circle 与独立包的版本升级另行确认。
- 2026-10-14：经维护者确认，包装载验收从 224daa6（APV 1.2.1）升级到 ba06eed（APV 1.2.2）；按冻结清单核原字节并运行，产品线 31/31、四技能 57/57、catalog 工具 4/4。该提交 README/CI 合并入口的 61 项是后两类之和，三类分别记录。

- 2026-10-15：准备 Hub 首个仓库发行 0.1.0。验证栈 1b4a6dc 使用 packs d91b23d 的 products/apv 1.4.0，既有固定验收输入另列，不混用。批量流程交付成功，设备结果 13 pass / 8 fail，不表示设备验收全绿；这是当时首版准备快照；维护者随后确认 D 直接实施，最终状态见下条。

- 2026-10-15：D 移除原生能力与 worker；migration 20 原字节保留，migration 44 令旧回执只读，兼容编译器升为 1.1.0。维护者确认 RPC 验收固定 fd8524a / Circle 1.7.0，只验收 hub 协议；Circle 打包客户端独立绑定 v1.7.1 / 259364f。v1.7.0 tag 的发行遇到刷新视图时序失败，保留该 tag 而未发布，1.7.1 仅在原集成上加入已合入主线的独立刷新修复。packs 的工具名消费者独立升版，发行不自动激活新模块。

- 2026-10-15：Hub v0.1.0（8f3b839）、packs v0.1.0（1f8948c）及 Hub v0.2.0（2f9cd20）已发布。7420 滚动到 v0.2.0 的同一提交；19 条历史任务与 2450 份原件前后 SHA 不变，旧回执只读。模型配置不变的脚本 runtime 升到 fd8524a / 1.7.0，新 profile 由另一身份批准，旧 profile 字节不改；没有新模型或设备任务。Circle 打包发布和应用安装另按其正式发行页与本机回执核验，不以 tag 或排队冒称已交付。

- 2026-10-15：Hub main a0a42bb 的完整全开电池实际退出 0，contracts 20/20、methods 282/282、acceptance 403/403、references 7/7，共 712 项，全部零 fail / skip；同提交三项 CI 成功。Circle 1.7.1 曾安装到本机，实际界面发现冷启动集成未加载及超限视图丢对象两个问题，其正式发行取消，没有 1.7.1 Release。客户端绑定改为 1.7.2 / 1914c58，修复可信启动初始化与完整视图字节投影，RPC pin 仍为 fd8524a；正式发布与本机应用验收按各自回执判断，不能由版本绑定代替。

- 2026-10-15：1.7.2 / 1914c58 已在本机通过冷启动与大视图验收；随后隔离环境确定性证明关闭后后台读仍可能重建目录，正式 Release 取消，原 tag 保留。客户端绑定改为 1.7.3 / ae0b0d5：待安装宿主有界 drain、token 异步返回后 abort 检查及 closed dataDir 不创建目录三层保护；三条旧实现红例与九项修后定向检查分列。Windows 的一次 ENOTEMPTY 不据此唯一归因，临时目录清理重试不替代关闭后真实副作用断言。固定 RPC 提交与 Hub 的源码、包、迁移和既有业务结果均不变。
