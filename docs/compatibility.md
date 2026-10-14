# 兼容矩阵

英文译文在 [compatibility.en.md](compatibility.en.md)，两者有出入以中文为准。

三个仓库各自版本化：circle（harness）、circle-hub（平台）、circle-packs（包）。谁依赖谁、以什么为准，都写在这里；改动任何一行都是一次有意识的升级，不是顺手为之。

## 现状（2026-10-14）

| 部件 | 版本 / 提交 | 以什么为准 | 说明 |
|---|---|---|---|
| circle-hub `main` | 设计文档为准；代码从 `server-s2` 分支经复核后合入 | `docs/design` | 7420 验证栈运行的是 `server-s2` 的复核提交（当前 8e212a6，数据库迁移 28），不是 `main` 的代码 |
| `foundation/circle` | Circle **1.0.4** 源基线，冻结 | `references/README.md` 的来源记录 | 只是源码参考，不装、不跑它的安装器；不是 hub 的运行依赖 |
| 验收用的 Circle 运行时 | Circle 主线提交 **8b2ceb6**（用户确认） | `CIRCLE_BIN` / `CIRCLE_COMMIT`，严格 Git 门禁 | **这是真实的测试依赖**：验收 RPC 用例只接受这个提交，换提交要用户确认并更新门禁 |
| Circle 最新公开发行（截至 2026-10-14） | 1.4.1（`v1.4.1`） | circle 仓库的 tag 与 Release | 仅记录发行状态，不表示 hub 已针对该版验收 |
| hub 的 Circle 侧扩展目标基线 | 1.2.1（`v1.2.1`） | 原定扩展目标版本 | 保持原目标，不随 Circle 新发行自动升级；不等同于上面的固定 RPC 验收提交 |
| circle 的 hub 扩展 | 分支 `server-tools`（4076953，未推送），建立在 Circle 1.1.1 检出上 | hub 的 `docs/client-api-handoff.md` | Circle 维护的扩展名 `circle-server`、`/server` 命令与子进程协议变量本轮不改；Hub CLI 与部署配置使用新名 |
| circle-packs `main` | 见其 CHANGELOG | hub 的包装载器与 schema | 产品线包测试使用 hub 提交 `dc93c69826f73f16d2f20f7520ba4c6663d014ac` 的锁定依赖集；circle-packs 的 `.github/workflows/checks.yml` 固定此提交，不跟随 main 漂移；仅为测试依赖，不声明生产兼容 |
| hub 验收用的 circle-packs 原件 | **ba06eeda83d27031fc1a452e43b24300d654da9e**，APV **1.2.2** | 该提交的 `modules.json` 与原字节 SHA | 产品线包 31/31；四技能模块 57/57 + catalog 工具 4/4 = 61/61，均无 skip；TAP 闸门读实际总数，不写死数量；不表示部署或自动批准 |
| 执行网关 cexg | 0.3.0（静态密钥） | compile-excel-server 仓库 | hub 的 worker 需要 §7 的 static-secret 凭据模式才能调用它 |

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
