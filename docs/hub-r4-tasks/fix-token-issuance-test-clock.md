# 任务：令牌记录测试里失败的记录写入改用测试的时钟

依据：2026-11-09 circle-hub#198 在合并队列里失败。`hub/records/token-issuance.test.ts` 的「a refused or failed change writes no record…」在 main（1100fcb4）上本地也稳定失败，不是偶发。

原因：测试世界的时钟固定在 2026-11-04T08:00Z，邀请在这个时间发出，24 小时有效（`INVITATION_TTL_MS`）。用来模拟记录写入失败的 `PgPrincipals` 用的是真实时钟 `() => new Date()`。真实时间过了 2026-11-05T08:00Z 以后，领取这个邀请时它已过期，领取在写记录之前就被拒绝，所以期望的 `synthetic record failure` 不再出现。main 最后一次通过是 2026-11-05T04:21Z，在过期之前。

做法：`world()` 把它的时钟交出来，写入失败的 `PgPrincipals` 用同一个时钟。产品代码不动。

- 分支和工作树：`fix/token-issuance-test-clock`（目录 `circle-hub-test-clock`），从 main（1100fcb4）开出。
- 可以改的路径：`hub/records/token-issuance.test.ts` 和本页。
- 验证：`node --test hub/records/token-issuance.test.ts`，5 项通过，0 跳过。
