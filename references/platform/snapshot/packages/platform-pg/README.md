# @infosec/platform-pg

C 的持久核心（P3-1，ADR 0017）：以 PostgreSQL 为业务存储的任务服务。受理是单事务语义——任务行、幂等记录与 outbox 事件同事务提交成功后才算 accepted；所有写操作绑定 `(tenantId, scopeId, taskId, expectedRevision)` 做乐观并发；待输入的陈旧/过期响应被持久记录为拒绝而不推进任务；交付门禁按 C-T01 逐路拒绝（无清单、空清单、无登记引用、签字无角色）；跨 scope 查询与无角色签字按 C-T02 拒绝。另含 outbox 中继（至少一次投递 + 消费侧按 event_id 去重）。

本地验证使用 embedded-postgres 拉起的真实 PostgreSQL 隔离实例（非常驻服务）：`npm install && npm run typecheck && npm test`。连接信息只经环境注入，不入仓。
