# P3-4 三家 harness 薄适配记录（L3）

- 日期：2026-10-10
- 步骤：P3-4（三家 harness 薄适配：能力协商、接管与配对）
- 依据：ADR 0018（接入次序与交付物）、ADR 0007（基线与降级标注）、ADR 0019（可见性并轨的接口事项）、验证矩阵 R01/R05/R06/R07
- 资产：`packages/harness-adapters`（脚本化模型端点、Circle loader 驱动、R06/R07 编排脚本）；平台侧被测对象为 `packages/server-stub` 的 MCP 传输（本步为其补齐状态文件持久化、协商日志与调用审计，P1-3 配对回归 11/11 不受影响）
- 固定版本：OpenCode **1.18.35**（npm opencode-ai）；Circle 提交 **9b532727**（包版本 1.0.4，调研基线为 f7ac6b0）；Pi **1.1.0**（npm @earendil-works/pi-coding-agent，与调研固定点一致）

## 1. 方法与口径（先读）

三家的**模型回路**由脚本化模型端点驱动（OpenAI 兼容接口，按固定剧本发出工具调用）——被测的是 harness 本体：它们的 MCP 客户端、会话与工具分发、配置与降级行为全部是真品。模型决策本身是脚本，这与 L4（真实模型质量，DEC-P3-04 未定案、P3-5 阻塞）严格分开，本记录不主张任何模型质量结论。服务端审计日志（stub 侧按 STUB_PRINCIPAL 记录每次调用）是全部断言的地面真相，不采信 harness 自报。

## 2. 能力协商记录（三家均为实测，服务端捕获）

| 项 | OpenCode 1.18.35 | Circle（9b532727） | Pi 1.1.0 |
|---|---|---|---|
| 客户端自报身份 | opencode / 1.18.35（属实） | circle / **0.1.0-dev**（硬编码，与产品版本 1.0.4 不符） | pi / 1.1.0（属实） |
| 提出协议版本 | 2025-11-25 | 2025-11-25 | 2025-11-25 |
| **协商落定版本（断言）** | **2025-11-25** | **2025-11-25** | **2025-11-25** |
| 客户端能力声明 | `{roots:{}}` | `{}`（无 roots） | `{roots:{}}` |
| 工具命名 | `infosec_task_*` | `infosec_task_*` | `mcp__infosec__task_*` |
| 自动化模式加载 MCP | `opencode run` 加载 | print/line/RPC **不加载**（仅全屏界面）；本步经其自有 McpManager（UI 同款 loader 机器）接入 | `--print` 加载 |
| 降级标注（ADR 0007） | 无（原生 MCP 全链） | **有**：全屏 UI 的逐调用审批卡未在无头环境驱动；loader 路径等价于计划中的「CLI/薄扩展适配」 | 无（原生 MCP；需配置 `exposure: "direct"`，见差异清单） |

P1-3 遗留的「MCP 协商版本未核」至此关闭：三家与本平台 stub 的协商版本均为 2025-11-25（服务端 initialize 请求/结果双向捕获）。

## 3. R06 接管序列（通过）

编排脚本 `drivers/run-r06.mjs` 一次干净运行（约 10 秒）全断言通过，服务端审计序列为：

1. `circle-actor-1` 经 Circle loader 提交 needs-input 任务 → accepted（op_1）；Circle 进程退出后状态文件仍在（R01 复核点）。
2. `pi-actor-2`（**不同 actor**，R05）在 Pi 中查状态 → running 且带 1 个待输入；提交输入（绑定 inrev_1）→ running；再查 → **succeeded**（结果 echo 与 decided 标记齐全）。
3. `opencode-actor-3` 在 OpenCode 中取结果 → succeeded。

任务状态全程只在平台侧（stub 状态文件，即 C 的替身），三家 harness 顺序退出/启动互不影响，接管不重复提交、不复用旧租约（本序列无租约面）、不丢待输入。

## 4. R07 跨 harness 配对（通过）

同一场景（submit instant + result）分别经三家在全新状态下执行，各家**实际收到**的响应信封（Circle 经 loader 返回值、Pi 经其会话 JSONL 的 toolResult、OpenCode 经其 SQLite 会话库的 tool part）取出后，去掉 requestId/acceptedAt 归一化，三方深度相等。L1 的「三传输信封一致」至此在 L3 以「三客户端信封一致」复证。

## 5. 三方差异清单（公开，本步实测）

1. **身份自报可信度不同**：Circle 的 MCP clientInfo 版本是硬编码 `0.1.0-dev`，与产品版本无关——平台侧记录 harness 版本时不能采信 clientInfo，须以适配登记的固定版本为准。
2. **协议版本一致**：三家都提出并协商到 2025-11-25；能力声明 Circle 无 roots，另两家有 roots（本平台基线不依赖 roots，无影响）。
3. **工具命名空间不同**：Pi 是 `mcp__<server>__<tool>` 双下划线式，OpenCode/Circle 是 `<server>_<tool>`；能力包与提示词不得写死工具名。
4. **Circle 的自动化缺口**：print/line/RPC 不加载 MCP，全屏 UI 又要求逐调用人工审批——Circle 的平台接入在自动化场景必须走 loader/CLI 薄适配（本步路线），原生全链（UI 审批卡）未验证。
5. **Pi 的 codemode 默认曝光**：MCP 工具默认不直接给模型（经 codemode 间接调用）；剧本按直连工具名发出时调用**到不了服务端**而会话照常推进——只有服务端审计能发现。适配必须显式 `exposure: "direct"` 并以服务端记录验收。
6. **OpenCode 的静默模型回退**：配置的 provider 未就绪时，`opencode run` 曾静默改用内置免费模型（big-pickle）继续跑（实测中它拿着任务描述去文件系统里搜 op_1）。适配必须用 `--model` 显式固定并以服务端审计验收，绝不采信 harness 自报的执行者。
7. **无头驱动的 stdin 陷阱**：OpenCode run 与 Pi print 在 stdin 是开放管道时都会等 EOF 而挂起；驱动一律关 stdin。另：OpenCode 经 node 直接 spawn 时出现过会话被其内部实例路由带偏的现象（同上回退叠加），编排脚本采用 shell 形式驱动后稳定；该现象未在 OpenCode 侧定根因，按驱动约束记录。
8. **超时语义不同**：Circle 的 MCP 工具调用默认无超时（连接 30s）；长任务工具不会被 harness 侧掐断，与六调用的异步语义相容。

## 6. 可见性并轨接口事项（ADR 0019）

本步确认的链接键：harness 会话标识与平台 task/operation 标识**分开**，关联只经信封内的平台标识完成（三家会话库里都能按 operationId 检索到同一任务的调用痕迹）。A 侧会话链接/展示合同的具体形态仍按 ADR 0014 与可见性计划推进，本步未实现展示合同，不并入 L3 结论。

## 7. 范围与未验证项（如实披露）

- 模型回路为脚本化端点：三家在真实模型下的工具选择质量、错误恢复与长会话行为未测（属 L4/DEC-P3-04）。
- Circle 全屏 UI（含审批卡、实时画面）未在无头环境驱动；其 loader 路径与 UI 共用同一 McpManager，但 UI 层行为不在本步证据内。
- R01 的复核口径是「harness 进程级」：任务状态由 stub 的状态文件承载（C 的替身），不是 P3-1 的 PG 持久服务本体；平台服务自身的重启恢复已在 P3-1 单独验证，两者不要混引。
- 每家只测了固定版本的一个构建；版本升级按 ADR 0018 须重跑协商记录与 R06。
