# 任务：台架归登记它的用户；预订没有时长限额，由运行持有到释放

依据：

- 决定 35 第 14 项（所有者 10-23 晚：谁的环境就是谁登记的）：设备归登记它的用户。设备的主人看得到谁占着，也能释放；别的用户看得到“被占用”，看不到是谁。
- 第 15 项（所有者 10-23 晚，更正以前的默认值）：不要预约时长的限额；租约只在运行期间持有；用户读得到哪套台架正被哪个运行占用。
  - 第 14 项原话里的“占到几点”，到第 15 项以后没有固定的时刻。显示的是：从几点起、被哪个运行占着，到它的谱系释放为止。
- 第 13、16 项：D04 R[0] 的修订（预订类租约按血缘持有）确认。
- 决定 35 上机第 2 问：台架清单是管理员发布的部署数据（`circle-hub doc put bed-topology`）。所以这里的“登记”只记归属：用户把清单里自己的台架登记到自己名下，清单的内容照旧由管理员发布。用户自己上传清单不在这一件里。
- `hub-device-run.md` 第 1 条：每个用例自己一条谱系，作业有终态以后释放，下一个用例再占，脚本里不写任何时长上限。这一件给它提供核心的做法。
- 现在的代码：
  - 租约表一行一个键，记持有的用户和运行；`holders(keys)` 给出持有人，`view(prefix)` 不给（`hub/leases/service.ts`，README 的 Limits 一节）。
  - 运行上下文的租约视图只有 `key`、`until`、`mine`，说明里写着可见性未定（`contracts/src/pack.ts` 的 `RunContext.leases`）。视图冻结进 `RunRecord.lease_context`：`contracts/src/run.ts`；`hub/runs/engine/start.ts` 约 466–480 行；`evaluate.ts` 的 `contextLeasesOf`。
  - 时长：
    - 工作流声明 `leases.max_ttl_seconds`（`contracts/src/pack.ts`：单次请求和累计续期的上限）；`start.ts` 第 140 行一带按它判。
    - 台架包声明 86400；`functions/conclude.ts` 有 `MAX_HOURS = 8`、`DEFAULT_HOURS = 2` 和 `hours` 参数，`extend` 动作续期。
  - 强制释放只有管理员的 `circle-hub lease release <键> --reason <理由>`（`hub/server/cli-admin.ts`）；续期和释放只认血缘（`start.ts` 的 `grantLeases`）。
  - hub-job-dispatch 加了只读的持有人快照 `holderSnapshot`：带围栏令牌，只给派发这类可信代码用，不进客户端和模型。强制释放会让令牌加一，原持有人之后的派发会被围栏拒绝。
  - 台架包 1.1.0（core-fixes 上是 1.1.1）的动作：search、facts、acquire、extend、release。`packs/workflow/test-bed/README.md` 的“核心缺口”一节第一条，就是持有人进不了运行上下文。
- 模型元素：D04、D01、R01、R02、B05。`node tools/show-element.ts D04 D01 R01 R02 B05`。

- 分工：模型文字由集成者先改，再开这一件：
  - D04 R[0]：
    - “时长上限取自允许的效果表”改成：声明了时长上限的租约照旧到期；预订类租约没有时长限额，由预订它的谱系持有，到谱系释放、或主人和管理员强制释放为止。
    - 加：预订类目标有主人，是登记它的用户；登记和注销各记一条租约动作记录；登记的前缀互不包含；主人和管理员看得到持有人，所有人看得到占着它的运行；主人和管理员能强制释放（带理由）；管理员能改登记。
  - D01：部署实例归管理员管的规定加一句：用户可以把清单里的台架登记到自己名下，只记归属。
  - R01 R[0]、R[1] 和 R02 照上面写。
  - 词表 `lease_op` 加 `register`（登记）、`unregister`（注销）。
- 分支和工作树：`test-bed-ownership`，目录 `circle-hub-test-bed-ownership`。
  - 等下面这些都合并以后，由集成者从 hub-redesign 开出并通知：core-fixes、hub-job-dispatch、kb-candidates、kb-links、views-and-notes、plan-evidence、hub-device-run，和集成者的模型提交。
  - 原因：`hub/leases`、`start.ts`、`contracts/src/pack.ts`、`run.ts`、`hub/records/migrations.ts`、`cli-admin.ts` 和台架包都在这些分支上改着。
- 可以改的路径：
  - `hub/leases/**`；
  - `hub/records/migrations.ts`：只在末尾加一个新迁移，已应用的不改；迁移快照测试跟着改；
  - `hub/runs/engine/start.ts`（租约时长、租约视图的冻结、`grantLeases`）、`evaluate.ts`（`contextLeasesOf`）、`deps.ts`（第 3 条的端口）、README 和对应测试；
  - `hub/server/assemble/hub.ts`：只接第 3 条的端口；
  - `contracts/src/pack.ts`（`leases` 声明、`RunContext.leases`、投影的 `lease_requests`）、`contracts/src/run.ts`（`leases`、`lease_context`）、`contracts/src/records.ts`（登记动作的形状）、`contracts/src/leases.test.ts`，照生成器重新生成 `contracts/generated/**`；
  - `hub/server/cli-admin.ts` 的 lease 命令和 `hub/server/assemble/cli-admin.test.ts`；
  - `packs/workflow/test-bed/**`；
  - `tests/acceptance/24-lease-start-run.test.ts`、`25-test-bed.test.ts`；
  - `hub/dispatch/` 原范围只加一个测试文件；凌晨补充授权的只读公共查询及导出见本页“集成者答复”，不改派发行为。

  别的路径不动。还有几处重叠：
  - hub-pack-findings 第 9 条也改台架包，集成者让两件先后做。
  - 同一批写的几页也碰到这里的文件，段落不同：kb-unversioned 改 `start.ts` 锁根的一段和 `contracts/src/run.ts`；script-distribution 改 `contracts/src/run.ts` 的 PackSummary；gateway-request-ids 第二步改 `hub/dispatch/**`。集成者排先后，后合并的照合并后的契约重新生成 `contracts/generated/**`。
  - hub-variables 改 `start.ts` 开头读变量的一段和参数的凭据扫描、`hub/server/cli-admin.ts`（var、secret、resource 的命令）、`hub/dispatch/**`（执行器的钥匙和变量）。段落不同，集成者排先后，后合并的照合并后的契约重新生成 `contracts/generated/**`。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 核心里不出现设备、台架这类词：核心只认“声明的前缀下面，一个键前缀有主人”；
  - 令牌不进运行上下文、运行记录、工具回答和控制台；
  - 占用的结论照旧写“Hub 记录里…（未排除本地操作）”；
  - 未知只能是过渡状态，写明缺的事实和下一步动作；
  - 枚举只来自生成的词表。
- 验证：
  - `npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；
  - `node --test --test-concurrency=1` 对这些：`contracts/**`、`hub/leases/**`、`hub/records/**`、`hub/runs/engine/**`、`hub/dispatch/**`、`hub/server/assemble/cli-admin.test.ts`、`packs/workflow/test-bed/**`、`packs/workflow/case-compile/**`、`tests/acceptance/24-lease-start-run.test.ts`、`tests/acceptance/25-test-bed.test.ts`；
  - `node packs/workflow/test-bed/pack-files.ts --check`。

## 要做的

1. **没有时长限额的租约**（核心）：
   - 工作流的 `leases.max_ttl_seconds` 改成可选。
     - 写了的，照现在到期、续期。
     - 没写的，租约没有到期时刻（`until` 为 null），到下面三种情况之一为止：持有它的谱系释放；主人或管理员强制释放（第 4 条）；管理员 `lease release`。
     - 没有到期时刻的租约不能续期，续期请求整次不受理，修正说明写“这个前缀的租约不到期，不用续”。
   - 谱系照 D04 R[0] 和 `grantLeases` 现在的写法：以预订运行为前驱的运行沿用同一份租约。
   - 测试：
     - 不到期的租约过了很久还在；续期被拒；
     - 谱系里后一个运行释放成功，别的谱系释放被拒；
     - 写了上限的旧行为照旧，现有测试照样通过。
2. **登记和注销**（`hub/leases`）：
   - 用户可以把工作流声明的前缀下面的一个键前缀登记到自己名下。台架包用 `bed/<台架>/`：台架的设备键和地址键都在它下面。
   - 登记的前缀以 `/` 结尾，严格在声明的前缀下面，不能就是声明的前缀；和已有的登记互不包含（`bed/a/` 和 `bed/a/x/` 不能同时有）。不合这几条的拒绝，码是 `LEASE_UNAVAILABLE`，消息只说哪一条不合，不说别人的名字。
   - 先登记的人是主人，这是所有者的原话：谁登记就是谁的。冒领时由管理员纠正：
     - 管理员可以 `circle-hub lease register <前缀> --owner <用户> --reason <理由>`，把前缀登记给指定的用户，已有主人时直接改给他；
     - 管理员也可以 `lease unregister`。
     - 两条都记动作记录。
   - 用户自己登记时，前缀已经有主人就拒绝，消息只说“已经有主人”，不说是谁。两条连接同时登记同一前缀，恰好一个成功，照现有的 50 轮并发测试写。
   - 主人或管理员可以注销。台架上还有别人没释放的租约时不准注销，修正说明写“先强制释放，或等它释放”。
   - 当前主人存在一张按前缀唯一的表里（新迁移）。每次变更在同一事务里追加一条租约动作记录（op `register`、`unregister`，记主人、前缀、理由，管理员改登记时还记原来的主人）。表能由动作记录重建，回放测试照现有写法。
   - 测试：
     - 登记；重复登记；并发登记；
     - 嵌套的、等于声明前缀的、不以 `/` 结尾的前缀，各一例被拒；
     - 主人、管理员、别人各注销一次；有租约时注销被拒；
     - 管理员改登记以后，原主人失去主人的视角；
     - 回放。
3. **运行上下文里谁看得到什么**（`start.ts`、`evaluate.ts`、`contracts/src/pack.ts`、`run.ts`）：
   - 冻结的租约视图每行有这几项：
     - `key`、`since`（取得时刻）；
     - `until`：没有到期时刻的是 null；
     - `run`：占着它的运行号，所有人都有；
     - `mine`；
     - 持有人（用户编号和名字）：只在这次运行的用户是这一行所在前缀的主人、或是管理员时才有。持有人自己照旧看 `mine`。
   - 另加一张登记表：声明前缀下每个已登记的前缀，加“是不是我的”。别人的登记不带名字，管理员的运行带。
   - 两张都冻结进运行记录；用记录里的上下文重跑投影，得到同样的请求。
   - 每行还要有一项：这些键上有没有还没终态的派发作业，有的话是哪个。这项经 `deps.ts` 里一个只读端口，向 hub-job-dispatch 已有的作业记录查（作业按围栏令牌记着租约键），在 `hub/server/assemble/hub.ts` 里接上。没有现成的查询时，按本页“集成者答复”的授权补只读公共查询，不改派发行为。
   - `RunContext.leases` 的说明去掉“可见性未定”，写成现在的规则。
   - 测试：主人、持有人、第三个人、管理员四个视角各开一个运行，断言冻结的行。第三个人的行里有运行号，没有持有人的编号和名字。
4. **主人强制释放**（`start.ts` 的 `grantLeases`、`contracts/src/pack.ts`）：
   - 投影的 `lease_requests` 加 `{ op: "force_release", keys, reason }`。Hub 先核对下面几条，有一条不对就整次不受理，什么都不动：
     - 每个键都在这次运行的用户登记的前缀下，或者这个用户是管理员；
     - 键上有没释放的行；
     - 理由不空；
     - 键上没有还没终态的派发作业。有的话，修正说明写：作业 <号> 还没有终态，本地释放停不了网关上的作业；等它结束，或者请管理员用 `circle-hub job status` 看、用 `job dispose` 处置。
   - 管理员的 `lease release` 照同一条核对作业。
   - 核对通过以后，用租约服务的强制释放，`by` 是这个用户，理由进动作记录；运行记录的 `leases` 写下释放了哪些键，以及原来的运行。
   - 原持有人的运行记录不变；它的谱系之后的派发被围栏拒绝。
   - 测试：
     - 主人释放成功；非主人被拒（`LEASE_UNAVAILABLE`）；管理员成功；
     - 有没终态作业时，主人和管理员都被拒，修正说明是上面那句；
     - `hub/dispatch/` 下加一条：主人释放以后，原持有人的派发因为令牌变了被拒。照 hub-job-dispatch 现有的合成执行器写。
5. **台架包**（`packs/workflow/test-bed`，升到 1.2.0）：
   - 时长：
     - `workflow.json` 去掉 `max_ttl_seconds`；
     - `conclude.ts` 去掉 `MAX_HOURS`、`DEFAULT_HOURS` 和 `hours` 参数；
     - 去掉 `extend` 动作。旧的 `hours`、`extend` 请求如实拒绝，修正说明写“台架预订不限时长，用完由运行释放”。
   - 新动作：
     - `register`：参数 `bed`，清单里的台架名；
     - `unregister`：参数 `bed`、`reason`；
     - `force_release`：参数 `bed`，可选 `devices`，必填 `reason`（照用户的原话写）。
     - 投影出对应的 `lease_requests`；检查照旧按冻结内容重算（`functions/check-bed.ts`）；每个动作一对正反样例。
   - 投影如实拒绝（包码写进 codes）：`register` 的台架不在当前清单里，或者已经有主人；`force_release` 的台架不是自己登记的；没写理由。
   - search 和 facts 的结论：
     - 主人和管理员看到：“<设备> 被 <名字> 的运行 <号> 占用，自 <时刻> 起”。
     - 别人看到：“被运行 <号> 占用，自 <时刻> 起”，不带名字。
     - 有没终态作业的，加一句：“作业 <号> 还没有终态”。
     - 已登记的台架写“有主人”，自己的写“你登记的”。主人的名字对别人不显示（决定没说，先按不显示做，README 写明）。
     - 原来那句“Hub 记录里…（未排除本地操作）”照留。
     - 主人 search 不写 need，就能看到自己每台设备谁占着、从几点起。
   - SKILL.md 写三个新动作：
     - 登记前先确认是用户自己的环境；
     - 强制释放前先问用户，理由照原话写；
     - 结论原样转述；
     - 另外写明台架预订不限时长，用例的作业有终态以后释放。
   - README 改“核心缺口”第一条，记下第 13–16 项已定。第 15 项写“没有时长限额，租约由运行持有到释放”，不写小时数。
   - 测试：
     - 每个动作的投影和检查；
     - 两个用户各 search 一次，断言别人那份里有运行号，没有持有人的名字；
     - 旧的 `hours` 和 `extend` 被拒；
     - `node packs/workflow/test-bed/pack-files.ts --write` 重签。
6. **管理员命令**（`cli-admin.ts`）：
   - `lease list` 加主人、持有人、运行三列，照旧不显示令牌和租约号；
   - 加 `lease register <前缀> --owner <用户> --reason <理由>` 和 `lease unregister <前缀> --reason <理由>`；
   - 测试：`hub/server/assemble/cli-admin.test.ts`。
7. **验收**（`tests/acceptance/25-test-bed.test.ts` 加一段）：
   - A 登记台架；B 预订，不写时长；
   - A 搜索，看到 B 的名字和运行号；C 搜索，只看到运行号和起始时刻；
   - C 强制释放被拒；A 强制释放成功，理由进记录；B 的谱系之后的派发被拒；
   - C 登记 A 的台架被拒；管理员把它改登记给 C 以后，C 成了主人，A 不再是；
   - 管理员 `lease list` 看到主人、持有人和运行。
   - case-compile 也读租约视图，它的测试照样要过。

## 集成者答复（2026-10-24 凌晨）

- **05:22，答 codex-d，可改路径补充**：可在 `hub/dispatch/**` 加按租约键查询未终态作业的只读公共方法、API 导出及测试；只读既有记录，不改派发行为。`expires_at` 为 null 判为不到期，不得因没有时间值判成已过期。
- **05:24**：用 `start.ts` 的 `LeaseRequest` 替换 `projection.ts` 的手写类型，可改这一处及对应测试。
- **05:37**：旧 `hours`、`extend` 只保留拒绝入口，给出确定的修正说明；不保留旧的有时长预订或续期功能。
- **05:56，可改路径补充**：`packs/workflow/case-compile/functions/bed.ts`、`project.ts` 及测试适配 `until: null`，包升补丁号并重签；对应 README 和版本断言同步。这里不改其他编译规则。
- `contracts/src/pack.ts` 与 hub-pack-findings 的动态读取声明有重叠，后合并方解冲突，保留双方的可选契约与测试。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
