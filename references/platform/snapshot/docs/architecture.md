# 平台架构与职责入口

2026-10-11 最新分工：Circle 保留通用 harness，默认插件库提供可选 server 连接插件；circle-server 持有 B/C/D/E 并提供自己的管理运维入口，不单独建设 Web 管理站点。共同代码、两条发布线与 GitHub 联动见[双产品计划](circle-server-plan.md)和 [ADR 0028](decisions/0028-circle-server-split.md)。下列职责与既有基线继续有效，具体派生范围未实施。

产品总框架见[产品框架](product-framework.md)，多产品/能力/任务组合见[组合设计](design/product-capability-composition.md)。本页继续定义 A–E 的运行职责；模块/函数设计遵循[设计规范](engineering/design-standard.md)，源码声明与当前缺口见[接口目录](reference/README.md)。

状态：知识库 V1、运行对象 V1 与共同契约已形成设计基线；已有 P1/P2 契约和最小参考实现记录。具体进程边界、持久化框架与部署继续逐项确定，不能据此声称完整平台已实现。

本轮仅做调研和计划，见 [ADR 0005](decisions/0005-harness-neutral-planning.md)。Circle 为可替换通用 harness，Pi/OpenCode 等也可承担 A；B/C/D/E 不依赖 Circle 的内部状态或事件语义。

本轮讨论 C/D/E，Circle 核心与知识库不展开。用户选 **C 优先评估 Temporal TS**；采用与版本仍未定案。当前设计检查、C/D/E 模块提案和待执行复现见 [C/D/E 实现讨论 V1](cde-implementation-discussion-v1.md)。用户后续要求实际 Web 全过程可见，A 的薄展示/会话关联契约进入讨论：Otty 并排或外部 Chrome 打开同一执行会话查看页，D 持有真实浏览器/终端，C 管授权与控制交接。见 [ADR 0014](decisions/0014-operator-visibility.md)与[可见性计划](operator-visibility-plan-v1.md)；未改 Circle 或部署显示服务。

设备管理通道采用 SSH 与 Web，实时可见性要求保留。细化归属见 [SSH 职责计划](ssh-responsibility-plan-v1.md)：A 是查看页/终端 UI，D 是会话/输出后端与真实输入控制者，C 是授权和接管决定，E 是产品命令/模式/判据，B 是资料与证据。共享身份/流格式属 F，回归属 G；均不新增运行对象。

用户交互和对象通信详见[讨论稿](user-interaction-and-object-communication-v1.md)：A 接收目标/回应并呈现真实操作，C 管任务与决定，D 管实际输入/输出，E 返回版本化方法/核验，B 提供原件与记录引用。短请求、持久工作和事件/实时流分别处理；模块可同进程，对象不直接写其他拥有者状态。范围以 [ADR 0021](decisions/0021-ssh-web-interaction-scope.md)为准，通信实现尚未冻结。

平台覆盖 InfoSec 全产品线，以负载均衡工程实践建立首批通用抽象。A–E 的职责和共享契约不限定某一产品线；各产品的命令、资源语义与判据由 E 的能力包、D 的执行适配器和 B 的知识模型扩展表达，见 [ADR 0010](decisions/0010-product-line-scope.md)。

## 当前基线

- [运行对象与能力归属 V1](object-boundaries-v1.md)：五类运行职责 A–E、共享契约 F 与评测 G。
- [知识库 V1](knowledge-v1.md)：B 的六类知识记录、查询、存储与发布。
- [项目能力盘点](research/project-capability-audit.md)：13 个仓库、403 条静态映射与来源校验。
- [共同契约 V1](common-contracts-v1.md)与 [P2 纵切计划](p2-vertical-slice-plan.md)：已接受契约、已有实现记录与未完成范围。

## 五类运行职责

| ID | 对象 | 主责 |
|---|---|---|
| A | 入口与 Agent 运行 | 可替换 Circle/Pi/OpenCode 等 harness、Web/消息入口、会话、推理、上下文和技能加载 |
| B | 产品知识、证据与制品 | 原件、声明与关系、检索、快照、产物身份与版本 |
| C | 任务与协作治理 | 长期目标、阶段、协作/交接、人工决定、身份政策与完成准入 |
| D | 操作执行与资源 | 设备/浏览器/外部系统/工作区操作、真实进程/连接、租约与回执 |
| E | 能力包与业务规则 | Skills、专业算法、编译、判据、报告和业务流程模板 |

F 为共用类型/协议/基础库，G 为回归/评测/实验，属于横切工程。库和验证器的职责由实际检查对象决定。

一个用户工具、CLI 或 MCP facade 可以跨这些对象；内部状态与真实作用必须分别持有。这是逻辑职责，不要求立即拆成五个或七个服务。

## 对原提案的调整

原“新 TS 平台服务”分清知识 B 和任务 C；原“共享契约与评测工程”分清 F/G 并退出运行对象层；原产品扩展按 E 的规则、F 的契约、A 的接入和 D 的实际操作拆职责。

旧五类提案和演进背景见[ADR 0004](decisions/0004-runtime-object-boundaries.md)。知识库的六类数据记录与运行对象五类是不同维度。

## 仍需逐项确定

- circle-server 内部模块、服务/进程、共同代码来源与不同 harness 的接入接口；两端的产品分工已经明确。
- C 的持久任务、调度历史与业务状态权威、修订/并发、人工响应和完成引用核验；内存阶段机不能代替持久恢复。
- D 的执行控制面、隔离 workers、强制写出口、实际取消/对账和残留核验。
- E 的 skill/程序/schema/规则与版本清单、专业 IR、领域完成策略和模板；当前脑图结构编译不能代替专业编译。
- C/D 的存储、队列与部署参数；身份/scope 和幂等/租约数值沿用 ADR 0011/0012，不重新默默定案。
- Web/消息入口、CI/发布连接器、运维与切换方案。

所有相关非 Circle 自研代码用 TS 新建。旧系统是经验、资料与行为参考，不是新生产实现的 Python 依赖。

后续讨论以[harness 适配计划](harness-adaptation-plan.md)和[基础验证计划](foundation-validation-plan.md)为依据；本轮不创建业务工程或运行实验。
