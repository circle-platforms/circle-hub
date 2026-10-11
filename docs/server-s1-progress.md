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

仍缺：真实 Otty/Circle 连接插件联合验收，原 brief 第 5–8 幕的 LBX 资源核对/设备审批/连接器全套行为、完整 admin 与 MCP。现有 D 仅用于脑图 worker，不能宣称设备执行端、独立设备核对或远端停止已经验证。
