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
