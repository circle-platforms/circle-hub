# GitHub 六目标合成检查

## 来源与范围

所有者于 2026-10-28 要求参考 Circle 的发布标准与 GitHub 管理方式，覆盖 macOS、Windows、Linux 的 x64 与 arm64，Windows 测试使用 GitHub Actions。此任务只准备本地检查入口，不执行推送、PR、tag、发布、部署、远端设置或真实系统访问。基于 hub-redesign 创建独立 github-platform-matrix 分支。

允许修改的路径：

- `.github/workflows/platform-matrix.yml`
- `.github/checks/platform-matrix.ts`
- `.github/checks/platform-workflow.test.ts`
- `docs/hub-r4-tasks/github-platform-matrix.md`

## 设计与限制

参考 Circle 工作流的六个原生 runner 标签；使用 Hub 既有的完整 SHA 固定 checkout/setup-node，只授予 contents:read，checkout 不持久化凭证，依赖安装禁用生命周期脚本。入口为 workflow_dispatch 及明确限定的 synthetic-platform/** 分支 push；未合入默认分支前，workflow_dispatch 本身不能作为首次触发保障。这里不新增发布流程，不使用 secrets、environment、pull_request_target 或产物上传。

每个 runner 硬核对 Node 的实际 platform/arch，执行合成 contracts 测试。测试进程超时、退出非零、未执行、取消、跳过、todo 均不能变绿；汇总列出实际计数。静态检查约束六目标、入口、权限与 actions 固定方式。

此矩阵仅验证原生 Node 上的合成契约；不证明 Hub 服务、密钥保管、沙箱、数据库、安装包或业务正确性。Windows 运行时打包、原生服务、凭证存储与规则沙箱仍缺验收，Windows job 在测试后额外明确失败。不得把该失败改为 skip 或 continue-on-error 来宣称支持。macOS/Linux 合成契约即便通过，也不构成发布支持验收；发布需另补运行时打包和平台端到端测试。

公开验证之前必须从完整去标识化的干净公开快照生成测试分支，经所有者授权后再推送；不能直接推送开发工作树。此任务未执行任何 GitHub Actions，六个 runner 的当前可用性与实际结果未验证。

## 验证记录

初始提交时 macOS 测试窗口忙，未运行测试。集成者随后释放窗口并授权定向验证；仅链接既有依赖，未安装或联网。

- `node --test --test-concurrency=2 .github/checks/platform-workflow.test.ts`：退出 0；tests 1、pass 1、fail 0、cancelled 0、skipped 0、todo 0。
- `./node_modules/.bin/tsc --noEmit -p .github/checks`：退出 0，无输出。
- `git diff --check`：退出 0。

窗口已释放。未运行完整 contracts、完整 docs 套件或平台集成测试；仍需在授权公开快照上获得六个原生 runner 的实际证据。
