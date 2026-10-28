# 任务：把 Hub 移植到 Linux，并迁到服务器 172.16.2.90（交给 codex 全程负责）

依据：所有者 2026-10-28 的要求"本地数据库的内容如果让同事做，他现在访问不到，得想办法迁移到 2.90 的服务器上"，以及他对下面四个问题的答复（决定 78）。集成者的额度快用完了，**这件事由 codex 从头到尾负责**：自己拆步骤、定默认值、写代码、测、复核、合入、写运行手册；只有下面列的"所有者专属"事项才停下来问。

## 所有者的决定（2026-10-28，已定，不要再问）

1. 目标：Linux，就是文档库那台 172.16.2.90。
2. 凭据：**把现有密钥库里的凭据原样搬过去**（集成者建议过改用服务账号，所有者没采纳；记入后续可选项，不影响本任务）。含义：新服务器上的密钥库主密钥要与本机钥匙串里的一致，由平台命令传过去，**密钥不显示、不落盘成明文临时文件、不进日志和简报**。
3. 访问：**Hub 直接监听内网地址**，同事的 Circle 直接连。所有者批准了这台部署对内网暴露（只限这一台、只限内网）；默认配置仍然只监听本机，非本机监听必须显式配置。
4. Linux 上包内函数的隔离：**用 bubblewrap 做等价隔离**，保持"包内函数不能联网、不能写文件、不能起别的程序"的设计；不要降成"只用 Node 权限模型"。

## 要搬的东西与不搬的东西（集成者在本机量过）

- 数据根里：`db/` 约 6.1 GB（`backup` 导出的 `database.dump` 约 1.1 GB）、`objects/` 约 4.7 GB、`vault/` 60 KB（加密条目）、`config/`。这些是要搬的，已有的 `circle-hub backup` 与 `restore`（`circle-hub-backup@3`，带 SHA-256 清单和行数/摘要核对）就是搬运格式。
- 不搬：`releases/`（15 GB，各提交的部署副本）、`set-aside/`、`backups/`（19 GB）、`packs/`（派生数据，注册表会按对象重建）、`logs/`。
- **钥匙串不进备份**：密钥库主密钥在 macOS 钥匙串里。目标上没有同一把钥匙，密库条目就打不开。所以要做 `key export`（只在标准输出不是终端时输出，需要明确确认参数）和 `key import`（从标准输入读，写进目标的密钥文件，权限 0600，已存在不覆盖），用管道 `circle-hub key export | ssh <目标> circle-hub key import` 传，不经过屏幕和磁盘。操作令牌（钥匙串项 `operator-token`）不搬，目标上用 `init-admin` 另建。
- 用户和令牌的哈希在数据库里，随库搬过去；同事的令牌由管理员在目标上 `token issue` 另发。

## 现状（已查明，不用重查）

- `hub/platform/README.md` 开头就写"macOS 上的单机持久部署"。macOS 专有的面很集中：`hub/platform/launchd.ts`、`process.ts`（launchctl）；`keychain.ts`、`keychain-items.ts`、`rehearse.ts`、`hub/server/assemble/operator-token.ts`（`/usr/bin/security`）；`backup.ts`（Homebrew 的 libpq 路径 `/opt/homebrew/opt/libpq/bin`，可用 `CIRCLE_HUB_LIBPQ_BIN` 改）；`layout.ts`、`cli.ts`（默认数据根 `~/Library/Application Support/circle-hub`）；`release.ts`、`backup.ts`（`.DS_Store`）。
- 沙箱隔离在 `hub/rules/sandbox/isolation.ts`：`isolatedCommand()` 一处拼命令行，macOS 用 `sandbox-exec -p <profile> node --permission …`，探测在 `probeSandboxExec`，非 darwin 一律"不可用"；`orphans.ts` 里有 darwin 分支；`connectors.ts`、`sandbox.ts`、`bootstrap.ts`、`hub/runs/engine/deps.ts` 有"要求系统级隔离"的开关。Linux 上要做的是：用 bubblewrap（无网络命名空间、只读绑定 Node、引导脚本、包目录、声明的依赖，其余不绑定，所以别的程序根本不在里面；PID/IPC 命名空间、`--die-with-parent`、`--new-session`），保留 `--permission`、`ulimit -t`、堆上限等现有手段。
- 嵌入式 PostgreSQL 的 Linux 平台包由 `embedded-postgres` 的可选依赖提供（公开 CI 的 Ubuntu 上验收测试已经在用）；`pg_dump`/`pg_restore` 不随它带，Linux 上用发行版的 `postgresql-client-18`（大版本必须和服务端一致）。
- HTTP 面在 `hub/server/app.ts`、`http.ts`：只监听回环，Host 检查只放行 `127.0.0.1:<端口>` 和 `localhost:<端口>`（防 DNS 重绑定），Origin 只放行回环来源，控制台的 POST 要求同源。非本机监听需要：显式的监听地址配置、显式的允许主机名单（Host 和 Origin 都按它放行）、令牌照旧必须；`/healthz` 可以不带令牌。
- 本机已起一台 Ubuntu 24.04（arm64）虚拟机用来测 Linux：`limactl shell hublinux`（6 核、12 GB、80 GB；若没起来，`limactl start hublinux` 或按 `limactl start --name=hublinux --cpus=6 --memory=12 --disk=80 template://ubuntu-24.04` 重建）。在里面装 Node 24、bubblewrap、`postgresql-client-18`（PGDG 源）。**不要在 macOS 挂载的目录里跑 Linux 的 `npm ci`**（原生模块会混）：把你的工作树 rsync 到虚拟机自己的磁盘（排除 `node_modules`），在那里 `npm ci` 和跑测试。目标服务器多半是 x86_64，所以也要让 CI 的 Ubuntu（x64）能跑你写的 Linux 测试。

## 交付物（按这个顺序，各一个分支一个提交序列，合入前独立复核）

1. **`linux-isolation`**：bubblewrap 后端（命令拼装、探测、孤儿清理、错误文案），以及真正在 Linux 虚拟机里执行的测试：断言包内函数联不了网、写不了文件、起不了别的程序、读不到未绑定的路径；探测在没有 bwrap 或用户命名空间被禁时给出明确的不可用原因（Ubuntu 24.04 默认用 AppArmor 限制非特权用户命名空间，要在运行手册里写清楚怎么放行）。现有因"没有沙箱隔离"而在 Linux 跳过的测试，在有 bwrap 的 Linux 上应当真的跑。
2. **`linux-platform`**：把 `init`、`db`、`key`、`service`、`backup`、`restore`、`deploy`、`rollback`、`rehearse`、`status` 做成能在 Linux 上跑：平台适配层（数据根默认值：以服务用户运行时用 `/var/lib/circle-hub`，否则 `$XDG_DATA_HOME/circle-hub`；密钥提供者：Linux 用密钥文件，0600，所在目录 0700，属主是服务用户；服务管理：systemd 单元，等价于 LaunchAgent 的"崩了自动拉起"；libpq 工具查找：`CIRCLE_HUB_LIBPQ_BIN`，否则 PATH 里与服务端大版本一致的）。macOS 路径行为不变，所有现有测试仍过。
3. **`hub-listen`**：可配置监听地址和允许主机（环境类别 `shared` 可用），默认仍是回环；非回环必须同时配置允许主机；写入 `config/platform.json` 并进 `status`；Host/Origin/控制台同源检查按配置放行；加测试（含 DNS 重绑定的反例：不在名单里的 Host 被拒）。TLS：本任务不做内置 TLS，运行手册里写"前面放反向代理终止 TLS"的做法和风险（内网明文令牌可被嗅探），由所有者决定是否上。
4. **`key-transfer`**：`key export`（macOS）、`key import`（Linux/macOS）、`key status`，以及传输后在目标上用 `records verify` 证明密库条目能打开。密钥任何时候不出现在屏幕、日志、命令行参数、环境变量里。
5. **`linux-runbook`**：`docs/hub-linux-deploy.md`——目标服务器的前置清单（系统版本、架构、Node 24、bubblewrap 与命名空间、`postgresql-client-18`、磁盘 ≥ 40 GB、服务用户、防火墙只放行内网网段、到各被读系统的网络可达：PLM 查询服务、敏捷平台、构建站、SVN、手册库、堡垒机/网关）、安装步骤、**切换步骤**（本机先 `backup` → 冻结写入（停 Hub）→ 传输 → 目标 `restore` 并核对清单 → `key import` → 启动 → 冒烟：健康检查、`records verify`、一次只读运行、一次 Circle 连接）、回滚（切换前本机保持为准，目标失败就在本机重新启动）、日常运维（备份、升级、发令牌）。目标机上的实际切换需要 SSH 账号和 sudo，**由所有者或同事执行，你只准备脚本和清单**。
6. 合入后另起一件：把以上改动同步到公开仓库（沿用 `public-snapshot-r6.md` 的做法），这件先不做，等所有者说。

## 规则

- 你自己拆分、定默认值，写进各分支的任务页或 README；终端里只在"所有者专属"事项上停下来问：到 172.16.2.90 的 SSH 账号与 sudo 怎么给、什么时候做切换（要停 Hub 一段时间）、防火墙和 TLS、服务账号是否仍要改。
- 工作树和分支：每件从 `hub-redesign` 开（目录放你自己的树目录下，依赖链接参考别的树）；`git commit -s`，只暂存明确路径，一句话英文祈使句，不推送、不建 PR、不发布；合入用 `wf/merge-locked.sh <分支> "<一句话>"`（它会跑 tsc、契约检查、docs 三道关口），**合入前必须**：本机 macOS 完整套（`hub/**`、`packs/**`、`contracts/**`、`scripts/**`、`.github/checks`，并发 2）全绿、Linux 虚拟机里的相关套全绿、请另一个终端（kimi 或 cursor，不同模型家族）做一次独立复核并把结论写进分支。
- 红线同 `AGENTS.md`：不动本机正在运行的部署（不 stop、不 deploy、不改数据根；只读的 `status` 可以；要做备份演练用 `rehearse` 或自建的临时数据根）；不碰钥匙串里的真实密钥（测试用临时钥匙串和临时密钥文件）；不打开环境配置文件；测试只用合成数据；不放松任何断言，不删测试；不碰任何真实系统和设备。
- 公开 CI 的 Ubuntu 没有 sandbox-exec，现有 282 个常规单元和 9 个验收测试在那里被跳过；有了 bubblewrap 后，应让这些测试在 Linux 上真的跑（CI 里装 bubblewrap 与放行命名空间是工作流改动，**要所有者批准**，先在运行手册里写做法，不要改 `.github/workflows`）。
- 完成后写报告到 `handoff/linux-migration-report.txt`（持久工作目录的 handoff 子目录），终端里只回一行结论加路径；交接文档 `HANDOFF.md` 由集成者维护，你不要改（里面有本机真实值）。

## 补充：所有者的答复（2026-10-28，覆盖上面对应的"专属事项"和红线）

- 登录：**直接用 root** 登录 172.16.2.90。集成者为这件事生成了一对专用 SSH 密钥（私钥只在本机，权限 0600，文件名 `circle_hub_2_90`，在本机用户的 `.ssh` 目录下；公钥注释 `circle-hub-migration-2026-10-28`）；所有者用 root 密码把公钥装到目标机一次后，用 `ssh -i <该私钥> -o IdentitiesOnly=yes -o BatchMode=yes root@172.16.2.90` 登录。**不要把 root 密码写进任何文件、简报或命令行**；密钥只用于这件事，迁完在运行手册里写明如何从目标机的 `authorized_keys` 里删掉。先用 `BatchMode` 试一次，登录不了就在终端里告诉集成者"密钥还没装"，不要去找密码。
- 时间：**随时都可以切换**。但切换前要核对：本机 Hub 没有未结束的作业（`job list`）、没有被占用的租约（`lease list`）、没有进行中的运行；停 Hub 前先在终端里回一行"即将切换"，让集成者通知所有者。本机的数据和部署切换后原样保留（只停服务，不删任何东西），作为回滚。
- 防火墙：只放行 `172.16.0.0/16`。
- TLS：**不加**。运行手册里把"内网明文令牌可被嗅探"作为已知并被所有者接受的风险写一句。
- 对"不动本机正在运行的部署"的修改：只在运行手册规定的切换步骤里、并且满足上面的核对之后，才可以对本机部署做 `backup`、停服务、`key export`；除此之外仍然不动。
- 对目标机的限制：只做**加法**——新建服务用户和目录、装 bubblewrap 与 postgresql-client-18 与 Node 24（若系统没有）、放 systemd 单元、加一条只对 `172.16.0.0/16` 开放 Hub 端口的防火墙规则；**不要碰文档库（OpenKM 等）现有的服务、端口、数据和配置**。先做只读预检（系统版本与架构、磁盘与内存、已占用端口、已有的防火墙、Node 与 bwrap 是否在、用户命名空间是否被禁）并把结果写进报告，预检不过就停下来问。
- 顺序：1–4 件合入且 Linux 虚拟机测试全绿 → 在虚拟机里用最新的真实备份加真实的密钥管道（`key export | ssh` 到虚拟机）整套演练一遍（演练完删掉虚拟机上的数据和密钥）→ 目标机预检 → 安装 → 切换 → 冒烟（健康检查、`records verify`、一次只读运行）→ 报告。

