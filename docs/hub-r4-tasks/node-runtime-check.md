# 入口检查 Node 版本，沙箱不可用时写出原因（issue #291）

来源：issue #291（Wangjuan-123，2026-11-09 生产环境）；所有者 2026-11-10“按照这个思路处理所有issue和PR”；基线 `origin/main` 7af42770，分支 `fix/node-runtime-check`。

## 允许路径

- `bin/circle-hub`、`hub/platform/bin.test.ts`
- `hub/rules/sandbox/{isolation.ts,sandbox.ts,sandbox.test.ts,isolation-failure.test.ts}`
- `CHANGELOG.md`、本任务页

## 现象和原因

生产上 `knowledge sync`、`knowledge seed`、喂入投影都失败，报“沙箱现在不能运行包内函数”，而健康检查是 200。issue 判断原因是“服务和 CLI 没有用 `--permission` 启动 Node”。核对代码后不是这样：

- 沙箱的子进程一直由 Hub 自己带 `--permission` 启动（`hub/rules/sandbox/isolation.ts`），父进程不需要这个参数。子进程用的是和父进程同一个 Node（`process.execPath`）。
- 探针退出码 22（`node_permission_drop_missing`）的意思是：这个 Node 在 `--permission` 下没有 `process.permission.drop`。本机核对：Node v24.21.0 带 `--permission` 时有 `drop`，不带时 `process.permission` 整个不存在；issue 里“自带 Node 裸跑没有 drop”是后一种情况，不能说明自带 Node 不行。
- issue 记录命令行解析到系统的 Node v22.22.3，它的权限模型没有 `drop`。`bin/circle-hub` 用 `#!/usr/bin/env node`，`package.json` 写了 `engines.node >= 24`，但启动时没有任何地方检查版本，所以在 Node 22 上命令照常运行，只有沙箱一直拒绝。
- 服务一侧用哪个 Node，取决于安装时写进服务定义的绝对路径；生产上那台机器的服务定义我没有看到，没有核实。

## 决定

- `bin/circle-hub` 在加载任何模块之前检查 Node 主版本，低于 24 就写明当前版本、实际运行的 Node 路径和处理办法并退出 1。服务用低版本 Node 启动时同样在这里停下，不再带着不能用的沙箱运行。
- 因缺少操作系统隔离而拒绝运行时，错误信息写出探针给出的那一个原因（`isolationFailureText`），不再用列出四种可能的那句话；原因码仍在 `detail.probe` 里。
- 不改健康检查，也不在探针失败时拒绝启动：没有隔离工具的开发机和 CI 的常规单元测试都依赖 Hub 在这种情况下照常启动。探针失败时是否应让健康检查降级，留给所有者定。

## 验收

- `hub/platform/bin.test.ts`：预加载模块把 `process.versions.node` 报成 22.22.3 时，命令退出 1，标准输出为空（没有加载任何命令模块），错误信息写出版本、运行的 Node 路径和处理办法；当前 Node 下照常运行。
- `hub/rules/sandbox/isolation-failure.test.ts`：八种探针原因各有自己的一句话，都不显示原因码；缺 `drop` 的一句写出 Node 版本和“需要 Node 24 及以上”；没有列出的原因按原样显示。
- `hub/rules/sandbox/sandbox.test.ts`：没有隔离时的拒绝信息以“沙箱现在不能运行包内函数：”开头，不再含“排队已满或 Hub 正在停止”。这一项只在没有隔离的机器上运行，本机跳过，由 CI 的常规单元测试执行。

## 不做

- 生产机器的修复（让服务和命令用自带的 Node 24）是运维操作，需要所有者安排；本任务没有接触任何真实环境。
- 不建议给整个服务加 `NODE_OPTIONS=--permission`：那会把数据库、对象存储等全部读写都放进权限模型的白名单里，漏一条路径就是新的故障。
