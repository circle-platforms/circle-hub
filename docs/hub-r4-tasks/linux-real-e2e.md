# Linux 真实 Hub 合成跨根演练

依据：所有者的 Linux 迁移要求及集成者本轮委派。分支 `linux-real-e2e` 从 `hub-redesign` 的 `5bd43165` 开出。

允许修改：本任务页、`hub/platform/testing/linux-real-vm.ts`、`hub/platform/linux-real-vm.test.ts`、`hub/platform/README.md` 中本任务的限制说明。不得修改工作流、HANDOFF、生产配置、真实数据或其他包。

## 当前交付与边界

本提交交付 fail-closed VM 前置门、唯一私有资源分配、失败可见的逆序清理及不捕获密钥字节的进程管道。它不是跨根迁移成功证据。现有 `linux-lifecycle-real.test.ts` 替换 npm 并用合成 HTTP 程序代替 Hub，也不是本任务的端到端证据。

完整演练待 `hub-listen`、`key-transfer` 合入并经集成者协调测试窗口后实现/运行；当前不运行测试、tsc、VM 操作或任何部署命令。本任务不会用 fake runner、替身 HTTP server、预装 node_modules 链接绕过缺失能力。

## VM 专属前置条件

执行必须同时满足 Linux、Node 24、非 root 测试账户、`CIRCLE_HUB_TEST_REAL_VM=synthetic-only`、`systemd-detect-virt --vm` 识别虚拟机，以及 root 在 VM 内创建的 `/run/circle-hub-synthetic-vm`。标记必须为 root 拥有的单链接普通文件、0644，内容精确为 `circle-hub-synthetic-only-v1\n`。该标记是管理员声明 VM 可丢弃的授权，不是技术上证明主机无真实数据；VM 管理员负责隔离 VM、无真实数据/凭据、无共享生产目录。容器、宿主 macOS、普通 Linux 物理机和仅设置环境变量都拒绝。不自动提权、不自动装标记或依赖。

网络准备仍需 VM 管理员授权测试账户在 VM 中执行受限 `ip link/address`：新建随机 dummy 接口和独占的 192.0.2.0/24 地址，不改任何现有接口、路由或防火墙。仅删除本次成功创建且身份核验一致的接口。AppArmor 放行如需 profile，只能新建带本次随机名的 profile，并在 finally 删除该 profile；不得放松全局限制。当前基础没有实现这些特权动作。

## 待实现步骤及验收（每步失败即停止，finally 仍执行）

1. 完成前置门；检查用户 systemd/D-Bus、bwrap、PG18 客户端、Node24、VM 本地磁盘、空间及动态链接器。独立用户 HOME 不得是所有者 HOME。不得继承 CIRCLE_HUB_*、PG*、NPM_CONFIG_*、代理、真实 token 等宿主环境。
2. 分配随机 0700 父目录及 source/target 两个独立 0700 数据根，随机 unit 名、独立端口和网络接口；空根断言与所有权记录先于修改。目标备份和对象路径必须在本次父目录内。
3. 从固定提交的真实 Git archive 构建真实 release，各根执行真实 `npm ci`。不得链接宿主 node_modules。对 release 内 embedded-postgres 实际可执行文件运行 `ldd`，拒绝 `not found`；执行 `postgres --version` 与 pg_dump/pg_restore 大版本核对，缺项失败，不跳过。
4. 用真实平台命令 init/db/key 建立源根，真实 init-admin 建合成管理员；token 只在内存，不进日志。通过正式 vault 命令加入至少三个随机合成凭据（包括不同长度），记录条目引用和期望值于内存，绝不使用真实环境文件或钥匙串。
5. 真实 systemd 唯一 user unit 运行真实 Hub。确认 FragmentPath、MainPID、源数据根、监听地址及健康状态。源 MCP initialize 必须返回合法 JSON-RPC 与真实 Hub 协议响应；仅 `/healthz` 不算。
6. 用真实 backup 生成并核验 `circle-hub-backup@3`：清单 SHA、表行数/摘要、对象和 vault 文件；核对无 keys/releases/logs/packs 混入。停源 Hub并禁用自启，核验 unit inactive、is-enabled disabled、PID 消失、端口无监听。不得以本地取消证明远程停止。源根保留到验收结束。
7. 目标为空根时执行真实 restore；重核清单/表摘要。源 key export 与目标 key import 两个真实 CLI 子进程通过 stdout→stdin 直接管道相连；密钥不经过 JS 字符串、argv/env、临时明文文件、shell、终端、日志。两端退出码和超时独立核验，任何失败都使演练失败。导入必须拒绝覆盖，目标 key 权限 0600/目录0700，身份正确。
8. 真实 `records verify` 及正式 vault API 逐条解密对比内存期望值（不得只数文件）；失败只报告步骤/引用或计数，不打印值。目标另建合成操作令牌，不搬源 operator-token。
9. 目标真实 Hub 在随机 systemd 单元通过新接口监听，允许主机只含本次测试地址/端口。带合成管理员 token 完成真实 MCP initialize，检查协议版本、serverInfo、六工具列表；名单外 Host 和 Origin 被拒。核验 source 不会自动重启。必须经新接口地址而非回环请求。
10. finally 逆序清理仅自己的 target/source unit、子进程、PG cluster、接口、profile、父目录。每步清理失败收集并使测试失败，不吞异常；源根未能安全停妥时保留数据根供调查而不删除。未创建成功的资源不登记删除。不得扫描/停止其他 Hub、执行 pkill、修改生产服务、访问真实目标或发送网络请求到测试地址以外。

## 接口依赖与假设

- `hub-listen`：配置可表达明确监听地址与 Host/Origin 白名单，并可由独占数据根注入；合入前不能进行第9步。
- `key-transfer`：真实 export 非终端确认参数、import stdin 帧/编码、无覆盖契约尚待合入后读取，不猜测参数或编码；合入前不能进行第7步。
- 管理员/token/vault/records 命令由 server 包正式入口提供，具体调用须以合入后的 CLI 为准；不能写 SQL 绕过 vault 或授权层来制造通过。
- 当前 systemd adapter 使用真实账户 user manager，HOME 不可通过 fake identity 注入；演练应使用 VM 专属非 root 账户和其 manager，不能在宿主账户上假装隔离。
- 环境变量和 root 标记只是显式选择加入条件，不能证明隔离；管理员必须确认可丢弃 VM。任何真实生产备份/主密钥演练是另一项授权步骤，不属于本合成测试。

## 验证记录

本轮按委派未执行测试、类型检查或真实 VM 演练。新增的安全基础单元测试也未运行；没有 Linux、macOS 或业务验证通过的结论。
