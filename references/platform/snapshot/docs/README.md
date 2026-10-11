# 项目说明从哪里读起

当前先读[Circle 与 circle-server 怎样一起开发和发布](circle-server-plan.md)：用户通过 Circle 默认插件连接，管理运维归 server，插件不单独建项目；共同代码同步与两条发布线共同管理。分工见 [ADR 0028](decisions/0028-circle-server-split.md)，下列前端组合保留其历史验证范围。

最新前端提供[插件组合与 Circle 接入设计](design/pluggable-workbench.md)，可以切换基础工作台和完整平台组件。[本轮检查](validation/workbench-plugins-20261011.md)记录实际结果。

先读[平台怎样工作](product-framework.md)，了解用户给出一个目标后，平台怎样查资料、操作、检查和交付。再读[项目里各部分做什么](project-explanation.md)，了解现有代码的作用和限制。

接入不同产品时，看[产品和方法怎样接入](design/product-capability-composition.md)。需要调整代码分工时，看[代码怎样分工](design/module-map.md)。要写新设计，可以使用[写设计的方法](engineering/design-standard.md)和[工作模板](templates/README.md)。

检查结果和支持范围见[怎样检查与交付](engineering/validation-and-delivery.md)。下一步要做的工作在[GitHub 任务索引](engineering/github-work-items.md)，日常组织方式见[GitHub 和文档怎样配合](engineering/repository-governance.md)。

需要查具体函数时，再看[函数说明目录](reference/README.md)。各页先解释用途，代码位置和原始签名收在可展开的核对资料里。

已开始实现[前端工作台](../packages/workbench-ui/README.md)，先通过 Web 检查布局和交互，验证范围见[本轮记录](validation/workbench-ui-20261010.md)。长期入口方向仍是桌面优先，见[ZCode 源码研究与桌面框架](research/zcode-desktop-framework.md)。具体复用范围尚未定案，当前没有运行中的新桌面客户端。

查看实际前端后，可对照[五种 Harness 界面方案](design/harness-interface-alternatives.md)及其[交互稿](../demo/harness-concepts/README.md)，旧工作台已被否定；再看[产品阶段](implementation-roadmap.md)和[敏捷流程](engineering/agile-product-process.md)讨论实施。人员权限见[安全划分](design/identity-and-security-boundaries.md)，各对象怎样观察维护见[Web 工作空间](design/web-workspace-and-operations.md)。

<details>
<summary>查阅既有的设计决定、实施计划和执行记录</summary>

## 产品与平台设计

| 文档 | 内容 |
|---|---|
| [C/D/E 实现讨论 V1](cde-implementation-discussion-v1.md) | 当前设计/代码边界检查，任务治理、执行资源、专业能力的实现提案与待执行复现计划 |
| [操作可见性计划 V1](operator-visibility-plan-v1.md) | 实际浏览器/终端实时显示、Otty 并排/Chrome 外部查看、同会话暂停接管与待执行验收 |
| [SSH 职责计划 V1](ssh-responsibility-plan-v1.md) | SSH 连接、输出流、终端展示、授权/控制接管、产品规则与证据的逐项归属 |
| [用户交互与对象通信 V1](user-interaction-and-object-communication-v1.md) | 四种用户入口、A–E 请求/返回路径、持久调用/实时流和用户干预的提案 |
| [知识库 V1 基线](knowledge-v1.md) | 数据模型、程序/模型分工、索引、查询、发布和验收 |
| [目标与范围](vision.md) | 产品定位、全生命周期场景与差异化目标 |
| [架构提案](architecture.md) | 可替换入口、任务治理、知识服务、执行资源、产品能力的关系 |
| [运行对象 V1](object-boundaries-v1.md) | 五类运行职责与两类横切工程，状态和规则的权威边界 |
| [可替换 harness 适配计划](harness-adaptation-plan.md) | Circle/Pi/OpenCode 的当前差异、四类平台对象共同契约与接管实验 |
| [五条基础链与全功能迁移计划](foundation-validation-plan.md) | 知识问答、APV、Web、评审、脑图→Excel 的验收和完整覆盖条件 |
| [A–E 共同契约 V1](common-contracts-v1.md) | 身份、结构化 IO、版本绑定、权限、副作用、失败/未知、重试取消、长任务与跨 harness 接管的编号条款（已接受为基线） |
| [五条链验收方案 V1](five-chain-acceptance-v1.md) | 五链验收基线；已有记录不代表全部条目通过 |
| [验证矩阵与实施顺序 V1](validation-matrix-v1.md) | 契约×功能链矩阵、分层状态和 P0–P5 门禁；保留未执行项 |
| [Excel 输出契约与脑图格式范围 V1](excel-mindmap-contract-v1.md) | V05 的 IR、工作簿结构与映射规则（结构层已冻结；XMind 版本范围延后） |
| [五条链完成清单构成 V1](completion-checklists-v1.md) | OPEN-08 定稿：逐链冻结交付前必须满足的记录集合（已定稿） |
| [能力与扩展边界](capabilities.md) | skill、tool、MCP、resource、hook、验证器如何分工 |
| [长任务、操作与协作](execution.md) | 持续执行、恢复、资源归属、Web/CLI 和多角色协作 |
| [知识与证据](knowledge.md) | 文档、版本、能力、事实和经验如何区分与关联 |
| [重写与验证](validation.md) | 全 TS 重写的行为对照、故障实验和验收方法 |

## 讨论与决定

| 文档 | 内容 |
|---|---|
| [讨论议程](discussion/topics.md) | 接下来逐项讨论的主题、问题与应形成的决定 |
| [设备交互范围修订](decisions/0021-ssh-web-interaction-scope.md) | SSH 与 Web 的当前范围；本轮仍只讨论和计划 |
| [操作可见性需求决定](decisions/0014-operator-visibility.md) | 用户明确的全过程可见与两种布局；组件和接管仍是提案 |
| [本次讨论记录](discussion/2026-10-10.md) | 用户意图、纠正、命名和范围的演进 |
| [方向决策](decisions/0001-project-direction.md) | 已确认的边界与尚未决定的事项 |
| [知识范围决策](decisions/0002-product-knowledge-scope.md) | 全产品知识范围与 CLI/footprint 的定位 |
| [知识库设计决策](decisions/0003-knowledge-v1-baseline.md) | 本轮收敛的基线与后续实现参数 |
| [归属决策](decisions/0004-runtime-object-boundaries.md) | 原五类对象的重新划分与后续契约方向 |
| [本轮范围决策](decisions/0005-harness-neutral-planning.md) | Harness 可替换、禁止复用旧代码、本轮仅做计划 |
| [第一阶段收口决策](decisions/0006-phase1-design-closure.md) | 本轮收口范围、产物、沿用决定与 OPEN 待定清单（已接受） |
| [Wire 基线决策](decisions/0007-wire-and-tasks-baseline.md) | OPEN-01 定案：最低基线（普通 tools + CLI 六调用）+ Tasks/媒体增强可选（已定案） |
| [脑图与 Excel 范围决策](decisions/0008-mindmap-and-excel-scope.md) | OPEN-05 定案：以 XMind 为原生格式唯一候选推进，版本与字段待样本探针后冻结（已定案） |
| [Cancelled 状态决策](decisions/0009-cancelled-status.md) | OPEN-09 定案：ResponseStatus 增补 cancelled，契约升 v1.1（已定案） |
| [P1 收口决策](decisions/0010-p1-closing.md) | P1 收口结论与门禁裁定（已通过，P1 收口） |
| [全产品线范围决定](decisions/0010-product-line-scope.md) | 负载均衡是抽象基础，平台覆盖 InfoSec 全产品线 |
| [幂等与租约决策](decisions/0011-idempotency-and-lease.md) | OPEN-02 定案：去重窗口/结果保留/租约参数基线（已定案） |
| [租户与 scope 决策](decisions/0012-tenant-and-scope.md) | OPEN-03 定案：单租户先行、scope 硬分区与角色集（已定案） |
| [语义判断决策](decisions/0013-semantic-assessment.md) | OPEN-04 定案：接口化形态、校准门槛与弃权规则（已定案） |
| [P2 收口决策](decisions/0015-p2-closing.md) | P2 收口结论与门禁裁定（已通过，P2 收口；编号说明见正文） |
| [持久运行评估决策](decisions/0016-durable-runtime-evaluation.md) | DEC-P3-01 定案：优先评估 Temporal TS，以 C-T03/C-T04 对比后另行定案（已定案） |
| [持久存储基线决策](decisions/0017-postgresql-baseline.md) | DEC-P3-02 定案：业务持久存储统一 PostgreSQL 基线（已定案） |
| [Harness 接入决策](decisions/0018-harness-integration-order.md) | DEC-P3-03 定案：接入顺序、版本固定、协商记录与 R06 序列（已定案） |
| [可见性并轨决策](decisions/0019-visibility-parallel-track.md) | DEC-P3-05 定案：可见性为并行轨道，P3 只含两项接口工作（已定案） |
| [执行控制面决策](decisions/0020-execution-control-plane.md) | DEC-P3-06 定案：统一控制面 + 隔离 workers，Browser 优先评估 Playwright（已定案） |
| [持久运行选型决策](decisions/0022-durable-runtime-selection.md) | P3-2 选型定案：采用 PostgreSQL 任务表路线为持久运行基线，Temporal 保留为备选（已定案） |
| [模型与 gateway 选型](decisions/0026-model-channel.md) | DEC-P3-04 定案：阿里云百炼 Token Plan（Anthropic 兼容端点）+ qwen3.8-flash，密钥经保险库连接器（已定案） |

## 实施计划与验证记录

| 文档 | 内容 |
|---|---|
| [P1 契约与样本冻结计划](p1-contract-sample-plan.md) | P1 的冻结对象、样本清单、OPEN-01/05 定案与门禁（已完成，门禁通过） |
| [P1 收口评审](p1-closing-review.md) | P1 门禁条件逐项核对与延后登记（已裁定通过） |
| [P2 隔离纵切规划](p2-vertical-slice-plan.md) | P2 的包结构、逐链纵切步骤与红线（已定案） |
| [P2-1 平台核心记录](p2-1-platform-record.md) | 内存 C/D 核心与契约 v1.2 的历史本地验证；不含持久化/并发安全保证 |
| [P2-2 V05 结构纵切记录](p2-2-v05-record.md) | 主题树/content.json 到工作簿的结构层范围与历史验证 |
| [P2-3 V01 纵切记录](p2-3-v01-record.md) | 最小知识问答与 scripted 校准；不证明真实模型质量 |
| [P2-4 V04 纵切记录](p2-4-v04-record.md) | 四个声明维度的规则式评审与签字流；不证明通用语义评审质量 |
| [P2-5 V02 夹具记录](p2-5-v02-record.md) | APV 内存模拟、逻辑延迟和回读对账；不证明真实协议/设备或进程故障恢复 |
| [P2-6 V03 HTTP 记录](p2-6-v03-record.md) | 本地 HTTP 登录/MFA/会话分类；不证明浏览器操作、视觉质量或实时显示 |
| [P2 收口评审](p2-closing-review.md) | P2 门禁逐项核对、L2 逐链范围标注与延后登记（已裁定通过） |
| [P3 实施规划](p3-implementation-plan.md) | 真实 harness 接入、持久化与语义质量的步骤与门禁（已定案；DEC-P3-04 待模型通道） |
| [P3-2 持久运行选型评估记录](p3-2-runtime-evaluation-record.md) | C-T03/C-T04 两路线对比（9/9 场景）：恢复、重复作用、升级语义与运维面；选型见 ADR 0022（已定案） |
| [P3-3 执行控制面记录](p3-3-execution-record.md) | D 控制面 + process/browser workers：D-T01/02/03/05、D-T04 浏览器部分与进程级 R02 回执（已完成） |
| [P3-4 三家 harness 薄适配记录](p3-4-harness-record.md) | OpenCode/Circle/Pi 薄适配：协商记录（均 2025-11-25）、R06 接管、R07 信封配对与三方差异清单（已完成） |
| [P3-5 真实模型 L4 评测计划](p3-5-evaluation-plan.md) | 冻结版 v1：qwen3.8-flash 评测 V01/V04 + V03 视觉试点，预算上限 120 次调用 / 150 万 token（已运行） |
| [P3-5 真实模型 L4 评测记录](p3-5-l4-record.md) | qwen3.8-flash 单遍评测：V01 一致率 100% 通过；V04 严格一致率 75% 未达 ≥90% 门槛（D-03 严重度分歧）；V03 试点 3/4；全轮 18 次调用 / 18,201 token（已完成） |

## 研究与来源

| 文档 | 内容 |
|---|---|
| [完整项目盘点](research/project-capability-audit.md) | 13 个仓库、403 条能力映射、具体拆分裁决与来源检查 |
| [逐项归属 CSV](research/inventory/capability-catalog.csv) | 可筛选的工具、MCP、接口、skills、hooks 和主要模块清单 |
| [同类项目经验](research/comparable-platforms.md) | OpenHands、Backstage、Nautobot、NetBox、Temporal、Playwright 等的经验与边界 |
| [已有工程调研](research/existing-systems.md) | 已检查的源码基线、经验和适用边界 |
| [知识主机盘点](research/knowledge-inventory.md) | 本次 SSH 只读观察的脱敏记录 |
| [外部参考](research/external-references.md) | 联网调研来源与可借鉴的设计 |

## 模块、组合与工程工作

[模块地图](design/module-map.md)、[多产品验证与交付](engineering/validation-and-delivery.md)、[函数契约草案](design/critical-interface-contracts.md)、[全部模板](templates/README.md)和后续 [P3-1 记录](p3-1-persistence-record.md)。

</details>
