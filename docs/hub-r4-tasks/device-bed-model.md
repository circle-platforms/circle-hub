# 任务：台架清单的校验、环境事实和选台架（纯函数，设备管理包的 P1）

设计在 `docs/hub-r4-device-pack.md`，复核在 `docs/hub-r4-device-pack-review.md`。这个任务写设备管理包里不依赖核心改动的那一半：只读一份台架清单（JSON），校验它，算出环境事实，按需求选台架。全部是纯函数，输入输出都是 JSON，不碰数据库、网络、文件。核心的租约、命名文档、`start_run` 接线由别的任务做，等它们合并后再把这些函数装进工作流（P2 到 P4）；所以这里**不写** `pack.json` 和 `workflow.json`，只写函数和测试。

- 分支和工作树：`hub-bedmodel`，目录 `circle-hub-bedmodel`
- 可以改的路径：`packs/workflow/test-bed/functions/**`（新建，含测试）和 `packs/workflow/test-bed/README.md`（新建，写决定、限制、函数清单）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`docs/hub-r4-device-pack.md`（全文）、`packs/workflow/case-location/functions/` 和 `packs/workflow/template-gap/functions/`（包函数的写法：纯 TypeScript，只用可擦除语法，导入以 `.ts` 结尾，包内自己带 `common.ts`，输出有大小上限、对坏输入全函数）、`packs/workflow/case-location/functions/candidates.ts`（构建别名的写法：`base`、`alias`）。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据：IPv4 地址只用 192.0.2.0/24（要几个不同的网段就把它切成几个 /26：192.0.2.0/26、192.0.2.64/26、192.0.2.128/26、192.0.2.192/26），IPv6 只用文档段 2001:db8::/32，不要写任何真实的设备名或地址（构建名用 `Rel_FAMX_10_6_2_8` 这样的形状，版本线用 10.6 以后的合成号）；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 清单的形状（合成示例，管理员上传的 JSON）

```json
{
  "schema": "test-bed-manifest@1",
  "beds": [
    {
      "name": "bed-a",
      "devices": [
        { "name": "afamx0", "type": "load-balancer", "product": "famx", "ipv4": ["192.0.2.10/26", "192.0.2.74/26"], "ipv6": ["2001:db8:1::10/64"] },
        { "name": "router0", "type": "router", "ipv4": ["192.0.2.1/26"], "ipv6": [] },
        { "name": "client0", "type": "client", "ipv4": ["192.0.2.80/26"], "ipv6": [] },
        { "name": "server0", "type": "server", "ipv4": ["192.0.2.90/26"], "ipv6": [] },
        { "name": "console0", "type": "console", "ipv4": ["192.0.2.140/26"], "ipv6": [] }
      ],
      "services": [ { "host": "server0", "ip": "192.0.2.90", "proto": "tcp", "port": 80 } ],
      "reserved": ["192.0.2.1-192.0.2.9", "192.0.2.65-192.0.2.69"]
    }
  ]
}
```

设备类型只有五种：`load-balancer`、`router`、`client`、`server`、`console`（标签：负载均衡、路由器、客户端、服务器、控制台）；`product` 是可选的自由字符串（被测设备属于哪条产品线），函数不读它的含义，只原样带出。设备的每个 `ipv4`/`ipv6` 项是“该设备在某网段上的接口地址/前缀”。

## 要做的（先写测试，含改前失败的）

1. **`parseManifest(json)`**：返回 `{ ok: true, beds }`（规范化后的模型：地址解析成数值、网段算好、按名字排序）或 `{ ok: false, problems }`；`problems` 一次列全，每条带 JSON 指针位置、中文说明和怎么改。必须拒绝：`schema` 不对；台架名重复或不是 `[a-z0-9-]{1,64}`；同一台架里设备名重复；类型不在五种里；地址或前缀写法不合法（IPv4 点分十进制、前缀 0 到 32；IPv6 的压缩写法、前缀 0 到 128，自己写严格的解析器，不用依赖）；同一台架里同一个地址出现在两个设备上（或同一设备两次）；服务的 `host` 不是该台架里的设备、或服务的 `ip` 不是该设备的接口地址；`reserved` 区间写法不对、起点大于终点、不落在该台架的任何网段里；超出上限（200 个台架、每台架 100 台设备、每设备 16 个地址、清单 2 MiB）。对任何输入（不是对象、数组、循环、超深）都不抛异常。
2. **`addressMath`**（`addresses.ts`）：IPv4/IPv6 解析与格式化、网段包含、区间展开的迭代（带上限，不要展开 /16 或 IPv6 /64）、`nextFree(subnet, taken, count)`：从网段里取前 `count` 个不在 `taken`（已分配、保留、被占用）里的地址，跳过网络地址和广播地址（IPv4），结果确定且有序。
3. **`bedFacts(bed)`**（`facts.ts`）：算环境事实，输出确定、有大小上限：每个网段的成员；每个网段上的触发设备（`router`、`client`）；监听候选：负载均衡设备的接口地址，且同网段上至少有一个触发设备，并列出配对的触发设备；盲地址：负载均衡设备的接口地址，同网段上没有触发设备（不能当监听地址或虚拟地址）；后端候选：服务器设备的接口地址和 `services` 里的地址；每个网段可分配的空闲地址数（扣除设备地址、保留段）。缺信息写“未知”而不是默认为可达（例如设备没有任何地址）。
4. **`matchNeed(beds, need, installed, builds, leases, now)`**（`match.ts`）：`need` 是 `{ devices: [{type, count}], build?, hours }`；`installed` 是 `{ "<台架>/<设备>": { build, source: "declared" | "observed", at } }`；`builds` 是构建名到基础构建名的映射（FAMY 名字基于 FAMX 构建，沿用 `case-location` 候选里 `base` 的写法）；`leases` 是 `{ "<键>": { until } }`（键 `bed/<台架>/<设备>`，只需要键和到期时刻），`now` 是 ISO 时间。对每个台架给出：设备数量和类型是否满足；构建是否一致（精确同名，或两个名字的基础构建相同；没有安装记录写“未知”，不写不一致）；版本来源（声明或观察，缺失写“无记录”）；Hub 记录里现在空闲，或最早空闲时刻（所需设备的租约到期时刻的最大值）。排序：能满足且空闲的在前，其次最早空闲时刻，其次多余设备少，最后按名字。结论文字一律写“Hub 记录里空闲（未排除本地操作）”，不写“台架空闲”。
5. **README**：函数清单、输入输出形状、上限、对设计稿的任何偏离和拿不准的地方（写在“Open questions”里），以及“等核心任务合并后装进工作流”的接口约定（P2 到 P4 要用的入口名）。
6. **验证。** `npx tsc --noEmit`；`node --test --test-concurrency=2 "packs/workflow/test-bed/**/*.test.ts"`。另写一条对抗性测试：随机生成的畸形清单（嵌套很深、很长的字符串、重复键）不抛异常、用时有界。

完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方（尤其是设计稿里你觉得不对的）。
