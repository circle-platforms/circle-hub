# 企业 Agent 平台的页面与交互设计

2026-10-11。状态：可操作的前端设计原型，不是企业服务已实现的声明。源代码位于 [demo/server-ui](../demo/server-ui/README.md)，使用合成资料、人员、任务、运行、设备与工程故事。测试范围见[当轮回执](validation/enterprise-demo-20261011.json)。

用户要求通过 Web 演示完整的平台设计，并指出第一版的话术、结构和交互不像企业 Agent 产品。本轮重新核对成熟平台的文档和公开 UI 源码，调整信息对象与入口，而不是继续按架构字母扩展首页。

## 人怎样使用这套平台

普通用户直接在 Circle 中描述目标、附材料，不必先选择任务分类或理解 Agent、B/C/D/E。系统按当前项目和授权范围选择适用方法；只有输出要求、缺少的条件或具体动作需要人决定时，才在这段会话里询问。评审意见、工作簿、代码差异和证据在旁边按需展开，修改与下载留在同一项工作中。关闭或断开客户端不等于取消 server 已受理的工作。

本次核对 platform 全部有用户目标的工作，并修正了把能力盘点做成菜单的方向。清单保留在设计检查文档，日常界面回到会话与按需结果。详见[工作覆盖与交互检查](platform-workflows-and-interaction.md)。演示的团队管理是同一个 Circle 产品中的授权入口，仓库与部署边界不要求用户切换两个产品。仓库是否合并仍是工程选择，本轮未合并仓库。

Agent 负责人在 server 中维护职责、知识与工具、测试、版本和使用入口。修改先进入草稿，测试记录和人员决定绑定当前修订；发布后新工作使用新版本，在途工作仍保留创建时固定的配置。

公司资料、来源连接、执行环境、组织权限、运行观测、审计和研发交付有自己的管理对象。页面结构采用列表、详情、当前动作的稳定顺序。B/C/D/E 继续拥有各自状态；架构字母放在系统设计和关联说明中，不要求普通用户按对象字母找工作。

## 关键对象怎样关联

| 对象 | 保存什么 | 与其他记录的关系 |
|---|---|---|
| Agent 配置 | 职责、模型配置、资料/方法/工具引用与发布版本 | 作为 A 运行和业务资源的组合视图；不吞并四对象的状态 |
| 会话 | 连续交流与上下文 | 可以关联持续工作及多次运行 |
| 用户任务 | 目标、输入修订、授权范围、持续状态与交付 | C 保留，可跨会话与执行尝试继续 |
| 运行 | 某次尝试的 Agent、输入、触发方式与步骤 | 原输入固定，新输入形成新运行；不覆盖历史 |
| 自动化规则 | 时间或事件、模板、Agent、目标与服务身份 | 每次触发形成独立任务与运行 |
| 操作与现场 | worker、目标、SSH/Web、租约、控制权与观察 | D 核对实际作用；B 保存原件和制品 |
| 人工请求 | 具体问题、材料、目标、影响、修订和指定人员 | C 保存回应、时效与后续条件，不能扩大原授权 |

Agent 配置是产品中方便管理的组合入口，配置发布与权限归 C 治理，专业职责与方法引用由 E 管理，模型与通用运行继续复用 A 的能力。具体正式 schema 待相应实施故事冻结，本轮没有增加一个包办所有业务状态的新运行对象。

## 每个区域包含什么

| 区域 | 前端要素与可操作流程 |
|---|---|
| Agents | 目录、职责、知识与工具、试运行、逐步骤输入输出、当前草稿、人员评审、版本、停用与运行记录 |
| Circle | 选择已发布 Agent、自然语言输入、原始工具记录、上下文、待回应请求、同现场入口、断开与重连 |
| 任务与运行 | 工作列表/看板、会话、运行尝试、输入历史、具体决定、证据、报告与未知；普通调查不编造完成百分比 |
| 待我处理 | 谁需要回应、为什么、依据、目标、影响、继续方式；批准/拒绝与原任务关联 |
| 自动化 | 固定规则、时区、版本、服务身份、重叠/补跑、运行历史、长期观察、停止与核对 |
| 知识库 B | 文档、代码、CLI/XML、测试、缺陷、经验和商务范围；来源 ACL、修订、原件、知识对象、候选、快照、回退、证据与制品 |
| 技能与工具 E / D | 产品方法、确定规则与分析要求、适用范围、候选样本/评测、工具拥有者、调用机制、执行位置与授权 |
| 执行环境 D | 网络区域、worker、连接配置、目标身份、操作账本、原始输出、SSH/Web 同会话、观察/接管/交还、未知与停止核对 |
| 组织权限 C | 项目成员、角色与环境范围、服务身份、任务委托、撤权、来源读取/导出、具体作用、公司身份映射 |
| 运行观测 | 范围内在途、队列、异常、时序、节点、预算与从 Agent 到工作/步骤的定位；运维不自动读取业务正文 |
| 审计日志 | 运行日志、任务事件与审计分层；人员/服务、目标、任务、操作、输入、政策、结果和时间；当前范围导出 |
| 部署与恢复 | 后台、PG、执行节点、原件存储、排空、维护窗口、恢复检查、兼容版本与迁移/回滚范围 |
| 研发交付 | 目标、Epic、故事、Sprint、依赖、独立验收、反馈、两端 PR/发行；代码、功能验收与发布分开 |
| 网络诊断 | 产品业务路径与不同观察点，物理到应用层的采集范围、原因候选、冲突和未知 |

固定任务的具体时间、重叠、补跑和通知参数属于本轮交互提案，未自动升格为正式调度决策。示例公司系统不是对用户实际系统的推测。控制、作用和权利检查仍要在正式 server、B/D/E 的作用路径实现。

## 已跑通的设计情景

- 修改 Agent 草稿不会影响发布版本；测试、当前修订评审后才能演示发布，旧任务保留旧版本。
- Circle 使用指定 Agent 建立工作，输入保持原文；断开/重连保留同一工作与证据。
- 公司来源生成候选并发布新快照；旧任务不静默换依据，显式更新后建立输入修订并使旧批准失效。
- 运行的输入修订不改写为新值；调试使用对应原输入进入隔离测试窗，不重放设备命令。
- 接管同一现场后 Agent 等待；停止先显示核对中，目标身份变化使后续作用被拒绝。
- 固定规则暂停不取消在途实例；同范围的重叠触发不创建第二项工作。
- 安全、运维、审计、业务、观察和商务身份的视图不同；搜索、原件、现场与导出不因另一个入口扩权。

这些是前端模拟约束与交互结果，不能证明真实身份授权、数据隔离、网络执行或模型语义质量。18 项状态约束检查与 12 个隔离浏览器情景通过；业务/模型/设备验证未运行。四张截图均由隔离浏览器使用合成数据生成：[Agent 目录](design/assets/enterprise-demo/agents.png)、[测试与步骤](design/assets/enterprise-demo/agent-test.png)、[Circle](design/assets/enterprise-demo/circle.png)、[移动布局](design/assets/enterprise-demo/mobile.png)。

## 调研怎样转成设计

以下结论是文档与静态代码观察；没有部署第三方平台或验证其后端授权。

| 主要来源 | 本轮采用的交互原则 |
|---|---|
| [Copilot Studio 创建与发布](https://learn.microsoft.com/en-us/microsoft-copilot-studio/fundamentals-get-started)、[测试](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-test-bot)、[治理](https://learn.microsoft.com/en-us/microsoft-copilot-studio/security-and-governance) | Agent 设计与用户任务分开；测试对话可以定位步骤和参数，测试与正式渠道分别验证；限制在实际接入和发布动作中反馈 |
| [Dify 人工输入](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input)、[运行日志](https://docs.dify.ai/en/cloud/use-dify/monitor/logs) | 人工请求有材料、字段与后续分支；会话和运行分别记录；原输入可回到隔离测试，反馈落到具体步骤 |
| [Dify 固定源码](https://github.com/langgenius/dify/tree/7c24bd02e78c2aa1b664ed0cdc52cab0a95b46bb/web/app/components) | 全局资源与应用内部配置分层，详情入口按类型和 ACL 生成；运行、预览、历史和检查有独立动作 |
| [LangSmith Agent Server](https://docs.langchain.com/langsmith/agent-server)、[Assistants](https://docs.langchain.com/langsmith/assistants)、[鉴权](https://docs.langchain.com/langsmith/auth) | 配置、线程、运行与 Cron 是不同资源；配置有版本；身份与资源/动作授权分开 |
| [AWS AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html)、[可观测性](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html) | 版本、端点、执行会话、入站和外部系统身份分别表达；从聚合异常追到会话和 trace，任务证据另行保存 |
| [OpenHands Conversations](https://docs.openhands.dev/openhands/usage/agent-canvas/conversations)、[Automations](https://docs.openhands.dev/openhands/usage/agent-canvas/managing-automations) | 当前动作靠近会话，资源和上下文渐进展开；触发规则、每次运行与修改权限分开 |
| [GitHub Primer](https://primer.style/product/)、[Linear](https://linear.app/features) | 稳定列表与详情结构，统一图标、色彩、表格和动作；主要页面避免堆架构说明 |

Dify 读取到的完整文件为 `web/app/components/main-nav/routes.ts`、`app-sidebar/app-detail-section.tsx`、`workflow/header/run-and-history.tsx`，固定 SHA 如链接。Agent V2 导航带特性开关，不作为已稳定发行的功能声明；中文概括不是原菜单文案逐字还原。没有复制其实现代码。

本平台保留区别：设备动作不随会话分支或日志调试自动再次执行；审批验证实际人员及当前范围；证据由 B 长期保存；引用与模型反馈不直接升级为产品事实。C 继续沿用已经确认的 PostgreSQL 任务表基线。

文案复核使用 humanizer 的具体化原则：删除日常入口中的架构字母与内部状态术语，动作命名为“委派工作”“补充信息”“批准本次动作”“查看关联现场”等；技术版本和身份留在相关详情。信息结构调整来自上述研究，未用文字润色改变产品边界。
