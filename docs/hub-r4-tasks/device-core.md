# 任务：设备管理包要的核心改动（C1 到 C4，一步一报）

设计在 `docs/hub-r4-device-pack.md`（第 4 节是这里的依据），复核在 `docs/hub-r4-device-pack-review.md`。这个任务做核心的四步，每一步自成一个提交，**做完一步就停下来在终端里回报，等监督者验过说“继续”再做下一步**（核心的改动要一步一步验）。

- 分支和工作树：`hub-leases`，目录 `circle-hub-leases`
- 可以改的路径：`contracts/**`（只通过生成器改生成物）、`hub/leases/**`（新建）、`hub/records/**`（只是迁移和动作记录的形状）、`hub/runs/**`（只是 `start_run` 的接线和包发布校验）、`hub/server/**`（只是 C4 的命令和 MCP 工具结果里的租约文字）、`hub/refs/**`（只是 C4 的外部标识）、以及这些目录里的测试和 README。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`docs/hub-r4-device-pack.md`、`docs/hub-r4-device-pack-review.md`（尤其第 2、3、4 节）、`node tools/show-element.ts D04 B05 W06 K05`、`contracts/src/pack.ts`（`CONTEXT_KEY`、`RunContext`、`WorkflowDeclaration`）、`hub/runs/engine/start.ts`（`startFresh`）、`hub/records/pointers.ts`（比较并交换和 `pg_advisory_xact_lock` 的写法）、`hub/records/api.ts`（`ActionBody`）、`hub/server/cli-admin.ts`。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据和临时 PostgreSQL；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。核心代码里不出现设备、台架、产品的词：键只是带前缀的字符串。注意 `hub-nojudge` 和 `hub-engine3` 两个分支也在改 `contracts/model.json` 和生成物（别的元素），合并时由监督者重新生成，你只管自己这几处。

## C1 模型和合约

1. `contracts/model.json`：动作种类的词表轴（`move_root` 所在的那一轴）加一个值“租约”（代码 `lease`，标签“租约”）；D04 R[0] 在“租约按运行持有……”后加一句：“预订类租约按血缘（W06）持有：以预订运行为前驱的运行沿用同一份租约，由 Hub 在派发时核对前驱关系。”并在 D04 的修订记录里写一条（照别的元素的 `changes5` 写法）。
2. `contracts/codes.json` 与 `contracts/src`：加错误码 `LEASE_UNAVAILABLE`（409，租约不可用，带最早空闲时刻）、`LEASE_EXPIRED`（409）、`FENCING_STALE`（409）；先看登记表里协议码和核心违规码的分法，放对地方，每个码带中文说明和修正说明。
3. `contracts/src/pack.ts`：`CONTEXT_KEY` 加 `leases`；`RunContext` 加可选的 `leases`（`{ now, entries: [{ key, until, mine }] }`，不含令牌，不含别人的名字：占用者可见性还没定，先只给 `mine`）；工作流声明加可选的 `leases: { prefix, max_ttl_seconds }`，发布校验要求声明了 `leases` 就必须有 `context: ["leases"]`，`prefix` 以 `/` 结尾；纯函数投影的结果加可选的 `lease_requests: [{ keys, ttl_seconds }]`（先看投影结果现在的形状，选最小的加法，在 README 写明）。
4. `contracts/src/run.ts`：`RunRecord` 加可选的 `leases: [{ lease, keys, until }]`；租约号用 `idOf('lse')`。
5. 动作记录的形状：`lease` 动作的 body：`{ op: acquire|extend|release|force_release|take_over, lease, keys, holder: { user, run }, until, token }`（令牌只在 Hub 自己的动作记录里）。
6. 重新生成：`node tools/gen-contracts.ts`，再 `--check`；测试先写：每个新形状的正反例、发布校验的正反例（有 `leases` 没有 `context`、前缀不以 `/` 结尾、`lease_requests` 的键越出前缀）。
7. 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "contracts/**/*.test.ts" "hub/runs/**/*.test.ts" "hub/records/**/*.test.ts"`。

## C2 租约服务（`hub/leases`）

1. 迁移（新文件，已应用的迁移不改）：表 `leases`：`key text primary key`、`lease_id`、`run_id`、`user_id`、`token bigint`、`acquired_at`、`expires_at`、`released_at null`。
2. `hub/leases/api.ts` 和实现：`acquire({ keys, ttlSeconds, holder: { user, run }, prefix, maxTtlSeconds })`——多个键一个事务，要么全成功、要么全失败；键上有未过期未释放的行 → 不可用（带那行的到期时刻）；有过期或已释放的行 → 一条语句里原子抢占（`UPDATE … WHERE key = $1 AND (expires_at <= now() OR released_at IS NOT NULL) RETURNING`），抢不到按不可用；没有行 → 插入（唯一约束冲突按不可用）。围栏令牌是行上单调递增的数，每次取得或续期加一。`extend`（持有者、未过期、不超累计上限）、`release`（持有者）、`forceRelease`（管理员，要理由）、`view(prefix)`（返回当前未过期未释放的行，供运行上下文）、`reclaimOrphans`（行引用的运行不存在，且取得超过 60 秒，按空闲处理）。过期一律按数据库的时钟（SQL 里的 `now()`）；测试要控制时间，给服务一个可注入的“取现在”的函数，默认走数据库时钟，不要用进程时钟比较。每次变更追加一条 Hub 动作记录（C1 里的 `lease` 种类），和表更新在同一个事务里。
3. 测试（临时 PostgreSQL，先写）：两条连接同时取同一个键恰好一个成功（用 `Promise.all` 和两个连接，循环 50 次）；多键全有或全无（第二个键被占时第一个键不留痕迹）；过期行被原子抢占且令牌加一；释放后别人能取；续期延长到期时刻、过期后续期被拒；累计上限；强制释放留下动作记录和理由；孤儿回收；前缀过滤；重启（新建服务对象）不丢状态；动作记录和表一致（用动作记录重放能重建表）。
4. README：决定、限制、怎么测。

## C3 `start_run` 接线

按设计稿 4 节 C3 的顺序：投影 → 校验 `lease_requests`（键都在声明的前缀下、期限不超 `max_ttl_seconds`、没有声明 `leases` 的工作流返回了 `lease_requests` 一律拒绝）→ `acquire` → 把租约写进 `RunRecord.leases` → 存运行；存运行失败就立刻 `release`（补偿）；取得失败是确定的否定结果，写在运行结果里（`LEASE_UNAVAILABLE`、最早空闲时刻），不是未知，也不是协议错误。`context: ["leases"]` 的冻结：在 `contextBuilds` 旁加 `contextLeases`，按声明的前缀取 `view`，附冻结时刻。用一个测试用的合成工作流包（放在测试夹具里，不进 `packs/`）覆盖：取得成功、同键第二次被拒并带到期时刻、期限越上限被拒、键越前缀被拒、存运行失败时补偿、孤儿。验收级的测试放 `tests/acceptance`，照现有场景的写法，加一个。

## C4 管理员命名文档

1. 迁移：命名指针（名字 → 当前那份源文件的摘要）；先看 `hub/records/pointers.ts` 能不能直接复用（它就是按名字比较并交换的指针），能复用就不要新建表。
2. 命令：`circle-hub doc put <名字> <文件>`（只有管理员；名字 `[a-z][a-z0-9-]{0,63}`；文件上限 2 MiB；经现有源文件管道存，凭据扫描照常；屏幕上只写名字、摘要、大小）、`doc list`、`doc show <名字>`（只写摘要和大小）。非管理员得到和不存在相同的回答。
3. 外部标识 `doc:<名字>`（当前那份）和 `doc:<名字>@<摘要>`（指定那份），由 Hub 内部读取器作答（先看 `knowledge:` 视图是怎么作为外部标识被读取的，照那条路）；运行开始时把摘要冻结进运行；来源类型是“声明”；只有分配了声明用到它的任务包的用户能经运行读到。
4. 测试：存、替换（旧摘要仍可按指定读到）、读当前、读指定、不存在、非管理员、超限、凭据扫描命中、同名并发替换（比较并交换）。

每一步完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。**不要在一步没验过之前做下一步。**
