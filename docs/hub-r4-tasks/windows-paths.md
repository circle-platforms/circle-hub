# Windows 目标映射与路径准备

## 授权与路径

所有者要求六目标统一发布、Windows 使用 GitHub Actions 验证；集成者分派本任务，从 `hub-redesign` 的 `a720a9de` 建立 `windows-paths` 分支与独立工作树。仅准备不依赖原生 API 的映射、路径和 PostgreSQL 查找；不证明 Windows 已支持。

允许修改：

- `hub/platform/target.ts`、`hub/platform/target.test.ts`
- `hub/platform/layout.ts`、`hub/platform/postgres.ts`
- `hub/platform/README.md`
- `docs/hub-r4-tasks/windows-paths.md`

不改 Circle、workflow、HANDOFF、依赖、模型或生成物；不推送、合并、发布、部署；不读取环境文件、密钥或真实系统。按集成者指示，本轮不运行测试或 typecheck，避免与正在运行的 macOS 全量验收竞争；验证由后续集成完成。

## 范围与缺口

- 对照 Circle `src/install_layout.ts` 的 `win32` → `windows` 与 `.exe` 命名。Hub 使用自己固定的 PostgreSQL 包目录，不复制 Circle 安装实现。
- Windows x64 只映射锁文件已有的 `@embedded-postgres/windows-x64`；Windows ARM64 无固定原生包，拒绝猜测和自动 x64 替代。混合架构尚待决定与原生 runner 实测。
- `layoutAt(root, 'win32')` 和 `postgresBinaryPaths(root, platform, arch)` 可在非 Windows 主机做纯函数验证。路径规则只做词法拒绝，不证明 ACL、重解析点或文件系统边界。
- 保留现有 Unix 路径和 PostgreSQL socket/peer 语义。Windows 创建目录与数据库控制器在执行原生操作前拒绝；服务、密钥与隔离未实现，不能宣称可用。
- 默认数据根仍是已有实现；Linux 默认路径由 `linux-platform` 任务负责，本任务不覆盖。Windows 默认数据根、ACL、服务、数据库传输与认证、密钥、OS 隔离、工具/DLL 清单与摘要、原生运行均未完成。

## 验证

新增合成纯函数正例和反例，覆盖固定包、架构拒绝、扩展名、Windows 分隔符、本地盘符、UNC/设备路径、ADS、越界段、保留设备名、命令字符和 Unix 不回退。按任务指示没有运行这些测试，没有 red/green 收据，没有平台通过数。仅作 Git diff 与源码静态复核；Windows GitHub Actions 原生验收仍待后续任务。
