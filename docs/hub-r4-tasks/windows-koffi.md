# 固定 Windows 适配依赖

## 来源与范围

所有者在 2026-10-28 本次会话明确授权：Hub 引入并固定与 Circle 相同版本的 koffi，仅用于 Windows 适配模块，版本与完整性锁死；Windows 沙箱与密库以 Circle 实现为参考，Linux 优先。本任务只准备依赖，不实现或执行平台适配。

分支：`windows-koffi`，基线：`hub-redesign` 的 `a720a9de8e5e26c145b8535b407837403a03f9f5`。

允许修改的路径：

- `package.json`
- `package-lock.json`
- `docs/hub-r4-tasks/windows-koffi.md`

不改 Circle、工作流或其他依赖，不接触环境文件、密钥或真实系统；只作本地签署提交，不推送、不合并。

## 依赖决定

只读核对 Circle 的 `package.json` 与 `package-lock.json`：koffi 精确版本为 `3.3.3`，包完整性为 `sha512-XWNI4eyxJJzR2MakPZzR3QeZ06JOklLbxglin0dHhx/qIQCby8lqHs9Acq4Q7CpCKnOrBSj+6b9J5y69wfr2ZA==`。沿用已选版本，避免 Windows FFI 适配引入另一套版本；本任务不复制 Circle 的运行时实现。

锁文件使用 npm 官方命令生成，关闭安装脚本、审计与资助请求，使用公开 npm registry 和临时配置、缓存；核对新增 koffi 与全部可选平台包的版本、下载地址和完整性均与 Circle 锁文件一致，已有包条目保持逐项相同。平台包进入锁文件不代表 Hub 在相应平台调用 koffi；运行时导入仅限后续 Windows 适配模块。

## 验证与限制

执行 `npm install koffi@3.3.3 --package-lock-only --ignore-scripts --save-exact --no-audit --no-fund --registry=https://registry.npmjs.org`，另以临时配置、缓存与空环境隔离用户 npm 配置；退出码 0。npm 11.13.0 自动移除了锁文件根条目中原有而清单未声明的 `bin` 元数据；保留 npm 官方重新生成的结果，不手改锁文件；此根元数据清理不涉及依赖版本或完整性。

Node 静态核对脚本退出码 0：304 个已有依赖包条目逐项深比较不变；新增 21 个 koffi 包条目的版本、下载地址与完整性逐项匹配 Circle 锁文件；清单只增加精确版本的 koffi。`git diff --check` 退出码 0。

本任务按分工不执行安装脚本、类型检查或测试。Windows 原生 runner 尚待验证，不能据此声明 Windows 沙箱或密库可用。
