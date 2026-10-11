# 五条链完成清单构成 V1（OPEN-08 定稿）

日期：2026-10-10。

状态：**已定稿（随 P1 收口，见 ADR 0010）。** 本文件按共同契约 VER-03 与契约包 FZ-08 的清单骨架（`CompletionChecklist`），逐链冻结“交付（delivered）前必须满足的记录集合”。清单条目分五类：`verification`（程序核验）/ `assessment`（语义判断）/ `human-decision`（人工决定）/ `operation-reconcile`（操作对账）/ `artifact-registered`（产物登记）。标注“条件必备”的条目在条件成立时与必备项同等对待；条件不成立时须在清单中显式记为不适用及理由，不得缺项无声。

通用规则（五链共同）：

- 执行成功（操作 `succeeded`）本身不构成任何一条清单项的满足证据。
- 每条 `verification` 必须声明检查范围（scopeNote），范围外的正确性不由该项背书。
- 每条 `assessment` 必须带方法与版本标识；引用证据为空的 supports/refutes 结论不满足条目（FZ-08 已有校验）。
- 清单与某个 `inputRevisionId` 绑定；输入一变，清单作废重开。

## V01 知识问答

| 条目 | 类别 | 必备性 | 满足标准 |
| --- | --- | --- | --- |
| v01-binding | verification | 必备 | 答案所依据的 snapshotId 与运行绑定一致，且引用来源修订都在该快照内 |
| v01-citation | verification | 必备 | 每条引用可解析到来源修订原文，且被引来源未被撤回 |
| v01-support | assessment | 必备 | 每个事实性结论有支持判断（含证据引用），或明确记为 insufficient-evidence 并在答案中如实呈现无答/冲突 |
| v01-conflict-decision | human-decision | 条件必备（存在来源冲突时） | 冲突裁决记录在案，或答案明示冲突未裁决且不给出单一确定值 |
| v01-artifact | artifact-registered | 必备 | 答案产物已登记，绑定回显（快照、来源、问题）完整 |

## V02 APV 设备操作

| 条目 | 类别 | 必备性 | 满足标准 |
| --- | --- | --- | --- |
| v02-identity | verification | 必备 | 操作前后设备身份（序列号/型号/固件）与绑定一致，无漂移未决 |
| v02-readback | verification | 必备 | 变更后读回与意图变更逐项比对一致（或差异有处置记录） |
| v02-reconcile | operation-reconcile | 必备 | 本任务全部非终局操作已对账定案；不存在未决 `unknown` |
| v02-cleanup | verification | 必备 | 会话关闭、租约释放、暂存残留检查通过（EFF 清理核验） |
| v02-approval | human-decision | 条件必备（准入层级为 irreversible-separate 时） | 不可逆变更的单独批准记录在案 |
| v02-artifact | artifact-registered | 必备 | 变更记录产物已登记，含逐步回执与最终配置版本 |

## V03 Web 登录操作

| 条目 | 类别 | 必备性 | 满足标准 |
| --- | --- | --- | --- |
| v03-target | verification | 必备 | 实际访问 origin 与绑定目标一致（防走错站点） |
| v03-outcome | verification | 必备 | 登录结果分类（成功/凭据错误/锁定/MFA 超时等）有页面状态证据支撑，非模型自称 |
| v03-sensitive | human-decision | 条件必备（涉及口令/MFA 输入时恒成立） | 凭据与 MFA 经敏感通道的待输入记录完整，敏感值未进普通记录 |
| v03-session | verification | 必备 | 结束时会话处置已核验：登出确认或残留风险明示 |
| v03-artifact | artifact-registered | 必备 | 操作报告产物已登记，含步骤级证据索引 |

## V04 用例评审

| 条目 | 类别 | 必备性 | 满足标准 |
| --- | --- | --- | --- |
| v04-input | verification | 必备 | 被评审用例集的哈希与绑定一致（评审对象完整、未被调包） |
| v04-findings | assessment | 必备 | 每个评审维度有判断记录（方法/版本/模型标识齐全）；发现项含位置与严重级 |
| v04-signoff | human-decision | 必备 | 评审结论经评审人确认（接受/驳回/修改留痕）；严重级争议有裁决记录 |
| v04-artifact | artifact-registered | 必备 | 评审报告产物已登记并绑定被评审版本 |

## V05 脑图编译为 Excel

| 条目 | 类别 | 必备性 | 满足标准 |
| --- | --- | --- | --- |
| v05-source | verification | 必备 | 输入文件 SHA-256 与绑定一致 |
| v05-coverage | verification | 必备 | IR 节点映射覆盖核对：已映射数 = 应映射数，或未映射清单存在且产物状态为 partial |
| v05-conformance | verification | 必备 | 工作簿往返解析通过，且逐单元格符合 Excel 输出契约 V1 的结构与映射规则 |
| v05-partial-acceptance | human-decision | 条件必备（产物为 partial 时） | 部分交付经人工接受记录在案 |
| v05-artifact | artifact-registered | 必备 | 工作簿产物已登记，含源文件哈希、契约版本与 IR 哈希 |

## 修订规则

本文件为 V1。增删条目或改必备性必须升版本并说明对五条链验收方案的影响；实现中发现条目不可执行时，按纠正记录回本文件修订，不得在执行现场自行豁免。
