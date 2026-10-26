---
nav_order: 7
---

# 设备管理包设计复核（独立，读代码）

复核人：代理（独立于设计稿作者）。方法：通读 `docs/hub-r4-device-pack.md` 全文，对照 `contracts/src/pack.ts`、`contracts/src/product.ts`、`contracts/src/resources.ts`、`contracts/src/run.ts`（经 `contracts/generated/vocabulary.ts` 的轴）、`hub/runs/engine/start.ts`、`hub/runs/engine/target.ts`、`hub/runs/engine/store.ts`、`hub/runs/packs/validate.ts`、`hub/knowledge/builds.ts`、`hub/knowledge/sync.ts`、`hub/records/store.ts`、`hub/records/pointers.ts`、`hub/records/api.ts`，以及模型元素 D02/D03/D04/D07、B05、C07、K03、T04、W03/W06、R01（`node tools/show-element.ts`）。逐条写明依据；结论不是“可行/不可行”，是要改什么。

## 总结论

设计的骨架（清单是知识、占用是租约、版本是主张、全部经 start_run、不加工具）与现有代码贴合，但有**六处站不住或没想清楚**：方案 A 挂在产品包机制上有三处硬伤（见 1）；租约意图放投影结果里要求投影先于运行记录存储执行，而现在的投影在 `startFresh` 里没有任何事务保护，取得租约和存运行记录之间崩溃会留下无主租约（见 2）；“客户端不持有令牌”与设计里“用户拿租约号”不冲突，但“预订跨运行持有”与 D04 R[0] 的原文冲突，需要改模型措辞而不是“澄清”（见 4）；并发方案应改为唯一约束而非 CAS 重试（见 3）；清单删除占用中设备、时钟、Hub 重启三条失败路径设计完全没写（见 5）。核心（不含包）估计 8–12 个文件、1500 行上下，见 6 的拆分。

## 1. 7.1 清单的家：两个方案都有硬伤，选修正后的 A

**方案 A 的三处硬伤**（依据：`contracts/src/product.ts:268-299` `ProductDeclaration`、`:103-134` `SyncDeclaration`、`:111-125` `SyncPlanInput/Output`）：

1. **同步的来源不是“上传的文件”。** `SyncDeclaration.start` 是 `ExternalTemplate` 数组（`product.ts:128`），模板变量只有 `product/line/build/base/family/platform`（`product.ts:31`），展开结果是 `ExternalObjectId`——即“外部系统里的一页”。同步循环（`hub/knowledge/sync.ts` 的 syncProduct）拿着外部读取端口逐轮读这些对象。管理员上传的拓扑文件没有外部对象身份，进不了这个循环。要走 A，要么给文件一个伪外部身份（如 `bed:file:<台架>@<修订>`，由读取端口从存储里答——这是给读取端口加一种“内部来源”，改动在 `hub/connectors` 的读取器分发处，约 100–200 行），要么不走 sync 循环、单独一个“清单导入”管理命令（改动在 `hub/server/cli-admin.ts` 加一条 `bed manifest import`，调 `hub/knowledge` 的新入口，约 150–250 行，不动 sync）。后者更小也更诚实：清单是**管理员声明**，不是从外部系统**发现**的，语义上本来就不是同步。
2. **`product@1` 的必填字段在这里没有意义。** `ProductDeclaration` 要求 `names`（≥1 个产品名）、`catalogs`（目录声明，`complete` 布尔决定“缺席是不是事实”，C07 R[0]）、`producers`；`BuildInfo`（`product.ts:83-95`）要求 `family`、`line`、`base`、`built_at`、`released_at`、`sources`。台架没有名称族、没有版本线、没有“发布”——`family`/`line`/`released_at` 全是凑数。根的标识也尴尬：知识根按 `product + base build` 键（`hub/knowledge/builds.ts` 的 `baseOf`/`latestProduction`，`builds.ts:155-170`），台架的“构建”是什么？如果把拓扑修订当“构建”，`built_at` 是修订时间，勉强能塞，但 `select_build`（无 build 时选最新发布构建，`target.ts:75` 起）会选出“最新发布的修订”——语义错位。**结论：A 方案不能原样走 `product@1`**；要走就得为清单另立一种“树类”（或者把清单做成无产品绑定的知识树），这是对知识包的结构改动（`hub/knowledge/store.ts` 的树键、`hub/knowledge/produce.ts` 的生产入口，估计 300–500 行），不是“零新增存储”。
3. **`workflow.json` 的 `product` 绑定是必填的**（`contracts/src/pack.ts:371-376`：`product` 字段带 `catalogs`，没有 optional 标记；`hub/runs/packs/validate.ts:242` 解析它）。设计里的 `bed-search` 等工作流要读清单树，但清单不是产品线；把 test-bed 包绑到 famx 上则所有床事实都挂在一条产品线下，别的产品线的床没法用。所幸 `target.ts:80-82` 已支持“不绑产品线”（`unbound = binding.id === undefined && binding.catalogs.length === 0`），`hub/runs/packs/` 的 `boundProducts` 同理——**工作流可以不绑产品**，但要读知识就得回答“读哪棵树”：现在的读取全部以 `product` 为键（`hub/knowledge/builds.ts` 的 `rootOfBuild(product, name)`、`hub/knowledge/views.ts` 的读取器）。这是 A 真正的坑：**知识读取的键是产品线**。清单树要么也挂一个伪产品线（`test-bed` 自己算一条“产品线”，`product@1` 的字段凑数），要么给知识读取加“按清单根直接读”的路径（改 `hub/knowledge/views.ts` 的视图读取入口和 `hub/refs` 的解析，约 200–300 行）。

**方案 B 的代价**（依据：`contracts/src/resources.ts:646-685` `ResourceRecord`）：`resource@1` 的 `origins` 是 `record(RoleName, BaseUrl)`——每角色一个 HTTP 基址；`allow_plaintext`、`credentials`、`credential_digests` 全是 HTTP/凭据语义；`settings` 是给读取函数的自由 JSON（≤64KB）。把设备塞进资源要：`origins` 改 optional 或加判别（设备没有基址）、动作从“读”泛化到“占用/释放”（现在 `SystemProfile.routes` 全是 `read: literal(true)`，`resources.ts:378`，**资源体系根本不能写**）。这是对 connectors 包的大改（`resources.ts` 的形状、`hub/connectors/resources.ts` 的管理命令、`hub/connectors/connectors.ts` 的读取路径，估计 400–600 行），而且违背了资源的本义（D01：部署实例；D07：执行器）。

**我的选择：修正后的 A'——管理员命令导入清单，知识树挂“test-bed 自己的树”，不走 sync、不伪装产品线。** 具体：`hub/server/cli-admin.ts` 加 `bed manifest import --file <path> --bed <name>`（管理员专用），字节经现有源工件管道入库（B02，`hub/records/artifacts.ts`），包里的解析器作为**生产器**对这份源工件产出台架/设备/接口条目（`hub/knowledge/produce.ts` 的生产入口已经接受“读取的源工件 + 包的生产器”，`produce.ts:2-4` 的注释；难点只是树的键不用产品线——`hub/knowledge/store.ts` 加一种“床清单树”的键，或者最省的办法：test-bed 包**同时**是一个最小 `product@1`（names=['test-bed']，没有 sync、一个不声明 complete 的目录），凑两个字段换零结构改动）。代价写清楚：凑 `names`/`line`（用台架名当“版本线”）不体面但改动最小（包内 + `hub/server/cli-admin.ts` 一条命令，约 200 行）；做干净的床清单树约 300–500 行（`store.ts`/`produce.ts`/`views.ts`）。**取舍留给所有者：省 vs 干净。**方案 B 不推荐：改动更大且方向错。

## 2. 7.2 租约意图放哪、和运行的事务关系

**放投影结果里（设计的推荐）是对的先例延续**，但设计没写关键一步的顺序。现在 `startFresh` 的顺序（`hub/runs/engine/start.ts:300-447`）：`bindInputs` → `contextBuilds` → `projectItems`（**无事务**，纯计算加动作记录）→ `bindExpected` → 组装 `RunRecord` → `evaluateProduction`（生产运行在这里全算完）→ `putRun`（`hub/runs/engine/store.ts:53-74`，**单条 put 自带一个事务**）→ `putAction('parse')` → `keepProduction`。运行记录和它的生产结果**不**在同一个事务里（`putRun` 一个事务，`keepProduction` 又一个）。

**我认为对的顺序**（租约取得夹在中间，两个事务，各有一个补偿）：

1. `projectItems` 返回 `lease_requests`（包的纯函数算出，无副作用）。
2. Hub 校验（前缀、上限）后**先取得租约**（`hub/leases` 的一次 CAS/唯一约束插入，自带事务），得到租约号和到期时刻。
3. 把租约结果（号、键、到期）写进 `RunRecord` 的新字段（如 `leases`），`putRun` 存运行。
4. 若 `putRun` 失败（超限等，`start.ts:410-416` 的 `LimitError` 路径）：**立刻释放刚取得的租约**（补偿），再抛拒绝。
5. 若进程在 2 和 3 之间崩溃：租约已存在但无运行引用。处理：租约记录里存 `run` 字段，`hub/leases` 的读取按“`run` 非空且该运行记录不存在”判孤儿，孤儿视为过期（下一读者可抢占）。这要求孤儿判定能查运行记录（`store.find` 按 `INDEX.runId`，已有，`store.ts:76-80`）——**这就是为什么租约不该做成动作记录（B05）而该是自己的记录种类**，见 4。

**不建议**把租约取得放进 `putRun` 的同一个数据库事务：`putRun` 是通用记录写入（`hub/records/store.ts:39-80`），把床租约的语义塞进去要在记录层开洞；而且生产运行在 `putRun` 之前还有 `evaluateProduction`（可秒级），把租约持有点提前到冻结之前只会拉长持锁窗口。**先租约、后存记录、失败补偿、孤儿按运行存在性回收**——这是改动最小且崩溃安全的顺序。每步文件：意图校验 `hub/runs/engine/start.ts`（projectItems 之后）；取得 `hub/leases/service.ts`（新）；写回 `start.ts:325-399` 的 record 组装与 `contracts/src/run.ts` 的 RunRecord；补偿 `start.ts` 的 putRun catch；孤儿 `hub/leases/service.ts`。

## 3. 7.3 并发：不要乐观重试，用唯一约束加过期行

设计 4.1 写“compare-and-swap、表头变了重算、最多三次”。对照代码：仓库里现成的 CAS 先例是根指针（`hub/records/pointers.ts` 的 `move`：`pg_advisory_xact_lock` + 期望比对，`pointers.ts` 的事务体），它**没有重试**——调用方（`hub/knowledge/builds.ts:288-303` 的 `reconcileLine`）重试三次是因为指针可能被别人合法移动。租约不是这种场景：两个用户同时订同一台架，**恰好一个该赢**，不需要“重算后再试”。

更简单的做法：**租约表 `(key) 唯一约束，插入即取得**；键上已有**未过期**行 → `LEASE_UNAVAILABLE`（带上那行的到期时刻当“最早空闲时刻”）；已有**过期**行 → 在一个事务里 `UPDATE ... WHERE key = $1 AND expires_at <= now() RETURNING`（原子的“抢占过期行”），更新数为 0 说明刚被人抢走，返回不可用。两个场景：

- **两个用户同时订同一台架**：唯一方案里两个 INSERT 只有一个成功（PostgreSQL 唯一约束保证，无重试、无窗口）；CAS 方案里两次读表头都看到“空闲”，两次 CAS 一个成功一个重算——重算后看到对手，返回不可用。结果相同，但唯一方案没有“最多三次”的循环，代码是一条 INSERT 的 catch。
- **过期行的清理**：唯一方案**不需要清理任务**——过期行原地保留，下一次取得同一键时原子抢占（上面的 UPDATE），读到的人按 `expires_at <= now()` 判空闲；行不会无限增长（键空间有限，每键至多一行）。CAS 方案要么删行（删和插之间有窗口，得再锁），要么同样留行——那就退化成和唯一方案一样，CAS 白做。

结论：**唯一约束 + 过期行原子抢占**，比设计 4.1 的 CAS 简单且不会输；CAS 重试删掉。围栏令牌用行上的单调序列（`token bigint`，每次取得/续期 +1，`UPDATE ... SET token = token + 1` 顺带返回），不另做表头摘要。

## 4. 模型一致性：五处冲突及处理

1. **“租约按运行持有”（D04 R[0]）vs 预订跨运行**：原文“运行第一次向某目标派发时由 Hub 取得，同一运行之后的派发沿用……交付、取消或超期时释放”。预订运行取得、之后的自动化运行沿用，不是“同一运行”。设计第 4 节建议的读法（持有者是血缘 W06）是**改模型**，不是澄清：D04 R[0] 要加一句“预订类租约按血缘持有：以预订运行为前驱的运行沿用同一租约，由 Hub 在派发时核对前驱关系”。这不是设计能单方面“确认”的——按 `contracts/model.json` 的规矩（`contracts/src/codes.test.ts:6-14`，协议码和记录种类都从模型生成），模型措辞改动要走所有者的模型修订。
2. **“客户端不持有令牌”（D04 R[0] 末句）vs “客户端只拿租约号”**：不冲突，但要把“号”和“令牌”分开写死：租约号是**标识**（可给人看），围栏令牌是**凭据**（只进 Hub 派发的效果，D07 R[4] 的注入方式）。设计 4.1 已写对，复核确认，无改动。
3. **D02 的前提表**：设计第 6 节“未排除本地操作”的限定正确引用了 D02 R[5]。但设计漏了 D02 R[0] 的另一半：**“没有证据按最弱处理”意味着阶段 1 的一切占用结论都不该写成“台架空闲”，而该写“Hub 记录里空闲（未排除本地操作）”**——设计的 bed-search 输出措辞要统一带这个限定，不只是阶段 3 的操作。
4. **B05 动作记录承载租约事件**：`ActionKind` 是封闭枚举（`contracts/generated/vocabulary.ts:271`：read/parse/generate/read_back/validate/dispatch/classify/move_root，从模型生成），没有“租约”种类；`hub/records/api.ts:498` 的 `ActionBody` 按 `action` 判别。把取得/释放塞进现有种类是语义造假。**租约该是新的记录种类**（如 `lease@1`），随 `RECORD_KINDS` 从模型生成（`contracts/src/codes.test.ts:38-42` 断言记录种类来自模型）——这又是模型修订。动作记录里**补**一条 `dispatch` 或新增种类的“租约取得”事件作为审计线可以，但权威状态在租约记录。
5. **`context` 封闭列表**：`CONTEXT_KEY = ['builds'] as const`（`contracts/src/pack.ts:191`），`ContextKeySchema = z.enum(CONTEXT_KEY)`。加 `leases` 要动：`contracts/src/pack.ts:190-193`（常量与枚举）；`RunContext`（`pack.ts:196-211`）加 `leases` 可选字段；`tools/gen-contracts.ts` 重新生成 `contracts/generated/schemas/*.json`（RunContext 出现在多个工具的输入 schema 里，`gen-contracts.ts:411` 一带）和 `tools.json`；发布校验 `hub/runs/packs/validate.ts:242` 一带对 `context` 的检查（目前只查重复，`pack.ts:393-395`，无需大改，但 `workflow.json` 的 shape 校验随生成文件走）；`hub/runs/engine/start.ts:89-91`（`contextBuilds` 旁加 `contextLeases`，按工作流声明的前缀过滤、附 `now`）。设计 4.2 说“先例是 builds”——对，但漏了生成器这步，工作量里要记。

## 5. 设计漏掉的失败路径（各给处理，不留待定）

- **Hub 重启时租约的状态**：租约在数据库（新记录种类），重启无损失；进行中的“取得”若没提交，事务已回滚，无孤儿。孤儿只来自第 2 节的崩溃窗口，按“引用的运行不存在”回收。**不需要恢复任务。**
- **时钟**：过期按读取时刻算（设计 4.1 已写）意味着不同节点时钟漂移会给出不同答案。处理：过期判定一律用**数据库时钟**（`expires_at <= now()` 在 SQL 里，`pointers.ts` 的先例），Hub 进程时钟只用于展示；运行记录里已存的时刻是 ISO（`run.ts` 的 started_at），不受影响。
- **同一用户重复预订**：设计没写。处理：允许（同一用户对同一键的第二个租约请求返回新的租约记录？不——唯一约束下同键只能一行，第二个请求得到 `LEASE_UNAVAILABLE`，最早空闲时刻是自己的到期时刻）。要“续订”语义就用 `extend`，不新取得。写进 SKILL。
- **清单修订删除了还被占着的设备**：处理：修订导入不检查占用（清单是事实，占用是意图；事实更新不迁就意图）。被占的键从此不在清单里——租约仍有效到到期（键是字符串，不依赖清单存在），但 bed-facts 对“清单外键的租约”要报**未知**（“设备已不在清单里，占用记录仍在”），管理员可见并可强制释放。包的检查函数把“租约键不在当前清单”作为一条警告。
- **拓扑修订换了设备名**：同上——旧名字的租约照常到期；bed-search 只认新清单；旧租约对 bed-search 不可见（键前缀里带台架名的话，台架名没变就还能看见）。**建议键里带台架名和设备名（`bed/<台架>/<设备>`，设计已这么写），并在修订导入时对“存在租约的旧设备名”输出管理员警告。**
- **管理员强制释放时持有者的运行**：设计只说“留下动作记录和理由”。处理：强制释放把租约行删掉（或标记 released），引用它的运行**不**作废（运行是不可变记录），但该运行之后对这台设备的派发会被 `hub/leases` 拒绝（围栏令牌已变）——这正好复用 D04 R[0] 的“租约中断后同一租约约束失效”。运行摘要里加一条管理员备注（`hub/server/mcp.ts:140-145` 的 adminNote 先例）。

## 6. 工作量：修正后的拆分

核心（hub/ 与 contracts/，必须先行于包）：

| 项 | 文件 | 内容与测试 | 估计 |
| --- | --- | --- | --- |
| C1 模型与合约 | `contracts/model.json`（D04 R[0] 措辞、记录种类 `lease`、动作种类若加）、`contracts/src/records.ts`（lease@1 形状）、`contracts/src/pack.ts`（CONTEXT_KEY、RunContext、workflow 的 `leases` 声明）、`contracts/src/run.ts`（RunRecord 的 leases 字段）、生成器产物 | 测试：`contracts/src/codes.test.ts` 扩、`pack.test.ts` 的 workflow shape | 300–400 行；**先于一切** |
| C2 租约服务 | `hub/leases/service.ts`（新）+ `hub/leases/README.md`：唯一约束建表（迁移在 `hub/records/` 的建表处）、取得/续期/释放/强制释放/按前缀读、过期原子抢占、孤儿回收、围栏令牌单调 | 测试：并发（两连接同时插入）、过期抢占、孤儿、前缀过滤、强制释放 | 500–700 行；依赖 C1 |
| C3 start_run 接线 | `hub/runs/engine/start.ts`（意图校验、取得、写回、补偿）、`hub/runs/engine/store.ts`（索引 run→lease）| 测试：投影返回意图 → 租约进记录；putRun 失败补偿；非生产包拒绝租约意图 | 200–300 行；依赖 C1、C2 |
| C4 清单导入命令 | `hub/server/cli-admin.ts` 一条命令 + `hub/knowledge` 的清单树入口（或最小 product@1 路线，见 1） | 测试：命令级（cli-admin.test.ts 的先例）| 200 行（product@1 路线）或 300–500 行（干净树）；依赖 C1；**可与 C2 并行** |

包（packs/workflow/test-bed 及 test-bed-*，全部依赖对应核心项）：

| 项 | 内容 | 测试 | 估计 |
| --- | --- | --- | --- |
| P1 清单解析器 | 拓扑文件解析纯函数 + 修订根 | 解析正反例（重复地址、地址落不进段） | 200–300 行；依赖 C4 |
| P2 bed-search | 工作流 + 投影 | 合成三台架 | 200 行；依赖 P1、C2 |
| P3 bed-booking | 租约意图投影 + 参数 action | 预订/续期/释放/地址 | 300 行；依赖 C2、C3 |
| P4 bed-facts、bed-version | 环境事实、版本主张 | 监听/盲地址、租约持有核对 | 300–400 行；依赖 P1、C2 |
| P5 验收与真实 Circle 场景 | 设计第 7 节验收 1–10 | scripts/real 场景 | 200–300 行；最后 |

原拆分 L1–L5 的顺序（L1 租约 → L2 上下文 → L3 清单 → L4 工作流 → L5 验收）大体对，但漏了**模型先行**（C1 必须第一个做，否则 C2 的记录种类和 C3 的合约字段没有依据）和“清单（原 L3）可与租约并行”这一事实。

## 7. 设计稿里我认为错的地方（汇总）

1. 4.1 的 CAS 重试应删，改唯一约束（见 3）。
2. 第 5 节“清单存哪里待复核定”的两个选项都没写“知识读取以产品线为键”这个真正的障碍（见 1）。
3. 第 4 节把“预订跨运行”说成“澄清 D04”——是模型修订（见 4.1）。
4. 第 7 节验收 3“不靠运气”在 CAS 方案下反而难测（要构造表头恰好变化的窗口），唯一约束下是自然的两连接插入测试（见 3、6 C2）。
5. 第 3 节“占用……Hub 的动作记录（B05）”——动作种类是模型生成的封闭枚举，租约状态放动作记录是错的家（见 4.4）。

## 8. 没读懂或拿不准的地方

- `hub/knowledge/produce.ts` 的生产入口能否接受“无 sync 的包”（我读了开头与 `ProductDeclaration.sync` 是 optional 的定义，推断可以，但没有端到端验证一条不走 sync 的知识树能被 `get_nodes` 读到——C4 做时要先做一个探针）。
- “最小 product@1 路线”里 `select_build` 对台架的错位行为（见 1.2）没有深挖：如果床树从不通过 `start_run` 的 build 选择读取，错位可能根本不触发；我按最坏情形估的 300–500 行可能偏高。
- 设计第 6 节“占用者对其他用户可见：所有者定”——我没有评估可见性改动在 `hub/records/api.ts` 的读者模型里是几行（`identityOf`/`canSeeRun` 一带没细读），这项没计入工作量。
