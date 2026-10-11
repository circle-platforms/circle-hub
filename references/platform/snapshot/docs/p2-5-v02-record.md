# P2-5 完成记录：APV 夹具与 V02 操作纵切

日期：2026-10-10。本记录是 P2 隔离纵切规划 P2-5 的出口证据。执行环境：助手自有计算机本地，夹具为内存模拟设备，**未连接任何真实 APV 或其他设备**；真实设备接入属 OPEN-06（P4 单独授权），本记录不构成任何真实设备证据。

## 1. 交付内容

`packages/apv-fixture`：

- `ApvFixture`：按 SMP-V02-01 实现的模拟设备——示意命令集（session.open / config.read / config.stage / config.commit / config.rollback / session.close）、状态机（no-session → in-session → staged → committed）、配置版本单调递增与历史版本回滚、五个注入点（INJ-APV-1..5，INJ-4 以 stage 的版本校验形态实现）。
- `ApvDriver`：V02 操作驱动——每个设备命令作为平台操作（D）执行；逐回执校验设备身份；commit 回执丢失/中途断连/慢响应一律进 `unknown`，只许回读对账定案且变更记录在对账确认时登记；场景末做清理核验（会话/暂存残留、配置与基线内容比对）。
- `runAllScenarios`：SMP-V02-02 四场景的可执行脚本与逐条期望断言。

平台核心一处增补（本步暴露的缺口）：`OperationService.markUnknown`（回执丢失/断连的 RC-03 入口），并给 `start`/`complete` 加上 unknown 守卫——unknown 只能经 reconcile 离开，此前仅靠状态迁移表无法强制（迁移表本身允许 unknown→succeeded）。平台测试 13/13（含新增用例）。

## 2. 场景实测（执行时验证）

| 场景 | 期望断言 | 结果 |
| --- | --- | --- |
| apv-s1 正常变更全流程 | 10 条（含 stage 不生效、版本只递增一次、回滚内容一致、清理无残留） | 10/10 |
| apv-s2 回执丢失（INJ-APV-1） | 10 条（含进 unknown、对账确认已生效、设备侧变更计数 = 1） | 10/10 |
| apv-s3 版本冲突（INJ-APV-4） | 6 条（conflict-stale 拒绝、设备不变、无暂存残留） | 6/6 |
| apv-s4 身份漂移（INJ-APV-3） | 9 条（检出即停手、后续 commit 被拒、暂存不生效、漂移证据登记、安全断开） | 9/9 |
| 场景外注入 | INJ-APV-2（断连→unknown→对账确认未生效→定案 failed）、INJ-APV-5（慢读→UPSTREAM_TIMEOUT 可重试；慢 commit→unknown→对账确认已生效） | 通过 |
| 清单纵切 | 回执丢失场景挂 V02 完成清单五项（身份/回读/对账/清理/变更记录）后交付成功 | 通过 |

apv-fixture 测试合计 5/5；平台核心回归 13/13。

## 3. 建模口径披露

- INJ-APV-2 的夹具语义是“断连且未生效”的一种确定化建模；被测点在驱动侧（结果不可知 → unknown → 对账），夹具侧真相只用于断言对账结论正确。
- INJ-APV-5 以逻辑延迟值（delayMs）与驱动超时预算比较建模，不使用真实计时器；超时分类（读为 transient 超时、commit 为 unknown）是本步的被测行为。
- 回滚的版本语义：版本号单调递增、内容恢复到目标版本（历史内容拷贝生成新版本），“与基线一致”按内容比对判定。
