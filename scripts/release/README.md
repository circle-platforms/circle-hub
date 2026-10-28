# 发行工具（未接入）

本目录独立于 `hub/platform/release.ts` 的机器部署记录。实现以 Circle 的 `scripts/build-release.ts`、`src/install_layout.ts`、`scripts/smoke-release.ts` 和 `.github/workflows/release.yml` 为对照，适配 Hub 的完整依赖、PostgreSQL 及隔离要求。

当前已有清单与固定表、可注入的原生构建流程和文件安装/升级流程，以及待执行的合成回归。构建/安装新增实现尚待测试；服务接入、完整原生 smoke、下载解包安装入口、Actions 或 GitHub Release 操作未实现；任何平台均没有由本目录建立的发行支持结论。`assertReleaseReady` 当前始终失败，不接受调用者自报成功来解除阻塞。它还未被任何现有部署或发布入口调用。

## 构建接口设计

原生 runner 上 `build-release.ts` 从当前提交的显式路径清单归档应用：`bin`、`hub`、`contracts`、`packs`、`scripts/release`、锁文件及许可证；禁止复制工作树目录，以免带入未跟踪环境和运行数据。创建 `circle-hub/app` 和 `circle-hub/runtime`，仅应用目录执行 `npm ci --include=dev --no-audit --no-fund`。不改 npm 脚本/可选依赖语义，不删 `.bin` 链接；检查目标 PostgreSQL 实际安装和可执行性。

固定 Node 归档必须通过原始归档 SHA-256 后才能解压；仅复制对应 Node 二进制与许可证。每个目标均使用原生 Node 执行自检，不能跨编译后把目标名当执行证据。构建完成后写 `release.json`，重新读取逐文件清单，再打 `circle-hub-<version>-<target>.tar.gz`（Windows 为 zip）和独立 `.sha256`。外层摘要不代替清单。Windows ARM64 没有 PostgreSQL 依赖时在构建前明确失败，不产成功包。

## 安装与升级接口

沿用 Circle 的 `install.sh`/`install.ps1` 下载、核验、解包、检查、复制顺序和版本目录布局；Hub 独立安装目录与数据根永不重叠。安装管理器从解包根执行 `verifyDistribution`，核对审核固定表及预期版本/目标/提交，运行包内 Node 读取应用版本（必须是纯读取路径，不加载平台配置、环境或钥匙串），再把包复制到暂存版本目录，重新校验后原子切换启动入口。

失败发生在切换前时，当前版本保持可用；切换后的服务启动失败时应恢复旧入口并报告原始失败。不得自动迁移、删除或重建数据库。平台部署协议应由平台包明确提供 API；安装器不能私自重写配置、调用真实 key 命令或操作正在使用的数据根。Windows 在服务适配和安全隔离实现前没有安装成功结论。

## 原生 smoke 接口设计

每个 runner 建临时 home/数据根，封闭继承环境，不从开发者的默认 home 查找凭据或设置。下列断言全部运行通过后才产证据文件，`skip`/缺失/未执行均失败：

- 原生 Node 和 PostgreSQL 的架构、版本，CLI 与 package.json/lock/manifest 版本一致。
- 解包校验、移动整个安装目录后的启动及默认路径安装；路径含空格。
- 使用临时合成数据库初始化、启停服务、健康检查和只读完整性检查；不触及已部署实例。
- 真实目标系统级函数隔离反例：联网、写文件、起其他程序、读未声明路径都被拒绝。
- 用第二个合成版本完整安装升级，切换后新进程健康；应用数据、密库加密字节和配置原样保留。
- 归档摘要错误、普通文件篡改、增加/删除文件、越界/悬空链接、错误目标、错误版本及错误运行时均拒绝，旧版本仍可启动。

证据至少绑定归档 SHA-256、manifest SHA-256、源码提交、版本、目标、runner OS/架构、Node 和 PostgreSQL 版本、每条断言的执行结果及命令。证据由 smoke 实际执行生成；合成文件不能证明原生 smoke。原始日志只留 runner 临时工件，不携真实数据或密钥。

## 六目标发布门禁设计

未来 Actions 的六目标矩阵与 Circle 同名：`ubuntu-24.04`、`ubuntu-24.04-arm`、`macos-15-intel`、`macos-15`、`windows-2025`、`windows-11-arm`。Windows 以 GitHub Actions 验证；本机模拟结果不替代。原生 job 的必需安全与数据库检查不可 `continue-on-error`、条件跳过或以 `echo` 代替。

未来 draft/publish 作业只消费同一审核源码提交的六目标资产，逐一重算资产摘要并检查原生证据及完整目标集合；不接收多余/重复目标或其他提交证据。所有目标齐备才解除 draft。手动演练不发布，任何失败都保持未发布。当前未编写此工作流，未操作远端；公开快照与运行授权是另一步。


## 当前代码接口

- `buildRelease({source, output, runner?, download?})`：只读提交构建，固定 Node 下载摘要，完整 npm 安装，PG/OS 隔离/版本检查后写资产。`runtimeFor` 仅为合成测试固定输入替换；使用注入实现得到的结果不是原生构建证据。
- `installRelease(root, {prefix, dataRoot, expected, runner?, checkActivation?})`：从已解包且来源可信的目录安装应用文件；数据根只做路径隔离检查。原子 staging、排他安装锁、切换后检查失败恢复指针。不会操作服务，也不会删除旧版本。
- `smokeExecutable` / `smokePlatform`：执行包内 Node、CLI、PG 的检查与真实隔离探针。它们仍不是临时 PG 初始化、服务生命周期和隔离全反例验收的替代。

目前 Windows 两目标直接失败；macOS/Linux 即使版本和探针检查成功，也只证明对应命令检查，不构成已完成部署或全套发行验证。


`install-release.ts` 提供本地已解包可信目录的命令入口，要求显式预期版本和提交。`smoke-release.ts` 提供实际执行安装启动器、升级、搬迁、篡改拒绝和持久目录合成 canary 保留的流程；默认使用真实命令执行，测试注入 scripted runner。此文件级 smoke 尚未执行真实原生包，不包含临时 PG 初始化、服务生命周期或完整隔离负例，不能代替六目标发布验收。

应用包内含安装管理器及其本地依赖/固定表，解包后可通过 `runtime/node app/scripts/release/install-release.ts ...` 安装到独立前缀；不依赖源码仓库或系统 Node。外层归档摘要和安全解包仍由调用者完成，尚未提供网络 bootstrap 安装器。

当前目标检查来自 `process.platform/process.arch`、Node/PG 的 ELF64 或 Mach-O 头以及命令执行输出；这能检查二进制声明的 CPU/OS，但不单独证明宿主硬件架构或排除模拟执行。未来 runner 验收还必须绑定 OS/runner 架构与 PostgreSQL 可执行文件架构，尤其不能把 ARM64 上的 x64 PostgreSQL 说成原生 ARM64。

平台依赖尚未闭合：此任务分支基线尚无 Linux 服务/密钥适配的公共 capability API。构建检查 PG 与系统级函数隔离，不检查完整服务生命周期；文件安装成功不代表平台部署支持。需平台包提供纯只读能力接口或由集成者在包含平台实现的提交上执行完整原生验收，不能通过某个后端文件存在来判定可用。Windows 在这些接口和证据具备前仍无条件拒绝。
