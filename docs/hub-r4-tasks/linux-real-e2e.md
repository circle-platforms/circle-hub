# Linux 真实 Hub 合成跨根演练

依据：所有者的 Linux 迁移要求及集成者本轮委派。分支 `linux-real-e2e` 从 `hub-redesign` 的 `5bd43165` 开出。

允许修改：本任务页、`hub/platform/testing/linux-real-vm.ts`、`hub/platform/testing/linux-rehearsal-isolation.ts`、`hub/platform/linux-rehearsal-isolation.test.ts`、`hub/platform/linux-real-vm.test.ts`、`hub/platform/linux-hub-migration-real.test.ts`、`hub/platform/README.md` 中本任务的限制说明。不得修改工作流、HANDOFF、生产配置、真实数据或其他包。

## 当前交付与边界

本提交交付 fail-closed VM 前置门、唯一私有资源分配、失败可见的逆序清理及不捕获密钥字节的进程管道。它不是跨根迁移成功证据。现有 `linux-lifecycle-real.test.ts` 替换 npm 并用合成 HTTP 程序代替 Hub，也不是本任务的端到端证据。

真实 runner 已添加为 `linux-hub-migration-real.test.ts`，待 `hub-listen`、`key-transfer` 合入并经集成者协调测试窗口后核对最终接口并运行；当前不运行测试、tsc、VM 操作或任何部署命令。本任务不会用 fake runner、替身 HTTP server、预装 node_modules 链接绕过缺失能力。

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
8. 真实 `records verify --vault` 逐条 AEAD 解密核验，并由 restore 核对原始密文 SHA（不得只数文件）；失败只报告步骤/引用或计数，不打印值。目标另建合成操作令牌，不搬源 operator-token。
9. 目标真实 Hub 在随机 systemd 单元通过新接口监听，允许主机只含本次测试地址/端口。带合成管理员 token 完成真实 MCP initialize，检查协议版本、serverInfo、六工具列表；名单外 Host 和 Origin 被拒。核验 source 不会自动重启。必须经新接口地址而非回环请求。
10. finally 逆序清理仅自己的 target/source unit、子进程、PG cluster、接口、profile、父目录。每步清理失败收集并使测试失败，不吞异常；源根未能安全停妥时保留数据根供调查而不删除。未创建成功的资源不登记删除。不得扫描/停止其他 Hub、执行 pkill、修改生产服务、访问真实目标或发送网络请求到测试地址以外。

## 接口依赖与假设

- `hub-listen`：配置可表达明确监听地址与 Host/Origin 白名单，并可由独占数据根注入；合入前不能进行第9步。
- `key-transfer`：真实 export 非终端确认参数、import stdin 帧/编码、无覆盖契约尚待合入后读取，不猜测参数或编码；合入前不能进行第7步。
- 管理员/token/vault/records 命令由 server 包正式入口提供，具体调用须以合入后的 CLI 为准；不能写 SQL 绕过 vault 或授权层来制造通过。集成者只读复核后决定整合 c0b88a6a 的管道实现与只读 `records verify --vault`：空库保持未知，修复分块超长导入和异步导出清零问题。runner 唯一面向该整合接口，待实际合入代码复核；不保留两套 CLI 分支兼容。旧主线的普通 records verify 不构成密库证明。合成凭据由三个正式 executor 定义引用，之后用 secret set 的 stdin 写入；不派发、不接触这些 endpoint。
- 当前 systemd adapter 使用真实账户 user manager，HOME 不可通过 fake identity 注入；演练应使用 VM 专属非 root 账户和其 manager，不能在宿主账户上假装隔离。
- 环境变量和 root 标记只是显式选择加入条件，不能证明隔离；管理员必须确认可丢弃 VM。任何真实生产备份/主密钥演练是另一项授权步骤，不属于本合成测试。

## 验证记录

本轮按委派未执行测试、类型检查或真实 VM 演练。新增的安全基础单元测试也未运行；没有 Linux、macOS 或业务验证通过的结论。

## 真实 runner 当前状态

实现已包含真实 Git archive 与两次 npm ci、嵌入式 PG 动态链接与版本核对、正式迁移/管理员/secret 命令、真实随机 systemd 源目标单元、随机 dummy 接口、backup@3/restore、直接 key export→import 管道和拒绝覆盖、逐条密库核验、全部记录类型核验、目标非回环 MCP initialize/六工具与 Host/Origin 拒绝。接口前置检查不通过会失败，绝不替换 HTTP server。清理错误可见，只有清理全部成功才删除独占数据根。

代码尚未运行或类型检查；任何实际通过结论都需后续 VM 输出。接口创建需专用 VM 账户被管理员授予受限 sudo ip 权限；本测试不会配置 sudoers。未实现 AppArmor profile 改动。真实 backup/restore 内部已校验表摘要/权限/文件 SHA；测试不额外读取或显示业务正文。

## 真实备份 VM 演练方案（当前不执行）

所有者已明确授权后续用最新真实 backup 和真实主密钥管道演练；主代理仍须先协调并确认 Linux 依赖分支合入、合成 e2e 通过、独审及完整测试满足。当前没有读取真实 backup、环境文件、钥匙串或原文，也没有操作本机服务或真实目标。

**当前合成自动化不接收外部 backup 路径或数据根参数，不能用它跑实物演练。** 它在 VM 默认网络命名空间新建 dummy 接口，只对它自己生成的数据安全；这不隔离恢复后存在的真实资源、作业、执行器和运行状态。不能把替换输入路径当作实物演练支持。恢复的 Hub 可能在启动 maintenance 时联系旧 endpoint，包含写、心跳、释放和取消出口。默认监听回环、Host 白名单、只做 MCP initialize、使用 bubblewrap 隔离包内函数，都不能阻止 Hub 宿主网络外连。

### 必须先补的隔离边界

- 在可丢弃 VM 内建立**无 veth、无物理接口、无默认路由**的专用 network namespace，只启用 lo；它没有生产网络出口。不能仅用应用配置禁用资源或黑名单；不得修改恢复的 append-only 内容来造安全状态。
- 所有会读真实恢复数据的进程（restore 启动的 PG、key import、operator-token reissue、records verify、serve、MCP 测试客户端）必须在此 namespace 内以专用非 root 账户运行。SSH 传输进程留在外层，只将标准输入交给 namespace 内命令，不能把 SSH 连接误当隔离内的网络出口。
- systemd 用户 manager 默认属于 VM 主 network namespace。现有 `systemdAgent` 不支持 NetworkNamespacePath，所以实物演练**不能运行现有 service install/deploy/start**。如要检验真实服务，须另建 root 管理的随机 unit，`User=<专用用户>`、`NetworkNamespacePath=/run/netns/<本次名称>`、`Restart=no`；核验服务 PID 的 `/proc/<pid>/ns/net` 与本次 namespace 相同。不得修改平台默认 unit 或真实服务。此独占服务夹具尚未实现/验证。
- root 权限只用于创建/核验/删除自己的 namespace 和独占服务，不用于以 root 运行 PostgreSQL/Hub。全流程用 root 拥有、禁止其他用户改写的固定 wrapper 进入 namespace；wrapper 的账户、根路径、Node/CLI路径、namespace名和 unit 名均由本次清单固定，不接受任意命令，不接受环境继承。
- 在任何数据传输前，用合成探针在 namespace 内确认只有 lo、没有非 lo 路由、没有可用 DNS；访问 VM 外的合成监听点必须失败，而外层相同探针成功。服务启动后再核验 namespace inode、接口/路由；任何未知或检查失败都中止。不得用真实生产地址作负例探测。

### 操作顺序与固定命令

下列是主代理后续准备的操作清单，变量均由协调后的专用清单提供；不是现在执行的脚本。`SOURCE_ROOT` 指本机已有部署，`SOURCE_CLI` 指已合入版本平台入口；`VM` 是专用演练 VM 的 SSH 别名，不能是真实目标；`RUN`、`NS`、`VM_USER`、`VM_ROOT` 和端口均本次唯一。不得把这些变量解析为仓库内的真实配置或从环境文件搜值。

1. 主代理记录合成 e2e 与独审的提交 SHA、各验证层结果及本次实物演练授权；确认 VM 可丢弃、无真实数据/凭据、无共享宿主生产目录。先在 VM 本地文件系统构建固定提交的真实 release，真实 npm ci、PG18 与 ldd 检查均在引入真实数据前完成。配置只允许 namespace 内回环地址与回环 Host，不启动 Hub。
2. VM 管理员使用 `sudo ip netns add "$NS"`，然后 `sudo ip -n "$NS" link set lo up`；不创建 veth 或移动已有 NIC。创建 0700 的唯一 `VM_ROOT` 和仅本次使用的 SSH 接收目录；以专用账户预置目标 settings（只包含本次回环 endpoint、DB socket 和独占密钥服务名）。确认目标 db/objects/vault 为空，尚无主密钥或 operator-token。
3. 在 namespace 内完成上述合成正/负网络探针；设置固定 wrapper，使 `restore <接收备份目录>`、`key import`、`key status`、`operator-token reissue --as <管理员>`、`records verify --vault`、只读 MCP 探针和 `db stop` 全部进入同一 namespace，使用 `env -i` 明确给数据根/Node/PATH/HOME/USER，仅允许清单内的命令。wrapper 不允许 key export、secret show/value 导出或任意 shell。主密钥不作 wrapper 参数。
4. 主代理协调后在本机通过平台命令取最新一致性备份：`CIRCLE_HUB_DATA_DIR="$SOURCE_ROOT" "$SOURCE_CLI" backup`。不手工读取/复制 db、vault 或 objects。若平台报告遗漏文件、校验不完整或其他未知，中止；不把结果归为通过，不自行停止本机服务修补快照。
5. 仅将这次 `circle-hub-backup@3` 的完整目录用 SSH 加密通道复制到 VM 的本次 0700 接收目录。用平台 `restore <接收目录>` 的清单/SHA/表摘要/权限校验作为接收与恢复验收，不打印原文或手工 dump。该命令须经 namespace wrapper 执行；不得先在默认 namespace restore 后再隔离。
6. 通过直接进程管道传主密钥：`CIRCLE_HUB_DATA_DIR="$SOURCE_ROOT" "$SOURCE_CLI" key export --confirm | ssh -T "$VM" <固定的本次 key-import wrapper>`。实际 runner 必须分别记录 export、ssh/远端 import 的退出状态并设超时；不能只检查管道末端。禁止 `tee`、shell tracing、命令替换、捕获 key stdout、重定向到临时文件或终端。远端 wrapper 的 stdout/stderr 只能是平台数量/状态消息，不含字节。失败时不覆盖、不重建主密钥；清理本次 VM 根后重新完整演练。
7. namespace 内通过平台 `key status` 核对存在性；检查目标 keys 目录0700/文件0600/专用属主。源 operator-token 不随 backup 搬运，目标通过正式 `operator-token reissue --as <已恢复管理员>` 另建，token不显示。管理员名字必须由主代理/所有者提供，不读取真实会话或原文搜索。
8. namespace 内执行整合实现的 `records verify --vault`，要求实际非零条目全部可解开；空库不能证明密钥与历史条目一致。各记录类型的核验也是平台命令。只记录 schema、完整性计数、SHA收据、退出码及缺证，不记条目名、正文、凭据、内部地址、数据库行或账号。
9. 若要启动 Hub，须使用上面的独占 namespace systemd unit，不能使用恢复数据里的默认服务安装入口；先核验 unit 的 User、ExecStart、NetworkNamespacePath、数据根及 FragmentPath。用同 namespace 的独占测试客户端经回环完成真实 MCP initialize/工具枚举。无外部 endpoint 请求、无实际只读业务运行、更不能派发作业。网络不可达仅证明隔离，不证明远端停止或真实业务正确。
10. finally 先停止/移除本次 unit，核验进程结束；namespace 内平台 `db stop` 停 PG，核验无本次 PID；确认 `ip netns pids "$NS"` 为空后删除本次 namespace。再删除本次接收备份、解密后的数据库、密文 vault/主密钥文件和本次数据根，最终销毁可丢弃 VM/其磁盘快照。任何清理失败都保留隔离边界并报告缺证，不能先删 namespace 名导致进程失联。绝不删除源备份、源数据/密钥或修改本机服务。

### 尚未关闭的危险缺口

固定 namespace wrapper、systemd root-unit 夹具、合成出口探针、SSH 双端超时与退出码核验、清理进程/namespace后销毁含真实数据的VM磁盘收据，均尚未实现/验证。故**尚不支持自动实物演练，也不可执行上述第4步起的数据操作**。主代理在补齐这些环节并协调窗口后再执行。实物演练不连接真实目标；其隔离内 MCP 成功不等于同事端 Circle 连接成功、生产业务正确或正式切换验收。

### 隔离保护设施实现（未执行）

`testing/linux-rehearsal-isolation.ts` 新增 root-only opt-in 夹具：Node24 + Linux +管理员声明VM门，唯一合成用户、无veth且仅lo的唯一namespace，私有chroot文件系统，真实systemd-run瞬时单元的User/RootDirectory/NetworkNamespacePath，去全部capabilities/NoNewPrivileges/禁止新namespace/隐藏其他用户proc/只读发布和动态库，只允许本次/data写入。没有绑定宿主/home、共享挂载或现有部署目录。

夹具只接受预备的真实代码release，生成全合成外层TCP哨兵与文件；先正向证明VM外层同一哨兵可达，再在真实瞬时systemd进程里证明不可达、宿主路径不可读、发布不可写及Node子进程netns继承。显式检查namespace接口和IPv4/6非lo路由。失败保持禁止实物状态；namespace仍有PID时不删除。没有任何真实backup、主密钥或环境读取入口。

新增 `linux-rehearsal-isolation.test.ts` 包含拒绝foreign identity/escaping path/任意入口的合成负例，以及显式opt-in管理员VM实证入口。此夹具尚未运行/类型检查；并未证明当前hublinux已授予systemd/root权限或可用RootDirectory/ProtectProc。它只实证基础隔离，不执行restore/serve/PG，因此PG/Hub进程树继承和真实数据阶段的固定命令wrapper/传输编排仍未关闭，不能开始实物。所有实物数据操作仍由主代理协调后另行实现与审查。

### 84b16edc 静态审查阻断修正（仍未运行）

- 宿主动态库/发布/Node/数据绑定先以真实规范路径定位其 mountinfo 的本地 ext4/xfs/btrfs 设备与 mount root；任一绑定源含子挂载或处在 virtiofs/9p/NFS 等未允许文件系统上即拒绝。隔离内逐个核设备、来源根和目标，未声明的真实文件系统挂载一律失败；不再用“mountinfo 非空”作证明。此严格规则可能拒绝 systemd 自动生成的额外挂载，未在VM跑过前不能放宽或声称可用。
- 哨兵在 rootfs 外的本次独占目录：仅 visible 单文件绑定到 `/sentinel/visible`，兄弟 hidden 不绑定；同时验证内路径、self/root路径与父进程 `/proc/<pid>/root` 逃逸拒绝。
- 取消任何按猜测名称 `systemctl stop` 的逻辑。同步 `--wait --collect` 成功后才读取真正systemd进程产生的 InvocationID/UID/netns/root inode收据。失败或超时不停止可能同名的他人unit；RuntimeMaxSec限制瞬时unit寿命，仍有PID时保留namespace/账户/目录并披露失败。
- namespace创建成功后登记dev/inode，删除前重核且要求无PID；账户创建成功后登记UID/GID和精确passwd/group行，删除前重核；rootfs和外部哨兵目录删除前核规范路径及dev/inode/属主/类型。未知不删。
- root固定为 `/var/tmp/chvm-<本次12hex>`，user/namespace/unit同suffix，data固定root/data；release固定专用 `/var/tmp/chvm-build-<12hex>/release`。禁止 `/`、重复斜线、dot/parent跳转、符号链接祖先与非管理员可改写的绑定源祖先；发布树必须管理员冻结，内部symlink仅能留在该发布内。

新增可复现合成负例覆盖宿主库子挂载、共享源、错误mount root/额外挂载、替换inode/设备/属主/文件类型、`/`与suffix不一致、symlink和词法重解析。全部尚未运行；原始 `pipeSyntheticKey` 仍只用于合成测试，不能作为真实主密钥传输保护设施。真实数据阶段继续关闭，不能用此补丁代替独审、完整测试与真实PG/Hub进程树实证。

### 21fe5fdc 绑定源自证阻断修正（未执行）

取消外部release路径输入，管理员VM夹具先冻结本机根挂载基线（唯一target=/、mount-root=/、ext4/xfs/btrfs设备），然后在唯一新建build根内从固定Git提交archive做真实npm ci；使用本次私有HOME/npm配置/缓存，不能读取现有部署release或任何环境文件。账户、namespace和服务全部晚于封闭构建。新stage发布只能由这一条内部路径产生。

所有绑定期望设备来自构建前冻结的VM根设备，期望mount-root直接等于本次规范源绝对路径；不再从当前源covering mount推导。任何非根挂载覆盖源自身、任一祖先或子树均拒绝，包含“同一ext4设备上的production目录bind到合规release路径”与“bind到/usr/lib”。VM根设备在预备后改变、根自身mount-root不为/、独立/usr或/var挂载等未知拓扑也拒绝，不猜测其安全。隔离内仍核对独立期望表。

新增精确反例：同设备 `/srv/production-release` bind覆盖合规release与/usr/lib，/var/tmp祖先被覆盖、根设备更换、根本身来自非/子树；均应拒绝。未执行这些测试或实际构建。此基线信任管理员声明的可丢弃VM启动根；无法证明该根来源时必须拒绝启动，不将被验证源的当前mountinfo当来源证明。初期构建失败可能保留无真实数据的本次build根供管理员确认npm子进程退出后清理，不执行模糊进程清杀。实物仍关闭，尚无真实Hub/PG树或真实密钥管道验收。
