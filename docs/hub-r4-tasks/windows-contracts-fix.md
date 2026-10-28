# Windows 契约测试路径和权限修复

分支：`windows-contracts-fix`，从 `hub-redesign` 的 `23df48c6` 创建独立工作树。授权来源：集成者转述所有者授权 Windows x64/ARM64 GitHub Actions 合成验证，并明确本任务不运行测试、不访问远端。

允许修改的路径：

- `contracts/src/generator.test.ts`
- `contracts/README.md`
- `docs/hub-r4-tasks/windows-contracts-fix.md`

## 归因和改动

集成者提供的公开运行 `40635243418`：Windows x64 和 ARM64 契约测试均 334 通过、2 失败。这里未访问远端，计数是输入证据，未重新核实。

源码确认符号链接根测试将本机绝对路径直接写入内联 ESM import；Windows 盘符导致 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。生产生成器已经使用 `pathToFileURL`，因此仅将测试导入路径改为标准文件 URL，保留退出状态和完整快照比较。

第二个样例通过 `chmod(0555)` 设置拒写目录；Windows 上该操作不能表达目录 ACL 拒写。Windows 分支改用系统自带 PowerShell 取得当前用户 SID，并用 `icacls` 拒绝临时目录新增文件/目录；POSIX 分支保留原 chmod。新增真实写入探针必须得到 `EACCES` 或 `EPERM`，再检验原有退出 3、诊断前缀和无堆栈断言。最终恢复权限；ACL 设置失败或恢复失败不降级为跳过。原有 POSIX root 跳过条件保留，未增加 Windows 跳过。

## 验证状态和 runner 命令

按指示未运行测试、类型检查或生成器；未访问远端，未修改 workflow、Circle、HANDOFF、生产代码或生成物。仅静态检查补丁。Windows ACL 和恢复行为尚未运行验证，不能称为通过。

由集成者在已授权 GitHub Windows x64 和 ARM64 合成 runner 上以 Node 24、安装锁定依赖后执行：

```powershell
node --test --test-concurrency=1 --test-name-pattern='generate\(\) through a symbolic link|a directory that cannot be written' contracts/src/generator.test.ts
node --test --test-concurrency=2 'contracts/**/*.test.ts' 'tools/gen-contracts*.test.ts'
npx tsc --noEmit
```

第一条为定向复现，完整契约套件仍须保留全部测试。测试仅创建合成临时目录及临时 ACL，不读取环境文件、凭据或真实业务系统。提交为本地显式路径签署提交，由集成者审阅合入。
