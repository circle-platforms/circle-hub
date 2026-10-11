# ADR 0020：D 执行控制面与首批 worker（DEC-P3-06）

日期：2026-10-10。状态：**已定案（用户确认）**。

## 决定

D 的形态按 `docs/cde-implementation-discussion-v1.md` 第 4/8 节：**一个执行控制面 + 按资源/故障边界隔离的 TS workers**。控制面登记资源身份与环境修订，管操作/attempt、租约、准入与回执；六调用语义与 ADR 0011 参数基线不变，不新增平行词表。

首批 worker 与 P3 范围：

- **Workspace/process worker**：真实子进程（隔离工作区、进程树、退出码、取消后的实际存活核对），P3-3 首批落地；
- **Browser worker**：**优先评估 Playwright**（公共 TS API、BrowserContext 隔离、trace）；对接本地测试站把 V03 升至浏览器级；凭据/MFA 只由敏感通道注入；context 不视为完整安全沙箱；
- **Device worker**：P3 内仍以 APV 夹具为执行对象（真实设备属 P4）；SSH 通道类实验按 SSH 职责计划另行推进。

强制约束（讨论稿 4.1/4.2）：紧邻实际副作用的执行出口再次核对权限、输入、目标与 fencing；没有真实观察的停止确认不作为生产路径；数据库租约过期只撤销权限，不证明远端命令已停止——无法实现远端 fencing 边界的操作，限制其自动接管而非宣称具备。

## 影响

P3-3 以 D-T01/D-T02/D-T03/D-T05 与 D-T04 浏览器部分为出口回执；worker 的具体操作面在各 worker 落地时以实现记录固定，不在本 ADR 展开。
