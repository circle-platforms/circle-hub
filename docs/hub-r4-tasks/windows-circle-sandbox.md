# Windows Circle 沙箱设计复用

来源：所有者 2026-10-28 指示，经集成者派发。基线 hub-redesign 542b53f6。

允许修改：本页、hub/rules/README.md、hub/rules/sandbox/windows.ts、hub/rules/sandbox/windows.test.ts、hub/rules/sandbox/isolation.ts、hub/rules/sandbox/sandbox.ts。
不得修改 Circle、package.json、lock、workflows、HANDOFF；不合并、不推送、不运行测试、不访问 GitHub、真实系统、环境文件或密钥。koffi 3.3.3 由另一分支提供。

目标：沿用 Circle 的延迟加载 kernel32 和 Job 进程树设计，提供严格失败关闭的生命周期适配；公开与 Hub 强隔离契约的差距。Windows x64/ARM64 原生合成用例交给集成者安排执行。Linux 优先，本分支不改变 Linux 后端。

验收状态：代码和用例已准备，未运行测试或类型检查，尚无 Windows 本机证据。Windows pack 执行继续拒绝，包含 requireOsIsolation:false；该开关不能掩盖未实现的 Windows 内核隔离、CPU 和内存边界。
