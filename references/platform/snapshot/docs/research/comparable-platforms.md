# 同类平台与公共组件调研

阅读日期：2026-10-10。本文件保存第一轮公开资料调研；当时没有安装或运行。后续已按用户授权进行本地源码与沙盒研究，实际结果见[本地研究记录](local-sandbox-findings.md)，不要把本文件的历史范围当作最新验证状态。

本轮关注的是产品平台如何支撑持续维护、设备/Web 操作和可验证协作。下列项目分别解决一部分问题，没有据此认定其中某个项目已经覆盖我们全部需求。旧项目盘点见[能力审计](project-capability-audit.md)。

## 1. 值得借鉴的项目

| 项目与本轮观察 | 可借鉴的经验（本项目的推论） | 对应对象与边界 |
|---|---|---|
| **OpenHands SDK / Automation**：SDK 区分 agent、conversation、typed action/observation/executor 和 workspace；Automation 单独持有调度、webhooks、run history 和 dispatch。来源：[SDK 架构](https://docs.openhands.dev/sdk/arch/overview)、[Automation 职责](https://github.com/OpenHands/automation)。 | 接入 agent 与持久任务分开；操作请求、实际执行和观察分开；本地与远程执行通过明确接口切换。 | A/C/D/F。借鉴职责与接口思路；不采用其 Python SDK/Agent Server 作为新自研平台后端，也不让平台绑定它的会话模型。 |
| **Backstage**：catalog 组织实体与关系；官方提醒它不适合充当实时动态关系系统，并建议将 catalog 作为来源的投影/缓存。来源：[关系图边界](https://backstage.io/docs/features/software-catalog/creating-the-catalog-graph/)、[扩展模型](https://backstage.io/docs/features/software-catalog/extending-the-model/)。 | 产品、型号、版本、架构、代码、测试、商务等先有明确实体/关系，再提供检索视图；业务来源与搜索投影分别维护。 | B/E。沿用知识库 V1 的 PostgreSQL 与原件/快照；不照搬仅面向软件服务的目录，也不把设备实时状态存成产品规范。 |
| **Nautobot**：负载均衡资料已有 virtual server、pool/member、monitor、certificate 等对象；Jobs 提供计划和审批，取消区分运行、未运行和存活未知。来源：[负载均衡模型](https://github.com/nautobot/nautobot/blob/061ccd5ad1bb55feba297c5749d1d16692c27d4a/nautobot/docs/user-guide/feature-guides/load-balancers.md)、[调度/审批](https://github.com/nautobot/nautobot/blob/061ccd5ad1bb55feba297c5749d1d16692c27d4a/nautobot/docs/user-guide/platform-functionality/jobs/job-scheduling-and-approvals.md)、[取消](https://github.com/nautobot/nautobot/blob/061ccd5ad1bb55feba297c5749d1d16692c27d4a/nautobot/docs/user-guide/platform-functionality/jobs/job-cancel.md)。 | APV 可以先定义设备/版本/拓扑及负载均衡资源，再定义操作。调度、审批记录和实际停止分别持有。 | B/C/D/E。借鉴模型与生命周期；其通用 LB 模型不足以表达 APV 全部命令/底层架构。文档中 Job Hooks 的审批支持有边界，不能推断所有入口都等价受控。 |
| **NetBox + 网络配置核验**：官方示例先取得 intended config，再采集 actual running config，最后比较差异。来源：[配置核验](https://netboxlabs.com/blog/network-configuration-assurance-with-netbox-and-ansible/)。 | 规范/意图、现场观察和差异判断必须分开；测试不能根据实际输出反向改写预期。 | B/D/E/C。不把库存系统当作设备执行器，不引入示例中的 Ansible/Python 运行链。 |
| **Temporal**：Workflow 需要确定性重放；LLM/API/数据库等外部调用放入 Activities；TS SDK 提供 workflow、activity、worker 等公共原语。来源：[确定性约束](https://docs.temporal.io/workflow-definition)、[TS SDK](https://docs.temporal.io/develop/typescript)。 | 长任务流程持久化，语义调用和现场副作用有独立执行身份；流程升级需兼容正在运行的任务。 | C/D/F。是持久任务实现候选，尚未选定；重试机制本身不能证明设备变更只执行一次，仍需 D 的去重/核对与结果未知状态。 |
| **Playwright Test / CLI / MCP**：Test 支持隔离 browser contexts 和登录状态；CLI+skills 与 MCP 面向不同调用成本/探索需求。来源：[认证](https://playwright.dev/docs/auth)、[CLI](https://github.com/microsoft/playwright-cli)、[MCP](https://github.com/microsoft/playwright-mcp)。 | D 持有浏览器，E 定义操作方法和断言；探索用结构/视觉，稳定路径逐步形成参数化 TS 测试。登录必须核验实际账户和受保护业务状态。 | D/E/B。可复用成熟 TS 浏览器原语；不能把裸浏览器工具直接当完整产品治理层，认证状态不得入 Git。 |
| **Stagehand**：V3 提供 act/agent 动作缓存，页面变化与参数会影响复用；当前文档索引也包含 V4。来源：[V3 缓存](https://docs.stagehand.dev/v3/best-practices/caching)、[版本索引](https://docs.stagehand.dev/llms.txt)。 | 把发现过的操作提炼为程序，但复用要绑定页面/产品版本、前置条件和结果断言，失效后重新探索。 | E 的操作程序、D 的执行、B 的来源/证据。缓存命中不证明业务成功；不提前选定 V3/V4 或外部托管浏览器。 |
| **Claude Code Mods**：JS/TS 处理运行事件，可以组合工具、提示与展示。来源：[Mods](https://code.claude.com/docs/en/plugins/mods/overview)、[事件](https://code.claude.com/docs/en/plugins/mods/events)。 | 薄适配器可以做客户端交互和事件投影；确定的业务步骤可由程序组织。 | A/F，专业步骤 E。客户端 hook 不是 B/C/D 的唯一强制边界；不采用 Claude 专属 API 作为平台契约。 |

公开仓库观察基线：OpenHands SDK `1cfba2117e92730b0fe1c32520a39aad8611bb8c`；Automation `7cda26ab0f60158a2a6dc74964e9aaf84008e04a`；Nautobot develop `061ccd5ad1bb55feba297c5749d1d16692c27d4a`。这是阅读基线，不是推荐生产版本；没有做其测试或部署验证。其余在线文档按阅读日期记录，正式选型再固定版本。

## 2. Harness 接入的当前事实

| 客户端 | 一手资料确认的接入面 | 本平台计划与未验证部分 |
|---|---|---|
| Circle `f7ac6b0` | [MCP 文档](https://github.com/qingshanfeihu/circle/blob/f7ac6b03f326d717863dd55a74061923d9ec9910/docs/mcp.md)与 [loader](https://github.com/qingshanfeihu/circle/blob/f7ac6b03f326d717863dd55a74061923d9ec9910/src/mcp_loader.ts)：stdio/远程传输；文档注明 print/line/RPC 不加载 MCP，settings 不支持认证 headers。 | 全屏入口可研究 MCP；自动化入口计划 CLI 或薄扩展。认证由独立 TS 客户端代理接平台。没有修改 Circle 或运行其接入测试。 |
| Pi `v1.1.0` / `abe508e` | [README](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/README.md)提供 CLI/JSON/RPC/SDK；[扩展文档](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md)列出 `registerTool()`、`registerMcpServer()` 和事件 API。 | 计划使用当前版本公共 MCP/extension API，CLI 作为最低路径。不能沿用“Pi 无 MCP”的历史印象；是否支持所需资源、任务扩展和媒体语义待实测。 |
| OpenCode | [官方 MCP 配置](https://opencode.ai/docs/mcp-servers/)描述 local/remote servers 和认证配置。 | 计划使用 MCP 配置加共享 skills，必要时使用 CLI。没有固定二进制或验证实际调用、取消和人工输入。 |
| 其他 harness / 程序 | MCP、CLI/HTTP 只是候选接口，客户端能力不同。 | 只要满足最低接口便可接入；不足的交互能力显式降级或拒绝，不宣称所有 UI、hook 和媒体天然通用。 |

MCP 当前 [2026-07-28 Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)规定结构化结果、输出 schema 和跨调用显式 handles；[Tasks 扩展](https://modelcontextprotocol.io/extensions/tasks/overview)需要双方能力协商，取消是协作式请求。平台应有自己的任务/操作 ID；客户端不支持 Tasks 时通过普通 submit/status/result 工具或 CLI 访问同一状态。

[Agent Skills](https://agentskills.io/specification)可以承载方法与资源，不能保证每个 harness 采用完全相同的加载/信任机制。Skill 内容与能力清单共享，加载和结果呈现留在薄适配层。

## 3. 从调研得到的建设建议

这些是本轮推论，具体包、进程和接口仍待讨论：

1. **平台围绕产品任务，而不是围绕某个聊天进程。** B 保存知识和证据，C 持有任务，D 持有实际操作，E 提供方法；A 可更换。不必增加第二个自研 harness。
2. **先把状态与规则所有者定清楚，再选技术。** 不因 MCP、skill 或某框架存在就新增权威服务。F/G 是契约和验证工程，不增加第六/第七个运行对象。
3. **重复性动作由程序执行，未知问题允许探索。** 方法先以 skill 提供；成功轨迹经校验后成为有前置条件、版本和失效条件的操作程序，仍检查真实结果。
4. **知识范围保持产品级。** CLI/XML/footprint 只是部分来源；代码、架构、商业资料和友商信息需要实体与关系、来源权限和时效，不能压成命令查询库。
5. **跨用户/agent/程序的沟通由结构化记录承载。** 记录原输入、来源、模型判断、程序核验和现场观察；Jev/LLM 的概率与不确定性保留。TS 类型还需运行时校验，类型正确不证明内容为真。
6. **先证明五条最小功能链及更换 harness，再扩展完整迁移。** 先设计通过/失败/未知与恢复证据。五条链通过不能替代全部历史行为的迁移验收。

对应[接入契约提案](../harness-adaptation-plan.md)和[基础验证计划](../foundation-validation-plan.md)。本轮仅将研究与计划放到 GitHub。
