# handoff 到设计文档的对照表

[客户端接口交接](../client-api-handoff.md)与[执行交接](../case-execution-handoff.md)里的规则已并入 docs/design 的对应文档；本表给出每一段的去处，供把两份 handoff 裁剪为变更记录时对照。右列「不搬」的段落是实现记录、验收数字或产品连接器契约，设计文档不收。

## client-api-handoff.md

| handoff 段落 | 并入 |
|---|---|
| 标题与首段（协议原件与版本） | 实现指针，不搬 |
| [启动和登录](../client-api-handoff.md#启动和登录) | 身份与令牌规则 → [roles.md#会话与令牌](roles.md#会话与令牌)；dev:stack 与 HTTPS 启动细节是运行手册，不搬 |
| [通用信封](../client-api-handoff.md#通用信封) | [circle-integration.md#接口的共同形状](circle-integration.md#接口的共同形状) |
| [普通用户只读接口](../client-api-handoff.md#普通用户只读接口) | [circle-integration.md#任务与审批的读取投影](circle-integration.md#任务与审批的读取投影)；分页契约 → [vocabulary.md#列表即查询的契约](vocabulary.md#列表即查询的契约) |
| [编译调用顺序](../client-api-handoff.md#编译调用顺序) | 调用教程不搬；其中：幂等与受理事务 → [circle-integration.md#接口的共同形状](circle-integration.md#接口的共同形状)；下载再验 SHA → [object-standard.md#四b-的原件与证据规则](object-standard.md#四b-的原件与证据规则) |
| [状态、事件和交付](../client-api-handoff.md#状态、事件和交付) | 游标纪律与取消语义 → [circle-integration.md#事件补读](circle-integration.md#事件补读)；delivered 后仍看 result.status、unknown 不重派 → [approvals-and-enforcement.md#未知的纪律](approvals-and-enforcement.md#未知的纪律) |
| [补充或更换输入](../client-api-handoff.md#补充或更换输入) | [approvals-and-enforcement.md#只有一个审批概念变更集](approvals-and-enforcement.md#只有一个审批概念变更集)（输入修订条） |
| 当前验收与下一次组合验收 | 实现记录，不搬 |
| [第二阶段：工具目录](../client-api-handoff.md#第二阶段工具目录) | [circle-integration.md#工具目录与调用](circle-integration.md#工具目录与调用)；失败分类收敛 → [approvals-and-enforcement.md#来源失败的分类](approvals-and-enforcement.md#来源失败的分类) |
| [脑图知识工具](../client-api-handoff.md#脑图知识工具) | 分页与覆盖的诚实规则 → [vocabulary.md#列表即查询的契约](vocabulary.md#列表即查询的契约)；知识异步入库 → [object-standard.md#四b-的原件与证据规则](object-standard.md#四b-的原件与证据规则)；逐工具字段表是产品连接器契约，不搬 |
| [第二阶段：技能包约定与 RPC 边界](../client-api-handoff.md#第二阶段技能包约定与-rpc-边界) | 登记契约 → [product-line-pack.md#技能包与模块的登记契约](product-line-pack.md#技能包与模块的登记契约)；运行边界 → [harness-primitives.md#七每种原语的契约](harness-primitives.md#七每种原语的契约)（Skill 执行条）；run token → [approvals-and-enforcement.md#凭据与资源](approvals-and-enforcement.md#凭据与资源) |
| [通用外部来源制品](../client-api-handoff.md#通用外部来源制品) | [object-standard.md#四b-的原件与证据规则](object-standard.md#四b-的原件与证据规则)；待批可见性 → [approvals-and-enforcement.md#只有一个审批概念变更集](approvals-and-enforcement.md#只有一个审批概念变更集) |
| [通用 OAuth 凭据登记](../client-api-handoff.md#通用-oauth-凭据登记) | [approvals-and-enforcement.md#凭据与资源](approvals-and-enforcement.md#凭据与资源) |
| [第二阶段：触发、整理与 Circle 渠道](../client-api-handoff.md#第二阶段触发整理与-circle-渠道) | [circle-integration.md#触发与-bot](circle-integration.md#触发与-bot)；回报拒绝原子回滚 → [object-standard.md#四b-的原件与证据规则](object-standard.md#四b-的原件与证据规则)；knowledge-consolidation 技能契约是产品内容，不搬 |
| [第二阶段：工作列表过滤与续页](../client-api-handoff.md#第二阶段工作列表过滤与续页) | [vocabulary.md#列表即查询的契约](vocabulary.md#列表即查询的契约) |
| [产品线安装与工具别名](../client-api-handoff.md#产品线安装与工具别名) | 别名解析与隐藏规则 → [circle-integration.md#工具目录与调用](circle-integration.md#工具目录与调用)；安装 JSON 的路径约定是运行配置，不搬 |
| [修订 3：人的范围角色与审批资格](../client-api-handoff.md#修订-3人的范围角色与审批资格) | [roles.md#角色登记与资格披露](roles.md#角色登记与资格披露) |
| [修订 3：变更集与依赖核验](../client-api-handoff.md#修订-3变更集与依赖核验) | [approvals-and-enforcement.md#只有一个审批概念变更集](approvals-and-enforcement.md#只有一个审批概念变更集)；摘要公式是实现细节，不搬 |
| [修订 3：Skill、Tool、MCP server 与 Hook 的执行绑定](../client-api-handoff.md#修订-3skilltoolmcp-server-与-hook-的执行绑定) | Hook subject 与主机策略 → [harness-primitives.md#七每种原语的契约](harness-primitives.md#七每种原语的契约)；executionIsChange 一次消费 → [approvals-and-enforcement.md#生产设备要两人规则怎么办](approvals-and-enforcement.md#生产设备要两人规则怎么办)；waiting-input 与床构建观测 → [approvals-and-enforcement.md#执行链在设备执行上的固定规则](approvals-and-enforcement.md#执行链在设备执行上的固定规则) |
| [修订 3：开发会话寿命与吊销](../client-api-handoff.md#修订-3开发会话寿命与吊销) | [roles.md#会话与令牌](roles.md#会话与令牌) |
| [修订 3：凭据模式、隔离与明确的明文例外](../client-api-handoff.md#修订-3凭据模式隔离与明确的明文例外) | [approvals-and-enforcement.md#凭据与资源](approvals-and-enforcement.md#凭据与资源) |
| [读取超时与大原件回报](../client-api-handoff.md#读取超时与大原件回报) | [approvals-and-enforcement.md#读取的超时](approvals-and-enforcement.md#读取的超时)；回报形状 → [object-standard.md#四b-的原件与证据规则](object-standard.md#四b-的原件与证据规则) |
| [审计补充：角色、Hook 形状与模型凭据](../client-api-handoff.md#审计补充角色hook-形状与模型凭据) | 凭据 provider 的角色下限 → [roles.md#角色登记与资格披露](roles.md#角色登记与资格披露)；Hook 形状 → [harness-primitives.md#七每种原语的契约](harness-primitives.md#七每种原语的契约)；模型代理与出口掩码 → [approvals-and-enforcement.md#凭据与资源](approvals-and-enforcement.md#凭据与资源)；APV 验收提交号是实现记录，不搬 |
| [读结果与治理内容补充](../client-api-handoff.md#读结果与治理内容补充) | 脱敏与原件可核对 → [object-standard.md#四b-的原件与证据规则](object-standard.md#四b-的原件与证据规则)；技能候选只读视图 → [approvals-and-enforcement.md#只有一个审批概念变更集](approvals-and-enforcement.md#只有一个审批概念变更集)（待批可见性）；gateway.health/topology 与 supervisor 日志是产品契约与运维细节，不搬 |
| [修订 3 第 6 节：通知流与工作队列](../client-api-handoff.md#修订-3-第-6-节通知流与工作队列) | [circle-integration.md#通知流与工作队列](circle-integration.md#通知流与工作队列) |
| [修订 3 第 8 节：列表即查询](../client-api-handoff.md#修订-3-第-8-节列表即查询) | [vocabulary.md#列表即查询的契约](vocabulary.md#列表即查询的契约) |
| [修订 3 第 9 节：中立原语与 MCP](../client-api-handoff.md#修订-3-第-9-节中立原语与-mcp) | [harness-primitives.md#三适配器导入和导出](harness-primitives.md#三适配器导入和导出)、[#四通用传输hub-自己是一个-mcp-server](harness-primitives.md#四通用传输hub-自己是一个-mcp-server)；迁移补偿的逐条历史是实现记录，不搬；worker 排空 → [approvals-and-enforcement.md#凭据与资源](approvals-and-enforcement.md#凭据与资源)；worker 离线阈值 → [circle-integration.md#通知流与工作队列](circle-integration.md#通知流与工作队列)；派发前拒绝 → 见该 handoff 末节 |
| [派发前拒绝与两次环境观察](../client-api-handoff.md#派发前拒绝与两次环境观察) | [approvals-and-enforcement.md#派发前拒绝与远端租约](approvals-and-enforcement.md#派发前拒绝与远端租约)、[#派发与两次环境观察](approvals-and-enforcement.md#派发与两次环境观察) |
| 权限导出（permission-export 段） | 设计文档已存在：[permission-export.md](permission-export.md) |

## case-execution-handoff.md

该文无小节标题，左列用各段首句。

| handoff 段落首句 | 并入 |
|---|---|
| 「能力包 `apv-case-execute/1.1.1` 使用既有 sources、submit……」 | 版本与部署记录不搬；执行默认不审批 → [approvals-and-enforcement.md#生产设备要两人规则怎么办](approvals-and-enforcement.md#生产设备要两人规则怎么办)；实现升版重新登记 → [product-line-pack.md#技能包与模块的登记契约](product-line-pack.md#技能包与模块的登记契约) |
| 「先上传 `case.xlsx`，或引用当前身份可读的编译 artifact……」 | 提交体教程不搬；字面关口的通用规则 → [approvals-and-enforcement.md#核验](approvals-and-enforcement.md#核验)；APV 字面闭集留在 handoff（产品契约），随执行流迁入 products/apv 时再搬 |
| 「命令核对也可绑定通用外部来源制品……」 | [object-standard.md#四b-的原件与证据规则](object-standard.md#四b-的原件与证据规则)；声明数据不当作事实同节 |
| 「本版执行关口支持 APV_n/Segn_tmp 的字面……」（含 test_env、主机策略、错误定位段） | 通用规则 → [approvals-and-enforcement.md#核验](approvals-and-enforcement.md#核验)；APV 字面闭集与主机名闭集留在 handoff（产品契约），随执行流迁入 products/apv 时再搬 |
| 「人的授权由范围角色及 Tool minimumRole 决定……」 | [roles.md#角色登记与资格披露](roles.md#角色登记与资格披露)；SHA 一路再核对 → [object-standard.md#四b-的原件与证据规则](object-standard.md#四b-的原件与证据规则) |
| 「任务先进入 cases.verify……」（含审批记录与投递前复核两段） | [approvals-and-enforcement.md#核验](approvals-and-enforcement.md#核验)、[#派发与两次环境观察](approvals-and-enforcement.md#派发与两次环境观察)、[#运行时没有审批只有执行链](approvals-and-enforcement.md#运行时没有审批只有执行链)（派发前重核段） |
| 「运行时配置都在仓库外……」（含凭据轮换与重新登录两段） | [approvals-and-enforcement.md#凭据与资源](approvals-and-enforcement.md#凭据与资源)；issuer 历史更正是实现记录，不搬 |
| 「事件包含 execution.commands.rechecked……」（含检查点判定段） | [approvals-and-enforcement.md#设备归属与日志解析](approvals-and-enforcement.md#设备归属与日志解析) |
| 「超时、lost、worker 断开或投递后取消转 unknown……」（含派发前拒绝段） | [approvals-and-enforcement.md#未知的纪律](approvals-and-enforcement.md#未知的纪律)、[#派发前拒绝与远端租约](approvals-and-enforcement.md#派发前拒绝与远端租约) |
| 「execution.environment.observed 只表示……」 | [approvals-and-enforcement.md#派发与两次环境观察](approvals-and-enforcement.md#派发与两次环境观察)、[#设备归属与日志解析](approvals-and-enforcement.md#设备归属与日志解析) |
| 「当前只完成合成网关验收……」 | 验收状态记录，不搬 |
| 「修订 3 的 static-secret 模式与明确的 HTTP 资料源例外……」 | [approvals-and-enforcement.md#凭据与资源](approvals-and-enforcement.md#凭据与资源) |
| 「设备归属来源更正（1.1.1）……」 | 通用归属规则 → [approvals-and-enforcement.md#设备归属与日志解析](approvals-and-enforcement.md#设备归属与日志解析)；APV_n 命名规则留在 handoff（产品契约），随执行流迁入 products/apv 时再搬 |
| 「dev-stack 的排空是合作式……」 | [approvals-and-enforcement.md#凭据与资源](approvals-and-enforcement.md#凭据与资源)（worker 排空条） |
| 「conf.device_names 的边界……」 | 通用归属规则 → [approvals-and-enforcement.md#设备归属与日志解析](approvals-and-enforcement.md#设备归属与日志解析)；APV_n 命名规则留在 handoff（产品契约），随执行流迁入 products/apv 时再搬 |

---

本文是 circle-hub 的工作文档（交接裁剪对照），不是设计规范；按 [Apache License 2.0](../../LICENSE) 授权。
