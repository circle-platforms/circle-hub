# Circle 客户端接口交接：普通用户读取与脑图编译

2026-10-12。实现位于隔离工作树 `/Users/jiangyongze/Public/circle-server-s1`，分支 `server-s1`。Circle 和连接插件由 Claude 负责；本分支只提供 server/worker。协议原件是 `packages/contracts/src/index.ts`：`CLIENT_ROUTES`、请求/回应 schema、`TaskListQuery`、`TaskView`、`ApprovalView`、`TaskResult`、`EventPage`、标准操作与 `MindmapPack`。API 版本 `1.0.0`，能力包与映射规则版本 `1.0.0`，Excel 契约为 `Excel 输出契约 V1`。

## 启动和登录

```sh
cd /Users/jiangyongze/Public/circle-server-s1
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

开发身份源仅在 `CIRCLE_SERVER_DEV_AUTH=1` 且显式指定临时身份配置时启用。它不是企业认证。token 默认有效 5 分钟；客户端用秘密存储保存登录材料，过期后重新登录并补读事件。账号和授权来自服务端配置/策略表，请求体自报的 principal、role、actor 或 tenant 都不授予权限。

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
| `buildsite.versions` | `{versionLine?}` | `versionLines`, `platforms`, `builds[]`；每个构建含 name/versionLine/formal/releasedOn/platform/buildTime/镜像声明 SHA 与大小 |
| `buildsite.command_tree` | `{build}` | build/sourceSha256/commands；固定构建 XML 投影 |
| `buildsite.command_heads` | `{build,prefix}` | heads/count/limit/ruleVersion；上限 128，超出报 `RESULT_TOO_LARGE`，details.outcome=`result_too_large`，不截断 |
| `buildsite.command_param` | `{build,head}` | status/head/parameters/ruleVersion；参数含 position/type/optional/help/range/enum，position 从 1 开始 |
| `buildsite.command_check` | `{build,commands:[...]}` | build/sourceSha256/ruleVersion/commands；每条含 status=`hit` 或 `missing`、head、arguments、violations |
| `docs.list` / `docs.get` | `{path?}` / `{file}` | files / path/contentBase64 |
| `docs.search` | `{query,version?}` | hits：file/line/snippet/sourceSha256；行号从 1 开始；version 以文档路径维度过滤 |
| `docs.section` | `{file,anchor}` 或 `{file,line,window?}` | file/lines[{line,text}]/sourceSha256；anchor 对应以 `**<命令头>**` 开头的小节；窗口默认 40、最多 80 行，超长小节明确失败 |
| `zentao.bug_search` | `{keyword?,product?,status?,severity?,assignedTo?,openedBy?,lastEditedDate_start?,lastEditedDate_end?}` | items；镜像列表不分页，keyword 在取回的授权列表上按标题字面过滤 |
| `zentao.bug_detail` | `{ids:[...]}`（1–100） | items；数字/日期统一，未知 resolution 留在 unmapped |
| `env.inventory` / `env.topology` / `env.device_status` | `{}` / `{environmentId}` / `{deviceId}` | 只读跳板返回；没有执行或改环境入口 |
| `env.framework_files` / `env.framework_get` | `{}` / `{path}` | 框架只读镜像目录/文件 |
| `knowledge.claim_submit` | `{claim:{subject,predicate,value,conditions?},evidence:[{evidenceId,sha256}]}` | **write/task**；最终 `result` 为个人沉淀候选记录，附原工具返回，不自动提升 |

E 的 `command-tree/1.0.0` 规则采用 POSIX quote/escape 分词并转小写，最多八词的最长前缀匹配。hit 表示命令头存在，参数另报 `ARGUMENT_COUNT`、`TYPE_MISMATCH`、`ENUM_MISMATCH`、`OUT_OF_RANGE` 或 `UNSUPPORTED_PARAMETER_TYPE`；missing 报 `HEAD_MISSING`，不能用手册命中改成 hit。STRING/XSTRING 为非空字符串，U16/U32 检查整数和位宽及 XML 范围；IPADDR 支持 IP 地址，DOTTEDIP 为 IPv4，IPMASK 为连续位的 IPv4 点分掩码。未知参数类型保留违规，不猜测支持。同一固定 XML 和输入产生相同结果，构建树不同的 missing 保持独立。

版本线来自首页链接标题或页面文件名；平台是独立维度，不是型号。正式发布需要 `Rel_` 且有 Released on 日期。构建段落没变时不重取 XML 和修复清单；ISO-8859-1 XML 按声明解码，引用 SHA 始终来自解码前原字节。命令存在只证明结构，完整功能语义需要产品证据。

来源地址只在运行时配置文件提供。`CIRCLE_SERVER_CONNECTOR_PROFILES` 指向仓库外的 JSON 文件，形状为 `{"profiles":{"<配置引用>":{"origin":"<运行时来源>","root":"<文档根>","index":"<构建首页>","payloadField":"data"}}}`。连接器资产 configuration 使用 `packageId`（documents/build-site/query-mirror/environment-view/knowledge）、`runtimeProfileRef`、可选 alias；个人凭据走 `/v1/assets/{id}/credentials`，之后在新资产修订的 declaration.credentials 中引用。PLM 的 JWT 只在 worker 内注入，无 Bearer；值不回到注册/目录/调用响应或审计。当前仅合成来源验收，真实源冒烟仍需授权。

`npm run dev:stack` 一次启动临时 PostgreSQL、server、两个 worker 和合成来源，并登记/独立批准/启用上述五个工具资产。终端打印 server 地址、developer 与 approver 的临时登录方式；developer 登录后立即可取非空工具目录。默认合成版本线为 10.5，正式构建 `Rel_PHOTON_10_5_0_101` / `Rel_PHOTON_10_5_0_109`，前者有 `feature.enable`，后者缺失；两者都有几十条 service 命令。Ctrl+C 也关闭合成来源并删除 scratch。

## 第二阶段：技能包约定与 RPC 边界

以下路由已实现，技能包/RPC 合成验收已通过。实际采用提交与全部检查结果见第二阶段进度。

`POST /v1/skillpacks` 接收 `{manifest,files:[{path,base64,sha256}],trial:{toolCalls:[{name,argsSha256,ok}],outputs:[{path,sha256}]}}`。manifest 含 id/version/title/owner/tools[]/triggers[]/inputs/outputs/model，trigger 为 manual/schedule/event；owner 仅为声明，认证身份来自 token。使用可选请求头 `X-Scope-Id`；只有一个授权 scope 时可省略，多 scope 必须明确。响应 `{skillPackId,digest,status,check:{undeclaredTools,missingTools},approvalTaskId}`；用户确认额外 approvalTaskId 复用第一阶段审批。missingTools 是声明但当前调用者目录不可用的工具，undeclaredTools 是试跑用到但未声明的工具；提交、批准、运行都重查目录。目录是 `GET /v1/skillpacks`，运行是 `POST /v1/skillpacks/{id}/runs` body `{inputs,idempotencyKey}`，返回 `{taskId}`。提交状态不能代替批准，批准绑定 digest，输入或目标修订变化需重新核对。

Circle 运行边界由用户确认改为正式 CLI RPC；当前固定 Git 提交 `3f08f0ed4216c356bbbd7db49531cb3ea22caf97`，同时核对 `--version` 为 1.1.1，禁止 import Circle 源码或改 foundation。开发期 CIRCLE_BIN 在运行时指向本机构建。每次运行独立 CIRCLE_HOME 与 HOME，准备可信 workspace、技能目录和输入；启动 `node <CIRCLE_BIN> --mode rpc --extensions --yolo <workspace>`，发 prompt，读 JSON 事件直到 agent_settled；取消先 abort/关 stdin，超时 kill，记录本地停止与远端未知的区别。运行 token 短期且只经环境注入，不落盘；模型使用脚本桩，付费模型仍需授权。详见 Circle 仓库 `docs/rpc.md` 与 `docs/cli.md#json-events`。

POST 成功是 201，status 初始 `candidate`，额外返回 manifest/ownerPrincipalId/scopeId/assetId/assetVersion 供展示；ownerPrincipalId 才是实际登记者。文件路径必须是安全相对路径，必有 SKILL.md，按原字节 SHA 核对，每份/总量均最多 16 MiB；整个清单、文件摘要、试跑记录参与 digest。相同人员/scope/内容复用 skillPackId 与 approvalTaskId；原版本不能改字节，变更需要新版本。试跑是客户端记录的证据声明，机械检查只能核对声明工具/可用目录，不能凭它宣称业务正确或确实试跑完成。

未声明或不可用工具拒绝为 422 `SKILLPACK_CHECK_FAILED`，details.check 带两张清单。用 `GET /v1/tasks/{approvalTaskId}/approvals` 取得 approvalId、inputRevisionId、targetIdentity、actionDigest，再由独立人员按第一阶段 respond body 批准；申请人不能自批。审批者需 decisions.approve 和 assets.approve，不因此获得执行权限；批准时重新核对申请人目录，运行时核对实际运行者目录。批准后包状态 `registered`，绑定 sealed digest 和当前资产修订；停用或修订变化阻止新运行。

运行请求 202 `{taskId}`，inputs 原 JSON 作为 `inputs.json` 写进 workspace；可用 `inputs.files:[{path,base64,sha256?}]` 附输入文件。输入不能覆盖 .circle/控制文件/声明输出；改输入使用新幂等键，同键不同输入拒绝。结果返回实际 artifacts/evidence/runtime，产物只在 CLI agent_settled、进程退出和声明文件完整、独立字节 SHA 核对后交付。文件完整性/摘要属于 script-conclusion，最后回答另记 model-judgment，不用回答替代产物或专业事实。artifact/content 与个人任务权限一并检查。

`CIRCLE_RUNTIME_CONFIG` 指向仓库外的运行时 JSON：

```json
{"circleBin":"<本机构建的 dist/cli.js>",
 "circleCommit":"3f08f0ed4216c356bbbd7db49531cb3ea22caf97","circleVersion":"1.1.1",
 "model":{"kind":"scripted","base_url":"<本机脚本模型 /v1>","model":"scripted-fixture","protocol":"openai","api_key":"<运行时值>"}}
```

在设置这个运行时配置后启动 `npm run dev:stack`；developer 有提交/运行权限，approver 可审批。当前 runtime 只允许 loopback 脚本模型，未配置时运行返回 SOURCE_UNREACHABLE，登记/审批仍可用。CircleBin 与所有地址只在运行时提供；CLI/模型安装由对应构建提供，这里不运行安装/更新脚本。

每次运行短期 token 仅授权声明的目录工具、其 scope 和该运行/子工具任务；不允许借它直接登记资产、提交其他能力任务或审批。token 通过认证 worker 的本机私有 IPC 交给进程，只存在内存/子进程环境，公开 worker preflight 不返回值，运行目录中不落盘；结束/取消失效。单 worker 留一个 RPC 运行槽，同时处理它的子工具调用，避免互相等待。

任务 events 增加 `runtime.<RPC type>`（例如 runtime.tool_result/runtime.agent_settled），payload.event 为实际 RPC 事件。取消发 abort、关 stdin，超时 kill；观察到本地进程退出后任务保持 unknown、资源冻结，返回 remoteStoppingVerified:false。未完成独立远端核对，不把本地退出记为远端停止或已交付；后续事件按原游标补读。

真实 RPC 验收需显式设置 `CIRCLE_BIN` 和 `CIRCLE_COMMIT` 再运行 `r2-05-skillpacks.test.ts` 或整套；没有时三个实际 CLI 用例显示原因并跳过，不能把 skip 当作运行通过。Circle 工作树升级时选择新的已确认构建或独立固定旧提交的 worktree，运行器不会因此放宽固定版本检查。
