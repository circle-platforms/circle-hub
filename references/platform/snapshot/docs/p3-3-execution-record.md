# P3-3 D 执行控制面与首批 workers 记录

- 日期：2026-10-10
- 步骤：P3-3（D 执行控制面与首批 workers）
- 依据：ADR 0020（执行控制面）、ADR 0011（幂等/租约参数）、ADR 0022（持久运行基线为 PG 路线；本步控制面为内存实现，见 §5）、`docs/cde-implementation-discussion-v1.md` §7 的 D-T01..D-T05 样本
- 实现：`packages/execution`（`@infosec/execution`）；测试站夹具升级：`packages/test-site`

## 1. 交付形态

**控制面（ControlPlane）**——D 的执行状态唯一权威（内存实现，注入时钟）：

- worker 按资源租约（TTL 60s，沿 ADR 0011）+ 每资源单调 fencing；派发、出口复检、回执都校验当前租约与 fencing。
- **出口复检**：worker 在真实副作用发生前必须调用 `authorizeEffect`，复检租约有效、fencing 当前、无取消请求；任一不符以结构化错误拒绝（LEASE_EXPIRED / FENCING_STALE / DECISION_CONFLICT）。
- **四段取消**：请求（1）→ 已发停止信号（2）→ worker 报告（3）→ **观察确认（4）**；`stopped-observed` 只能由观察产生，worker 死亡且子进程仍在运行时状态为 `stop-unconfirmed`，永不冒报已停止。
- **可信记录**：只有 fencing 有效的 worker 回执或对账观察能落终局；`confirmStopped` 本身不产生任何终局（D-T01）。
- **资源冻结**：操作进入 unknown/stop-unconfirmed 的资源在对账前不可再租出写（RESOURCE_BUSY）。
- **幂等分区**：去重键按 (tenantId, scopeId, principalId, 操作名， 幂等键） 分区，同分区异哈希 IDEMPOTENCY_MISMATCH；终局操作过 24h 窗口后键可复用，**unknown 操作过窗口仍不可重写**（D-T05）。

**Process worker**：独立子进程（stdio JSON-lines），经 supervisor 与控制面相连；副作用是向工作区 `effects.log` 追加可计数行与启动可独立观察生死的 sleeper 子进程。worker 在每次效果前向控制面请求出口复检，获准才执行。

**Browser worker**：Playwright（Chromium Headless Shell 156）驱动真实浏览器；每任务独立 BrowserContext；分类读页面 `data-state`。为此测试站夹具做了加法升级：登录/MFA 页改为真实表单（同时接受 form 编码与 JSON 提交）、MFA 错误页保留表单、首页增加 `/download` 夹具端点与退出表单——P2-6 的 HTTP 流程级回归保持 3/3 全绿，浏览器级断言不复用 HTTP 路径充数。

## 2. 样本结果（2026-10-10 本地全量重跑：execution 13/13，test-site 回归 3/3）

| 样本 | 结果 | 证据要点 |
|---|---|---|
| D-T01 无可信记录不对账 | 通过 | 操作 unknown 后，以说明文字或任意 outcome 调 confirmStopped 均 EVIDENCE_INSUFFICIENT 且状态不变；观察无法确定时对账同样不动状态；观察确定后才落终局且资源解冻 |
| D-T02 陈旧写拒绝 + 回执前杀进程 | 通过 | 逻辑半：租约过期后出口复检 LEASE_EXPIRED；新持有者 fencing+1 后旧持有者 FENCING_STALE 且其迟到回执被拒。进程半：worker 在效果已落、回执被扣住时被 SIGKILL，操作转 unknown、资源冻结（新 worker 租约 RESOURCE_BUSY），按观察对账后终局 |
| D-T03 四段取消与残留核对 | 通过 | 正常取消走完 1→3 段后由观察（pid 信号 0 探活）落 stopped-observed（第 4 段）；变体：取消中 worker 被 SIGKILL → stop-unconfirmed，观察如实报告子进程仍在运行而不给 stopped；事后子进程清除再观察才落 stopped-observed |
| D-T04 浏览器部分 | 通过 | 双任务双 context 并行登录：MFA 任务停在验证页、错误码呈现 mfa-error 页状态、正确码只经站点模拟器带外按本 context 会话取得；两任务会话互不相同、下载字节只含本任务账号与会话；A 退出不影响 B；凭据错误呈现 login-error；MFA 等待超时经站点时钟快进后分类为 login-mfa-timeout（非代码错误）；会话过期后 /home 重定向回登录页。截图作为原始通道证据留存（测试产物） |
| D-T05 幂等分区与窗口外未知 | 通过 | 同键异 scope 是两个独立操作且跨分区读 FORBIDDEN_SCOPE；同分区异哈希 MISMATCH；终局键过窗口可复用；unknown 操作过窗口重提只返回原 unknown 操作、不产生新执行 |
| R02 真实进程级核对 | **通过（关闭 P2 收口登记项）** | 进程半 D-T02 即 R02 的进程级形态：效果发生后、回执前 SIGKILL 执行进程，恢复路径（冻结 + 观察对账）全程效果恰好一次（effects.log 始终 1 行），不以 attempts 数代替实测 |

D-T04 的 SSH 部分（分页/CRLF/长输出）按 SSH 职责计划另行推进，不在本步范围。

## 3. 实现中发现并修正的问题（如实记录）

- supervisor 初版在 worker stdout 上挂了两个 readline 接口，第二个会饿死第一个（ready 能收到、后续协议行收不到，execute 挂死）；已改为单一接口 + ready 回调。
- 控制面测试一处期望错误：被指派给旧 worker 的操作在**新** worker 退出时不会转 unknown（只有其所属 worker 退出才触发），测试已按此语义修正——这正是 D-T02「陈旧 worker 的操作悬置到其死亡/对账」的应有行为。
- 测试站 MFA 错误页初版没有表单，真实浏览器无法在同页重试（第二次填码超时）；夹具已补齐表单，符合真实站点形态。

## 4. 与 P3 规划的对应

- 规划 P3-3 行所列 D-T01/02/03/05 回执、D-T04 浏览器部分回执、R02 真实进程级核对完成，均见 §2。
- 可见性并轨（ADR 0019）在本步的落点：浏览器 worker 的真实画面以截图证据留存为起点；实时观看与接管仍按可见性计划自身推进，不并入本步结论。

## 5. 范围与未验证项（如实披露）

- 控制面为内存实现：D 的执行状态持久化（按 ADR 0022 基线落 PostgreSQL）尚未做，进程级重启后控制面状态不恢复；本步的杀进程证据针对 worker/子进程，不针对控制面自身。
- Process worker 的资源模型是本地工作区目录；Browser worker 只对接本地测试站。真实设备、真实站点、SSH 通道均不在本步范围（OPEN-06/07 与 SSH 计划各自后续）。
- Playwright 评估结论限本步样本：Chromium Headless Shell 可完成表单登录、MFA、下载与状态读取；未评估有头浏览器、真实产品页面结构与视觉状态判定（OPEN-07）。
