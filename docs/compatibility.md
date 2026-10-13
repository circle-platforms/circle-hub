# 兼容矩阵

英文译文在 [compatibility.en.md](compatibility.en.md)，两者有出入以中文为准。

三个仓库各自版本化：circle（harness）、circle-hub（平台）、circle-packs（包）。谁依赖谁、以什么为准，都写在这里；改动任何一行都是一次有意识的升级，不是顺手为之。

## 现状（2026-10-13）

| 部件 | 版本 / 提交 | 以什么为准 | 说明 |
|---|---|---|---|
| circle-hub `main` | 设计文档为准；代码从 `server-s2` 分支经复核后合入 | `docs/design` | 7420 验证栈运行的是 `server-s2` 的复核提交（当前 8e212a6，数据库迁移 28），不是 `main` 的代码 |
| `foundation/circle` | Circle **1.0.4** 源基线，冻结 | `references/README.md` 的来源记录 | 只是源码参考，不装、不跑它的安装器；不是 hub 的运行依赖 |
| 验收用的 Circle 运行时 | Circle 主线提交 **8b2ceb6**（用户确认） | `CIRCLE_BIN` / `CIRCLE_COMMIT`，严格 Git 门禁 | **这是真实的测试依赖**：验收 RPC 用例只接受这个提交，换提交要用户确认并更新门禁 |
| circle 主线 | 1.2.1（`v1.2.1`） | circle 仓库的 tag | hub 的 Circle 侧扩展目标版本 |
| circle 的 hub 扩展 | 分支 `server-tools`（4076953，未推送），建立在 Circle 1.1.1 检出上 | hub 的 `docs/client-api-handoff.md` | 标识符仍是 `circle-server`；与 hub 一起改名 |
| circle-packs `main` | 见其 CHANGELOG | hub 的包装载器与 schema | 测试需要 hub 的依赖集（CI 克隆 hub `main` 取 `node_modules`） |
| 执行网关 cexg | 0.3.0（静态密钥） | compile-excel-server 仓库 | hub 的 worker 需要 §7 的 static-secret 凭据模式才能调用它 |

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

升级验收用的 Circle 提交、更换 `foundation/circle` 基线、改名（`circle-server` → `circle-hub` 的标识符，三仓同步）都是单独的决定，各留一条记录在本页的「历史」里。

## 历史

- 2026-10-13：建立本页。改名尚未开始；验收 Circle 提交 8b2ceb6；foundation/circle 1.0.4；circle 主线 1.1.1。
- 2026-10-13 晚：7420 就地升级到 server-s2 8e212a6（§5，迁移 28）；circle 主线 1.2.1；circle-hub 与 circle-packs 改为 Apache-2.0，提交需签署；circle-packs 验收固定提交 316760a（products/apv 1.2.0）。
