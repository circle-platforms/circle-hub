# P3-1 完成记录：C 持久化（PostgreSQL 事务受理 + C-T01/C-T02）

日期：2026-10-10。本记录是 P3 规划 P3-1 的出口证据。环境：助手自有计算机本地隔离实例（真实 PostgreSQL 18.4 服务器进程，仅监听 127.0.0.1 临时端口），未部署、未接任何外部系统。

## 1. 交付内容

`packages/platform-pg`（`DurableTaskService` + outbox 中继），按 ADR 0017 落地 C 的持久核心：

- **事务受理**：任务行、幂等记录、outbox 事件在同一事务提交成功后才返回 accepted；同键同哈希返回原任务（deduplicated），同键异哈希为 IDEMPOTENCY_MISMATCH。
- **乐观并发**：一切写操作绑定 `(tenantId, scopeId, taskId, expectedRevision)`，修订冲突为 DECISION_CONFLICT；输入修订生成新 revision 并作废已挂清单。
- **待输入**：陈旧/过期响应被持久写入 decisions 表作为拒绝记录，任务不推进（与内存实现的语义一致，现落盘可查）。
- **交付门禁（C-T01）**：无清单、空清单、未登记引用、签字人无 scope 角色，逐路拒绝；`satisfied` 只能由已登记的 verification 引用或有角色的签字支撑。
- **outbox 中继**：至少一次投递，消费侧按 event_id 去重（测试以持久 ledger 证明强制重投不重复计数）。

## 2. 实测（执行时验证，7/7）

- 受理原子性含**真实子进程 SIGKILL**：提交前被杀 → 任务与幂等记录均不存在；提交后被杀 → 任务完好可读。
- C-T01：四条绕过路径全拒（无清单 INPUT_REVISION_STALE、空清单 INVARIANT_VIOLATION、伪造引用 EVIDENCE_INSUFFICIENT、无角色签字 FORBIDDEN_SCOPE），齐备后正常交付。
- C-T02：陈旧决定落盘为 stale-revision 且任务停留在 waiting-input；跨 scope 读取 FORBIDDEN_SCOPE；两写者同修订并发修订输入，恰一成功、另一 DECISION_CONFLICT。
- 重启恢复：新连接池/新服务实例 over 同一数据库，任务与阶段完好；中继强制重投一事件，消费 ledger 不重复计数。
- 平台内存实现回归 13/13（未受影响）。

## 3. 环境与口径披露

- 本机以 root 运行，PostgreSQL 拒绝 root，故测试装置把 `@embedded-postgres/linux-x64`（18.4.0-beta.17）的真实 PG 二进制 staging 到 /tmp、以 postgres 系统用户运行（沙箱 overlay 不允许该用户穿越 home 目录，且 cpSync 会把符号链接绝对化进工作区，装置内已物化处理）；非 root 机器上同一装置直接以当前用户运行。该装置是测试环境安排，不改变“真实 PostgreSQL 服务器”的证据性质；本地实例用 trust 认证仅限 127.0.0.1 临时端口。
- 无角色签字的错误码暂用 FORBIDDEN_SCOPE（冻结错误注册表无专用角色码）；是否在契约 v1.3 增补专用码，留作后续议题，本步不擅自改契约。
- 本步只落 C 的任务核心持久化；OperationService/Registry 的 PG 对应实现不在 P3-1 范围（按讨论稿顺序 C 先行）。durable runner 本步为 outbox 中继基线；C-T03 的完整故障矩阵（杀中继/runner、等待人工时重启）与 C-T04 属 P3-2 选型评估。
