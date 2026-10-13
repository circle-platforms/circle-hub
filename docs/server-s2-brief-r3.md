# circle-server 第二阶段简报（修订 3）：对象标准、变更集与角色

2026-10-13。这一版在修订 2 的资产、连接器、技能包之上，收口治理部分：角色与范围策略、变更集、运行不审批、通知流、静态密钥、列表即查询。方案页面是私有的 claude.ai 画布，你打不开，本文件是它的可执行摘要。分支继续用 `server-s2`。Circle 仓库由 Claude 负责，你不要改。

维护者已把公开仓库改名为 circle-hub 并更新 main 的公开门面。本轮继续在 server-s2 实现，不修改 README，也不改运行时名字、环境变量或路由前缀；分支合并由维护者处理。

## 1. 对象标准

server 的四个对象（B 资料、C 任务、D 执行、E 方法）都由同样五样组成，接口和存储按这五样组织：

1. **记录**：对象自己拥有的记录类型，各有 id 前缀和版本；字节记录带 sha256。
2. **资产**：可插拔的东西，一种形状：kind · version · sha256 · declaration（reads / writes / credentials）· configuration · lifecycle。
3. **审批策略**：以变更集为单位，哪些动作需要独立审批人；审批请求绑定 inputRevisionId + targetIdentity + actionDigest。
4. **证据**：与外界每次交互的原样记录，evidenceId 由 server 发；脚本事实与模型判断分开标。
5. **扩展点**：对象允许插入的接口类型；产品内容不进核心。

术语固定如下，接口字段、错误码和文档都用它们：审批策略 approval policy、审批请求 approval request、决定 decision、绑定三项 binding、独立审批人 independent reviewer、审批资格 eligibility、平台核验 verification、申请内容 submission、扩展点 extension point、工作队列 work queue、等待原因 waitingReason、变更集 change set、执行链 enforcement chain、运行报错 run error、结果未知 unknown outcome。不再使用：变更门、待办、预授权、异常审批。

两条原则贯穿全部：**审批发生在变更时，不在运行时**；**平台不是审批人**——记录里只写「按规则 X vN 核验」，不写 approved。

## 2. 授权和边界

与修订 2 相同：本机 TypeScript，精确依赖版本，合成桩验收，不连真实系统，不调付费模型，不 push、不 PR、不部署，不碰 7420。仓库公开，提交里不能有内网地址、凭据、真实数据、本机绝对路径。

兼容：固定 Circle 8b2ceb6 的真实 RPC 测试继续跑；Circle 扩展 4076953 现有调用（登录、工具目录、技能推送、原件登记、submit/follow、审批）要继续能用；接口形状有变的，在 `docs/client-api-handoff.md` 写清楚新旧两种。

## 3. 角色与范围策略（C）

主体两类：人、服务客户端（机器身份，只有 scope 串，没有角色）。

人的角色按范围授予，只有三种：**管理员 admin**、**成员 member**、**访客 viewer**。根范围的管理员就是 hub 管理员。现有的动作串保留在内部，收成三个预设；接口对外只暴露角色，策略表存 principal × scope × role。预设是数据，以后可自定义。

| 能做什么 | 管理员 | 成员 | 访客 |
|---|---|---|---|
| 读资料、证据、登记簿、本范围任务状态 | ✓ | ✓ | ✓ |
| 交活、运行（走执行链，不审批）、回应自己的任务 | ✓ | ✓ | — |
| 推送技能包、上传原件、登记资源、建 bot | ✓（变更集） | ✓（变更集，需管理员批） | — |
| 批变更集 | ✓，不批自己（见两人规则） | — | — |
| 人员、角色、范围策略 | ✓（变更集） | — | — |
| worker、运行 profile、服务客户端 | ✓ | — | — |

范围策略 `twoPersonRule`（布尔，默认 true）。审批资格：

- 成员的变更集永远要管理员决定。
- 管理员自己的变更集：规则开，要另一位管理员；规则关，或该范围只有一名管理员，允许本人决定，决定记录 `decisionMode: 'self'`，响应和审计里带范围标志 `singleAdminMode`。自决不是静默放行，列表里和他决并排显示。
- 角色变更本身是变更集。

dev-login 保留。现有 `developer`、`approver` 都映射为 scp_lab 管理员：两名管理员、规则开，和今天的行为一致。

## 4. 变更集

`POST /v1/change-sets`：items 为一个或多个资产版本（新建的草稿，或已提交的草稿资产的引用，例如技能推送产生的草稿）。一个变更集只产生一条审批请求：targetIdentity 为各项 sha256 的有序摘要，actionDigest 为各项身份的摘要，inputRevisionId 同今天。一次决定对全部项原子生效：批准则各项 lifecycle → approved，驳回则各项 declined。同一资产的新变更集取代旧的：旧请求关闭为 superseded（沿用 f45cdc8 的处理）。

平台核验在受理时检查依赖：声明工具对应的连接器实例、runtimeProfileRef、sourceArtifactId 必须已 approved / running；否则变更集进入 `blocked` 并列出原因，不驳回，依赖变化时重核。引用的资产不重批。

现有单资产流程照旧，内部变成只有一项的变更集。模块安装（`/v1/modules/install`）每个模块提交一个变更集。

## 5. 运行不审批：执行链与错误码（C、D）

去掉 `cases.execute` 以及任何运行时的审批。执行提交走执行链，每一步都是脚本：

1. 权限：范围内成员以上；资源策略允许该主体。
2. 绑定：方法版本 approved、资源版本 running、原件 approved；领取时钉住 pin。
3. 核验：确定性规则——命令在绑定的树里、函数契约、自毁规则、床回报的构建 = 绑定的构建。
4. 租约与 fencing。
5. 执行、审计、证据。

结果只有三种：

- `succeeded`。
- `failed`，带固定错误码和事实（哪条命令、哪棵树、规则 id 与版本、两个构建值、evidenceId）：`COMMAND_NOT_IN_TREE`、`DESTRUCTIVE_COMMAND`、`BUILD_MISMATCH`、`GATEWAY_UNREACHABLE`、`PERMISSION_DENIED`、`LEASE_UNAVAILABLE`、`SOURCE_NOT_APPROVED`。申请人改输入能修的，任务停在 waiting-input 并写 `waitingReason`（新字段，枚举值如 `gateway-configuration`、`build-mismatch`）；否则 failed。
- `unknown`：如实披露观察到的一切，不重发，等申请人核对、标记失败或放弃；reconcile 沿用现有实现。

资源的 declaration 可以声明 `executionIsChange: true`：对这种资源的执行提交作为变更集走审批路径；默认 false。这是生产设备「两人规则」的唯一实现方式，不另造运行审批。

## 6. 通知流（C → Circle）

`GET /v1/notifications/stream`（SSE）和 `GET /v1/notifications?cursor=`（轮询兜底）：按当前主体过滤的事件——审批请求创建 / 决定 / 被取代、任务进入 waiting-input / waiting-review / delivered / failed、操作 unknown、bot 运行结果。游标持久化（outbox），断线按游标补读。

`GET /v1/queues`：按当前身份算出的计数——awaitingMyApproval、awaitingMyInput、submittedByMe、assignedToMe、exceptions（unknown、expired、superseded、failed、worker 离线），各带最久等待时间和超 SLA 数。

## 7. 静态密钥凭据模式（D）

执行资源的 credentials 新增 `static-secret` 模式：密钥在登记或轮换时只写入保险箱，执行时由 worker 以 `Authorization: Bearer` 注入网关调用；网关不再回调 /token 和 /v1/introspect。server 签发和外部 OAuth 两种模式保留。网关侧的 Python 改动由 Claude 做，server 只需要凭据模式和 worker 注入。

## 8. 列表即查询

所有登记簿列表接口接受分面（scopeId、productLineId、flowVersion、status 或 lifecycle、owner、年龄区间），返回 `total`、`items`、`cursor`，可按年龄或更新时间排序。保存视图以后再做。

## 9. 验收

每节一组合成验收，全套回归无跳过，typecheck 通过：

- 角色：成员不能批；规则开时管理员不能批自己；单管理员自决记录为 self 并带 singleAdminMode；角色变更走变更集。
- 变更集：多资产原子批准 / 驳回；被取代关闭；依赖未就绪 blocked，就绪后放行；单资产流程兼容。
- 执行链：核验失败返回错误码与事实；waitingReason 落库；unknown 路径不变；`executionIsChange` 资源走变更集；记录里没有「平台批准」。
- 通知流：游标补读；按主体过滤；队列计数与 SLA。
- 静态密钥：只写不读，worker 注入，网关桩不收到 introspect。
- 列表：分面、计数、游标。

## 10. 交接

按 3 → 4 → 5 → 6 → 7 → 8 的顺序本地提交，每节一个提交即可；更新 `docs/server-s2-progress.md` 和 `docs/client-api-handoff.md`；每个提交号通过 Otty 发给 Claude，由 Claude 在独立工作树复核后就地升级 7420。不 push、不部署、不碰 7420 和跳板机。

## 11. 接口决定（Claude 已确认，2026-10-13）

针对第 3 节提出的三项建议，决定如下，第 4、5 节按此做：

1. **executionIsChange 的冻结执行申请资产**：同意。声明了 `executionIsChange: true` 的资源，执行提交先登记为 `execution-submission` 草稿资产，冻结 inputRevisionId、方法摘要、资源版本、原件 sourceArtifactId、工作簿 sha；它作为变更集的一项，批准后才进入执行链，且只能消费一次（审计高危项的修法与此合并）。默认资源不产生这个资产，直接走执行链。全平台只有变更集这一个审批概念。
2. **列表兼容**：采用。列表默认维持旧数组形状，固定 8b2ceb6 的 RPC 测试与扩展 4076953 的调用不变；`?view=page` 返回 `total / items / cursor`，接受统一分面与排序；新 Circle 一律用 `view=page`。
3. **runtime-profile 资产**：按此迁移。资产绑定 profile ref、版本、配置摘要（不含端点与密钥本身），依赖要求 approved / running；已有真实部署由管理员补登记并批准，平台不因配置文件存在而自动 approved；合成旧用例显式登记并批准依赖。

角色层的其余表述全部同意：按范围的角色是唯一的人权限源，旧动作串只做一次迁移；机器用 scope 串；targets / readers 保留；根管理员管角色与范围，不自动继承子范围资料读取；角色变更先走单项变更集骨架，第 4 节扩到多资产。

另：代码审计（只读，f45cdc8）的报告与修复顺序在 Claude 本机的 `scratchpad/security-audit-20261013.md`，路径已通过 Otty 发出；不进仓库，修完只把结论写进进度记录。
