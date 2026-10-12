# Circle 客户端接口交接：普通用户读取与脑图编译

2026-10-12。第一阶段实现位于隔离工作树 `../circle-server-s1`，分支 `server-s1`；第二阶段增补在 `../circle-server-s2` 的 `server-s2` 分支。Circle 和连接插件由 Claude 负责；本分支只提供 server/worker。共享协议原件是 `packages/contracts/src/index.ts`：`CLIENT_ROUTES`、请求/回应 schema、`TaskListQuery`、`TaskView`、`ApprovalView`、`TaskResult`、`EventPage` 和标准操作。编译包的描述及专用协议在 `packs/apv/contracts.ts`，HTTP 形状保持兼容。API 版本 `1.0.0`，能力包与映射规则版本 `1.0.0`，Excel 契约为 `Excel 输出契约 V1`。

## 启动和登录

```sh
cd ../circle-server-s1
npm ci
npm run dev:stack
```

Node.js 24。启动命令使用锁定的 `embedded-postgres@18.4.0-beta.17` 在新临时目录运行真实 PostgreSQL 18.4，不需要 Docker、系统 PostgreSQL 或系统用户安装。随后启动受监管认证 API 和独立 `lab-east-01` / `lab-east-02` worker。终端会打印：

```text
地址：http://127.0.0.1:<本次端口>
开发登录：POST /v1/auth/dev-login，用户名 developer，密码 <本次随机密码>
项目：scp_lab
合成 XMind：<临时目录>/synthetic-mindmap.xmind
```

同时输出一条 `type: "dev-stack-ready"` JSON，含 `url`、`login`、`scopeId`、`samplePath`、`pid` 和 PostgreSQL 实际版本。端口默认随机；需要固定时用 `CIRCLE_SERVER_PORT=8080 npm run dev:stack`。全部服务只监听 127.0.0.1。本次登录密码只保存在临时配置并打印到该终端，不固定在 Git。Ctrl+C 有序停止 worker、server 和 PostgreSQL 并删除临时数据库、原件及制品。再次启动是新环境；server 在同一个仍存活的 PostgreSQL 中重启才会恢复原任务。

开发身份源仅在 `CIRCLE_SERVER_DEV_AUTH=1` 且显式指定临时身份配置时启用。它不是企业认证。token 默认有效 **8 小时**；`CIRCLE_SERVER_DEV_TOKEN_TTL_MS` 可配置 1000–86400000ms（最多 24 小时），显式请求的短 expiresInMs 仍有效。客户端用秘密存储保存 token，到期前无交互续期。账号和授权来自服务端配置/策略表，请求体自报的 principal、role、actor 或 tenant 都不授予权限。

`POST /v1/auth/refresh` 带当前 Bearer 和空 JSON `{}`，响应沿用 dev-login 的 `{token,tokenType,expiresAt,principalId,tenantId,scopes}`（CLIENT_ROUTES.authRefresh）。仅仍有效、未撤销且身份未禁用的开发会话可续期；不要求密码、不接受自报期限/身份/范围。当前实现延长同一 token，避免并发旧请求因换 token 被拒；scopes 重新取当前策略。已过期返回 401，不从过期凭据恢复会话；受约束 run token 返回 403，不能升级成普通登录。

Circle 2035247 已由维护者报告支持：保存 expiresAt、到期前约 2 分钟或短期限的 1/5（至少 5 秒）及请求前续期；旧 server 的 404/405 只尝试一次。任何工具/任务轮询的 401 都只提示 sign-in expired 和显式 `/server login`，不自动弹密码框；run token 不由客户端续期。已过期的旧 5 分钟会话需要主动登录一次，随后使用新期限。正式企业身份/刷新 token 仍未接入。

## 通用信封

除二进制下载，回应均为 JSON。成功有 `data`，失败有 `error`：

```json
{"apiVersion":"1.0.0","status":"accepted","data":{"taskId":"task_..."}}
```

```json
{"apiVersion":"1.0.0","status":"failed","error":{"code":"FORBIDDEN_SCOPE","category":"permission","message":"...","details":{},"retryable":false}}
```

登录以外的每个接口都需要 `Authorization: Bearer <token>`。JSON POST 用 `Content-Type: application/json`。普通请求体上限 64 KiB；上传原件上限 16 MiB（JSON/base64 信封预留相应编码空间）。token 无效或过期为 HTTP 401 `UNAUTHENTICATED`，范围拒绝为 403 `FORBIDDEN_SCOPE`。不要把 token 或原件内容写到会话/Git。

## 普通用户只读接口

桌面端与 circle-server 运行扩展使用同一个登录身份读取持久任务和审批记录。下面两个接口都只需要 `tasks.read`，返回普通成功信封，其中 `data` 是数组。权限按每次请求时的服务端策略核对。

| CLIENT_ROUTES | 调用 | 成功 data |
|---|---|---|
| `tasks` | `GET /v1/tasks?limit=20` | `TaskView[]`；省略 limit 默认为 20，允许 1–100 的整数 |
| `approvals` | `GET /v1/tasks/{taskId}/approvals` | `ApprovalView[]`；没有记录时为 `[]` |

任务列表先按当前身份的 tenant 和授权 scope 筛选，再按创建时间倒序截取 limit；相同创建时间按 taskId 倒序，输入修改或后台推进不会改变创建顺序。它包含授权范围内其他人创建的可读任务，不按当前 principal 的创建记录缩小范围。没有可读任务或没有授权 scope 时返回 `[]`；无 `tasks.read` 返回 403 `FORBIDDEN_ACTION`。limit 为 0、负数、非整数、超过 100、空值或无法解析时返回 400 `INVALID_PAYLOAD`，不会静默截断。

列表元素与 `/status` 使用同一个 `TaskView`，含 `taskId`、tenant/scope/principal、`title`、`phase`、当前 `inputRevisionId`、`input`、`revision`、`flowVersion` 和 `pendingInputs`。已绑定能力包的任务含 `capabilityPackId` / `packVersion`，通用任务沿用这些字段可省略的既有契约。`pendingInputs` 为数组，包含历史回应项；客户端沿用下文的当前修订与 open 状态判断。`CLIENT_ROUTES.tasks.query` 是 `TaskListQuery`，`response` 是 `TaskView` 数组 schema。

审批列表先按该任务执行 `tasks.read`、tenant 与 scope 检查；跨 scope 或跨 tenant 返回 403 `FORBIDDEN_SCOPE`，无读取权限返回 403 `FORBIDDEN_ACTION`。不存在的 taskId 返回 404 `TARGET_NOT_FOUND`，格式无效返回 400 `INVALID_PAYLOAD`。用户无需 `admin.manage` 或 `decisions.approve`；读取权限不会授予回应审批或设备操作权限。

审批元素保持 `approvals.view` 的形状：`approvalId`、`taskId`、`inputRevisionId`、`applicantId`、`targetIdentity`、`actionDigest`、`action`、`status`、`approvedBy`、`expiresAt`。`action` 为 `ApprovalProposal` 的修订/标准操作/目标/身份/参数；status 为 `open`、`approved` 或 `declined`。未作决定时 approvedBy 为 `null`，批准或拒绝后为回应人的 principalId；expiresAt 为 ISO 时间。按创建时间、approvalId 升序返回全部记录，包括旧修订的记录。旧修订上保存的 approved 状态不能证明当前动作仍获授权，执行出口仍核对修订、目标身份、动作摘要与有效期。读取不改变审批状态、不生成决定或事件。`CLIENT_ROUTES.approvals.response` 是 `ApprovalView` 数组 schema。

## 编译调用顺序

| 调用 | 请求 | 成功 data / 行为 |
|---|---|---|
| `POST /v1/auth/dev-login` | `{ "username":"developer", "password":"<本次随机密码>" }` | 200：`token`、`tokenType:"Bearer"`、`expiresAt`、`principalId`、`tenantId`、`scopes`。`/v1/auth/token` 保留为同义旧路径 |
| `POST /v1/sources` | `{ "scopeId":"scp_lab", "fileName":"cases.xmind", "contentBase64":"<原文件字节的标准 base64>" }` | 201：`sourceRevisionId`、原字节 `sha256`、字节数 `size`、`fileName`、`scopeId`。同项目同 SHA 上传复用原件修订 |
| `GET /v1/packs` | 无 body | 200：能力包数组。按 `capabilityPackId:"mindmap-compile"` 选择脑图能力，字段与版本保持原契约；另有合成 `lbx-healthcheck` 和 `defect-review` 能力 |
| `POST /v1/tasks/submit` | 见下例 | 202：任务身份、当前 phase/inputRevisionId、流程/能力包版本、`deduplicated`。受理事务同时提交任务、幂等、outbox 与 wakeup |
| `GET /v1/tasks/{taskId}/status` | 无 body | 200：`TaskView`，含当前修订、phase、输入引用与 `pendingInputs` |
| `GET /v1/tasks/{taskId}/events?after=0` | 可加 `&waitMs=10000`（0–30000） | 200：`{ events:[{seq,taskId,kind,payload,createdAt}], after:<最新返回 seq> }`。每页最多 500 条，按 seq 升序 |
| `GET /v1/tasks/{taskId}/result` | 无 body | 200：`TaskResult`，含 phase、`status`、产物与证据引用、unmapped、独立 verification 或结构化 error |
| `GET /v1/artifacts/{artifactId}/content` | 无 body | 200：原工作簿字节；`Content-Type` 为 xlsx，`X-Content-SHA256` 为登记摘要，`Content-Disposition` 为 UTF-8 文件名 |
| `GET /v1/sources/{sourceRevisionId}/content` | 无 body | 200：源文件原字节，下载时再次校验 SHA；同样需要作用范围与认证 |
| `GET /v1/evidence/{evidenceId}/content` | 无 body | 200：JSON 证据原件，含规范化 IR、映射规则、核验输入/结果和未知项；下载时再次校验 SHA |
| `POST /v1/tasks/{taskId}/input` | 修订绑定的回应或替换，见下文 | 200：新 `TaskView`；不会将旧修订回答用于当前任务 |

上传也支持原字节方式：`Content-Type: application/octet-stream`，`X-Scope-Id: scp_lab`，`X-File-Name: <encodeURIComponent(basename)>`，body 为原文件 bytes。这适合插件读取本地 `.xmind` 后直接发送，不需要 multipart。

提交示例：

```json
{
  "scopeId":"scp_lab",
  "title":"将脑图编译为用例工作簿",
  "capabilityPackId":"mindmap-compile",
  "idempotencyKey":"circle-mindmap-request-0001",
  "input":{"sourceRevisionId":"src_...","sourceSha256":"<上传返回的 64 位 SHA，可省略>"}
}
```

`title` 可省略；`idempotencyKey` 为 8–200 字符。重试必须保留原键、title、能力包和输入内容。幂等分区包含 tenant/scope/principal/action，在线窗口 24 小时。同键同内容返回同 taskId 且 `deduplicated:true`；同键不同内容为 409 `IDEMPOTENCY_MISMATCH`。任务保存服务端核对过的 source SHA。即便用新键创建另一任务，同项目、同源字节、同能力包/映射/契约版本也复用一个 artifactId。

## 状态、事件和交付

典型 phase 为 `admitted → running → waiting-resource → under-review → delivered`。`waiting-resource` 在当前能力中表示等待 worker/回报。`delivered` 后仍必须查看 result.status，完整映射为 `succeeded`，有未映射元素为 `partial`；解析失败的 phase 为 `failed` 且无产物。失去运行租约的操作为 `unknown`，不会自动重派。

result 示例（省略摘要具体值）：

```json
{
  "taskId":"task_...","inputRevisionId":"inrev_...","phase":"delivered",
  "capabilityPackId":"mindmap-compile","status":"succeeded",
  "artifacts":[{
    "artifactId":"art_...","sha256":"<64 位 SHA>","size":12345,
    "fileName":"cases.xlsx","mediaType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "downloadPath":"/v1/artifacts/art_.../content"
  }],
  "evidence":[{
    "evidenceId":"evd_...","kind":"script-conclusion","sha256":"<64 位 SHA>","size":1234,
    "downloadPath":"/v1/evidence/evd_.../content"
  }],
  "unmapped":[],
  "verification":{
    "reader":"read-excel-file/9.3.12","rowCount":8,"sourceSha256":"<源 SHA>",
    "irSha256":"<规范 IR SHA>","artifactSha256":"<工作簿 SHA>"
  }
}
```

原件下载与制品下载均执行 token、tenant/scope 权限和存储字节 SHA 检查。客户端下载后应再算 SHA-256 并与引用比较。`partial` 的 `unmapped` 是 `{path,reason}` 数组，并写入工作簿的 `说明` 表。这个脚本结论证明结构编译及逐格回读，不评价测试用例的业务质量，也不代表真实 XMind 应用或 Microsoft Excel 已打开验证。

客户端给每个 taskId 单独保存已处理 seq。消费成功后把游标更新为最后一个 seq；空页保留原游标，再次请求直到没有积压。seq 可以有跨任务间隔，不要求连续。重连时使用原游标补读；客户端断开/终端关闭不会触发 cancel。用户主动取消才调用 `POST /v1/tasks/{taskId}/cancel`，JSON body `{}`；它是取消请求，不证明远端已停止。`POST /v1/tasks/{taskId}/reconcile`（body `{}`）在当前编译 unknown 场景只披露缺少独立观察，不把未知结果强制判成功。

## 补充或更换输入

通用 C 的待回应请求在 status.pendingInputs 中，客户端只提示 `status:"open"` 且 inputRevisionId 等于当前修订的项：

```json
{"inputRevisionId":"inrev_...","requestId":"pin_...","response":{"target":"LBX-LAB-01"}}
```

旧修订为 409 `INPUT_REVISION_STALE`（outcome `stale-revision`）；超时为 409 `INPUT_EXPIRED`（outcome `expired`）。所有已授权的回应尝试均记入 decisions，包括这些拒绝。

脑图任务已获完整源引用后不需要人工问题。需要更换源时，在交付前上传新原件，再调用：

```json
{"inputRevisionId":"inrev_旧修订","replacement":{"sourceRevisionId":"src_新原件"}}
```

服务端发新 inrev，使旧 worker 回报失效。已 delivered/failed/cancelled 或 unknown 的任务不接受输入替换；使用新提交表达新的工作。`response` 和 `replacement` 必须二选一，不通过自然语言消息隐式修改。

## 当前验收与下一次组合验收

`npm run typecheck`、`npm test`、`npm run verify:references` 和 `npm audit` 是本分支的检查入口；具体实际结果在进度文档登记。冻结 V05 的 content.json/主题树 JSON 通过 HTTP 上传、独立 worker 编译、server 再核验与下载，逐格匹配冻结的 8 行。另生成合成 `.xmind` zip。原 reference 文件保持原字节。

Claude 的真实 Otty/Circle 观察已由用户提供并登记在进度第 4 节，保留客户端提交 `e60ed96`、两个任务、原件/产物 SHA 与重连结果。新的 server 实现又通过脑图 HTTP/worker 兼容测试；本次没有将旧观察改写为新提交的客户端复跑。

第一阶段的合成 LBX 操作、主机身份拦截、审批/交付、Bugzilla/Jira/OpenKM 桩与完整 admin 已完成，见进度与管理说明；它们在现有脑图 API 之外增加入口，没有改变该故事的登录、上传、提交、状态、事件、结果、下载和 input 路径。MCP、真实模型/企业认证/设备系统及部署不由本次本地八幕验收覆盖。没有 push、PR、GitHub 设置变更或部署。

## 第二阶段：工具目录

第一阶段的 envelope、Bearer 登录、scope/tenant 检查和任务补读方式继续使用。以下响应形状是 `data` 的内容，错误仍在 `error`。单一原件和产物下载保持原路径。工具契约定义在 `packages/contracts/src/index.ts` 的 `CLIENT_ROUTES.tools` / `toolCall`。

`GET /v1/tools` 返回调用者当前可用的数组：

```json
[{"name":"buildsite.command_check","title":"按固定 XML 与确定性规则核对命令",
  "description":"按固定 XML 与确定性规则核对命令",
  "inputSchema":{"type":"object","properties":{"build":{"type":"string"},"commands":{"type":"array","items":{"type":"string"}}},"required":["build","commands"],"additionalProperties":false},
  "effect":"read","mode":"sync","permission":"builds.read","assetId":"ast_...","assetVersion":"1.0.0"}]
```

名称只用小写字母、数字、点和下划线，在 tenant 内唯一；多连接器实例使用 `docs_apv.search` 等别名。同名登记被 `TOOL_NAME_CONFLICT` 拒绝。目录按当前身份权限、范围、资产读权限、个人凭据权限及已批准运行中的当前资产修订过滤。停用、修订和撤销权限立即影响后续目录与执行出口；普通客户端基础角色需 `tasks.read` / `tasks.submit`，再授予条目里的业务 permission。

响应带 `ETag` 与 `Vary: Authorization`。Circle 可发送 `If-None-Match`：同一身份的目录未变化返回 **304 无 body**，保留已有工具；200 时整体替换目录。不要对 304 调用 JSON 解析，也不要在不同身份之间共用目录缓存。schema 的 `type` 始终为 `object`；Circle 以实际返回的完整 schema 校验参数，不自行维护第二份。

`POST /v1/tools/{name}/call` body 为 `{"args":{...},"idempotencyKey":"<每次逻辑调用的稳定键，8–200 字符>"}`。读工具返回 200：

```json
{"result":{"build":"Rel_PHOTON_10_5_0_101","commands":[]},
 "evidence":[{"evidenceId":"knr_...","sha256":"<64位 SHA-256>"}]}
```

即使同步返回，读取也由已认证 worker 执行，C/D 保存任务、当前输入修订、操作、租约与 fence；B 收到原字节且核对 SHA 后才返回。相同身份/范围/工具/键及规范化输入复用原任务和结果；同键不同内容报 `IDEMPOTENCY_MISMATCH`。同步等待超时给 `UPSTREAM_TIMEOUT`，details 中保留 `taskId` 和 `remoteStoppingVerified:false`，可通过旧任务接口检查；这不是取消。需要更改工具参数时使用新调用，工具任务的 input 修订固定。

工具调用任务和事件初始归调用者个人，其他 scope 内用户也不能通过 tasks/status/result/events 读到其查询返回或候选内容；列表在 limit 前过滤。来源 ACL 和普通任务 scope 权限不能互相代替。后续团队知识提升通过知识审核与发布表达，不直接公开个人任务。

task 工具返回 202 `{"taskId":"task_...","phase":"admitted"}`（phase 以实际值为准），随后按第一阶段 status/events/result 补读。结束后的 result 增加 `data.result` 保存工具结果，`data.evidence` 保存出处；原 artifacts/unmapped/status 等字段继续保留。证据原件可经 `GET /v1/knowledge/records/{evidenceId}/content` 取回，返回 `x-content-sha256`，客户端应重算 SHA；下载再次检查当前来源权限。

失败分类包含 `SOURCE_ABSENT`、`SOURCE_FORBIDDEN`、`SOURCE_LOGIN_EXPIRED`、`SOURCE_UNREACHABLE`。用户已确认：普通调用将缺失/无权限统一隐藏为 `SOURCE_FORBIDDEN`；具备 `sources.diagnose` 的诊断者可见完整分类。只有确认不存在可进入来源不存在缓存，登录失效/权限拒绝/源不可达不能当作缺失。幂等键保存的失败收据仍可重读；一次新的查询使用新键。

### 脑图知识工具

工具名表展示默认实例，多实例以目录中的别名为准。除候选提交外均为 **read/sync**。

| 工具 | args | result 主要字段 |
|---|---|---|
| `buildsite.versions` | `{versionLine?,page?,limit?,formal?,platform?,current?,commandTreeAvailable?}` | versionLines/builds/page/limit/total/totalPages/hasMore/nextPage/revision/coverage；构建仅返回七个精简字段 |
| `buildsite.command_tree` | `{build,platform?,scope?,versionLine?}` | build/buildId/platform/parserVersion/sourceSha256/commands；固定构建 XML 投影，保留 scope/menuPath |
| `buildsite.fixed_releases` | `{issueId,issueSystem,builds:[1–20 个相关构建],platform?,versionLine?}`；旧 `{legacyIssueId,...}` 仍可用 | issue/status/earliestFormal/all/coverage；体系为 zentao 或 bugzilla，旧请求默认 bugzilla，空编号 unknown，Beta 不作正式发布 |
| `buildsite.command_heads` | `{build,prefix}` | heads/count/limit/ruleVersion；上限 128，超出报 `RESULT_TOO_LARGE`，details.outcome=`result_too_large`，不截断 |
| `buildsite.command_param` | `{build,head}` | status/head/signatures/overloaded/parameters/ruleVersion；签名含 signatureId/scope/parameters，参数含 position/type/optional/help/range/enum，position 从 1 开始 |
| `buildsite.command_check` | `{build,commands:[...]}` | build/sourceSha256/ruleVersion/commands；每条含 status=`hit` 或 `missing`、head、arguments、violations、matchedSignatures、signatureChecks |
| `docs.list` / `docs.get` | `{path?,page?,limit?}` / `{file}` | root/path/files/total/page/limit/nextPage/revision / path/contentBase64 |
| `docs.search` | `{query,path?,version?,limit?,after?}` | hits：file/line/snippet/sourceSha256；行号从 1 开始；nextCursor/revision/coverage/limits 说明当前页与完整范围 |
| `docs.section` | `{file,anchor}` 或 `{file,line,window?}` | file/lines[{line,text}]/sourceSha256；anchor 对应以 `**<命令头>**` 开头的小节；窗口默认 40、最多 80 行，超长小节明确失败 |
| `zentao.bug_search` | `{keyword?,product?,status?,severity?,assignedTo?,openedBy?,lastEditedDate_start?,lastEditedDate_end?,page?,limit?}` | items/total/page/limit/nextPage/revision；必须有 product、status 或日期筛选；keyword 还必须带 product |
| `zentao.products` | `{page?,limit?}` | items[{id,name}]/total/page/limit/nextPage/revision；先查产品名对应的 id，不猜编号 |
| `zentao.bug_detail` | `{ids:[...]}`（1–100） | items；数字/日期统一，未知 resolution 留在 unmapped |
| `env.inventory` / `env.topology` / `env.device_status` | `{}` / `{environmentId}` / `{deviceId}` | 只读跳板返回；没有执行或改环境入口 |
| `env.framework_files` / `env.framework_get` | `{}` / `{path}` | 框架只读镜像目录/文件 |
| `knowledge.claim_submit` | `{claim:{subject,predicate,value,conditions?},evidence:[{evidenceId,sha256}]}` | **write/task**；最终 `result` 为个人沉淀候选记录，附原工具返回，不自动提升 |

E 的 `command-tree/1.1.0` 规则采用 POSIX quote/escape 分词并转小写，最多八词的最长前缀匹配。hit 表示命令头存在，参数另报 `ARGUMENT_COUNT`、`TYPE_MISMATCH`、`ENUM_MISMATCH`、`OUT_OF_RANGE` 或 `UNSUPPORTED_PARAMETER_TYPE`；missing 报 `HEAD_MISSING`，不能用手册命中改成 hit。STRING/XSTRING 为非空字符串，U16/U32 检查整数和位宽及 XML 范围；IPADDR 支持 IP 地址，DOTTEDIP 为 IPv4，IPMASK 为连续位的 IPv4 点分掩码。未知参数类型保留违规，不猜测支持。同一固定 XML 和输入产生相同结果，构建树不同的 missing 保持独立。

同一命令头可有多个参数签名，heads 去重后列出，不因其他头重载而失败。param 总是返回 signatures；单签名仍把该签名放在旧 parameters 中，多签名时 parameters=[]、overloaded=true，调用者须读完整 signatures。重复的相同签名去重，签名携带 scope；可选 scope 先筛选 XML，再匹配。check 检查全部签名，至少一条完全通过则 violations=[]，matchedSignatures 列出通过项；全部失败时保留一组确定性违规并在 signatureChecks 列出每条失败原因。不会把不同签名的参数拼成一个签名。异步产品知识也合并完整签名，不取最后一条覆盖其他重载。

版本线来自首页链接标题或页面文件名；平台是独立维度，不是型号。正式发布需要 `Rel_` 且有 Released on 日期。构建段落没变时不重取 XML 和修复清单；ISO-8859-1 XML 按声明解码，引用 SHA 始终来自解码前原字节。命令存在只证明结构，完整功能语义需要产品证据。

versions 默认 page=1、limit=20，limit 为 1–100；page 为正整数（最多 1000000）。先按版本线取元数据，再按 formal/platform/current/commandTreeAvailable 过滤后计数与分页。正式构建优先，发布日期倒序，再按 current/平台/名称稳定排序。`builds` 每项只有 name/buildId/formal/releasedOn/current/platform/commandTreeAvailable；文件、镜像、完整替代历史不进入列表回复。主平台最新可用正式构建可调用 `{versionLine:"<版本线>",formal:true,platform:null,current:true,commandTreeAvailable:true,limit:1}`，不需要让模型读完整目录。

nextPage=null 表示已到匹配结果末尾，hasMore 明确标识分页，不能把当前页视为全量。revision 是当前元数据及筛选条件摘要；跨页值变更时应重新读取，以免混用源修订。coverage 仍保留 complete 和有限 missing/conflicts/superseded 摘要（每种最多 20 项），counts 给出全部数量，detailsTruncated 说明诊断是否省略；不回传嵌套整份历史。完整 HTML 原件、全部定位和异步知识投影照常保留，即使列表只返回一页。

版本列表支持首页 → 汇总页 → 列表页。产品线清单的 `connectorOptions.build-site.buildSite` 声明 listingPathPattern（可带 versionLine/variant 命名捕获）与 variantPlatforms，通用连接器按该配置筛选汇总页链接和映射平台。遍历有 maxDepth（默认 3、最多 5）及 maxPages（默认 128、最多 256），循环页去重；旧的直接列表仍支持。列表按标题文本加紧随 BLOCKQUOTE 取构建，font 仅是展示标记；支持带变体前缀的 .click 镜像、命令 XML 和修复页，绝对/相对链接都须同源。

`buildId` 是名称与 platform 的稳定身份。所有命令工具的 build、修复工具的 builds 都可用版本列表给出的 buildId；旧构建名仅在结果唯一时使用。同名多平台时返回 INVALID_PAYLOAD，details.reason=ambiguous_build；也可传 platform（null 为普通平台）明确选择。command_heads/param/check 同样新增可选 platform/scope/versionLine。XML 命令头由全部祖先 menu 名加 item 名组成，scope 单独保留；parserVersion=menu-path/2，所有命令工具和产品投影共用该解析。

版本列表记住 buildId/名称到列表页、版本线和平台的定位，保存在 worker 私有缓存，绑定调用身份/资产修订/凭据及产品策略；worker 重启后继续使用。后续命令调用只重读相关列表页，再按段落修订复用或重新取选定 XML；fixed_releases 只重读相关列表页与选定清单。未建立定位的冷调用先发现一次。定位只减少访问范围，当前段落和权限仍重查，不直接采用旧元数据。

同名同平台的重建段落按有效 build on 选唯一最新条，旧条进入 superseded；时间相同/缺失而内容冲突时 current=false、conflict 明确，查询该构建返回 INVALID_PAYLOAD（build_revision_conflict）。列表的 coverage.superseded/conflicts/missing 记录局部替代、冲突和不可读页面，coverage.complete=false 不影响其他构建/版本线返回。平台映射忽略大小写，未知后缀保留规范化源标签；带连字符的构建名与 nodebug-*.click 镜像照样列出。commandTreeAvailable=false 明确表示页面没有命令树，不把它静默丢掉或断言命令 missing。

修复链接识别 show_bug.cgi?id=... 为 bugzilla、index.php?m=bug&f=view&id=... 为 zentao，**只读清单、不跟随缺陷链接**。两种同号不能互相匹配：zentao 用缺陷 id，bugzilla 用镜像 bugzillaID/legacyIssueId。普通响应带 issue={system,id}，all/earliestFormal 保留平台；coverage.buildRefs/readRefs 带完整身份，缺失变体也带 buildId/platform。SDK fixed.result/fixedIds 继续只表示 bugzilla 编号，新增 issues/fixedIssues 表示带体系编号；知识中 fixed-identifiers 保留旧含义，fixed-issues 保存两类。新版 source-projection/3 重读时替换该源旧脚本投影的正式成员，历史声明和 SHA 原件保留。

文档 list/get/section 的 path/file，以及 search.path，都是站点绝对路径，采用 list 返回的值；服务根未必是 `/`，须在运行时 root 配置实际 WebDAV 根，不能假定 `/` 支持 PROPFIND。search 优先使用显式 path；只有 version 时按产品线 `connectorOptions.documents.documents.versionDirectoryTemplate` 定位，APV 声明 `cli/rel_apv_{version}/`，点分版本用 versionSeparator 转成目录形式。没有目录模板的旧包保留 version 路径过滤。

list 默认 page=1/limit=20，limit 为 1–100，nextPage=null 才到目录末尾。目录路径自动补尾斜杠，再发 PROPFIND，避免目录 301；省略 path 使用 profile.root。传 `/` 而已登记根是子目录时返回 INVALID_PAYLOAD 和 details.root。PROPFIND 405 返回可读的路径错误；其他非 207 回应说明预期的 WebDAV 状态，不把错误页面当目录。

search 对选定目录做有界递归（PROPFIND Depth:1），默认深度 3、64 个目录、总原件每页 4 MiB；目录元数据最多 5000 个文件。默认每页只读 20 个文本原件，limit 为 1–100，并受产品 maxFiles 上限约束。每页最多 100 命中，命中页满时可从同一文件下一行继续，不会丢后续行。把 nextCursor 作为同 query/path/version 的 after 补读；coverage.complete=false 不能说“全目录无命中”，只有 nextCursor=null 且无 skipped 才完整。游标绑定身份和当前目录修订，其他身份/查询 INVALID_PAYLOAD，目录变化 INPUT_REVISION_STALE，应从第一页重读。深度/目录数/元数据/字节超限仍明确 RESULT_TOO_LARGE，可缩小 path；不会为一次 spec 查询下载上千个原件。先核对当前目录 etag，再复用同身份缓存的原件；无稳定修订时重取。coverage 带本页 files、totalFiles、directories、bytes、skipped/skippedCount；非文本或非 UTF-8 明确列出。超长片段标 snippetTruncated，完整原件仍以 SHA 保留；已入库产品文档也可走 knowledge/search 的 fulltext。

缺陷镜像列表本身不分页，不能把 keyword 发送到源后假定服务端已过滤。无 product/status/日期约束的查询、或 keyword 没有 product 时，在 HTTP 前返回 INVALID_PAYLOAD；severity/assignedTo 单独不算有界查询。product 必须为 products 返回的正数字 id（数字或数字串），不能传产品名或 0；status 为 active/resolved/closed。先发送允许的源筛选，再做标题字面过滤与本地分页，page/limit/keyword 不发给镜像。默认 20、最多 100，跨页 revision 变化应重新读取。过滤后依然超过 16 MiB 时明确 RESULT_TOO_LARGE，须收窄 product/status/日期；镜像请求允许 30 秒，登录失效与真正不可达保持独立分类。schema 错误的 details.issues 提供 path/code/message，可据此补过滤条件；不回显提交值或凭据。

审批默认有效一天，由 CIRCLE_SERVER_APPROVAL_TTL_MS 配置（1000–2592000000 毫秒）；审批 pending input 使用同一到期时间。普通澄清仍由 CIRCLE_SERVER_INPUT_TTL_MS 控制，默认五分钟。延长审批时间不解除修订、目标身份、动作摘要、当前目录/权限以及 D 出口复核。

`apv-case-execute` 用既有 submit/approvals/events/result 执行 APV 单表工作簿，输入可带 sourceRevisionId 或 artifactId、gatewayAssetId、commandSourceAssetId、build/buildId。服务端两次独立核对命令，投递需另一人批准；网关访问/刷新令牌为个人私有凭据引用，原件、逐步结果与检查点证据按 SHA 存 B。配置、输入边界、恢复与权限详见 [执行交接](case-execution-handoff.md)。Circle `circle_server_submit` 可附加 input，上传源的 id/SHA 由客户端填；同步返回落工作区是 Circle 的职责，server 不写客户端目录。

版本列表与同步只取首页/版本页元数据，**不下载任何 XML/修复清单**。命令 XML 在对应构建首次被命令工具用到时获取，内容按 SHA 持久缓存，索引绑定调用身份/资产修订/来源与构建段落修订，不跨个人凭据复用；元数据变化重新取。修复清单只有 fixed_releases 查询才按指定候选取，结果声明 coverage.completeSite=false，不把候选中的最早发布冒充全站最早。运行时 profile 可配置 requestConcurrency（1–8，默认 2）与 requestIntervalMs（构建工具默认 200）；相同连接器调用的请求同时受并发与开始间隔限制。

个别构建无 fixed 链接或页面失败时保留其他答案，coverage.read/missing[{build,code}] 分别列出已读/缺失，全部缺失时 unknown；普通身份缺失/无权限代码统一隐藏。`coverage.earliestFormalCertain` 仅针对指定候选：已读到正式命中、且没有日期更早或相同的正式构建清单缺失才为 true；否则保留观察到的 earliestFormal 并标为不确定。缓存目前无淘汰；若发布站原地替换 XML 而段落摘要不变，会沿用旧缓存，不能用该缓存证明源站字节仍未变化。

来源地址只在运行时配置文件提供。`CIRCLE_SERVER_CONNECTOR_PROFILES` 指向仓库外的 JSON 文件，形状为 `{"profiles":{"<配置引用>":{"origin":"<运行时来源>","root":"<文档根>","index":"<构建首页>","payloadField":"data"}}}`。连接器资产 configuration 使用 `packageId`（documents/build-site/query-mirror/environment-view/knowledge）、`runtimeProfileRef`、可选 productLineId 和 alias；个人凭据走 `/v1/assets/{id}/credentials`，之后在新资产修订的 declaration.credentials 中引用。PLM 的 JWT 只在 worker 内注入，无 Bearer；值不回到注册/目录/调用响应或审计。当前仅合成来源验收，真实源冒烟仍需授权。

成功的只读回执自动进入产品知识，采用最终一致的异步入库。同步回报只验 SHA、保存原件/证据和持久 outbox，读取立即返回，响应 `{result,evidence}` 保持不变；无须等待声明或快照。server 的独立 runner 从原件抽取结构观察，按批写实体/声明/评估，整个索引任务成功后再更新产品 stable。声明 origin=script，评估 semantic=not-asserted，仅证明字面内容/结构，不能凭命令存在宣称整个功能支持。

通过 `GET /v1/tasks` 可见本人 `capabilityPackId="asset-index"` 的索引任务，其 input.originTaskId 关联原读取任务。原任务 events 的 `knowledge.indexing.linked` 含 `{jobId,taskId,status}`；索引任务的 queued/started/progress/completed 事件带 jobId、processed/total 或 indexed，失败沿用 task.failed/result.error。须补读索引任务事件或 status 后再要求知识检索完整；读取 succeeded 不代表索引已完成。相同源修订/投影版本复用工作，server 中断后 outbox 可恢复；索引失败不把原读取改判失败。

批量记录先暂存成员，成功后增量替换来源的声明闭包，不逐声明遍历整个 scope；旧快照的成员在升级时回填保留。当前快照排除被替换的来源，历史证据保留，空列表修订也更新。源 head 的 generation 区分再次观察到旧字节，避免误用旧的已完成工作。检索按实际读取者、当前资产与源权限、读 grant 和个人凭据状态过滤；每批和发布时重查，不因快照发布扩权。共享会话和 footprint 等模型来源必须 consolidated、显式许可，仍从个人候选开始。

`npm run dev:stack` 一次启动临时 PostgreSQL、server、两个 worker 和合成来源，并登记/独立批准/启用上述五个工具资产。终端打印 server 地址、developer 与 approver 的临时登录方式；developer 登录后立即可取非空工具目录。默认合成版本线为 10.5，正式构建 `Rel_PHOTON_10_5_0_101` / `Rel_PHOTON_10_5_0_109`，前者有 `feature.enable`，后者缺失；两者都有几十条 service 命令。Ctrl+C 也关闭合成来源并删除 scratch。

## 第二阶段：技能包约定与 RPC 边界

以下路由已实现，技能包/RPC 合成验收已通过。实际采用提交与全部检查结果见第二阶段进度。

`POST /v1/skillpacks` 接收 `{manifest,files:[{path,base64,sha256}],trial:{toolCalls:[{name,argsSha256,ok}],outputs:[{path,sha256}]}}`。manifest 含 id/version/title/owner/tools[]/triggers[]/inputs/outputs/model，trigger 为 manual/schedule/event；owner 仅为声明，认证身份来自 token。使用可选请求头 `X-Scope-Id`；只有一个授权 scope 时可省略，多 scope 必须明确。响应 `{skillPackId,digest,status,check:{undeclaredTools,missingTools},approvalTaskId}`；用户确认额外 approvalTaskId 复用第一阶段审批。missingTools 是声明但当前调用者目录不可用的工具，undeclaredTools 是试跑用到但未声明的工具；提交、批准、运行都重查目录。目录是 `GET /v1/skillpacks`，运行是 `POST /v1/skillpacks/{id}/runs` body `{inputs,idempotencyKey}`，返回 `{taskId}`。提交状态不能代替批准，批准绑定 digest，输入或目标修订变化需重新核对。

Circle 运行边界由用户确认改为正式 CLI RPC；当前固定 Git 提交 `8b2ceb6df620832bfd7925aede93bb35f4a605a2`，同时核对 `--version` 为 1.1.1，禁止 import Circle 源码或改 foundation。开发期 CIRCLE_BIN 在运行时指向独立固定提交的本机构建；不要指向仍在提交的客户端工作树。每次运行独立 CIRCLE_HOME 与 HOME，准备可信 workspace、技能目录和输入；启动 `node <CIRCLE_BIN> --mode rpc --extensions --yolo <workspace>`，发 prompt，读 JSON 事件直到 agent_settled；取消先 abort/关 stdin，超时 kill，记录本地停止与远端未知的区别。运行 token 短期且只经环境注入，不落盘；模型使用脚本桩，付费模型仍需授权。详见 Circle 仓库 `docs/rpc.md` 与 `docs/cli.md#json-events`。

POST 成功是 201，status 初始 `candidate`，额外返回 manifest/ownerPrincipalId/scopeId/assetId/assetVersion 供展示；ownerPrincipalId 才是实际登记者。文件路径必须是安全相对路径，必有 SKILL.md，按原字节 SHA 核对，每份/总量均最多 16 MiB；整个清单、文件摘要、试跑记录参与 digest。相同人员/scope/内容复用 skillPackId 与 approvalTaskId；原版本不能改字节，变更需要新版本。试跑是客户端记录的证据声明，机械检查只能核对声明工具/可用目录，不能凭它宣称业务正确或确实试跑完成。

未声明或不可用工具拒绝为 422 `SKILLPACK_CHECK_FAILED`，details.check 带两张清单。用 `GET /v1/tasks/{approvalTaskId}/approvals` 取得 approvalId、inputRevisionId、targetIdentity、actionDigest，再由独立人员按第一阶段 respond body 批准；申请人不能自批。审批者需 decisions.approve 和 assets.approve，不因此获得执行权限；批准时重新核对申请人目录，运行时核对实际运行者目录。批准后包状态 `registered`，绑定 sealed digest 和当前资产修订；停用或修订变化阻止新运行。

工具不匹配的 message 直接列具体名称与原因，例如 `Undeclared trial tools: docs.get; Tools unavailable in caller catalog: zentao.products`；示例不表示这些工具在某个实际身份下不可用。单条消息最多 1000 字符，长清单保留完整名称、显示剩余数量，并指向 details.check；details.check.undeclaredTools/missingTools 完整、去重且稳定排序。名称用 GET /v1/tools 的规范名称，不用 Circle 的 srv_* 名称。缺失与无权限仍统一表示“当前调用者目录不可用”，不泄露隐藏资产、地址、凭据或输入。提交、审批和运行共用该格式；受理后目录撤销导致后台失败时，task result/error 和任务事件保留完整 details.check。客户端应展示 message，并允许查看完整两张清单。

## 通用外部来源制品

客户端沿用 `POST /v1/sources` → `POST /v1/assets` → 独立资产批准这一条链路。先上传每份原始字节，保存响应里的 sourceRevisionId/sha256，再登记 kind=knowledge-source。configuration 的 F 契约是 `SourceArtifactConfiguration`：`{schema:"external-source-artifact/1",metadata:{...},files:[{path,role,mediaType?,sourceRevisionId|sourceRecordId,sha256?}]}`。每个文件只能给一个原件引用；已有产品 SourceRevision 可填 sourceRecordId，候选 Claim 不可作原件。path 是制品内唯一相对路径，不能含绝对路径、点段或反斜杠。

命令树及函数契约的完整登记示例（占位值由客户端替换）：

```json
{
  "scopeId": "<登录授权的 scopeId>",
  "kind": "knowledge-source",
  "name": "<来源名称>",
  "version": "1.0.0",
  "declaration": {"reads": ["registered-source"], "writes": [], "credentials": []},
  "configuration": {
    "schema": "external-source-artifact/1",
    "metadata": {"packageId": "apv", "buildName": "<预期构建名>", "platform": "<平台>", "versionLine": "<可选版本线>"},
    "files": [
      {"path": "commands.xml", "role": "command-tree", "mediaType": "application/xml", "sourceRevisionId": "<XML 上传响应的 id>", "sha256": "<XML 上传响应的 SHA-256>"},
      {"path": "functions.json", "role": "function-contract", "mediaType": "application/json", "sourceRevisionId": "<JSON 上传响应的 id>", "sha256": "<JSON 上传响应的 SHA-256>"}
    ]
  },
  "readers": ["<所有者 principalId>", "<批准者 principalId>"]
}
```

metadata 是消费者的声明数据，不参与平台的产品派发；packageId/buildName/platform/versionLine 在通用层均不解释。APV 模块使用 buildName 作为待 env_prepare 核对的预期构建。平台只校验来源权限、字节 SHA、路径、修订及只读声明，格式和语义由消费模块校验。上传原件先成为 product/SourceRevision（sourceType=external-artifact），响应 files 包含实际 size/sha256/sourceRecordId；绑定工具读取得到 Evidence，命令结构再异步入库，可用索引任务/事件观察进度。文件内自报摘要或 certification 不替代上传原字节 SHA 和独立批准。

登记返回完整资产，初始 lifecycle=draft、顶层 sourceArtifactId=null。草稿作为待批定义，自动对同 tenant、同授权 scope 且有 assets.approve 的审批人可见；登记者不必知道或列出审批人。审批人可用 `GET /v1/assets?lifecycle=draft&kind=knowledge-source&limit=20`（kind 可省略）发现，再 GET 资产或旧 source-artifacts 查询定义，只需 assets.approve。另一人用 `POST /v1/assets/{assetId}/lifecycle` `{version,sha256,state:"approved"}` 批准后，该响应直接返回可用 sourceArtifactId（sar_ 前缀），无需额外激活；所有者或原本 readers 可从 GET 资产继续读取。相同 assetId/version/原件/声明重提复用资产，变内容必须新版本；更新要带首次响应的 assetId。来源 id 绑定资产版本、metadata 和全部文件摘要，旧 id 不自动换成新字节。configuration 里的生成字段只读；提交时使用上述原件引用形状，不复制返回里的 size/sourceRecordId/sourceArtifactId 作为客户端生成字段。

AssetListQuery/CLIENT_ROUTES.assets 增加 lifecycle（draft/approved/running/disabled）过滤，与 kind、scope、权限一起先过滤再计数/分页。审批可见性只覆盖当前草稿的定义和摘要，不把审批人加进 readers，不授予原件/知识内容、凭据、工具或运行权限；credential-reference 保持私有，审批完成/停用后不再借待批规则可见。需要长期共享资料时仍由所有者明确声明 readers 并以新修订批准。审批出口在锁定当前资产后重新检查权限，仍拒自批、旧 version/sha256、跨 tenant/scope。技能登记审批沿用任务接口，个人工具/技能运行/bot 结果的可见性不变。

命令树工具的 build 直接填 sar_ id。也可调用 `buildsite.versions`，args={sourceArtifactId:<sar_ id>}，返回一条精简构建，其 buildId 即该 sar_ id；name 来自 buildName，platform 来自声明，formal=false/releasedOn=null，不能据文件名或上传者声明推成正式发布。分页和过滤沿用 versions 契约，此调用读取本地固定原件，不遍历站点。APV 执行 input={commandSourceAssetId:<来源 assetId>,build:<sar_ id>,...}，函数契约与树 SHA 共同进入审批和投递前检查。实际床构建仍由 env_prepare 确认。

上传来源的 command_tree/command_heads/command_param/command_check 也返回顶层 result.build 与 result.buildId，两者均为实际绑定的 sar_ id，供 gate 直接核对该回执的来源身份。source 块继续带 sourceArtifactId、assetId/assetVersion、commandTreeSha256、buildName、association=operator-declared、origin=uploaded-artifact、live=false。metadata.buildName 只是用户声明的预期构建名，不替代顶层稳定 id；不把其他未知 metadata 字段当成 buildName，也不据上传原件证明床构建。

早期 `/v1/source-artifacts` 辅助登记/查询仍保留兼容，内部使用同一 assets 登记、版本和批准机制；新客户端只使用现有 sources/assets 链路，不新增产品专用命令源路由。CLIENT_ROUTES 已补 assetSubmit/asset/assetLifecycle；SourceArtifactConfiguration 为确切的 configuration 输入形状。

所有工具输入 schema 都增加可选 sourceArtifactId；调用可放 args.sourceArtifactId，或 POST 工具 body 的同名字段，两处有值必须一致。绑定源须与工具任务同 scope、当前已独立批准且原件可读。绑定后仅使用制品原件，不回退到网络；必要时 metadata.requests 可将 `METHOD /path`（或加请求 JSON 的 canonical SHA）映射到 `{path:<制品文件路径>,status:<响应状态>}`，供连接器读取保留响应。结果标 source.origin=uploaded-artifact/live=false，包含来源资产版本/摘要；这不能证明远端当前状态或写效果。原件与读取上下文留 B 证据，索引仍异步。

knowledge.claim_submit 拒绝不可用证据时，失败任务的 GET /result 仍是 HTTP 200、信封 status=failed，原因在 data.error。SOURCE_FORBIDDEN 的 details={field:"evidence",index:<从0开始>,evidenceId:<请求中的引用>} 仅定位调用者提交的项；不存在与无权限同码同文，不泄露实际记录内容、存在性或归属。无效 SHA、非 Evidence 引用及无依据声明的原有拒绝规则保留；它不能代替原件上传和产品来源批准。

## 通用 OAuth 凭据登记

执行资源改用 C 签发的短期访问令牌，无旧外部签发服务、设备授权或个人刷新令牌。服务客户端、标准 /token 与 /v1/introspect、SHA bundle/blob 及原生 HTTPS 配置见 [资源身份交接](resource-identity-handoff.md)。以下外部 OAuth 仍供其他连接器的配置签发方使用，不构成执行资源身份或 HTTP 例外。

签发方与端点从仓库外 CIRCLE_SERVER_OAUTH_PROFILES 读取 `{profiles:{<ref>:{issuer,tokenEndpoint,deviceAuthorizationEndpoint?,clientId,clientAuthentication:"none"|"client_secret_basic"|"client_secret_post",scope?,accessTtlSeconds?,caFile?,caSha256?}}}`。没有固定签发方或固定 token 路径。连接器 configuration.oauthProfileRef 必须绑定该 ref；请求不能传任意端点。远端端点必须 HTTPS；HTTP 只供回环合成测试，用户已决定不开放真实明文签发例外。CA 每次核验，不跟随重定向。

POST /v1/credentials/oauth/device 接收 `{connectorAssetId,connectorVersion,profileRef,clientCredentialId?,idempotencyKey}`，返回 flowId/status/userCode/verificationUri/intervalSeconds/expiresAt。用户去签发方确认，再 POST /v1/credentials/oauth/device/{flowId}/poll 空 JSON。轮询遵守 interval，slow_down 后增加五秒，拒绝/过期停止；流程按用户和连接器修订持久化，设备 code 在私有加密 vault 中，未返回。

POST /v1/credentials/oauth/client-credentials 使用同形请求；clientCredentialId 是本人通过既有私有凭据端点登记的 `{client_id?,client_secret}` JSON 引用，绑定同一连接器。只支持配置好的保密客户端认证方式。两种授权成功均只返回 credentialAssetId 与到期元数据，值不在 API、事件、审计或 Git 中；把新引用放入连接器新修订并批准后使用。不同 scope/所有者不能借用凭据。

令牌临期在私有单写者锁内续期；标准刷新未返回新 refresh_token 时保留旧的非轮换令牌，返回新值则原子替换；client_credentials 无 refresh_token 时重取该 grant。未知刷新回执停止重放，明确 5xx 保留原会话，撤销需重新授权。未返回 expires_in 且无配置默认 TTL 时到期未知（null），不虚构期限。连接器 runtime profile 的 authorizationScheme 可为 raw 或 bearer，旧 raw 默认保持兼容。授权流程与 token/credential 引用分开，流程完成并不自动批准连接器或设备动作。

运行请求 202 `{taskId}`，inputs 原 JSON 作为 `inputs.json` 写进 workspace；可用 `inputs.files:[{path,base64,sha256?}]` 附输入文件。输入不能覆盖 .circle/控制文件/声明输出；改输入使用新幂等键，同键不同输入拒绝。结果返回实际 artifacts/evidence/runtime，产物只在 CLI agent_settled、进程退出和声明文件完整、独立字节 SHA 核对后交付。文件完整性/摘要属于 script-conclusion，最后回答另记 model-judgment，不用回答替代产物或专业事实。artifact/content 与个人任务权限一并检查。

`CIRCLE_RUNTIME_CONFIG` 指向仓库外的运行时 JSON：

```json
{"circleBin":"<本机构建的 dist/cli.js>",
 "circleCommit":"8b2ceb6df620832bfd7925aede93bb35f4a605a2","circleVersion":"1.1.1",
 "model":{"kind":"scripted","base_url":"<本机脚本模型 /v1>","model":"scripted-fixture","protocol":"openai","api_key":"<运行时值>"}}
```

在设置这个运行时配置后启动 `npm run dev:stack`；developer 有提交/运行权限，approver 可审批。当前 runtime 只允许 loopback 脚本模型，未配置时运行返回 SOURCE_UNREACHABLE，登记/审批仍可用。CircleBin 与所有地址只在运行时提供；CLI/模型安装由对应构建提供，这里不运行安装/更新脚本。

每次运行短期 token 仅授权声明的目录工具、其 scope 和该运行/子工具任务；不允许借它直接登记资产、提交其他能力任务或审批。token 通过认证 worker 的本机私有 IPC 交给进程，只存在内存/子进程环境，公开 worker preflight 不返回值，运行目录中不落盘；结束/取消失效。单 worker 留一个 RPC 运行槽，同时处理它的子工具调用，避免互相等待。

任务 events 增加 `runtime.<RPC type>`（例如 runtime.tool_result/runtime.agent_settled），payload.event 为实际 RPC 事件。取消发 abort、关 stdin，超时 kill；观察到本地进程退出后任务保持 unknown、资源冻结，返回 remoteStoppingVerified:false。未完成独立远端核对，不把本地退出记为远端停止或已交付；后续事件按原游标补读。

真实 RPC 验收需显式设置 `CIRCLE_BIN` 和 `CIRCLE_COMMIT` 再运行 `r2-05-skillpacks.test.ts` 或整套；没有时实际 CLI 用例（第 5 幕三条、第 6 幕两条、第 7 幕一条）显示原因并跳过，不能把 skip 当作运行通过。Circle 工作树升级时选择新的已确认构建或独立固定旧提交的 worktree，运行器不会因此放宽固定版本检查。

## 第二阶段：触发、整理与 Circle 渠道

`POST /v1/automations/triggers` 登记草稿资产：共同字段 scopeId/version/name，定时追加 `{kind:"schedule",intervalMs,startsAt}`，事件追加 `{kind:"event",sourceAssetId,eventName}`。`POST /v1/automations/bots` 共同字段追加 skillPackId/triggerAssetId/identityPrincipalId/channel/inputs；第一版 identity 必须是登记者本人，channel 为 `circle-events`。组件须同 scope，技能 manifest 必须允许相应 trigger。需要 automations.manage，资产经独立人员批准并由主人激活才运行；不跳过资产生命周期。

`intervalMs` 至少 60000。迟批或关机错过的定时 occurrence 合并成最近一次到期运行，不逐条补跑。任务 `inputs.trigger`、`bot.started.payload.trigger` 和 runs 的 trigger 均含 `{kind:"schedule",dueAt,firstDueAt,skippedOccurrences}`；firstDueAt 是原游标，dueAt 是本次实际受理的到期点，下一游标严格推进到未来。

`GET /v1/automations/bots/{assetId}/runs` 返回个人任务及 occurrenceKey/channel/published，需 automations.read。`POST /v1/connectors/{assetId}/events` 接收 `{externalId,name,payload}`，需 connectors.events、当前源主人及运行中的连接器；同源/范围/外部 id 去重，不同 payload 同 id 拒绝。正常连接器读收据也会按 path/SHA 生成 source.changed；不连接旧缺陷系统。

runs 保留上述字段，追加 `status:"admitted"|"failed"`、`trigger`、`error`。status 描述受理结果：admitted 的 taskId 非空，最终执行结果仍从该任务读取；failed 的 taskId 为 null，error 含失败分类和不带来源细节的说明，客户端直接显示 error。每个 occurrence 的受理 ApiError 独立回滚并保存失败，事件游标继续前进，不重复尝试已拒绝的事件；后续新事件照常受理。失败受理没有任务，不伪造 bot.output。

定时 dueAt 和事件游标、任务/唯一 occurrence 同事务保存，重启重读不会丢/重派。C 最终新增 bot.output，含 channel/botAssetId/status/artifacts/evidence/unknowns；输出只在 Circle 事件流，渠道注册可扩展，没有企业微信桩。

为避免动态页面的自触发和 bot 互相触发，C 根据持久的运行/子工具关系忽略任何 bot 运行产生的 observed source.changed；原件、证据、知识和 bot.output 仍保存。显式连接器事件和普通人工工具读取继续触发，用户输入的 trigger 字段不能伪造来源分类。

`knowledge.shared_fragments {limit?,after?}` 是 read/sync：只取 caller 明确允许共享、当前可见的 shared-session 修订，返回原片段、工具返回和 Evidence；未共享输入不进入整理。limit 默认 20、范围 1–100，每页片段和未映射条目的总数受限；SQL 按创建时间/recordId 限量读源，游标也记录同一源内的片段位置。`result.nextCursor` 是不透明字符串或 null，非空时传作下一次 after；游标绑定身份和 scope，重启可继续，同键回放原页，后续修订保持各自来源证据。目录正确导出输入 schema，默认值参数可省略。`packs/common/skills/knowledge-consolidation` 逐页处理，其 TypeScript 脚本只规范/去重有证据的结构化 facts/practices/corrections，真实文本的语义抽取没有验收；候选仍为 personal/consolidated，产品优先、冲突保留、不自动发布团队快照。普通 bot 读者不能看他人个人任务/候选。

worker 的回报处理若因 ApiError 拒绝，知识/制品写入回滚，操作与任务保存为 failed、释放租约，保留原回报 hash 供同回报幂等重传；不会停留 running 阻塞下一次调用。租约、fence、当前输入校验仍在回报处理前执行，迟到或越权回报仍拒绝。

## 第二阶段：工作列表过滤与续页

`GET /v1/tasks` 仍返回 TaskView 数组，limit 默认 20、最多 100。新增可选 `kind=work|tool|index`、`capabilityPackId=<精确包 id>`、`after=<上一页末项 taskId>`，请求 schema 在 CLIENT_ROUTES.tasks.query。kind 的分类为 asset-tool→tool、asset-index→index，其余及未指定能力包的任务→work；同时提供 kind 和 capabilityPackId 时取交集。客户端工作页使用 `?kind=work&limit=20`，下一页追加 after，数组为空即读完；不必先下载内部任务再过滤。

## 产品线安装与工具别名

启动时 `CIRCLE_SERVER_PRODUCT_LINES` 可指向仓库外的安装 JSON：`{"schemaVersion":"installed-product-lines/1","productLines":["apv/product-line.json","meridian/product-line.json"]}`。清单路径相对安装文件解析；未设置时使用 packs/installed-product-lines.json，默认客户端工具名保持兼容。每份 product-line/1 清单声明 connectorPackages、toolAliases、skills、methods 和 knowledgeMappings；包 id、版本、重复声明和安全相对路径在启动前校验。格式及边界见 [packs/README.md](../packs/README.md)。

新连接器资产可在 configuration 带 `productLineId`，由该产品线清单选择工具前缀。例如 `{"packageId":"documents","productLineId":"meridian","runtimeProfileRef":"<运行时引用>"}` 自动登记 meridian_docs 工具。可选 alias 仍覆盖实例前缀，同一 tenant 内工具名称冲突仍拒绝。省略 productLineId 时沿用第一个声明该连接器的清单前缀；公共 knowledge 工具独立保留。移除产品线并重启后，该产品线明确绑定的工具从目录隐藏；恢复安装后可继续使用原已批准绑定。ETag 和普通调用权限规则不变。

清单安装只读取声明，不导入其中的可执行路径，也不等于技能包已经获批。技能提交/审批/运行仍查当前目录，沿用原接口；既有编译能力和历史迁移保留。

运行 token 仍默认短期 5 分钟（CIRCLE_SERVER_RUN_TOKEN_TTL_MS 1000–300000ms 可缩短用于验收），绑定操作/fence/任务和固定 scopes/grants/tools。只有持有效租约的 worker 在完整 preflight 校验后续期，截止不超过该操作 deadline；任务结束、取消、租约过期、旧 fence 或输入修订变化立即阻止新访问。客户端不能调用 auth/refresh 续这种 token，也不因本地会话断开就声称远端停止。

权限、类别和能力包筛选先于 limit，按创建时间、taskId 倒序；游标取保存的完整 PostgreSQL 创建时间，不按 phase/更新时间排序，server 重启可续读。after 必须是当前身份可读的任务；越 scope/个人任务返回 FORBIDDEN_SCOPE，格式错误、未知类别和越界 limit 为 INVALID_PAYLOAD。省略新参数时行为与第一阶段相同。
