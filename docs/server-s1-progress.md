# 第一阶段构建记录

2026-10-12。基线 `d839935`；隔离目录 `../circle-server-s1`，分支 `server-s1`。授权与八幕要求固定在 [brief](server-build-brief.md)。Circle、foundation 和 references 不参与修改。检查只使用脚本模型、合成资源和临时 PostgreSQL。

## 授权固定

首笔提交更新 AGENTS.md 并登记 brief。确认 brief 已在分支跟踪且与主工作树副本相同后，按 brief 删除主工作树的未跟踪副本；主工作树保持干净。没有 push 或 PR。

## 1：契约（已完成）

先编写独立契约验收，固定 `task` / `inrev` 身份、60/20 秒租约参数、统一操作词表、请求身份剥离、规范哈希和连接器动作声明。依赖版本以 npm 元数据核实并固定，锁文件随本步骤提交。

实际检查：`npm run test:contracts` 先因缺少实现失败，实现后 3/3 通过；`npm run typecheck` 通过；`npm run verify:postgres` 在临时目录启动 PostgreSQL 18.4，实际返回 x86_64-apple-darwin24.6.0，监听仅 127.0.0.1，随后停止并删除目录。包版本 `embedded-postgres@18.4.0-beta.17`，没有系统安装或创建系统用户。`npm run verify:references` 校验 714 原件，`npm run test:references` 7/7 通过。

后续按 brief 顺序推进 PostgreSQL/C、worker/D、B/E、连接器、审批交付、管理命令。每一步在此登记实际检查和仍缺项。八幕尚未验收；尚未发布或部署。

## 2：server 与 PostgreSQL/C（第 1–4 幕已通过）

先增加四幕 HTTP 测试，实际先运行第 1 幕，因 server 入口不存在失败。新实现包括显式启用的开发身份源、持久 token 与策略、请求体限制、检查作用范围和 tenant、规范内容幂等、同事务任务/输入修订/幂等/outbox/wakeup、版本化迁移、行锁 runner、回应拒绝记录、持久事件补读。事件序号通过事务行锁在提交前串行分配，避免先提交的高序号遮住未提交的低序号。

实际运行 `node --test --test-concurrency=1 tests/acceptance/01-login.test.ts tests/acceptance/02-submit.test.ts tests/acceptance/03-input.test.ts tests/acceptance/04-reconnect.test.ts`：4/4 通过。包含六个 HTTP 并发提交、向 wakeups 注入 PostgreSQL 触发器异常后整笔受理回滚、回应以数据库时钟判过期、SIGKILL server 后启动新的进程从原数据库继续。`npm run typecheck`、`git diff --check` 通过。

目前 running 之后的执行、知识、规则、审批、交付、连接器与完整管理命令尚缺。此处通过只覆盖前四幕的当前范围。

## 3：优先交付脑图故事（已完成 server 交接范围）

用户追加 [优先级调整](server-s1-priority.md)：先实现脑图编译，LBX 设备几幕后移。新增的脑图方法和 HTTP/stack 验收均先于对应实现编写并运行失败，随后实现到通过。

当前行为：

- 新的 TypeScript `mindmap-compile/1` 流程钉死能力包版本，接受 XMind 2020+ 的 zip/content.json、裸 content.json 与主题树 JSON；解析到规范 IR 后按冻结契约写两表七列。深度优先行、标题规范化、文本空值和数字深度逐格匹配 V05 的 8 行独立预期。
- 使用 ExcelJS 写出、read-excel-file 独立读取；server 收到 worker 制品后再次读取验证，不相信回报里的成功标签。拒绝错单元格、宏、公式或主动外链；未知扩展、多 sheet、未映射附件列为 partial；解析失败不出工作簿。JSON/ZIP/工作簿有大小、节点、深度和原件名边界。
- B 的 S3 形状本地对象接口保存原字节、规范 IR/核验记录和产物，均计算 SHA-256，下载时重新校验。工作簿 ZIP 元数据固定，同一输入跨时间可生成相同字节；同项目同源字节/能力包/契约/映射版本仅一份 artifact，任务修订各自绑定它。
- 独立 worker 经过认证、持久操作账本、60 秒租约和单调 fence 执行，20 秒心跳。执行前及交付前复核当前身份、权限、输入和源 SHA；迟到/旧修订回报拒绝；同一完成回报可重送，同操作不同回报冲突。旧修订租约失效只影响旧操作，不覆盖新修订交付。
- C 的受理、阶段事件、worker 收据、事实核验清单和交付保留事务边界，任务存当前输入修订。交付记录只证明结构编译；没有脚本模拟 LLM 准确率或对业务用例质量作判断。
- `npm run dev:stack` 启动临时真实 PostgreSQL、server、worker，打印 loopback 地址、随机开发登录密码、scope 和合成 .xmind 路径；临时身份、数据库和对象文件均在 Git 外。PostgreSQL 包的退出钩子在独立受监管进程运行；重复 SIGINT 不打断清理。退出顺序与实际 Ctrl+C 清理已验证。

本次完整回归实际命令和结果：

| 命令 | 实际结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | contracts 4/4、methods 4/4、acceptance 10/10、references 7/7；合计 25/25 |
| `npm run verify:references` | 714 原件、两份完整来源树通过 |
| `npm audit` | 0 个已报告漏洞；锁定覆写 uuid 11.1.1，运行验证使用相同锁文件 |
| `git diff --check` | 通过 |
| `npm run dev:stack`（PTY）与实际 Ctrl+C | 完整启动，真实 HTTP 上传/提交/事件/下载得到 3 行合成工作簿；停止后临时目录删除，没有保留实例 |

验证环境为 Node.js 24.17.0/npm 11.13.0、Darwin arm64；实际嵌入式数据库返回 PostgreSQL 18.4 on x86_64-apple-darwin24.6.0。没有核验 Linux/Windows。依赖均精确版本并记录在根锁文件，没有使用 foundation 或 reference 包的依赖安装入口。

修复中确实出现过两次启动清理回归：先是 embedded-postgres 的退出钩子先退出父进程，后是 npm/终端重复 SIGINT 中断 once handler。前者隔离 PG 所有者，后者保留幂等信号 handler；完整 npm 命令的进程组 SIGINT 测试先失败、修复后通过，并再用 PTY Ctrl+C 验证。已停止的验证环境不作为仍可下载的服务宣传。

[实际运行摘要](validation/mindmap-server-runtime.json)保留 task/inputRevision/operation/worker/fence、原件与产物 SHA、独立读取结果和阶段事件；不含密码、token、连接字符串或业务原件。该记录明确 `circleClientVerified:false` 与 `ottyApplicationVerified:false`，不能当作最终的 Circle/Otty 组合演示。

[客户端交接文档](client-api-handoff.md)固定登录、上传、能力包、提交、状态、事件、结果、原件/制品下载和 input 的路径、schema、错误及重试行为，可交给 Claude 接入。所有工作只在 server-s1 提交；未 push、开 PR、改 GitHub 或部署。

server 交接时仍缺：真实 Otty/Circle 连接插件联合验收，原 brief 第 5–8 幕的 LBX 资源核对/设备审批/连接器全套行为、完整 admin 与 MCP。该时点 D 仅用于脑图 worker，尚未验证设备执行端、独立设备核对或远端停止。

## 4：真实 Otty/Circle 组合验收（Claude 观察，用户提供）

用户提供了 Claude 在真实 Otty 终端完成的观察，按本节登记。Codex 此次只整理记录，没有重跑该演示或读取其 scratch 数据；上一节的 HTTP/PTY 验证及其 JSON 中的 false 标志仍保留原范围，不改写成这次组合结果。

| 环境 | 本次观察 |
|---|---|
| 客户端 | Circle 1.1.1，工作树 `../circle-extension-capabilities`，本地提交 `e60ed96`，内置连接插件 `circle-server` 0.1.0 |
| 客户端隔离与模型 | scratch `CIRCLE_HOME`，本地脚本模型桩，未调用真实模型 |
| server | `npm run dev:stack`，`http://127.0.0.1:7410`，PostgreSQL 18.4，worker `lab-east-01` |
| 身份与范围 | 开发登录 `developer`，scope `scp_lab`；密码经 Circle 掩码卡输入，token 存入插件秘密存储，未进入会话。此处不保存密码或 token |

任务 1 使用 `LBX-200-upgrade.xmind`，由冻结 `smp-v05-01-content.json` 打包：

| 记录 | 值 |
|---|---|
| 源文件 SHA-256 | `f4678f70519c988382cc6c8140d300e85b138e728656dc21f463c6a5abec2196` |
| sourceRevisionId | `src_1871691ac19148a0894c881b89f1cf4a` |
| taskId | `task_50e7f1bcdb43495ca2faa981534c20d9` |
| inputRevisionId | `inrev_10e0d16ed2b0487cb09f22d7264677e7` |
| 事件与结果 | 事件 1–8，推进至 `delivered` / `succeeded` |
| artifactId | `art_df1de0df6ea74bf78eb80d1cd7a09f8e` |
| 产物 SHA-256 | `6207a5c6f75a2807f4fd0a8e3b7c897eec32c26bafef1c8b34a5af86fc535e69` |
| 产物大小 | 8703 字节；客户端重算 SHA 与引用一致 |
| evidenceId | `evd_e2c02d34be714cc58cf4639cfc64919b` |

Claude 用 Python `zipfile` + XML 独立读取下载的工作簿，8 行与 `smp-v05-02` 的 `expectedRows` 逐格一致，层级深度为数值单元格，说明表源 SHA 与上传文件一致。该 Python 读取用于外部独立验收，不成为 TypeScript 编译运行链。同一文件重提返回同一任务，`deduplicated` 为 true。

任务 2 使用 dev:stack 生成的 `synthetic-mindmap.xmind`：taskId `task_308d759d63b44c5ba4786bb304129afe`，事件 9–16，`delivered` / `succeeded`，3 行，artifactId `art_34ffb54ac3f74552bb65731bc7077f59`。用户提供的产物 SHA 前缀为 `dc72e4640389`；本节只登记此前缀，不从之前的独立运行补全本次完整摘要。

关闭 Circle 后在新的 Otty 标签重开，`/server tasks` 从 server 取回两个任务的状态；`/server task` 按插件保存的游标补读，未重复下载。

据这份观察，脑图编译经真实 Otty/Circle 的登录、上传、受理、事件、交付、下载、幂等及重连场景记为通过。原 brief 第 5–8 幕的 worker/资源核对、设备审批、交付清单和连接器全套行为，以及完整 admin 仍需继续完成；本节不扩大到真实模型、真实设备、企业系统或部署验收。

## 5：worker 中断与独立核对（第 5 幕通过）

先写并运行 `05-worker-interruption.test.ts`，因 operations API 缺失失败；随后扩展同一个 PostgreSQL 操作账本与租约，不另建内存状态。合成设备 driver 只访问本次临时目录中的 `LBX-LAB-01.json`，执行前再次核对实时授权、目标主机身份与执行端 fence。

实际运行 `node --test tests/acceptance/05-worker-interruption.test.ts`：1/1 通过，约 61.9 秒。执行后故意延迟回报并 SIGKILL `lab-east-01`；不修改数据库时钟或租约时间，等待默认 60 秒到期。原操作转 unknown，冲突写返回 RESOURCE_BUSY，不重派。`lab-east-02` 通过新的只读核对操作取得更高 fence、回读原操作收据并登记原字节证据后，原操作变 reconciled、资源解冻。旧 worker/fence 的迟到回报被拒，新操作 fence 继续增加。核对只证明本次合成资源观察，不证明真实远端进程停止。

脑图仍使用原提交/结果/上传/下载接口和独立读取核验。审批、专业交付清单、连接器与完整 admin 正在按用户新指示继续，未 push。

补充检查：`npm run typecheck` 通过；前四幕与脑图/stack 的十个既有 HTTP 验收全部通过；`npm run verify:references` 714 原件通过，`npm run test:references` 7/7 通过。权限被撤回也不阻止租约到期的后台记账；公开查询和新执行仍按当前权限检查。

## 6：绑定审批与执行端身份（第 6 幕通过）

先运行 `06-approvals.test.ts`，因审批接口缺失 0/2 失败，随后实现 C 的持久审批、待回应绑定和每次回应记录。申请人不能自批，body 自报身份/角色无效；批准绑定申请人、当前 inrev、目标身份及标准动作/参数的 SHA。变更输入、参数、身份、批准状态、期限或当前批准权限使授权失效。D 在创建操作、下发与执行出口重复检查；审批权限没有授予设备权限。

实际 `npm run typecheck` 和 `node --test tests/acceptance/06-approvals.test.ts` 通过，2/2。覆盖被拒回应的记录、输入/动作变更、仅有审批权的人提交设备动作被拒、受理后撤回设备权限使 D 不下发，以及执行端观察到主机密钥变化后不修改配置。补充复现了下发拒绝只回滚导致坏队头永久占队的问题，改为提交明确的未开始失败记录后再返回拒绝，允许后续获准操作继续。全部资源为本次合成临时文件。

交付清单、知识/结论类别与连接器接下来继续；尚未扩大脑图 API、模型或真实设备范围，未 push。

## 7：当前修订的事实交付（第 7 幕通过）

先运行 `07-delivery.test.ts`，缺少清单/结论入口时 0/2 失败；随后增加 B 的固定知识快照、原字节结论记录，以及 C 的当前修订清单和交付复核。脚本结论、脚本模型桩的模型判断、未知各自持久化；需要事实的项只接受通过限定规则计算的脚本结论。结论原件与元数据再次对比 SHA/内容，已有引用但缺可比值返回 unknown，不采用旧 assessor 的引用即 supports 回退。

实际 `npm run typecheck` 与 `node --test tests/acceptance/07-delivery.test.ts` 通过，2/2。覆盖模型不能满足事实项、三类别分别存储、原件按 SHA 下载、输入变化后旧结论/清单失效、新修订重新观察及交付。合成设备的 timeout=5 与手册 §6.4 的最小值 10 比较得到 refutes，允许“比较已完成”的清单交付 partial，并完整披露不符合结果。未将它标签改成配置已修正。开放的操作和人工决定仍阻止交付。

脑图/stack 与审批的八个已有验收也通过，接口保持兼容。B/C 迁移各自管理自己的表；没有新增模型调用或 Python 运行依赖。接下来完成连接器/规则的全部路径及 admin。

## 8：角色连接器、规则触发与回写（第 8 幕通过）

先写并运行 `08-connectors.test.ts`，因 defect-review 能力缺失 0/2 失败。新 SDK 的清单声明角色、标准操作、效果、幂等与核对方法以及事件模式；实际调用在独立 worker 内运行，只访问合成 Bugzilla/OpenKM/Jira JSON 桩。C 管理作用范围、连接器启用状态、规则、游标和事件去重；D 记录每次标准操作、租约与回读；B 保留原文/转换制品/结论原件；E 按 requiredOperations 与角色绑定推进，方法没有按具体缺陷系统分叉。

实际 `npm run typecheck` 和 `node --test --test-concurrency=1 tests/acceptance/08-connectors.test.ts` 通过，2/2，分别使用 Bugzilla 和 Jira。服务身份按当前权限与规则所有者的交集取数据：隐藏的 SECRET-99 不生成事件或任务。cursor 前进至新位置，重复外部 id 不再建任务/评论。写入评论后模拟响应超时产生 unknown、冻结冲突资源；另一 worker 按 `[circle op_id]` 和动作绑定回读原评论后 reconciled，原评论数量始终为 1。OpenKM 原文 SHA 经 B 核对，合成 JSON→文本转换实际生成可下载且摘要匹配的制品。

`07-delivery.test.ts` 增加并通过完整 LBX 能力故事：实际观察 timeout=5，按固定手册 §6.4 的 10 请求独立人员批准，写入一次后重新观察 timeout=10，再以当前事实清单交付 succeeded；原 refutes 记录仍保留。该文件现为 3/3，未把历史结论覆盖成 supports。

接下来完成 admin 的管理查询、排空、事件补读、审计、启停和实际优雅重启，最后再跑当前 HEAD 的整套八幕与脑图兼容检查。未 push。
