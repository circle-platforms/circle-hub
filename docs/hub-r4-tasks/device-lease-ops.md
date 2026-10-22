# 任务：租约的续期和释放（C6）：预订之后的运行按血缘续期或释放

C3 只让投影能“取得”租约。设计稿（`docs/hub-r4-device-pack.md` 第 4 节 C3 和 D04 R[0] 的新句子）要求：预订类租约按血缘持有，以预订运行为前驱的运行可以续期或提前释放同一份租约；否则用户订了台架只能等它自己过期，或者找管理员强制释放。这个任务补上这两个操作。

- 分支和工作树：`hub-lease-ops`，目录 `circle-hub-lease-ops`
- 可以改的路径：`contracts/**`（只通过生成器改生成物）、`hub/leases/**`、`hub/runs/**`（`start.ts` 的接线、`projection.ts`）、`hub/server/**` 里的测试装配、`tests/acceptance/**` 的租约场景（现在的 24 号）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-device-pack.md`（4 节）、`hub/leases/service.ts` 和 README、`hub/runs/engine/start.ts` 里 `grantLeases`/`contextLeases` 和投影的 `lease_requests`、`contracts/src/pack.ts` 里 `lease_requests` 的形状。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 要做的

1. **意图加动作。** `lease_requests` 的每一项加可选的 `op`：`acquire`（默认，现在的行为）、`extend`、`release`。`extend`：`{ op: 'extend', keys, ttl_seconds }`（从现在起再给这么长，受累计上限约束）；`release`：`{ op: 'release', keys }`。合约、生成物、发布校验同步（键仍要在声明的前缀下，`ttl_seconds` 只对 acquire 和 extend 必填）。
2. **按血缘判持有者。** 续期和释放时，Hub 对每个键读出租约行的 `run_id`，要求发起这次运行的用户等于行的 `user_id`，并且这次运行的前驱链（`RunRecord.predecessor` 一路往上，最多 20 层）里有那个 `run_id`；满足才调用服务的 `extend`/`release`（持有者写成行里的那个运行号和用户号）。不满足得到确定的拒绝：错误码 `LEASE_UNAVAILABLE`（不是持有者）或 `LEASE_EXPIRED`（已过期），修正说明写清楚。管理员的强制释放仍走 `lease release` 命令，不走这里。
3. **补偿。** 一次运行里混合了 acquire 和 release 时，后面的失败要把前面已经做的 acquire 补偿释放；release 和 extend 不可逆，所以顺序固定为先做 extend 和 release 的检查（只检查，不动），全部通过再依次执行；执行中途失败的补偿同 C3。写在 README：release 之后运行失败不会把租约放回去。
4. **运行记录。** `RunRecord.leases` 记录这次运行实际做的（acquire 的租约号和键，extend/release 的键和结果），字段加 `op`；动作记录沿用服务已写的 `lease` 动作。
5. **上下文。** 冻结进运行的租约视图的 `mine` 改为“持有者在这次运行的血缘里”（现在是“键是这次运行自己取得的”），续期和释放的投影靠它判断哪些键可以操作。
6. 测试先写：血缘续期成功；换一个无关的用户被拒；同一用户但前驱链里没有持有运行的被拒；已过期的续期被拒；累计上限；提前释放后别人能取得；一次运行里 release 再 acquire 同一台设备（换台架）；链太深（21 层）被拒；acceptance 里加一个场景：运行 A 订台架，运行 B（前驱 A）续期，运行 C（前驱 B）释放，第三人随后订成功。
7. 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=3 "hub/runs/**/*.test.ts" "hub/leases/**/*.test.ts" "hub/records/**/*.test.ts" "hub/server/**/*.test.ts" "hub/platform/**/*.test.ts" "contracts/**/*.test.ts"`；`node --test --test-concurrency=1 "tests/acceptance/*.test.ts"`（不要和别的终端的数据库测试同时跑：macOS 共享内存段只有 32 个，临时 PostgreSQL 会起不来）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
