# circle-server 第一阶段实施简报

2026-10-12。用户和 Claude 讨论后确认了方案，方案页面是私有的 claude.ai 页面，你打不开；本文件是它的可执行摘要。用户已授权开始实现 server。Circle 侧的通用能力由 Claude 在 Circle 仓库完成，你不要改 Circle 仓库。

## 1. 授权范围

用户 2026-10-12 授权：

- 在 circle-server 新建 `apps/`、`packages/`、`tests/` 等生产目录，用 TypeScript 实现。
- 安装依赖，版本写精确值并提交锁文件。
- 在本机启动 PostgreSQL、server 和 worker 进程，只用合成数据、临时目录和临时数据库。
- 在隔离 worktree 的功能分支上提交。

仍需先问用户：push、开 PR、改 GitHub 设置或发布流程、任何部署。

不允许：调用付费或真实模型（用脚本模型）；连接真实设备；连接真实企业系统（OA、OpenKM、PLM、Bugzilla 一律用合成桩）；读取真实 Circle 用户数据；修改 `references/` 或 `foundation/circle` 的字节；从生产入口 import 归档模块；引入 Python 运行链。

第一笔提交：更新 AGENTS.md 的 Current scope，写明这次授权和上面的边界。

本机没有 Docker，也没有 PostgreSQL。开发和验收用 npm 包 `embedded-postgres`（精确版本）在临时目录启动真实 PostgreSQL，不做系统安装。它在本机跑不起来时停下来问用户，不要改用 SQLite 或内存实现代替（ADR 0017）。

## 2. 定位

- server 负责 agent 工作本身：受理、授权、执行、留证据。它不替代 OA、OpenKM、PLM、Bugzilla，不做通用集成总线，也不做 Web 管理站。
- server 只有认证 API，像 k8s 的 API server。客户端有：Circle 连接插件（下一阶段）、`circle-server admin` 命令行、OA 和即时通讯渠道（以后）、HTTP 和 MCP。所有入口走同一套认证和权限，没有后门。
- B、C、D、E 起步放在同一个后台进程里，各自只改自己的表，不拆成独立服务。worker 是独立进程。

## 3. 这一阶段交付什么

八幕演示。每一幕是 `tests/acceptance` 里的一组自动测试，用 HTTP 测试客户端驱动，不依赖 Circle。

| 幕 | 必须证明 |
|---|---|
| 1 登录 | 开发用身份源签发 token；请求体里的 principal、role 一律不参与判断；访问范围之外的项目返回 `FORBIDDEN_SCOPE`；token 过期后拒绝 |
| 2 提交 | 同键同内容返回同一任务（`deduplicated: true`）；同键不同内容返回 `IDEMPOTENCY_MISMATCH`；另一个项目用同一个键各自独立；任务、幂等记录、唤醒在同一事务提交 |
| 3 补充信息 | 待回应请求绑定输入修订；按旧修订回答返回 stale-revision；过期回答返回 expired；每次回应都留记录，包括被拒的 |
| 4 断开与重连 | `events?after=seq` 补读不丢不重；server 进程重启后在途任务从数据库继续；客户端断开不会发出取消 |
| 5 worker 中断 | 执行中 `kill -9` worker；租约过期后操作变成 unknown，不重新派发；核对完成前资源写操作返回 `RESOURCE_BUSY`；独立核对后变成 reconciled；旧 fence 的迟到回报被拒 |
| 6 审批 | 申请人不能批准自己的请求；批准绑定输入修订、目标身份和动作摘要；修改输入后旧批准失效；D 在下发前再核对；目标主机密钥变化时在执行端拦下；审批权不带来设备操作权 |
| 7 交付 | 交付清单绑定当前修订；脚本结论、模型判断、未知分开存储；模型判断不能满足需要事实依据的清单项；证据原件按 SHA-256 可取 |
| 8 缺陷触发与回写 | Bugzilla 桩按游标轮询产生事件；规则用服务身份建任务，外部事件 id 去重；服务身份读不到规则所有者看不到的缺陷；写回评论超时变成 unknown，按 `[circle op_id]` 标记回读后变成 reconciled；把连接器换成 Jira 桩，同一个能力包的验收照样通过 |

合成场景：产品 LBX 8.4.2，设备 LBX-LAB-01，worker lab-east-01 和 lab-east-02，配置 `backend.timeout=5` 低于合成手册 §6.4 的下限 10。用户请求示例："检查 LBX-LAB-01 的健康检查配置是否符合 8.4 版本说明，不符合就在测试域改正"。

## 4. 目录

| 位置 | 内容 |
|---|---|
| `apps/server` | HTTP API、后台 runner、开发用身份源、`circle-server admin` 命令 |
| `apps/worker` | 执行节点进程，连接器和合成设备 driver 在这里运行 |
| `packages/contracts` | 请求、事件、状态、错误码、标准操作和连接器清单格式的唯一定义 |
| `packages/tasks` | C：任务、幂等、待回应请求、决定、交付清单 |
| `packages/execution` | D：操作账本、租约、fencing、核对 |
| `packages/knowledge` | B：来源修订、固定快照、证据和制品 |
| `packages/methods` | E：能力包和确定性检查 |
| `packages/connectors` | 连接器 SDK，以及 bugzilla、openkm、jira 合成桩 |
| `tests/acceptance` | 八幕验收 |

## 5. 关键设计

- **API**：ADR 0007 的六个调用 submit、status、result、input、cancel、reconcile，加 `GET events?after=<seq>` 长轮询。身份只从 token 来。
- **存储**：PostgreSQL。表至少有 tasks、idempotency、outbox、wakeups、pending_inputs、decisions、checklist_items、operations、leases、evidence、artifacts、connector_events。用版本化迁移，不要只靠 `CREATE IF NOT EXISTS`。
- **任务推进**：ADR 0022 的 PG 任务表加自建 runner。可以参考 `runtime-eval/src/pgflow.ts` 的 wakeups 思路，但要重写。阶段变化和待发事件在同一事务里提交。
- **执行**：租约 60 秒、心跳 20 秒、单调 fencing（ADR 0011）。结果不明只能经核对离开。执行端在产生副作用前再核对一次授权（AUTH-01）。
- **证据**：原件存本地文件，接口按 S3 形状设计，记 SHA-256（ADR 0017）。
- **模型**：只用脚本模型。结论分三类存储：脚本结论、模型判断、未知。
- **连接器**：清单声明担任的角色、提供的标准操作、每个操作的作用、幂等方式（例如 marker）、核对方式（例如 read-back）、事件模式。连接器在 worker 里运行。每次外部调用都依次经过：身份、权限、动作声明、操作账本、执行、留证。
- **能力包**：用 requiredOperations 引用标准操作（如 `defects.search`、`defects.comment`、`docs.fetch`、`docs.convert`、`product.version`），不写死具体系统。
- **管理命令**：`circle-server admin` 至少有 restart --graceful、tasks、workers drain、approvals、events --tail、audit、connectors enable/disable。

## 6. 参考怎样采用

只读源码，不 import。在 `docs/` 里建一份采用清单，逐项写源文件、来源提交、采用了什么行为、做了哪些修改、调用方和新的验收。参考代码在 `references/platform/snapshot/`，ADR 在 `references/platform/snapshot/docs/decisions/`。

已知要修的地方：

- `packages/contracts`：任务服务生成的 ID 前缀是 `tsk`、`rev`，契约要求 `task`、`inrev`；`execution/control-plane.ts` 的操作状态和契约词表不一致。
- `platform-pg/src/service.ts`：调用上下文要改为从认证获取；幂等范围补上 tenant 和 scope；没有 wakeups 表。
- `execution/src/control-plane.ts`：内存 Map 要改成持久化。
- `assessor/src/index.ts` 第 92–99 行：去掉"有引用就判定 supports"的回退分支。
- `server-stub/src/http-server.ts` 没有认证，也没有请求体大小限制，不能改个名字就当正式 API。
- 可选：Codex 旧 demo 里的脑图转 xlsx（`/Users/jiangyongze/Public/circle-server-ui-demo/src/workflows.ts` 第 1135–1208 行、`src/workflow-files.ts`）可以作为 E 的确定性方法候选。

## 7. 构建顺序

1. contracts，包括标准操作和连接器清单格式。
2. server 和 PostgreSQL（C），对应第 1–4 幕。
3. worker 和执行记录（D），对应第 5 幕。
4. 最小的 B 和 E，对应第 7 幕的脚本结论。
5. 连接器框架，以及 bugzilla、openkm、jira 合成桩，对应第 8 幕。
6. 审批与交付，对应第 6–7 幕。
7. 管理命令，对应第 4 幕的重启和排空。

Circle 连接插件是下一阶段。等 Claude 在 Circle 里补完通用能力（扩展的秘密输入和存储、状态显示、插件库机制、打开链接）之后再做，放在 Circle 默认插件库，不另建仓库。

## 8. 工作方式

- 先读 AGENTS.md、README.md、docs/bcde-integration-plan.md 和本文件。
- 建 worktree：`git worktree add ../circle-server-s1 -b server-s1`。把本文件（主工作树里未跟踪的 `docs/server-build-brief.md`）放进你的分支提交，然后删掉主工作树里这份未跟踪的副本。
- 显式写出要提交的路径，不用 `git add -A`、`git add .` 或 `git commit -a`。提交信息按 AGENTS.md：一句首字母大写的英文祈使句，不加前缀，不加句号。
- 每一步先写这一幕的验收测试，再实现。`npm run verify:references` 和 `npm run test:references` 保持通过。
- 记下实际跑过的命令和结果，不宣称没跑过的检查。每完成一步，在 `docs/` 下更新进度记录：做了什么、跑了什么、还缺什么。
- 遇到需要用户决定的事就停下来问，例如 embedded-postgres 不可用、要 push、要扩大范围。
