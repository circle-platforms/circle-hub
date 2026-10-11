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

## 9：同一认证入口的 admin（已通过）

先写并运行 `admin.test.ts`，因 CLI 缺失 0/2 失败。新增 TypeScript `circle-server admin` 及本地 bin 入口；所有管理动作走同一 Bearer HTTP API，没有直连数据库或自报身份后门。支持 tasks、workers drain、approvals、events --tail、audit、connectors enable/disable、restart --graceful。

实际 `npm run typecheck` 和 `node --test tests/acceptance/admin.test.ts` 通过，2/2。覆盖普通用户调用管理命令被拒、作用范围内的查询/审批列表/审计/事件、连接器禁用阻止实际调用后再启用、worker 完成当前操作并停止接新操作，以及 supervisor 以相同端口实际重启 server。重启前后 PID 与 bootId 不同，PostgreSQL 原任务、inrev、待回应、事件游标、token 和 worker 状态保持；没有写取消请求。IPC 的重启请求/确认由已认证 server 与其 supervisor 完成，CLI 等新 bootId 出现后才报告完成。

dev:stack 已随本阶段提供两个 worker、独立 approver 和服务身份；所有新增权限只针对合成目标，随机密码与配置仍在临时目录。审批人员没有设备操作权限。[管理命令说明](admin-cli.md)记录启动、秘密注入和使用方式。接下来进行最后的整套验收，未 push。

## 10：第一阶段收口（初次单轮记录）

本节保留当时的单轮运行结果。随后用户复核发现优雅重启间歇失败；修复、连续重跑和当前完整验收见第 11 节。

运行代码提交 `956fda9`（其后仅更新文档/摘要）。在此代码提交实际执行 `npm run typecheck`、`npm test`、`npm run verify:references`、`npm audit`、`git diff --check`，全部通过；commands/范围见[验收摘要](validation/server-s1-acceptance.json)。

| 当前检查 | 结果 |
|---|---|
| contracts | 4/4，身份、统一词表、效果/连接器清单、禁止归档/旧编译运行链 import |
| methods | 4/4，冻结 8 行逐格一致、合成 XMind、partial/失败、独立读取与宏/公式拒绝 |
| acceptance | 20/20，八幕全部通过，另含完整 LBX 故事、admin 两组、脑图/stack 与边界场景；总时长约 93.3 秒 |
| references | 7/7；另校验 714 原件与两份来源树完整 |
| 总计 | 35/35，没有跳过或待办测试 |
| 类型/依赖/差异 | typecheck 与 diff 检查通过，npm audit 0 个已报告漏洞 |

八幕分别由 `01-login`、`02-submit`、`03-input`、`04-reconnect`、`05-worker-interruption`、`06-approvals`、`07-delivery`、`08-connectors` 的自动 HTTP 验收覆盖。第 5 幕实际 SIGKILL 并等待默认租约，未改时间戳；第 8 幕在两种连接器下分别通过同一个方法；优雅重启核对新 PID/bootId 和原数据库任务/游标；脑图按原 API 再次通过。

本次用户指定的第一阶段剩余项目已完成，本地分支 server-s1 保存逐步提交。主工作树保持 `d839935` 且干净，Circle、foundation、references 和工作流字节未修改。没有 push、PR、GitHub 设置调整、发布或部署。

验证范围为本机临时真实 PostgreSQL、开发身份、本地脚本模型桩和合成资源。真实模型质量、真实设备/企业系统、生产身份、MCP 及其他操作系统的发行/部署验收另行推进；没有从本次通过推断这些能力。用户提供的真实 Otty/Circle 脑图观察保留第 4 节的来源与时点，未在本次重跑 Circle 或触及其工作树。

## 11：优雅重启间歇失败修复（2026-10-12）

用户复核原 `admin graceful restart actually changes the server process…`：单独连跑三次，一过两挂，失败约 21.9 秒，错误为 `Graceful restart did not produce a new server process`。本次在修复前代码 `a2b378b` 上再次独立跑三次，两过一挂，失败测试总时长 21.57 秒。第 10 节的 35/35 只代表当时的一次运行，未覆盖持续连接复用下的关停。

先增加两条 HTTP 验收，再改运行源码。第一条保留一个实际复用的 keep-alive 状态轮询，并挂起 task/admin 两种 30 秒 events 长轮询；事件响应结束后继续用各自的 Agent 轮询，重启期间也持续请求。第二条通过 HTTP 100 Continue 确认请求已被 server 接收，再故意留下不完整的提交请求体。两条在旧实现上均失败，0/2，报同一重启超时。

用户分析得到验证：关停只清理当时空闲的连接，正在处理的连接随后完成、进入 keep-alive 并被轮询复用时，`server.close()` 的回调一直等不到全部连接退出；supervisor 因旧进程还活着而无法替换它。本机 Node.js 24.17.0 的 HTTP 实现中，`close()` 自身也只在开始时执行空闲清理；重复一次相同筛选没有解决后续复用。接口语义参见 [Node HTTP 关停说明](https://nodejs.org/docs/latest-v24.x/api/http.html#serverclosecallback)。

修复代码提交 `3e70233`：关停响应设置 `Connection: close`；每 50ms 清理空闲连接；5 秒宽限后调用 `closeAllConnections()`；关停信号立即唤醒两种 events 长轮询。server 等已进入处理程序的请求与当前 runner 收尾，再关闭连接池。共享退出时限由 main、supervisor、dev:stack 消费，外层保护分别留出 10 / 15 秒，避免与 HTTP 的 5 秒宽限抢先冲突。CLI 的 100ms 轮询和脑图接口契约保持原有方式。

在同一修复代码上连续十轮运行 `node --test --test-name-pattern='admin graceful restart' tests/acceptance/admin.test.ts`，每轮三条，共 30/30，无失败、跳过或待办。每轮都核对新 PID/bootId、持久任务/修订/token/worker/游标恢复；两种挂起的长轮询在 2 秒内返回 `Connection: close`，空事件的游标保持；未完成请求体在 4.5–8 秒内断开，未产生任务。轮询覆盖重启前后的进程，允许连接断开/端口切换期间的传输错误；API 错误仍使验收失败。

随后在代码提交 `3e70233` 实际执行完整检查：

| 检查 | 结果 |
|---|---|
| contracts / methods | 4/4 + 4/4 |
| acceptance | 22/22，八幕、admin 四组、脑图与边界验收全部通过；约 106.65 秒 |
| references | 7/7；另校验 714 原件和两份来源树 |
| 完整测试总计 | 37/37，无失败、跳过或待办 |
| 类型 / 依赖 / 差异 | typecheck 与 diff 检查通过，npm audit 0 个已报告漏洞 |

[本次复核与验收摘要](validation/admin-graceful-restart-acceptance.json)记录修复前的失败与十轮重复结果；原单轮 JSON 保留原提交和结果。本次继续使用临时 PostgreSQL 与合成资源，未重跑 Circle/Otty、未调用真实模型或连接真实设备/企业系统。后续仅提交这份记录与 README，不改变已验证运行代码；本地提交、不 push。

## 12：普通用户任务与审批读取（2026-10-12）

先写 `tests/acceptance/client-read.test.ts` 的三条 HTTP 验收，再实现接口。在原运行代码 `260d2e9` 上三条都因路径不存在返回 404 `TARGET_NOT_FOUND`，0/3。实现后独立验收 3/3、typecheck 通过；随后完整检查通过后，本地提交代码、契约、测试与交接文档为 `9ab3c8b`。

`CLIENT_ROUTES.tasks` 定义 `GET /v1/tasks`、`TaskListQuery` 与 `TaskView[]`：只需 `tasks.read`，先过滤实时策略允许的 tenant/scope，再按创建时间倒序截取；相同时间以 taskId 倒序稳定排序。limit 缺省 20，合法整数范围 1–100，非法值为 400 `INVALID_PAYLOAD`。C 的列表复用 status 读取，保持当前输入修订、能力包字段和 pendingInputs；授权范围内其他人创建的任务也按既有读取权限返回。

`CLIENT_ROUTES.approvals` 定义 `GET /v1/tasks/{taskId}/approvals` 与 `ApprovalView[]`：按该任务检查 `tasks.read`、tenant 和 scope 后复用 `approvals.view`，返回全部修订的历史记录；跨 scope/tenant 拒绝为 `FORBIDDEN_SCOPE`。读取无需管理或批准权限，不会修改审批、生成决定或事件。交接文档补入查询边界、排序、nullable approvedBy、旧批准的修订绑定与完整字段；原脑图调用保持兼容。

验收通过真实 HTTP 受理 100 多个可读任务，另建创建时间更晚、但不可见的 scope/tenant 任务，核对过滤发生在 limit 前；也覆盖默认值/1/100、0/负数/101/小数/非数字/空值拒绝、跨创建人可读、改输入后创建顺序不变、只读身份、现存 token 的授权撤回以及空列表。审批测试保留旧修订 approved、新修订 declined/open 三种记录，核对形状、权限拒绝、缺失/非法 taskId 和读前读后的决定/事件数量。

完整检查在与 `9ab3c8b` 相同的运行文件上于提交前实际执行：contracts 4/4、methods 4/4、acceptance 25/25、references 7/7，总计 40/40，无失败、跳过或待办；acceptance 约 110.19 秒。八幕、三条重启回归和脑图 HTTP/worker 边界都通过，另有 typecheck、714 原件校验与 diff 检查通过。详见[本次验收摘要](validation/client-read-acceptance.json)。

本次只提供 server 的普通用户读取 API；Circle 桌面组件/运行扩展由 Claude 配对，未在这里执行桌面组合验收。主工作树与 Circle 保持不动，未连接真实模型、设备或企业系统。本节与摘要/README 的后续提交只记录已完成验收，运行代码保持原字节；本地提交、不 push。
