# packs/workflow/test-bed（函数，P1：清单校验、环境事实、选台架）

设备管理包里**不依赖核心改动**的纯函数一半：解析并校验管理员上传的台架清单、算一个台架的环境事实、按需求选台架。输入输出全是 JSON；不碰数据库、网络和文件。设计在 [设备管理包设计](../../docs/hub-r4-device-pack.md)，独立复核在 [复核](../../docs/hub-r4-device-pack-review.md)。

本目录现在**只有函数和测试**：`pack.json`、`workflow.json`、`checks.json` 等包文件等核心任务（租约记录种类、`context: ["leases"]`、清单的命名文档）合并后再装（P2 到 P4）。

## 函数清单

| 文件 | 导出 | 作用 |
| --- | --- | --- |
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
- 测试数据：IPv4 只用 192.0.2.0/24（按 /26 切段），IPv6 只用 2001:db8::/32；构建名用 `Rel_APV_10_4_6_*`、`Rel_NSAE_10_4_6_*` 形状。

## 已定的口径（与任务页逐条对应）

- **选设备的顺序**：同类型里先挑无租约的（按名字），不够再挑有租约的——台架的最早空闲时刻是被选中有租约设备的到期最大值；未被选中的闲置设备的租约不影响结论。
- **构建判定只看被选中的设备**（负载均衡类；需求里没有负载均衡时看全部被选类型），装机记录来自 `installed`（声明或观察），没有记录写“未知”，不写不一致；别名经 `builds` 映射到基础构建再比较（NSAE 名基于 APV 构建算同一构建，与 case-location 候选的 `base` 写法一致）。
- **排序**：设备够且现在空闲（Hub 记录里）→ 最早空闲时刻早 → 多余设备少 → 名字。设备不够的台架排最后但仍出现在答案里，写明缺什么。
- **盲地址**：负载均衡设备的接口地址所在网段上没有任何触发设备（路由器、客户端）时是盲地址，不进监听候选。
- **后端候选**：服务器设备的接口地址和服务条目；服务地址与某接口地址相同时只保留服务条目（带 `host:port/proto`）。
- **空闲地址数**：网段可用地址（IPv4 去网络/广播地址）减设备接口地址、减落在该网段的保留段地址。

## Open questions（给装进工作流的任务）

1. **接口地址的主机位**：任务页示例 `"ipv4": ["192.0.2.10/26"]` 里 .10 的主机位非零，按“设备自己的地址/所在网段前缀”解读并实现；若清单作者的意图是“网段地址/前缀”（主机位全零），`parseInterface` 的语义要换（改一个函数即可），README 与错误消息同步。
2. **构建判定的设备范围**：现在只看被选中的设备（含“闲置的被测设备不参与”）；若 P2 的 `bed-search` 要报“台架上所有同类设备的构建”，应把 `deciding` 的范围改成整个类型（match.ts 一处）。
3. **`hours` 与租约上限**：`matchNeed` 收下 `hours` 但不校验（上限属于包声明，见设计稿 4.2 的 `leases: { prefix, max_ttl }`）；P3 的 `bed-booking` 投影要把它带进租约意图。
4. **保留段与接口地址重叠**：清单允许保留段覆盖设备接口地址（不报错），空闲数按减法算；若要拒绝，在 `parseManifest` 的保留段检查里加一条（与“服务地址必须是接口地址”同款）。
5. **超过 65536 地址的大网段**：`segmentUsable` 与 `nextFree` 按上限 65536 截断（清单里的网段都是 /26 或 /64 级别，不会碰到）；若允许 /8 之类的网段，空闲数的语义要改成“至少 N 个”或拒绝大网段。

## 装进工作流的接口约定（P2 到 P4 用）

- `parseManifest(json: unknown): ParsedManifest` —— 清单导入命令（C4）与 P1 的唯一入口。
- `bedFacts(bed: ManifestBed): BedFacts` —— `bed-facts` 工作流的投影函数入口（P4）。
- `matchNeed(beds, need, installed, builds, leases, now): BedMatch[]` —— `bed-search` 工作流的投影函数入口（P2）；`installed` 与 `leases` 的键 `bed/<台架>/<设备>` 与租约键一致。
- P3 的 `bed-booking` 投影自行组 `lease_requests`（键、期限），不经本文件。
