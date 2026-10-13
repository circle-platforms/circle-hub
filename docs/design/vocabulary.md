# 术语与状态

术语进 F 的契约，中英一一对应；状态一律枚举，固定词和颜色；列表一律是查询。页面因身份不同只改计数，不改结构。

## 术语表

| 术语 | 标识 | 含义 | 不再使用 |
|---|---|---|---|
| 记录 | Record | 对象自己拥有、有 id 前缀和版本的条目 | — |
| 资产 | Asset | 可插拔的东西；kind · version · sha256 · declaration · configuration · lifecycle | 包、插件、配置 |
| 审批策略 | Approval policy | 对象级：哪些动作需要独立审批人 | 变更门 |
| 审批请求 | Approval request · `pin_` | 实例级：一次待决定的申请，绑定三项 | 待批、单子、待办 |
| 决定 | Decision | 审批请求的结果与记录：approved / declined | 批了、驳了 |
| 绑定三项 | Binding · inputRevisionId / targetIdentity / actionDigest | 请求钉住的三个值，任一变化即失效 | 钉住三样 |
| 独立审批人 | Independent reviewer | 申请人以外、在该范围持有 approve 权限的人 | 另一个人、他人 |
| 审批资格 | Eligibility | 当前身份能否对该请求做决定，及原因 | 你能不能批 |
| 平台核验 | Verification | 平台自己算出的事实：工具一致、SHA、派发前重核 | hub 核过的 |
| 申请内容 | Submission | 申请人提交的动作与参数，原样展示，不验证 | 提交者声明的 |
| 证据 | Evidence · `evd_` | 与外界每次交互的原样记录 | 回执、返回 |
| 扩展点 | Extension point | 对象允许插入的接口类型 | 接入 |
| 工作队列 | Work queue | 按当前身份计算的待处理集合 | 待办、等你 |
| 等待原因 | waitingReason | 任务停住的原因，独立字段，不是状态 | 把原因写成状态 |
| 平台约束 | Platform invariant | 平台无条件执行的规则 | hub 强制 |
| 登记簿 | Registry | 对象页：分面 + 计数 + 搜索，不是样本列表 | 列表 |
| 变更集 | Change set | 一次提交的一个或多个资产版本；一次决定，原子生效；引用的资产不重批 | 逐个资产批 |
| 执行链 | Enforcement chain | 运行时平台做的五步：权限 · 绑定 · 核验 · 租约 · 审计。结果只有通过 / 报错 / 未知；没有审批，平台不是审批人 | 运行审批、预授权、异常审批 |
| 运行报错 | Run error · 可证真 | 执行链里脚本能确定的失败，带错误码和事实返回 Circle | 让审批人决定 |
| 结果未知 | Unknown outcome · 如实披露 | 脚本确定不了的结果：披露观察到的一切，不重发；申请人选择核对、标记失败或放弃 | 当成失败或成功 |
| 错误码 | Error code | 可证真失败的固定标识：COMMAND_NOT_IN_TREE · DESTRUCTIVE_COMMAND · BUILD_MISMATCH · GATEWAY_UNREACHABLE · PERMISSION_DENIED · LEASE_UNAVAILABLE · SOURCE_NOT_APPROVED | 自由文本的失败原因 |

## 状态枚举

灰 = 未生效或终态 · 橙 = 等人 · 蓝 = 进行中 · 绿 = 通过 · 红 = 拒绝或异常。

| 字段 | 值 |
|---|---|
| `task.phase` | received · running · waiting-input · waiting-review · delivered · failed · cancelled |
| `approval.status` | open · approved · declined · expired · superseded |
| `asset.lifecycle` | draft · approved · running · retired · declined |
| `operation.status` | queued · claimed · running · succeeded · failed · unknown · reconciled |
| `claim.origin` | script · model（候选用 approval.status，不另造词） |

行里永远是「状态 + 等待原因」：`waiting-input` 加 `waitingReason: gateway-configuration`；不把「等网关配置」写成状态。

## 规模下的处理与显示

任务上千、审批上百、证据上万时仍成立：

1. **列表即查询**：每个列表都是服务端查询 + 分面（范围 · 产品线 · 流程 · 状态 · 负责人 · 年龄）+ 计数 + 游标分页 + 可保存视图。没有「全部」。
2. **队列是首页**：待我审批 / 待我回应 / 我提交的 / 我负责的 / 异常。默认按年龄排序，显示最久和超 SLA。
3. **对象页是登记簿**：左栏是分面与计数，不是样本；详情五格不变。
4. **聚合层级**：租户 → 范围 → 产品线 → 流程 → 任务。概览只显示计数与异常。
5. **异常先行**：unknown、expired、superseded、failed、worker 离线各成一队，带老化时间。
6. **逐条审阅，不批量批准**：每个决定绑定各自摘要；队列提供上一条 / 下一条。
7. **状态是枚举，原因是字段**：筛选只按枚举。
8. **身份只改计数**：管理员、成员看同一页面，结构不变。
9. **审批在变更时，不在运行时**：变更集批一次；运行走执行链，可证真的直接报错，不可证真的如实披露。记录里只写「按规则核验」，不写「hub approved」。

hub 要补的字段：`task.priority · task.assignee · task.dueAt · task.waitingReason · approval.supersededBy · operation.unknownSince · asset.productLineId`，保存视图，变更集，审批策略数据化，执行链错误码与披露格式，通知流。

---

本文是 circle-hub 的设计规范之一，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权：引用、借鉴须署名 Circle Hub 与 qingshanfeihu 并注明原始出处链接。见[设计规范索引](README.md#许可)。
