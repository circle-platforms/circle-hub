# @infosec/platform

平台核心（对象 C 与 D 的最小实现，P2-1）。契约版本 1.2.0（`@infosec/contracts`）。

- `TaskService`（C）：任务阶段机（FZ-02）、结构化待输入（FZ-09，过期/旧修订响应只记录拒绝、永不推进任务）、完成清单绑定与交付门禁（VER-03：仅 under-review 且必需项全满足才可 delivered；输入修订变更使清单失效）。
- `OperationService`（D）：操作状态机（FZ-02）、ADR 0011 幂等（键 = principal + 操作名 + key，同键比对请求哈希，异哈希 `IDEMPOTENCY_MISMATCH`；去重窗口 24h、结果保留 7d）、租约到期分流（只读操作自动以新 fencing 恢复；副作用操作进 `unknown`，仅显式对账可离开，禁止从 unknown 直接恢复副作用操作）。
- `LeaseManager`：租约（默认 TTL 60s）与每资源单调 fencing token；过期持有者的完成与写入以 `FENCING_STALE` 拒绝。
- `Registry`：证据/产物按 `(tenantId, scopeId)` 硬分区登记与读取（ADR 0012），跨区读取 `FORBIDDEN_SCOPE`。

内存参考实现，时钟与 id 生成可注入（测试确定性）；持久化存储在后续步骤以接口替换，不改变语义。参数基线见 `PLATFORM_PARAMS`（ADR 0011）。

本地验证：`npm install && npm run typecheck && npm test`。
