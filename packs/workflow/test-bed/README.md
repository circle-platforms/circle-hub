# packs/workflow/test-bed（设备台架：search / facts / acquire / extend / release）

设备管理包的工作流包（P2 起）：读管理员发布的台架清单（命名文档），按需求搜索台架、算环境事实、预订台架、按血缘续期和提前释放自己的预订。只含事实要求项，开始运行时由 Hub 直接算出结果。设计在 [设备管理包设计](../../docs/hub-r4-device-pack.md)，独立复核在 [复核](../../docs/hub-r4-device-pack-review.md)。P1 的纯函数（清单校验、环境事实、选台架）在 `functions/`，核心的租约与命名文档已落地（`hub/leases`、`hub/server/docs.ts`；续期与释放按血缘，D04 R[0]）。

- **绑定**：不绑产品线（`product: { "catalogs": [] }`）。输入槽 `inventory` 读命名文档（`accepts: ["doc:doc"]`，json@1 解析，形状 test-bed-manifest@1）；声明 `context: ["leases"]` 和 `leases: { prefix: "bed/", max_ttl_seconds: 86400 }`——声明的这个数同时是单次请求和累计续期的核心上限（contracts 里 max_ttl_seconds 的语义），包要的是单次最多 8 小时、累计最多 24 小时，所以声明 86400（24 小时，累计由核心判），单次 1 到 8 小时由 `readParameters` 判（MAX_HOURS）。
- **动作**（参数 `action`）：
  - `search`（默认）：每个满足设备数量和类型的台架一个条目，结论写空闲状态（只写“Hub 记录里空闲（未排除本地操作）”或“Hub 记录里最早 <时刻> 空闲（未排除本地操作）”）、构建是否一致、缺什么。构建判定读清单里每台设备的 `installed`（构建名，可选 `base` 基础构建）——那是管理员写的声明，没有核对过，结论写“构建一致/不一致（…，声明，未核对）”；NSAE 名按声明的 `base` 映射到基础构建再比较；没有 `installed` 的设备写“没有记录（未知）”，不当作不一致。观察层（执行器）属于阶段 2。
  - `facts`：每个台架一个条目，监听候选、盲地址、后端候选、每网段空闲地址数（`functions/facts.ts`），外加每台设备的装机声明（`installed`，声明，未核对；没有就是空列表）。
  - `acquire`：选定台架（`bed`）或按 `need` 取最佳匹配，投影返回 `lease_requests`（键 `bed/<台架>/<设备>`，要地址时加 `bed/<台架>/ip/<地址>`；期限 `hours`×3600，单次≤8 小时由包判）；取得失败由核心拒绝（`LEASE_UNAVAILABLE` 带最早空闲时刻）。
  - `extend`：续期自己的预订。`booking` 写预订那次运行的编号，**开始运行时 `predecessor` 写同一个编号**（Hub 按血缘判持有者：持有运行在前驱链里且同一用户）。要操作的键从冻结的租约视图里取 mine 为真的全部键（设备和地址一起），投影返回 `{ op: "extend", keys, ttl_seconds }`；累计超过 24 小时由核心拒 `LEASE_TTL`。
  - `release`：提前释放自己的预订（`booking` 和 `predecessor` 同 extend），投影返回 `{ op: "release", keys }`；释放不可逆，运行随后失败也不放回。
  - extend 和 release 在血缘里没有未过期的租约行时如实拒绝：`test-bed.not_holder`“你没有持有这个预订”；核心另外把守非持有者与过期行（`LEASE_UNAVAILABLE` / `LEASE_EXPIRED`）。
- **检查**：`functions/check-bed.ts` 逐条目用同一份代码（`functions/conclude.ts`）按冻结的清单与租约视图重算，结论与冻结内容一致记支持，矛盾记反驳（`test-bed.search_mismatch`、`test-bed.facts_mismatch`、`test-bed.acquire_mismatch`、`test-bed.extend_mismatch`、`test-bed.release_mismatch`，提示档）；包只声明一个检查（检查声明 `tier: advisory`，正反例样本在 `samples/`，五个动作各一对，外加搜索的构建判定一对）。
- **清单**：管理员用 `circle-hub doc put bed-topology <文件>` 发布（见 `examples/bed-topology.json`）；每台设备可带 `installed: { "build": …, "base": … }`（构建名必填、基础构建可选，阶段 1 的装机记录，来源类型“声明”）；有问题的清单整份拒绝并逐条指出位置（`functions/manifest.ts`）。
- **验收**：`tests/acceptance/25-test-bed.test.ts`（真实 Hub 全链路：管理员发布清单、搜索、预订、第二人被拒带最早空闲时刻、血缘续期与释放及“你没有持有这个预订”的如实拒绝、环境事实、重复地址整份拒、未分配者不可用）；真实 Circle 客户端场景在 `scripts/real/accept/test-bed.ts`（脚本化模型发工具调用：搜索、预订、按前驱链续期和释放；租约键不进客户端文本，gold 独立写设备名、地址和时长，键由它们机械推出）。

## 函数清单

| 文件 | 导出 | 作用 |
| --- | --- | --- |
| `conclude.ts` | `readParameters`、`searchFields`、`factsFields`、`acquirePlan`、`heldKeys`、`extendPlan`、`releasePlan`、`leaseRecord`、`manifestBeds` | 参数规整与五个动作的同一份结论计算（投影与检查共用） |
| `project.ts` | 默认导出（ProjectionInput -> ProjectionOutput） | 按动作出条目、冻结组（清单、参数、租约视图）和 acquire 的 `lease_requests` |
| `check-bed.ts` | `bedOutcomes` 与默认导出 | 按冻结内容重算并比对每个条目 |
| `addresses.ts` | `parseIp`、`parseSubnet`、`parseInterface`、`formatIp`、`formatSubnet`、`subnetOf`、`subnetContains`、`expandRange`、`nextFree`、`segmentUsable`、`parseIpv4ish` | 严格的自写 IPv4/IPv6 解析与格式化、网段包含、带上限的区间迭代、空闲地址选取 |
| `manifest.ts` | `parseManifest`、`LIMITS`、`DEVICE_TYPES`、`DEVICE_TYPE_LABEL` 及模型类型 | 清单校验：一次列全所有问题（JSON 指针、中文说明、怎么改），成功给规范化模型 |
| `facts.ts` | `bedFacts` | 一个台架的环境事实：网段与成员、监听候选、盲地址、后端候选、每网段空闲地址数、未知项 |
| `match.ts` | `matchNeed` 及类型 | 按需求选台架：设备数量与类型、构建一致性（含别名）、租约与最早空闲、排序与结论文字 |
| `common.ts` | `isRecord`、`clip`、`intOf` | 小工具（无运行时依赖） |

## 形状与上限

- 清单：`{ schema: "test-bed-manifest@1", beds: [...] }`；设备类型五种（`load-balancer`/`router`/`client`/`server`/`console`）；`product` 是可选自由字符串，原样带出。上限：200 台架、每台架 100 设备、每设备 16 地址、整份 2 MiB（`LIMITS`）。
- 接口地址项 `地址/前缀`：**地址是设备自己的**（主机位不必为零），前缀标它所在的网段；`parseSubnet`（保留段、服务里用）才要求主机位全零。这是对任务页示例的解读，见 Open questions。
- `parseManifest` 全函数：任何输入（非对象、数组、循环引用、超深、超长）都返回 `{ok:false,problems}` 或 `{ok:true,beds}`，不抛异常；超限整份拒绝。
- `bedFacts` 有界：100 设备的台架答案 < 100 KB。
- `matchNeed` 的键：租约与安装记录都用 `bed/<台架>/<设备>`；结论一律写“Hub 记录里空闲（未排除本地操作）”或“Hub 记录里最早 <时刻> 空闲（未排除本地操作）”，不写“台架空闲”（D02：Hub 记录排除不了台架上的本地操作）。
- 测试数据：IPv4 只用 192.0.2.0/24（按 /26 切段），IPv6 只用 2001:db8::/32；构建名用 `Rel_APV_10_6_1_*`、`Rel_NSAE_10_6_1_*` 形状。

## 已定的口径（与任务页逐条对应）

- **选设备的顺序**：同类型里先挑无租约的（按名字），不够再挑有租约的——台架的最早空闲时刻是被选中有租约设备的到期最大值；未被选中的闲置设备的租约不影响结论。
- **构建判定只看被选中的设备**（负载均衡类；需求里没有负载均衡时看全部被选类型），装机记录来自清单的 `installed`（声明，未核对；观察层属于执行器阶段，到了之后来源写“观察”），没有记录写“未知”，不写不一致；别名经 `builds` 映射到基础构建再比较（`installed.base`；NSAE 名基于 APV 构建算同一构建，与 case-location 候选的 `base` 写法一致）。
- **排序**：设备够且现在空闲（Hub 记录里）→ 最早空闲时刻早 → 多余设备少 → 名字。设备不够的台架排最后但仍出现在答案里，写明缺什么。
- **盲地址**：负载均衡设备的接口地址所在网段上没有任何触发设备（路由器、客户端）时是盲地址，不进监听候选。
- **后端候选**：服务器设备的接口地址和服务条目；服务地址与某接口地址相同时只保留服务条目（带 `host:port/proto`）。
- **空闲地址数**：网段可用地址（IPv4 去网络/广播地址）减设备接口地址、减落在该网段的保留段地址。

## Open questions（给装进工作流的任务）

1. **接口地址的主机位**：任务页示例 `"ipv4": ["192.0.2.10/26"]` 里 .10 的主机位非零，按“设备自己的地址/所在网段前缀”解读并实现；若清单作者的意图是“网段地址/前缀”（主机位全零），`parseInterface` 的语义要换（改一个函数即可），README 与错误消息同步。
2. **构建判定的设备范围**：现在只看被选中的设备（含“闲置的被测设备不参与”）；若 P2 的 `bed-search` 要报“台架上所有同类设备的构建”，应把 `deciding` 的范围改成整个类型（match.ts 一处）。
3. **`hours` 与租约上限**（已落地）：`readParameters` 判单次 1 到 8 小时；包声明 `max_ttl_seconds: 86400` 让核心判累计 24 小时（这个声明数同时是单次请求的核心上限，所以单次 8 小时由包自己判）；extend 的投影把 `hours` 换成 `ttl_seconds` 带进租约意图。
4. **保留段与接口地址重叠**：清单允许保留段覆盖设备接口地址（不报错），空闲数按减法算；若要拒绝，在 `parseManifest` 的保留段检查里加一条（与“服务地址必须是接口地址”同款）。
5. **超过 65536 地址的大网段**：`segmentUsable` 与 `nextFree` 按上限 65536 截断（清单里的网段都是 /26 或 /64 级别，不会碰到）；若允许 /8 之类的网段，空闲数的语义要改成“至少 N 个”或拒绝大网段。

## 核心缺口（只记录，不在包里绕）

- **占用者名不进运行上下文**：`RunContext.leases` 只有 key/until/mine，"谁占着"写不出来；占用者对其他用户是否可见由所有者定（设计稿第 6 节，未定）。
- **没有 subject 模块的检查拿不到 context**：引擎给无 subject 模块的检查的默认 subject 只有 `{ items, cross_item }`（`hub/runs/engine/evaluate.ts` 一带），所以包自带 `functions/subject.ts` 透传 `parameters/groups`——这个绕法可以；若核心以后把 context 加进默认 subject，本包的 subject 模块可删。

## 装进工作流的接口约定（P2 到 P4 用）

- `parseManifest(json: unknown): ParsedManifest` —— 清单导入命令（C4）与 P1 的唯一入口。
- `bedFacts(bed: ManifestBed): BedFacts` —— `bed-facts` 工作流的投影函数入口（P4）。
- `matchNeed(beds, need, installed, builds, leases, now): BedMatch[]` —— `bed-search` 工作流的投影函数入口（P2）；`installed` 与 `leases` 的键 `bed/<台架>/<设备>` 与租约键一致。
- P3 的 `bed-booking` 投影自行组 `lease_requests`（键、期限），不经本文件。

## 生成词表与包版本

test-bed@1.1.1 改用生成词表的类型。包内函数的运行时依赖仍只来自包内文件和已允许的依赖。词表更新导致包内字节变化时，必须升版并重签清单，不复用已发布版本。
