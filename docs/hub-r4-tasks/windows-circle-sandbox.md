# Windows Circle 沙箱设计复用

来源：所有者 2026-10-28 指示，经集成者派发。基线 hub-redesign 542b53f6。

允许修改：本页、hub/rules/README.md、hub/rules/sandbox/windows.ts、hub/rules/sandbox/windows.test.ts、hub/rules/sandbox/isolation.ts、hub/rules/sandbox/sandbox.ts。
不得修改 Circle、package.json、lock、workflows、HANDOFF；不合并、不推送、不运行测试、不访问 GitHub、真实系统、环境文件或密钥。koffi 3.3.3 由另一分支提供。

目标：沿用 Circle 的延迟加载 kernel32 和 Job 进程树设计，提供严格失败关闭的生命周期适配；公开与 Hub 强隔离契约的差距。Windows x64/ARM64 原生合成用例交给集成者安排执行。Linux 优先，本分支不改变 Linux 后端。

验收状态：集成者于 2026-10-28 提供 GitHub 原生合成回执：公开固定提交 bac907e，运行 40637922550，Windows x64 与 ARM64 的 Job 测试文件各 7/7、0 跳过。本分支代理未访问 GitHub、未独立重跑，本机测试与类型检查未运行。该结果仅证明合成 Job 清理和拒绝用例，不证明 OS 禁网、禁写或资源限额。Windows pack 执行继续拒绝，包含 requireOsIsolation:false；该开关不能掩盖未实现的 Windows 内核隔离、CPU 和内存边界。

下一阶段：README 已列 AppContainer/受限令牌 + 挂起启动 + Job 的候选边界与逐项验收，尚非实现或等效隔离证据。特别需要证明私有存储、重解析点和本地 IPC 等边界；任何未证明项保持失败关闭。本次变更仅记录文档，未修改执行代码。

所有者后续授权继续实现 Windows 原生后端，保留禁网、禁写和禁止启动其他程序；先设计与验证序列，
再按层实现。本轮只新增 Job 用户态 CPU/提交内存限制及合成反例，未接 pack。README 记录后续令牌、
LPAC、挂起创建与逐调用内核验证方案。新增用例未执行，原 7/7 回执不覆盖新增代码。
