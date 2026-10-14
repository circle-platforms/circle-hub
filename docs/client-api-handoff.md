# Circle 客户端接口交接：普通用户读取与脑图编译

本文件保留接口变更记录、运行教程和产品连接器契约；通用规则以[设计规范](design/README.md)为准，迁移对照见[handoff-map](design/handoff-map.md)。

2026-10-14：维护者报告全量 **623/623**，A3 轮已在 `be9c6c0` 合并；这是维护者观察，不是 CI 结论。真实试验栈仍为 `e1ca68d`，未因本轮升级。

2026-10-12 的首阶段记录：第一阶段实现位于隔离工作树 `../circle-server-s1`，分支 `server-s1`；第二阶段增补在 `../circle-server-s2` 的 `server-s2` 分支。Circle 和连接插件由 Claude 负责；本分支只提供 server/worker。共享协议原件是 `packages/contracts/src/index.ts`：`CLIENT_ROUTES`、请求/回应 schema、`TaskListQuery`、`TaskView`、`ApprovalView`、`TaskResult`、`EventPage` 和标准操作。编译包的描述及专用协议在 `packs/apv/contracts.ts`，HTTP 形状保持兼容。API 版本 `1.0.0`，能力包与映射规则版本 `1.0.0`，Excel 契约为 `Excel 输出契约 V1`。

Hub 名称与配置已统一，下文运行示例使用新名。旧阶段记录、来源 schema、已存在工作树名保留历史原文，不表示需要改文件系统目录。

| 范围 | 当前名称 | 兼容边界 |
|---|---|---|
| Hub 本地与 package bin CLI | `circle-hub`，本地 `./bin/circle-hub` | `circle-server` 可执行名不保留别名；`npm run admin` 不变 |
| Hub 配置前缀 | `CIRCLE_HUB_<后缀>` | 同后缀 `CIRCLE_SERVER_<后缀>` 仅作弃用回退 |
| 连接地址与管理身份 | `CIRCLE_HUB_URL`、`CIRCLE_HUB_TOKEN`、`CIRCLE_HUB_TOKEN_FILE`、`CIRCLE_HUB_SCOPE` | 值与秘密文件仍只在运行时提供 |
| 数据库、存储与监听 | `CIRCLE_HUB_DATABASE_CONFIG`、`CIRCLE_HUB_DATA_DIR`、`CIRCLE_HUB_PG_DIR`、`CIRCLE_HUB_PORT`、`CIRCLE_HUB_TLS_CONFIG` | 原配置形状、TLS 核验与回环边界不变 |
| 身份与任务时限 | `CIRCLE_HUB_DEV_AUTH`、`CIRCLE_HUB_DEV_IDENTITIES`、`CIRCLE_HUB_DEV_TOKEN_TTL_MS`、`CIRCLE_HUB_RUN_TOKEN_TTL_MS`、`CIRCLE_HUB_RESOURCE_TOKEN_TTL_SECONDS`、`CIRCLE_HUB_INPUT_TTL_MS`、`CIRCLE_HUB_APPROVAL_TTL_MS` | 时限、授权、刷新与审批规则不变 |
| 来源、凭据与模块配置 | `CIRCLE_HUB_CONNECTOR_PROFILES`、`CIRCLE_HUB_EXECUTION_GATEWAYS`、`CIRCLE_HUB_OAUTH_PROFILES`、`CIRCLE_HUB_PRODUCT_LINES`、`CIRCLE_HUB_CA_FILE`、`CIRCLE_HUB_CA_SHA256` | 已批准 profile 的内容与摘要不因环境变量名变化改写 |
| 进程、索引与通知 | `CIRCLE_HUB_POLL_MS`、`CIRCLE_HUB_INDEX_POLL_MS`、`CIRCLE_HUB_MANAGED_WORKERS`、`CIRCLE_HUB_WORKER_OFFLINE_MS`、`CIRCLE_HUB_NOTIFICATION_STREAMS`、`CIRCLE_HUB_OUTBOX_REPLAY_EVENTS`、`CIRCLE_HUB_OUTBOX_MAX_ROWS`、`CIRCLE_HUB_OUTBOX_MAX_AGE_MS` | 作用与取值范围沿原配置 |
| 冻结执行实现的配置读取 | 对外使用 `CIRCLE_HUB_EXECUTION_GATEWAYS` | 集中配置层把选定的新值提供给冻结 controller 的 `CIRCLE_SERVER_EXECUTION_GATEWAYS` lookup；两键都有时仍以新值为准，空值不回退。保留旧 lookup 避免只为改名更换实现 SHA/版本并要求重批；以后实际执行实现升级时迁掉 |
| 冻结编译产物的 creator | 原 `circle-server` creator 文本 | creator 参与产物字节与 SHA，本轮原样保留；待编译方法迁入产品包并正式升版时再改，不把改名当作重新编译授权 |
| Circle 自己的扩展协议 | 扩展 `circle-server`、命令 `/server`、工具 `srv_*` / `circle_server_*` | Hub 启动无界面 Circle 时仍注入 `CIRCLE_SERVER_URL`、`CIRCLE_SERVER_TOKEN`、`CIRCLE_SERVER_USER`、`CIRCLE_SERVER_SCOPE`。它们由 Circle 维护，待 Circle 扩展发布一并迁移；本轮 Hub 改名不单独修改客户端协议 |
| HTTP、schema 与版本绑定 | `/v1/*`、`/mcp`、既有请求/响应字段、持久 schema、数据库迁移字节与冻结实现 | 本轮不因平台改名更换路由、契约、数据库标识或历史迁移 |
| 历史与实际路径 | 既有 `../circle-server-s1`、`../circle-server-s2` 工作树，旧简报/进度/validation schema 与 provenance | 未改名的目录仍使用真实旧名；foundation/references 与归档中的 circle-server 来源保留原字节 |

配置选择以“新键是否存在”为准：有 `CIRCLE_HUB_<后缀>` 就选它，空字符串也不回退到旧键，随后照常校验该值；两键同时出现时新键优先。只有新键缺失且旧键存在才使用旧值；进程启动发现旧输入键时输出一行弃用提示，只记录变量键名，不记录地址、值或密钥，也不在每次请求重复告警。冻结 controller 的旧 lookup 与 Circle 子进程的旧协议注入按表保留，不能据此声称所有旧标识已消失。`CIRCLE_BIN` / `CIRCLE_COMMIT`、`CIRCLE_RUNTIME_CONFIG`、`CIRCLE_HOME`、`CIRCLE_WORKER_*` 与模块验收的 `CIRCLE_PACKS_*` 本轮不改。

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

同时输出一条 `type: "dev-stack-ready"` JSON，含 `url`、`login`、`scopeId`、`samplePath`、`pid` 和 PostgreSQL 实际版本。端口默认随机；需要固定时用 `CIRCLE_HUB_PORT=8080 npm run dev:stack`。全部服务只监听 127.0.0.1。本次登录密码只保存在临时配置并打印到该终端，不固定在 Git。Ctrl+C 有序停止 worker、server 和 PostgreSQL 并删除临时数据库、原件及制品。再次启动是新环境；server 在同一个仍存活的 PostgreSQL 中重启才会恢复原任务。

第二阶段完整栈支持原生 HTTPS：在启动 Node/npm 进程前设置仓库外 `CIRCLE_HUB_TLS_CONFIG`（certFile/keyFile）及 `NODE_EXTRA_CA_CERTS`（自签 CA 文件），ready.url 会是 https://127.0.0.1。worker、admin 和无界面 Circle 均保留证书/主机名校验并使用该信任；不放宽为远端 worker 地址。启动示例及用户选定的 SSH 反向隧道交接见[资源身份与 HTTPS](resource-identity-handoff.md#执行接入与-https)。

开发身份源仅在 `CIRCLE_HUB_DEV_AUTH=1` 且显式指定临时身份配置时启用。它不是企业认证。token 默认有效 **8 小时**；`CIRCLE_HUB_DEV_TOKEN_TTL_MS` 可配置 1000–86400000ms（最多 24 小时），显式请求的短 expiresInMs 仍有效。客户端用秘密存储保存 token，到期前无交互续期。账号和授权来自服务端配置/策略表，请求体自报的 principal、role、actor 或 tenant 都不授予权限。

`POST /v1/auth/refresh` 带当前 Bearer 和空 JSON `{}`，响应沿用 dev-login 的 `{token,tokenType,expiresAt,principalId,tenantId,scopes}`（CLIENT_ROUTES.authRefresh）。仅仍有效、未撤销且身份未禁用的开发会话可续期；不要求密码、不接受自报期限/身份/范围。初版曾延长同一 token；修订 3 已改为轮换，当前会话口径见[会话与令牌](design/roles.md#会话与令牌)。已过期返回 401，不从过期凭据恢复会话；受约束 run token 返回 403，不能升级成普通登录。

Circle 2035247 已由维护者报告支持：保存 expiresAt、到期前约 2 分钟或短期限的 1/5（至少 5 秒）及请求前续期；旧 server 的 404/405 只尝试一次。任何工具/任务轮询的 401 都只提示 sign-in expired 和显式 `/server login`，不自动弹密码框；run token 不由客户端续期。已过期的旧 5 分钟会话需要主动登录一次，随后使用新期限。正式企业身份/刷新 token 仍未接入。

## 通用信封

初版接口增加 JSON 成功 / 失败信封；当前共同形状、认证、容量与错误分类已并入[接口的共同形状](design/circle-integration.md#接口的共同形状)。协议 schema 仍由 CLIENT_ROUTES 与 F 提供，不在此重述规则。

## 普通用户只读接口

第一阶段新增两条普通读取路径，旧数组兼容保留。TaskView / ApprovalView、权限、排序与 limit 边界见[任务与审批的读取投影](design/circle-integration.md#任务与审批的读取投影)，后续 view=page 变更见本文件的列表记录。

| CLIENT_ROUTES | 调用 | 成功 data |
|---|---|---|
| `tasks` | `GET /v1/tasks?limit=20` | `TaskView[]` |
| `approvals` | `GET /v1/tasks/{taskId}/approvals` | `ApprovalView[]`；没有记录时为 `[]` |

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

提交示例中的 title 可省略。幂等分区、窗口、受理事务和制品复用规则已并入[接口的共同形状](design/circle-integration.md#接口的共同形状)；下载字节核对见[B 的原件与证据规则](design/object-standard.md#四b-的原件与证据规则)。

## 状态、事件和交付

首阶段脑图任务使用 admitted → running → waiting-resource → under-review → delivered 的流程，waiting-resource 表示等待 worker / 回报。交付与 unknown 的解释见[未知的纪律](design/approvals-and-enforcement.md#未知的纪律)；下列编译结果示例保留。

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

事件游标和取消纪律已并入[事件补读](design/circle-integration.md#事件补读)。调用仍为 POST /v1/tasks/{taskId}/cancel / reconcile，body `{}`；编译 unknown 的核对接口只披露缺少独立观察。

## 补充或更换输入

通用 C 的待回应请求在 status.pendingInputs 中，客户端只提示 `status:"open"` 且 inputRevisionId 等于当前修订的项：

```json
{"inputRevisionId":"inrev_...","requestId":"pin_...","response":{"target":"LBX-LAB-01"}}
```

输入修订、回应尝试记录与超期处理见[变更集与输入修订](design/approvals-and-enforcement.md#只有一个审批概念变更集)。下列回应与 replacement 教程保留。

脑图任务已获完整源引用后不需要人工问题。需要更换源时，在交付前上传新原件，再调用：

```json
{"inputRevisionId":"inrev_旧修订","replacement":{"sourceRevisionId":"src_新原件"}}
```

输入修订换版沿上述设计规则实现，HTTP 回应与替换字段保持既有契约。

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

目录命名、当前身份过滤和资产状态检查已并入[工具目录与调用](design/circle-integration.md#工具目录与调用)。

本轮增加 ETag / If-None-Match 支持；缓存与 schema 使用规则见[工具目录与调用](design/circle-integration.md#工具目录与调用)。

`POST /v1/tools/{name}/call` body 为 `{"args":{...},"idempotencyKey":"<每次逻辑调用的稳定键，8–200 字符>"}`。读工具返回 200：

```json
{"result":{"build":"Rel_PHOTON_10_5_0_101","commands":[]},
 "evidence":[{"evidenceId":"knr_...","sha256":"<64位 SHA-256>"}]}
```

同步调用已接入持久任务与 worker 回执；幂等、等待超时和新查询规则见[工具目录与调用](design/circle-integration.md#工具目录与调用)。

工具任务的个人范围规则已并入[角色登记与资格披露](design/roles.md#角色登记与资格披露)。

task 工具返回 202 `{"taskId":"task_...","phase":"admitted"}`（phase 以实际值为准），随后按第一阶段 status/events/result 补读。结束后的 result 增加 `data.result` 保存工具结果，`data.evidence` 保存出处；原 artifacts/unmapped/status 等字段继续保留。证据原件可经 `GET /v1/knowledge/records/{evidenceId}/content` 取回，返回 `x-content-sha256`，客户端应重算 SHA；下载再次检查当前来源权限。

来源失败分类及普通身份的隐藏规则已并入[来源失败的分类](design/approvals-and-enforcement.md#来源失败的分类)。

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

审批默认有效一天，由 CIRCLE_HUB_APPROVAL_TTL_MS 配置（1000–2592000000 毫秒）；审批 pending input 使用同一到期时间。普通澄清仍由 CIRCLE_HUB_INPUT_TTL_MS 控制，默认五分钟。延长审批时间不解除修订、目标身份、动作摘要、当前目录/权限以及 D 出口复核。

早期上机接入记录：`apv-case-execute` 用既有 submit/approvals/events/result 执行 APV 单表工作簿，输入可带 sourceRevisionId 或 artifactId、gatewayAssetId、commandSourceAssetId、build/buildId。当时服务端两次核对命令、投递需另一人批准，网关访问 / 刷新令牌用个人引用；修订 3 的当前执行声明和凭据模式见[执行链](design/approvals-and-enforcement.md#生产设备要两人规则怎么办)与[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。本段保留当时接入字段，原件、逐步结果与检查点证据按 SHA 存 B。配置、输入边界、恢复与权限详见 [执行交接](case-execution-handoff.md)。Circle `circle_server_submit` 可附加 input，上传源的 id/SHA 由客户端填；同步返回落工作区是 Circle 的职责，server 不写客户端目录。

版本列表与同步只取首页/版本页元数据，**不下载任何 XML/修复清单**。命令 XML 在对应构建首次被命令工具用到时获取，内容按 SHA 持久缓存，索引绑定调用身份/资产修订/来源与构建段落修订，不跨个人凭据复用；元数据变化重新取。修复清单只有 fixed_releases 查询才按指定候选取，结果声明 coverage.completeSite=false，不把候选中的最早发布冒充全站最早。运行时 profile 可配置 requestConcurrency（1–8，默认 2）与 requestIntervalMs（构建工具默认 200）；相同连接器调用的请求同时受并发与开始间隔限制。

个别构建无 fixed 链接或页面失败时保留其他答案，coverage.read/missing[{build,code}] 分别列出已读/缺失，全部缺失时 unknown；普通身份缺失/无权限代码统一隐藏。`coverage.earliestFormalCertain` 仅针对指定候选：已读到正式命中、且没有日期更早或相同的正式构建清单缺失才为 true；否则保留观察到的 earliestFormal 并标为不确定。缓存目前无淘汰；若发布站原地替换 XML 而段落摘要不变，会沿用旧缓存，不能用该缓存证明源站字节仍未变化。

来源地址只在运行时配置文件提供。`CIRCLE_HUB_CONNECTOR_PROFILES` 指向仓库外的 JSON 文件，形状为 `{"profiles":{"<配置引用>":{"origin":"<运行时来源>","root":"<文档根>","index":"<构建首页>","payloadField":"data"}}}`。连接器资产 configuration 使用 `packageId`（documents/build-site/query-mirror/environment-view/knowledge）、`runtimeProfileRef`、可选 productLineId 和 alias；个人凭据走 `/v1/assets/{id}/credentials`，之后在新资产修订的 declaration.credentials 中引用。PLM 的 JWT 只在 worker 内注入，无 Bearer；值不回到注册/目录/调用响应或审计。此段配置教程写于合成来源验收阶段；后续获授权的真实只读观察另记[阶段进度](server-s2-progress.md)，不代表本轮重新访问来源。

只读回执已接入持久异步索引，通用入库与快照规则见[B 的原件与证据规则](design/object-standard.md#四b-的原件与证据规则)。下段保留 asset-index 的接口观察方式。

通过 `GET /v1/tasks` 可见本人 `capabilityPackId="asset-index"` 的索引任务，其 input.originTaskId 关联原读取任务。原任务 events 的 `knowledge.indexing.linked` 含 `{jobId,taskId,status}`；索引任务的 queued/started/progress/completed 事件带 jobId、processed/total 或 indexed，失败沿用 task.failed/result.error。须补读索引任务事件或 status 后再要求知识检索完整；读取 succeeded 不代表索引已完成。相同源修订/投影版本复用工作，server 中断后 outbox 可恢复；索引失败不把原读取改判失败。

索引批量发布与当前权限过滤沿上述 B 设计实现；源 head 的 generation 用来区分再次观察到旧字节，旧快照成员在升级时回填保留。

`npm run dev:stack` 一次启动临时 PostgreSQL、server、两个 worker 和合成来源，并登记/独立批准/启用上述五个工具资产。终端打印 server 地址、developer 与 approver 的临时登录方式；developer 登录后立即可取非空工具目录。默认合成版本线为 10.5，正式构建 `Rel_PHOTON_10_5_0_101` / `Rel_PHOTON_10_5_0_109`，前者有 `feature.enable`，后者缺失；两者都有几十条 service 命令。Ctrl+C 也关闭合成来源并删除 scratch。

## 第二阶段：技能包约定与 RPC 边界

以下路由已实现，技能包/RPC 合成验收已通过。实际采用提交与全部检查结果见第二阶段进度。

独立仓库模块新增 `POST /v1/modules/install`，body `{module,files,trial?}`、可选 `X-Scope-Id`，F 路由为 CLIENT_ROUTES.moduleInstall。module 来自 `circle-packs/modules/1` 的单个条目，files 是其精确文件集的原字节 base64/SHA；server 重新核对路径、清单摘要及自身 manifest 的 id/version。技能模块 trial 必填，响应里的 digest 是模块清单摘要，skillPackDigest 才是原技能包审批摘要；复用 approvalTaskId 和既有 runs。产品线模块登记为 draft 原件资产，批准不自动激活运行配置。CLI `modules check/install`、确切 body/响应和边界见[模块安装交接](module-installation.md)。原 skillpacks body 可选带 module，未带时保持原行为。

`POST /v1/skillpacks` 接收 `{manifest,files:[{path,base64,sha256}],trial:{toolCalls:[{name,argsSha256,ok}],outputs:[{path,sha256}]}}`。manifest 含 id/version/title/owner/tools[]/triggers[]/inputs/outputs/model，trigger 为 manual/schedule/event；owner 仅为声明，认证身份来自 token。使用可选请求头 `X-Scope-Id`；只有一个授权 scope 时可省略，多 scope 必须明确。响应 `{skillPackId,digest,status,check:{undeclaredTools,missingTools},approvalTaskId}`；用户确认额外 approvalTaskId 复用第一阶段审批。missingTools 是声明但当前调用者目录不可用的工具，undeclaredTools 是试跑用到但未声明的工具；提交、批准、运行都重查目录。目录是 `GET /v1/skillpacks`，运行是 `POST /v1/skillpacks/{id}/runs` body `{inputs,idempotencyKey}`，返回 `{taskId}`。提交状态不能代替批准，批准绑定 digest，输入或目标修订变化需重新核对。

Circle 运行边界由用户确认改为正式 CLI RPC；当前固定 Git 提交 `8b2ceb6df620832bfd7925aede93bb35f4a605a2`，同时核对 `--version` 为 1.1.1，禁止 import Circle 源码或改 foundation。开发期 CIRCLE_BIN 在运行时指向独立固定提交的本机构建；不要指向仍在提交的客户端工作树。每次运行独立 CIRCLE_HOME 与 HOME，准备可信 workspace、技能目录和输入；启动 `node <CIRCLE_BIN> --mode rpc --extensions --yolo <workspace>`，发 prompt，读 JSON 事件直到 agent_settled；取消先 abort/关 stdin，超时 kill，记录本地停止与远端未知的区别。运行 token 短期且只经环境注入，不落盘；模型使用脚本桩，付费模型仍需授权。详见 Circle 仓库 `docs/rpc.md` 与 `docs/cli.md#json-events`。

提交已增加 201 / candidate 及 manifest / ownerPrincipalId / scopeId / assetId / assetVersion 展示字段；文件冻结、digest、试跑声明与重复提交规则见[技能包与模块的登记契约](design/product-line-pack.md#技能包与模块的登记契约)。

未声明或不可用工具拒绝为 422 `SKILLPACK_CHECK_FAILED`，details.check 带两张清单。用 `GET /v1/tasks/{approvalTaskId}/approvals` 取得 approvalId、inputRevisionId、targetIdentity、actionDigest，再由独立人员按第一阶段 respond body 批准；申请人不能自批。审批者需 decisions.approve 和 assets.approve，不因此获得执行权限；批准时重新核对申请人目录，运行时核对实际运行者目录。批准后包状态 `registered`，绑定 sealed digest 和当前资产修订；停用或修订变化阻止新运行。

旧待批申请新增独立驳回兼容路径：仍用旧 approvals 返回的绑定字段与 approve:false，成功后旧登记任务 delivered、技能 declined。取代与驳回规则见[变更集](design/approvals-and-enforcement.md#只有一个审批概念变更集)；新版本资格不因此改变。

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

签发方与端点从仓库外 CIRCLE_HUB_OAUTH_PROFILES 读取 `{profiles:{<ref>:{issuer,tokenEndpoint,deviceAuthorizationEndpoint?,clientId,clientAuthentication:"none"|"client_secret_basic"|"client_secret_post",scope?,accessTtlSeconds?,caFile?,caSha256?}}}`。没有固定签发方或固定 token 路径。连接器 configuration.oauthProfileRef 必须绑定该 ref；请求不能传任意端点。远端端点必须 HTTPS；HTTP 只供回环合成测试，用户已决定不开放真实明文签发例外。CA 每次核验，不跟随重定向。

POST /v1/credentials/oauth/device 接收 `{connectorAssetId,connectorVersion,profileRef,clientCredentialId?,idempotencyKey}`，返回 flowId/status/userCode/verificationUri/intervalSeconds/expiresAt。用户去签发方确认，再 POST /v1/credentials/oauth/device/{flowId}/poll 空 JSON。轮询遵守 interval，slow_down 后增加五秒，拒绝/过期停止；流程按用户和连接器修订持久化，设备 code 在私有加密 vault 中，未返回。

POST /v1/credentials/oauth/client-credentials 使用同形请求；clientCredentialId 是本人通过既有私有凭据端点登记的 `{client_id?,client_secret}` JSON 引用，绑定同一连接器。只支持配置好的保密客户端认证方式。两种授权成功均只返回 credentialAssetId 与到期元数据，值不在 API、事件、审计或 Git 中；把新引用放入连接器新修订并批准后使用。不同 scope/所有者不能借用凭据。

外部 OAuth 的续期 / 轮换 / 未知回执规则已并入[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。连接器 runtime profile 的 authorizationScheme 可为 raw 或 bearer，旧 raw 默认保持兼容。

运行请求 202 `{taskId}`，inputs 原 JSON 作为 `inputs.json` 写进 workspace；可用 `inputs.files:[{path,base64,sha256?}]` 附输入文件。输入不能覆盖 .circle/控制文件/声明输出；改输入使用新幂等键，同键不同输入拒绝。结果返回实际 artifacts/evidence/runtime，产物只在 CLI agent_settled、进程退出和声明文件完整、独立字节 SHA 核对后交付。文件完整性/摘要属于 script-conclusion，最后回答另记 model-judgment，不用回答替代产物或专业事实。artifact/content 与个人任务权限一并检查。

`CIRCLE_RUNTIME_CONFIG` 指向仓库外的运行时 JSON：

```json
{"circleBin":"<本机构建的 dist/cli.js>",
 "circleCommit":"8b2ceb6df620832bfd7925aede93bb35f4a605a2","circleVersion":"1.1.1",
 "model":{"kind":"scripted","base_url":"<本机脚本模型 /v1>","model":"scripted-fixture","protocol":"openai","api_key":"<运行时值>"}}
```

在设置这个运行时配置后启动 `npm run dev:stack`；developer 有提交/运行权限，approver 可审批。该早期验收配置使用 loopback 脚本模型；后续已批准模型端点支持见[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。未配置时运行返回 SOURCE_UNREACHABLE，登记 / 审批仍可用。CircleBin 与所有地址只在运行时提供；CLI/模型安装由对应构建提供，这里不运行安装/更新脚本。

每次运行短期 token 仅授权声明的目录工具、其 scope 和该运行/子工具任务；不允许借它直接登记资产、提交其他能力任务或审批。token 通过认证 worker 的本机私有 IPC 交给进程，只存在内存/子进程环境，公开 worker preflight 不返回值，运行目录中不落盘；结束/取消失效。单 worker 留一个 RPC 运行槽，同时处理它的子工具调用，避免互相等待。

任务 events 增加 `runtime.<RPC type>`（例如 runtime.tool_result/runtime.agent_settled），payload.event 为实际 RPC 事件。取消发 abort、关 stdin，超时 kill；观察到本地进程退出后任务保持 unknown、资源冻结，返回 remoteStoppingVerified:false。未完成独立远端核对，不把本地退出记为远端停止或已交付；后续事件按原游标补读。

真实 RPC 验收需显式设置 `CIRCLE_BIN` 和 `CIRCLE_COMMIT` 再运行 `r2-05-skillpacks.test.ts` 或整套；没有时实际 CLI 用例（第 5 幕三条、第 6 幕两条、第 7 幕一条）显示原因并跳过，不能把 skip 当作运行通过。Circle 工作树升级时选择新的已确认构建或独立固定旧提交的 worktree，运行器不会因此放宽固定版本检查。

## 第二阶段：触发、整理与 Circle 渠道

`POST /v1/automations/triggers` 登记草稿资产：共同字段 scopeId/version/name，定时追加 `{kind:"schedule",intervalMs,startsAt}`，事件追加 `{kind:"event",sourceAssetId,eventName}`。`POST /v1/automations/bots` 共同字段追加 skillPackId/triggerAssetId/identityPrincipalId/channel/inputs；第一版 identity 必须是登记者本人，channel 为 `circle-events`。组件须同 scope，技能 manifest 必须允许相应 trigger。需要 automations.manage，资产经独立人员批准并由主人激活才运行；不跳过资产生命周期。

定时错过 occurrence 的合并已实现，具体规则见[触发与 bot](design/circle-integration.md#触发与-bot)。trigger / bot.started / runs 保留 dueAt / firstDueAt / skippedOccurrences 字段。

`GET /v1/automations/bots/{assetId}/runs` 返回个人任务及 occurrenceKey/channel/published，需 automations.read。`POST /v1/connectors/{assetId}/events` 接收 `{externalId,name,payload}`，需 connectors.events、当前源主人及运行中的连接器；同源/范围/外部 id 去重，不同 payload 同 id 拒绝。正常连接器读收据也会按 path/SHA 生成 source.changed；不连接旧缺陷系统。

runs 新增 admitted / failed、trigger 与 error 投影；taskId=null 的受理失败、游标推进和事件真实性规则见[触发与 bot](design/circle-integration.md#触发与-bot)。

本轮新增 bot.output（channel / botAssetId / status / artifacts / evidence / unknowns），渠道暂为 Circle 事件流，未加企业微信桩；持久触发纪律见[触发与 bot](design/circle-integration.md#触发与-bot)。

动态来源的自触发保护已加入，判定依赖持久运行 / 子工具关系；规则见[触发与 bot](design/circle-integration.md#触发与-bot)。

`knowledge.shared_fragments {limit?,after?}` 是 read/sync：只取 caller 明确允许共享、当前可见的 shared-session 修订，返回原片段、工具返回和 Evidence；未共享输入不进入整理。limit 默认 20、范围 1–100，每页片段和未映射条目的总数受限；SQL 按创建时间/recordId 限量读源，游标也记录同一源内的片段位置。`result.nextCursor` 是不透明字符串或 null，非空时传作下一次 after；游标绑定身份和 scope，重启可继续，同键回放原页，后续修订保持各自来源证据。目录正确导出输入 schema，默认值参数可省略。`packs/common/skills/knowledge-consolidation` 逐页处理，其 TypeScript 脚本只规范/去重有证据的结构化 facts/practices/corrections，真实文本的语义抽取没有验收；候选仍为 personal/consolidated，产品优先、冲突保留、不自动发布团队快照。普通 bot 读者不能看他人个人任务/候选。

回报 ApiError 已改为可终结的 failed 收据，不再长期占 running；原件写入的原子处理规则见[B 的原件与证据规则](design/object-standard.md#四b-的原件与证据规则)。

## 第二阶段：工作列表过滤与续页

`GET /v1/tasks` 仍返回 TaskView 数组，limit 默认 20、最多 100。新增可选 `kind=work|tool|index`、`capabilityPackId=<精确包 id>`、`after=<上一页末项 taskId>`，请求 schema 在 CLIENT_ROUTES.tasks.query。kind 的分类为 asset-tool→tool、asset-index→index，其余及未指定能力包的任务→work；同时提供 kind 和 capabilityPackId 时取交集。客户端工作页使用 `?kind=work&limit=20`，下一页追加 after，数组为空即读完；不必先下载内部任务再过滤。

## 产品线安装与工具别名

启动时 `CIRCLE_HUB_PRODUCT_LINES` 可指向仓库外的安装 JSON：`{"schemaVersion":"installed-product-lines/1","productLines":["apv/product-line.json","meridian/product-line.json"]}`。清单路径相对安装文件解析；未设置时使用 packs/installed-product-lines.json，默认客户端工具名保持兼容。早期 product-line/1 安装清单记录为 connectorPackages / toolAliases / skills / methods / knowledgeMappings，修订 3 的可执行模块已改为 tools / hooks / resources / flows；包 id、版本、重复声明和安全相对路径在启动前校验。格式及边界见 [packs/README.md](../packs/README.md)。

新连接器资产可在 configuration 带 `productLineId`，由该产品线清单选择工具前缀。例如 `{"packageId":"documents","productLineId":"meridian","runtimeProfileRef":"<运行时引用>"}` 自动登记 meridian_docs 工具。可选 alias 仍覆盖实例前缀，同一 tenant 内工具名称冲突仍拒绝。省略 productLineId 时沿用第一个声明该连接器的清单前缀；公共 knowledge 工具独立保留。移除产品线并重启后，该产品线明确绑定的工具从目录隐藏；恢复安装后可继续使用原已批准绑定。ETag 和普通调用权限规则不变。

清单安装只读取声明，不导入其中的可执行路径，也不等于技能包已经获批。技能提交/审批/运行仍查当前目录，沿用原接口；既有编译能力和历史迁移保留。

运行 token 仍默认短期 5 分钟（CIRCLE_HUB_RUN_TOKEN_TTL_MS 1000–300000ms 可缩短用于验收），绑定操作/fence/任务和固定 scopes/grants/tools。只有持有效租约的 worker 在完整 preflight 校验后续期，截止不超过该操作 deadline；任务结束、取消、租约过期、旧 fence 或输入修订变化立即阻止新访问。客户端不能调用 auth/refresh 续这种 token，也不因本地会话断开就声称远端停止。

权限、类别和能力包筛选先于 limit，按创建时间、taskId 倒序；游标取保存的完整 PostgreSQL 创建时间，不按 phase/更新时间排序，server 重启可续读。after 必须是当前身份可读的任务；越 scope/个人任务返回 FORBIDDEN_SCOPE，格式错误、未知类别和越界 limit 为 INVALID_PAYLOAD。省略新参数时行为与第一阶段相同。

## 修订 3：人的范围角色与审批资格

登录 / 续期保持 token / expiresAt，新增 subjectType；人返回 roles:[{scopeId,role:"admin"|"member"|"viewer"}]，服务客户端保留授权 scope 串。developer / approver 的运维样例为 scp_lab 两个管理员；当前角色 / 范围 / 种子治理见[角色登记与资格披露](design/roles.md#角色登记与资格披露)。

GET /v1/scopes 返回 {total,items}，每项含 scopeId/name/twoPersonRule/policyVersion/adminCount/singleAdminMode；GET /v1/scopes/{scopeId}/roles 返回 {total,items} 的当前人员角色登记簿，包含角色记录 revision、verification 和 changeSetId。内部预设数据位于 packages/tasks/role-presets.json；member 可以读、运行、提交草稿，viewer 可以读和调用获准的 read 工具，只有 admin 决定变更。动作与目标授权仍在每次访问实时检查。

POST /v1/scopes/{scopeId}/roles 接收 {principalId,role,idempotencyKey}（role:null 移除）；POST /v1/scopes/{scopeId}/policy 接收 {twoPersonRule,idempotencyKey}。两者登记冻结的策略草稿并返回 {changeSetId,scopeId,owner,approvalTaskId,status,items,targetIdentity,identityDigest,verification}，角色/策略直到决定后才生效。审批沿用任务 approvals/input 接口，输入修订、目标摘要、动作摘要必须原样回应。只有同 tenant 的人可获得角色；最后一名根管理员不能移除。

角色资格已按修订 3 接入；ApprovalView / 响应新增 decisionMode / singleAdminMode / verification，审计追加 policyVersion。决定、自决与记录规则见[角色登记与资格披露](design/roles.md#角色登记与资格披露)。

四对象的登记形状已对齐[对象标准](design/object-standard.md)，本节不再重述通用分类。

## 修订 3：变更集与依赖核验

POST /v1/change-sets 接收 {scopeId,title?,items:[{assetId,version,sha256}],idempotencyKey}，1–100 项，各资产只能出现一次，必须是本人、同 scope 的当前 draft。items 的请求顺序固定：targetIdentity=canonicalHash(items.map(item=>item.sha256))，actionDigest=canonicalHash(items.map(({assetId,version})=>({assetId,version})))；输入修订仍单独绑定。返回 changeSetId/approvalTaskId/status/items/submission/targetIdentity/identityDigest/verification/blockedReasons/supersededBy，identityDigest 即该审批的 actionDigest。GET /v1/change-sets/{id} 和列表按任务读权限与 tenant/scope 过滤。审批请求 action.name=changesets.apply；原审批回应接口不变，客户端原样回传绑定三项。

变更集实现已新增 superseded：旧请求 / pending input 关闭，旧治理任务 delivered，ApprovalView 与技能状态保留取代信息。原子决定、幂等与取代规则见[变更集](design/approvals-and-enforcement.md#只有一个审批概念变更集)。

依赖字段已接 configuration.dependsOn / runtimeProfileRef / sourceArtifactId，blockedReasons 与 details.check 可定位未就绪项；生命周期重核及 blocked 决定规则见[变更集](design/approvals-and-enforcement.md#只有一个审批概念变更集)。

GET /v1/runtime-profiles 需 admin，返回当前运行配置的 {profileType:"connector"|"runtime"|"execution",profileRef,profileSha256,verification} 数组。没有地址、文件路径或密钥值；这只是配置观察。管理员再 POST /v1/assets，kind=runtime-profile、configuration={profileType,profileRef,profileSha256}、version/作用 scope/声明/readers 仍按普通资产；另一名管理员决定后才满足依赖。配置 ref 在每 scope/type 唯一，改配置后登记新版本并重新决定。连接器配置仍用 runtimeProfileRef；同名 ref 跨类型时另带 runtimeProfileType 明确选择。Circle runtime 的 ref 为 circle-runtime。旧真实部署须管理员补登记，平台不会因仓库外配置存在而批准。

既有 POST /v1/assets、/v1/source-artifacts、/v1/skillpacks 和 /v1/modules/install 自动产生单项变更集并追加 changeSetId/approvalTaskId。原 lifecycle state=approved 调用继续可用，内部回应该单项的请求；多项必须使用其任务审批接口，不能逐项批准。技能缺声明的工具继续 SKILLPACK_CHECK_FAILED；仅声明工具当前不可用时受理为 blocked，check.missingTools 保留具体名称，就绪后仍须人决定。技能决定与运行时继续查目录。旧数据库的 assets.publish 请求保留历史绑定批准/驳回规则，旧单仍可驳回；新请求用自动 superseded 关单。

## 修订 3：Skill、Tool、MCP server 与 Hook 的执行绑定

运行仍使用既有 submit/status/events/result/input 接口。默认资源不会产生审批请求或 execution-submission；成员以上按当前范围角色、来源 readers、资源策略、已批准的 Tool 实现/产品线模块、running 资源和 runtime-profile 依赖进入执行链。`apv-case-execute` 的 input 可带 `methodAssetId`，值为批准后的 product-line 模块资产 id；模块须声明对应 flow。来源保持 commandSourceAssetId/build/sourceArtifactId 的既有绑定。既有内置兼容实现也要有 scope 内明确批准的 knowledge-source 定义，configuration 为 `{schema:"hub-tool-implementation/1",capabilityPackId,flowVersion,implementationSha256}`；这不是新的资产 kind。

执行变更新增 execution-submission 草稿与 changesets.apply 请求，冻结 inputRevisionId / 输入摘要 / 方法、资源、来源版本 / 原件和工作簿 SHA；对应操作一次消费沿[生产设备两人规则](design/approvals-and-enforcement.md#生产设备要两人规则怎么办)。默认运行不新增审批概念。

Tool 保持原有 name/title/description/inputSchema/effect/mode/permission/assetId/assetVersion，追加 MCP annotations、minimumRole、approval。人的权限以范围角色和 minimumRole 为准，旧 permission 仅为机器 scope/客户端兼容标识；professional_permissions 登记表撤下。provider declaration 可带 provides:{tools,resources,prompts}，tools 使用 MCP name/description/object inputSchema/annotations 与 effect/minimumRole/approval 标注。

product-line/1 使用 tools:[{manifest,imports}]、hooks:[{manifest,event,order}]、resources 与 flows。tools 的直接、动态、转导入及局部引用在安装前检查：文件须在冻结集合内；外部依赖只允许明确声明的 exceljs 4.4.0、read-excel-file 9.3.12、fflate 0.8.3、zod 4.6.5、saxes 5.0.1、parse5 8.0.1。Node 内建模块也不允许，未声明或计算式 import 为 IMPORT_NOT_DECLARED；不执行安装脚本。Tool 读取原字节并返回结构，模块文件不改写；散列可用全局 WebCrypto。产品线原件经变更集批准后装载，每次执行仍核对当前权限、版本和 SHA。

产品线 Hook 已按 hub-hook/1 与五个挂点装载；subject、严格字段和返回 / 顺序规则见[Hook 契约](design/harness-primitives.md#hook)。hook.verification 保留 ruleId / ruleVersion / event / result。

执行链新增 TaskView.waitingReason 与对应 pendingInputs 修订入口；可修失败、核验拒绝与 unknown 的处理已并入[报错与等待输入](design/approvals-and-enforcement.md#报错与等待输入)。

## 修订 3：开发会话寿命与吊销

修订 3 已把开发会话改为轮换 token（旧 token 五秒并发宽限），并新增 POST /v1/auth/logout，携带会话 Bearer，body 为 `{}`。登录响应字段保持 token / expiresAt / roles，运维身份配置仍只作角色初次种子；绝对寿命 / 吊销 / 限流规则见[会话与令牌](design/roles.md#会话与令牌)。

## 修订 3：凭据模式、隔离与明确的明文例外

static-secret 登记操作：provider.configuration.credentialMode="static-secret"，declaration.credentials 引用 POST /v1/assets/{providerId}/credentials 返回的凭据 id。body `{version,value,mode:"static-secret"}`，value 至少 32 字符、无头部控制字符；响应只有引用 / 模式。以凭据资产 id 调同路由轮换当前值，模式不能原地改变。该模式用 Bearer 注入，不调用 /token / introspect；server-issued / external-oauth 的旧接入仍保留。共享、使用与撤销纪律见[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。

资料源 HTTP 例外的配置步骤：管理员登记 kind=runtime-profile 新版本，configuration 加 allowPlaintextAuthentication:true，保 profileType / profileRef / profileSha256，再交独立决定。修改例外也用新版本，运行文件自加字段不生效；资格与生命期、SOURCE_NOT_APPROVED / SOURCE_FORBIDDEN 的规则见[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。匿名 HTTP 与回环合成配置保留。

明文例外已在派发、审计与 SourceRevision / Evidence 加 plaintextAuthentication:true 及批准 profile 版本引用；标记的持久 / 缓存 / 撤销规则见[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。

Skill、Tool 和 Hook 使用同一主机隔离边界。当前 Mac adapter 用 sandbox-exec 对未信任的进程及其后代限制文件内容读取、写入、网络出口及其他进程信息；只开放当前运行目录、固定 harness 的受信代码/依赖、明确的 CA 和 loopback server/model 端点。不能直接或经符号链接读取 vault 或运行配置。其它系统未配置受支持的隔离 adapter 时以 SANDBOX_UNAVAILABLE 失败，不退回同用户任意执行。Hook 与 Tool 在同一 tool-host 子进程执行，10 秒/16 MiB 返回上限；工作簿命令批量核验，避免每条命令启动一个进程。三种 subject 先按严格 schema 校验，主机客户端闭集属于批准的 Hook，解析器只读取字面行。

早期运行器曾把模型凭据放入单次 home；后续模型代理已替代该方式，当前密钥边界见[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。终态 / 失效注入副本由维护器清理，永久静态凭据留到轮换 / 吊销；开发角色仍只作初次种子。

主机策略只能取 binding.resource.declaration 的已批准原声明：allowedTestHosts 为显式集合，hostCommandPolicies[host].allowPrefixes 为可选缩小策略；运行文件中的同名字段不作治理授权。三个 verify 挂点均带资源 assetId/version/sha256/declaration。当前固定的 APV 1.2.2 / ba06eed 的 host-policy Hook 按新版四字段 subject 执行，闭集未声明、主机不在床、命令含模板、前缀不符分别给固定事实码；主机名与策略键比较不区分大小写，事实仍保留输入拼写。

## 读取超时与大原件回报

读操作的超时分类修复见[读取的超时](design/approvals-and-enforcement.md#读取的超时)。迁移 29 释放历史只读 unknown 并重算 frozen，只解除没有写 unknown 的资源；写记录与核对保留。

worker 先把原件按 SHA 放入 B，再在报告 raw[] 传 {path,sha256,objectKey:sha256,size,sourceType,...}；C 在当前租约/输入/资产授权下回读并验证实际字节和大小。旧 contentBase64 报告仍兼容；原件缺失、换 SHA 或错误 size 不被接纳。证据存指针、范围、SHA 与小片段，不把大文件或 NUL/不合法 UTF-8 的完整文本塞入 JSONB。GET /v1/knowledge/records/{evidenceId}/content 仍可在现有授权下读取原字节并复算 SHA。任何回报处理错误都原子落成 failed；数据库异常只给 RECEIPT_PROCESSING_FAILED 和安全 storageCode，不带 SQL、参数、内容或内部路径。

docs.search 已完成文件后发生读取超时时，返回已观测 hits、nextCursor、coverage.complete=false 和 coverage.stopped:{code,file,fileIndex,lineIndex,completedFiles}；任务结果是 partial。游标指向未完成文件，不截掉也不猜测余下命中。该页没有完成文件，或目录遍历未完成时仍为 UPSTREAM_TIMEOUT，details.coverage 说明读取进度；没有伪造完整结果。正常分页形状保持。

## 审计补充：角色、Hook 形状与模型凭据

凭据 provider 的角色下限已并入[角色登记与资格披露](design/roles.md#角色登记与资格披露)；Hook binding / subject 形状和主机策略依据已并入[Hook 契约](design/harness-primitives.md#hook)。主机解析只记录字面行及 functionStatus。

Tool/Hook 子进程带 256MiB V8 堆上限，Hook 以最多 200 个 subject 的批次执行，每批十秒，保持顺序和首次 block 停止。APV 验收默认冻结 circle-packs 提交 ba06eeda83d27031fc1a452e43b24300d654da9e（APV 1.2.2，22 个文件，模块 digest faa9e79d03a97fa1e5142a2f169cecc2caef7f52f7d714f9aac53226164c347d）。清单与文件均用该提交的原字节核 SHA，不跟随独立仓库工作区变化；包内 Node TAP 收尾断言实际 pass=tests 且 fail/skip/cancel=0，不把数量写成闸门。本次产品线包 **31/31**、hub Hook 专项 **3/3**；同提交四个技能模块（case-review 0.1.3、defect-claims 0.1.0、mindmap-compile 0.3.0、product-qa 0.1.3）的全部五个测试文件冻结后纯合成单测实际 **57/57**，catalog 工具另 **4/4**，合计 **61/61**，均无跳过。这与该提交 README/CI 的 tools 与 skills 合并入口一致，61 并非技能本身的数量。数字只描述这份冻结原件的验证，不是自动安装/批准或真实设备与模型验收。

后续运行器加入可信 loopback 模型代理，Circle settings / credentials 只存本次代理端点与 nonce；当前密钥 / 掩码 / 失败边界见[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。下段保留代理部署参数与观察字段；--yolo 不替代平台执行链。

模型代理运维参数保留：每 run 一个回环临时端口、256 位 nonce；seatbelt 仅开放代理 / hub 端口，体上限各 16MiB，SSE 透传。runtime.model.proxy 观察字段为 upstreamHost / statusCode / requestBytes / responseBytes / durationMs / requestNumber；固定失败码 MODEL_PROXY_UNAVAILABLE / MODEL_UPSTREAM_REJECTED。目标、头部 / key 注入、失败降级和停止纪律见[凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。本地验收仍用回环脚本模型。

## 读结果与治理内容补充

docs.section / docs.search 投影里的 NUL 统一剔除；有变换的 result 带 sanitized:true、nulBytes 总数，原件仍可按 evidenceId 下载、逐字节核 SHA。docs.get 原件超过 256KiB 时返回 {path,content:{sha256,size,evidenceId,downloadPath}}，不再把大件 contentBase64 塞入任务；小件保留既有字段。下载沿用 GET /v1/knowledge/records/{evidenceId}/content 和当前来源权限。

Tool 必须显式声明 effect，缺失拒绝登记。迁移 30 保持第 29 版原校验值，逐个审计/发出 operation.read-unknown-released，租约删除只针对释放集合；同一任务还有 write unknown 时保持 unknown，不推成读失败，也不重派写操作。

GET /v1/skillpacks/{id} 为候选内容的只读视图：原技能摘要、files:[{path,sha256,sizeBytes}]、declaredTools、trial:{toolCalls,outputs}。同 scope 的有资格审批人能查看待批候选，即使未列入 readers；只列冻结提交清单和试跑哈希，不返回文件字节或凭据。跨 tenant/scope、失去角色或不可见草稿仍拒绝。

case-gateway 资产的 POST /v1/assets/{id}/health 现在经 worker 的只读 gateway.health 调 lease_status，无远端租约；available/gateway-read-confirmed 表示本次凭据和网关读链路获确认，不代表设备就绪。gateway.topology 是 effect=read/mode=sync/最低成员的 provider Tool，实例别名遵循目录规则。worker 在 C 的当前租约/fence 与批准 runtime-profile 下，lease_acquire → bed_topology(refresh:false) → lease_release，立即释放；result 仅含 hosts（名字、没有地址）、remoteLeaseReleased、observation。原始拓扑 JSON 按 SHA 入 B，evidence 可由当前授权身份回读。管理员据这些观察登记新资源声明 allowedTestHosts，再经变更集独立批准；平台不自动批准或把返回拓扑当设备构建观察。静态密钥和 server-issued 两种方式均沿用保险箱注入，失效/无租约给明确错误，无旁路占床。

supervisor 为每次子进程 start/exit/error 打一行 JSON：at/supervisorId/processId、code/signal、reason、graceful。dev:stack 会转出这些元数据；意外退出和明确 graceful 重启可区分，没有请求/响应体或凭据日志。

## 修订 3 第 6 节：通知流与工作队列

GET /v1/notifications?cursor=0&limit=100 需 tasks.read，返回 {items:[{seq,taskId,scopeId,kind,payload,createdAt}],cursor,hasMore}；limit 为 1–200。过滤当前 tenant/scope/私有任务之后分页，游标来自持久 outbox；游标修复的当前口径见下方补项与[通知流与工作队列](design/circle-integration.md#通知流与工作队列)。bot 受理失败没有伪造任务，通知 taskId=null、payload 带 botAssetId/occurrenceKey/error，只对运行所有者可见。

GET /v1/notifications/stream 用同样的 cursor/limit 或 Last-Event-ID 建 SSE；事件 notification 带 id=seq 和通知 JSON，cursor 事件带下一游标（即使本页无通知）。客户端保存已处理游标，断线按它补读，轮询是同一条持久流。服务器每轮重核身份/角色，过期发 session.expired、撤权发 permission.revoked、流内部错误发 stream.error 后关闭；使用客户端已刷新会话重连，不在流中索取密码。流有心跳/背压处理，graceful shutdown 会结束连接。

GET /v1/queues 返回 awaitingMyApproval/awaitingMyInput/submittedByMe/assignedToMe/exceptions，各为 {count,oldestWaitMs,overSla,slaMs}。审批计数按当前管理员资格、twoPersonRule 与申请人过滤；输入和 bot 失败仅归当前所有者，私有任务不借队列暴露。异常包括 unknown/failed、expired/superseded 请求、失败 bot occurrence 与管理员范围内离线 worker。SLA 默认审批24小时、输入5分钟、其它1小时，响应明示阈值；assignedToMe 只读持久的真实 assignment context，没有分派记录就是零，不从模型文本或申请人身份推断指派。

## 修订 3 第 8 节：列表即查询

登记簿的 GET 加 `view=page` 返回 `{total,items,cursor}`。覆盖 tasks、assets、skillpacks、change-sets、scopes、scopes/{id}/roles、service-clients、object-types、objects、tools；不带 view 保留各接口原数组或原分页形状。F 导出 RegistryPageQuery/RegistryPage 与各路由的 pageQuery/pageResponse（tasks/assets/objects 的 query 与 response 同时接受兼容形状）。Circle 新列表统一用 view=page。

通用参数：limit 默认20、范围1–100；cursor 是原样回传的 opaque token；scopeId/productLineId/flowVersion/status/lifecycle/owner 可选；minAgeMs/maxAgeMs 非负，最小不得大于最大；sort=updatedAt|age、order=desc|asc，默认最近更新时间倒序。age/desc 表示最老在先。tasks 另支持 kind=work|tool|index、capabilityPackId；assets 另支持 kind；objects 另支持 typeId/system。权限、私有边界与分面先过滤，再计算总数和分页，权限每页重核。跨身份或改变筛选/排序/limit 的游标为 INVALID_PAYLOAD，越权 scope 为 FORBIDDEN_SCOPE；不手工拼 token。

时间游标保存数据库完整微秒和稳定 id，年龄条件钉住首个请求时间；总数是本页当前授权数据的总数，后续页仍可能因真实变更而改变，不承诺跨请求的永久快照。新增资产版本、技能和服务客户端更新时间用于排序，健康/轮换/状态的实际更新也会改变更新时间。tools 先用调用者目录做权限核对，再在该集合分页，ETag 跟随实际页与授权。

分面只用记录里已声明的维度，不从产品名/平台名猜分类。任务 productLineId 取持久 context，资产/技能/工具取 configuration，企业对象取 attributes；flowVersion 使用任务 flow 或相应声明。owner 对任务/变更集/技能是申请人，资产/工具是资产所有者，对象是观测登记人，角色/服务客户端是其主体，词表是登记人。范围和租户级词表没有凭空补个人 owner/scope/productLine：不存在的维度不匹配该筛选。状态用各登记簿原状态（task phase、资产 lifecycle、skill status、change-set status、role、服务客户端 active/revoked、词表 registered）。

模型上游规则修正：runtime-profile 的模型端点是批准 allowlist，回环脚本模型仅为验收配置；非回环 HTTPS 可用，非回环认证 HTTP 拒绝。运行配置 model.kind 支持 scripted/remote，可加 caFile/caSha256；有自定义 CA 时验证实际 DER SHA/主机名，仍可用正常系统 CA。每次 run 冻结 runtimeProfile:{assetId,version,sha256,profileSha256}，派发前重核，换版本不会悄悄替换旧运行的模型端点。worker 的私有通道把对应端点交可信代理，sandbox 只见回环代理。模型原件/流量仍不属于 evidence。gateway.health 使用独立 gateway-health 资源，不占或解冻用例执行资源；lease_status 正常仍只证明链路读确认。

Circle runtime 的新受理从同一 scope 的 circle-runtime 资产修订中选最新已 approved/running 且 approved_digest 等于该修订 SHA 的版本；登记草稿不会改变这个选择。已受理/已派发任务每次 preflight 核对自己冻结的 assetId/version/sha256/profileSha256，旧修订仍获批准且摘要与进程配置一致时继续，批准同配置的新修订不会终止它。新受理改用新的批准版本。停用旧修订可 POST /v1/assets/{id}/lifecycle，带旧 version/sha256/state=disabled，仅该资产所有者且当前有 assets.change 可做；只对 runtime-profile 开放历史修订停用。被停用或摘要与进程配置不再匹配时，worker 终止本地 Circle，观察本地退出并保持 remoteStoppingVerified=false/unknown，按现有核对路径处理。未配自定义 CA 的 HTTPS 使用系统信任库和主机名校验；要固定 CA 时同时配置 caFile/caSha256。

## 修订 3 第 9 节：中立原语与 MCP

Circle 的 POST /v1/skillpacks 仍收原 body，响应增加 neutralManifest（hub-skill/1）。名称/描述/入口从 frontmatter 与清单推导，inputs 为声明输入名、outputs/triggers/tools 保留原清单；无法推导的为空，不把 harness 特有字段删出原件。knownCompatible 初始空；成功的固定 Circle 运行另存 harness/runtimeCommit/evidenceId/taskId 观察，GET skillpacks/{id} 与列表投影显示它，冻结提交原件与 digest 不改。

POST /v1/harness/import：{scopeId,sourceHarness:"claude-code"|"codex"|"opencode"|"gemini"|"cursor",version,files:[{path,base64,sha256}],trial?:{toolCalls:[{name,argsSha256,ok}]}}。调用已合入的公开 importFrom/exportTo 纯库，创建 skill-package/instruction/agent/command 草稿，共用资产/变更集独立批准。整批事务，SHA/文件集/范围重核，重复同字节不重复登记；声明工具时拒绝试跑声明外调用，没有中立声明的只披露。各 harness 的 permission hint 由适配器保留，不擅自等同工具闭集。Hook/provider 需要产品模块/runtime-profile 的治理路径，返回 NO_HARNESS_PROJECTION，不自动装入或执行。

四类导入原语在登记事务内即创建变更集，返回 changeSetId/approvalTaskId；重复导入返回同一资产与请求引用，批准前导出为 SOURCE_NOT_APPROVED。knownCompatible 只记实际 RPC 中匹配本包 manifest.id 的成功 Skill 装载：用 tool_result.id 关联之前 assistant.tool_calls 的 args.name，不依据返回文字或别的技能成功。

MCP 的所有调用都校验 body.idempotencyKey（若有）与 _meta["hub/idempotencyKey"] 一致。平台控制 Tool 的读写共用持久幂等回执：同 tenant/主体/scope/工具/键重放返回同一 evidence，不再执行读取；要读最新状态使用新键，重放仍检查当前权限和任务可见性。改变参数为 IDEMPOTENCY_MISMATCH。平台控制回执当前无到期窗口；专业 Tool 沿用 C 的 24 小时受理去重窗口，窗口之外可以受理新任务。这两类窗口不同，客户端不得把专业工具旧键当作永久防重证明。

迁移 36 是追加历史补偿，不重写 29/30。operation.read-release-compensated 审计的 correctsAudit 指向原 30 审计，originalState=unprovable 表示 29 前状态没有可证明日志；leasesRestored=false。task.read-release-phase-compensated 只记 36 前实际 phase 和原任务/read 审计引用，historicalPhase=unprovable。旧租约不恢复；新释放只针对当前 unknown/read，写 unknown 继续冻结与独立核对。33–35 仍分别保留中立清单、MCP 回执与兼容观察用途。

dev:stack 的 admin restart --graceful 现在请求 server 换进程后逐个排空/替换受其监督的两个 worker。每次保留同伴处理运行中的子 Tool，旧 worker 停止领取新活、完成已有操作后退出，再用原身份起新代码；不强杀设备操作以赶升级期限。CLI 的 workersRestartRequested=true 表示后台已请求替换，完成看 dev-stack.worker.draining/exit/ready JSON 日志（pid、时间、码/信号、graceful）。worker 自身退出只替换该进程，不删除临时 PostgreSQL；退出仍走 C 的租约与 unknown 规则。停止整个栈才清理临时数据。单独部署的外部 worker 不由 dev-stack 管理，workersRestartRequested=false；管理员仍须先 drain，再由其进程管理器替换，server restart 不声称已升级这些 worker。

已安装并为产品线声明的 provider Tool，缺别名时使用产品线默认 prefix、包 prefix，最后以 packageId（连字符改下划线）作 prefix；显式实例 alias 优先。没有安装/声明的产品线仍不获得 provider。名称冲突按现有 tenant 唯一规则拒绝，不让缺 alias 静默隐藏工具。

apv-case-execute 现为 **1.1.1**，flowVersion 仍 apv-case-execute/1。实现摘要变化后须用 GET /v1/packs 当前 version/flow/implementationSha256 重新登记并独立批准 hub-tool-implementation/1；旧任务的 methodAssetId 不自动改写。产品线模块资产仍按自身冻结 SHA/flow 解析，本笔未改变其字节或批准状态。成功终态的 gateway-results 原件与 result.result 也带 remoteLeaseReleased，释放失败为 false，不覆盖整案原结论。拒绝带 task_id/dispatched:true、已提交后的 status 错误均保留 unknown 且不释放潜在活动租约。

设备日志归属与派发前拒绝的完整说明同步在 [执行交接](case-execution-handoff.md)：有序设备 IP 来自 env_prepare.conf.device_ips，或已有租约内按需读的 bed_topology.topology.applies_to.device_ssh_ips；原样入 B。解析按设备推进游标，每条已匹配命令有自己的 logSpan；拿不到唯一映射，设备步 unknown/unmapped=device_map_unavailable，主机步和检查点各按自身证据处理。设备归属接口 {environment,topology} 留给产品包解析 Tool 后续接管，尚未把这段旧兼容解析迁入独立产品包。

1.1.1 的来源口径更正：现网部署版没有前述两个有序字段，真实回退用 topology.devices。全部负载均衡设备名须为 APV<index>，索引集合与 env_prepare.device_count 精确一致；日志 IP 必须唯一落在对应设备 ipv4 的 CIDR 地址集合里。否则 device_map_unavailable，绝不据任意主机名或命令文本猜 APV_n。source 标 gateway.bed_topology.devices；三种候选优先级是 conf.device_ips、applies_to.device_ssh_ips、devices 名字规则，前两个只在实际返回时适用。排空无截止时间，claim 在途时仍可能完成一笔新领操作；不强杀的边界也已补入执行交接。

工作查询与通知补项：GET /v1/tasks?view=page 增加 queue=awaitingMyApproval|awaitingMyInput|submittedByMe|assignedToMe|exceptions；exceptions 可加 exception=unknown|expired|superseded|failed。GET /v1/queues 接受同一分面及 kind/capabilityPackId，使用同一任务授权/私有范围/run 委托/分面与队列条件，计数发生在限制之前。过期但仍 open 的审批按 expired 分类，不再待批。exceptions.groups 分开给任务四类、workerOffline、botAdmissionFailed；后两类是各自记录查询，分面不适用时 omittedGroups 明示，不能当作全平台确为零。

POST /v1/tasks/{taskId}/assignment：{inputRevisionId,assignee?:principalId|null,dueAt?:ISO时间|null}，须任务可读且拥有 tasks.input；所有者或该 scope 管理员可更新，成员不能改别人的任务。assignee 必须同 scope 活跃成员/管理员；分派不授予私有任务读取权限，私有任务当前只允许分给所有者。TaskView 返回 assignee/dueAt。dueAt 是队列 SLA 日期，独立于 D 的执行截止时间。Scope 的 slaMs 可随 POST /v1/scopes/{scopeId}/policy 的单项变更集独立决定：完整键为 awaitingMyApproval/awaitingMyInput/submittedByMe/assignedToMe/exceptions，值为正毫秒；未传时保留原策略。计数优先 task.dueAt，否则等待起点加该范围 slaMs；不同范围值不一致时 counter.slaMs=null，并在 slaByScope 给出依据。

updatedAt 页游标冻结 PostgreSQL 微秒时间锚点，后续更新超过锚点的记录交由下一次新查询展示；total 是锚点下当前可见匹配数。年龄排序按创建时间与 id；同微秒两条记录仍有独立位置。没有该分面的登记簿返回 INVALID_PAYLOAD/details.facet，不把 NULL 比较当空页。service-clients 的集合查询只在调用者拥有 service-clients.manage 的范围计数；没有这种范围时，旧 items/nextCursor 与 view=page 均返回同形空集合，仍校验 limit/游标/分面。详情、登记、轮换和吊销继续要求管理资格，不因集合可查而授权。

通知只含 id、状态/原因码与 evidence 引用；完整结果从任务 result 取。规范事件包括 approval.requested/decision/superseded、task.waiting-review/waiting-input/delivered/failed/cancelled、operation.unknown、bot.started/output/admission-failed，以及已实际发出的变更集状态。旧 task.approval-requested/approval.response 继续保留在任务事件兼容流，通知目录使用规范名字。输入改写与新变更集都会发 approval.superseded，并给 supersededBy。通知游标只推进到最后可见事件；权限后来增加时，客户端应从 cursor=0 重查先前被滤掉的区间。

outbox 保留默认最近至少 **10000 条事件**的补读窗口、最多 **100000 行**，年龄目标 **7 天**（硬上限优先）；环境可配 CIRCLE_HUB_OUTBOX_REPLAY_EVENTS、CIRCLE_HUB_OUTBOX_MAX_ROWS、CIRCLE_HUB_OUTBOX_MAX_AGE_MS。写入超限同事务批量裁剪，年龄每分钟维护，任务当前状态/结果、B 原件与审计不删除。通知返回 replayWindow；旧非零游标早于 minCursor 为 CURSOR_EXPIRED，明确从零重新查询当前窗口，不能宣称全历史仍在。task/admin events 同样拒绝过窗游标。SSE 每 tenant/主体默认四条连接，可配 CIRCLE_HUB_NOTIFICATION_STREAMS；超限 NOTIFICATION_STREAM_LIMIT，断开释放名额，运行中游标过窗发 cursor.expired 并关闭。角色/会话失效仍关闭流。

登记簿分页已按确认顺序接 tasks/assets/skillpacks/change-sets/scopes/roles/service-clients/object-types/objects/tools，以及 task/admin approvals、来源/证据/制品、审计/worker、bot runs、通知。各集合 view=page 复用同一查询编译器；已经存在的旧数组或补读形状保留，B 新集合 GET 按下文显式 view=page。相关权限/游标验收分别记录，不将未运行的维护者全套称作本轮已通过。

审批登记簿已接：/v1/tasks/{taskId}/approvals 与 /v1/admin/approvals 加 view=page，旧数组保留。任务页沿用 tasks.read/私有任务/run 边界，admin 页限定当前 admin.manage 范围，旧 admin 数组同样遵守私有读取。owner 为 applicantId，产品线/流程取绑定任务已记录的 context/flowVersion；status/lifecycle 在页上把 open 且已到期投影为 expired，原审批行与旧数组状态不改。createdAt/updatedAt 用审批自己的时间，迁移 39 从 createdAt 初始化历史更新时间，仅后续实际审批行变更用触发器记录；不推断缺失历史决定时间。

B 集合页：GET /v1/sources?view=page、/v1/evidence?view=page、/v1/artifacts?view=page 使用 RegistryPageQuery/RegistryPage，分别列 src_ 上传原件、evd_ 任务证据、art_ 产物，返回现有引用字段与 downloadPath，不返回字节。这些路径此前没有集合 GET，必须显式 view=page；上传与 content 不变。范围/来源 ACL/私有任务/run 归属先核对，再计算 total 与分页；来源同时服从历史与当前企业观察、知识来源 readers，产物存在多个绑定时只计一次。owner 对来源是上传者、证据是任务申请人、产物是任一可读绑定的申请人；隐藏绑定不参与 owner 筛选。不伪造状态、产品线或流程维度，未支持分面为 INVALID_PAYLOAD。年龄/更新时间均为不可变登记时间。

MCP resources/list 是同一 B 权限与分面查询的投影，除上述三类还保留既有 knr_ 与个人 mcr_ 资源；新增可列表的 src_ 和已支持的 source URI 读取一致。请求 params._meta["hub/query"] 可传同一公共分面/limit/sort/order，cursor 用 params.cursor 原样续读；默认 limit=100、年龄倒序，返回 resources/nextCursor 与 _meta["hub/total"]。游标改为统一查询/身份绑定形状，旧资源游标不兼容，应重新列第一页；REST 与 MCP 集合不同，不能互换游标。列表全程不读取原件字节；复杂来源/knr 的递归 ACL 会遍历当前授权范围内候选元数据，耗时随候选量增长，不承诺只处理 limit 条元数据。knr_ 与 mcr_ 的现有读取/个人权限不变。

已知规模限制：B 分页当前把整个授权范围的候选元数据取入内存逐行判定（来源和知识记录每条还核来源权限，MCP 对五类各做一次），以后数据量增大需改成 SQL 层可见性谓词；本轮不做这项改造。

审计/worker/bot runs 已接 view=page：/v1/admin/audit、/v1/workers（含兼容 admin workers）、/v1/automations/bots/{assetId}/runs。审计沿现有管理范围，scope=null 的租户管理审计仍可见，owner=principalId，createdAt 也是更新时间，不从 detail 推断产品线/状态。worker 范围来自机器 policy 的 scope 交集，不展开成重复行；owner 为 worker principal，status=offline|draining|online（离线优先），阈值与现有列表一致；尚无不可变注册创建时间，age/minAgeMs/maxAgeMs 对 worker 明确定义为距 lastSeen 的观测年龄，updatedAt 也用 lastSeen。两类都保持 admin.manage，未支持的分面明确 INVALID_PAYLOAD，旧数组不变。

bot runs 仍仅 bot 所有者可读；产品线与 lifecycle 取被运行资产版本，owner 为运行身份，status 是已有 admitted/failed，不改成任务 phase；flowVersion 为 skill-run/1。更新时间为 publishedAt（未发布时为 createdAt），完整键 bot/version/occurrence 的 SHA 作游标平局依据。页内新增 recordId/version 供跨版本记录去重；旧数组项不加字段，taskId=null/failed 不伪造任务，occurrenceKey/channel/published/trigger/error 全部保留。

通知登记页 GET /v1/notifications?view=page 使用 RegistryPageQuery，返回 total/items/cursor；对象项与旧通知补读/SSE 使用同一冻结投影，额外不挑选任何正文。这里 cursor 是查询绑定的 opaque token；不带 view 的通知补读及 SSE 仍使用整数 seq，两个游标不能互换。登记页只查询当前保留窗口，不是完整历史或 seq 补读证明，裁剪后 count/后续页可减少；窗口恢复仍用旧通知补读协议。owner 为任务申请人（taskless 为原主体），产品线/流程取关联任务已记录维度，status 只用原 payload 的 status/phase/outcome，无值不猜当前任务状态；没有独立 lifecycle，筛选时明确拒绝。年龄与更新时间同为 outbox 的不可变 createdAt，seq 作同时间平局，私有任务与 taskless 原主体可见性先过滤再计数。

迁移 38 追加修复 36 的归因细节：多条已释放读取统一为 UPSTREAM_TIMEOUT/sideEffects=none/sorted operationIds；不触动 unknown/write。task.read-release-audit-links-completed 的 correctsAudit 指原 36 任务补偿行，relatedAudits 列出该任务/输入全部 30 原释放审计；原行/原 min 引用保持历史原样，阅读完整链以追加行补足，不猜历史状态。29/30/36 的校验和均不改。

task/admin events 的权限、窗口校验与取页也在同一只读快照内；裁剪并发时返回该次校验的完整可见页或明确 CURSOR_EXPIRED，长轮询逐次重核，不返回静默缺失的空页。bot.admission-failed 的通知原因读取 payload.reason.code；完整运行错误仍从 bot runs 的 error 或任务 result.error 获取。

复核补充：床 conf.device_names 的自定义名称会让第三来源的 APV<index> 规则失效；日志 IP 只能定位到拓扑设备，任意名字不能推断工作簿索引。cexg 0.3.1 的计划接口是 env_prepare.conf.device_ips，实际出现后使用第一来源，因而不受改名影响；hub 不根据版本号假定字段已出现。共享地址日志不归属、不消费设备游标。

客户端恢复契约：通知补读页首次 cursor=0 也返回 replayWindow.minCursor；大于零表示窗口之前已有事件被裁剪，这次响应不代表完整历史。task/admin events 仍只返回 events/after，不带 replayWindow；过窗依据 CURSOR_EXPIRED 的 details.minCursor。随后通知从 cursor=0、事件从 after=0 重拉保留窗口，按 seq 去重，并从 GET /v1/tasks?view=page（遍历当前状态页）及 /v1/tasks/{id}/approvals 补窗口外的任务/审批当前事实；历史正文仍需持久 B 原件/产物，不从当前状态反推过去发生顺序。SSE 的 cursor.expired 使用同一恢复过程。

保留策略当前没有按主体已读水位保护未读事件；全局其它 scope 的事件产出也会缩短本人的时间窗口，离线七天并不保证能补全。推荐 SSE 在线跟随，轮询/重连及处理一页的总预算不超过 min(30 秒、replayEvents/(4×全局峰值事件速率)、maxAgeMs/4)。例如一万条窗口、全局峰值每秒 200 条，预算应小于约 12.5 秒；未掌握峰值时可从 5 秒轮询开始，并以 minCursor/游标缺口触发状态重建。它是降低缺口的运行建议，不是未读永久保留保证。

updatedAt 页锚点限制上界，未保存旧行版本。普通服务端更新晚于锚点会进下一次查询；若显式回填时间或时钟回拨，使已交出的行改到仍在锚点内、又晚于升序游标的位置，该行可以再次交出。客户端按稳定记录 id 合并，跨页去重；需要严格不可重复扫描时使用不可变创建时间的年龄排序，并在扫描后发起新查询补更新。SSE 连接上限目前是每个 server 进程内按 tenant/主体计数，多进程各自计算；没有承诺集群总上限。

事件正文接口：task events、admin events、GET /v1/notifications 与 notifications/stream 的同一事件采用同一显式字段投影，不以字节大小决定内联。保留字符串 phase/to/status/message/question/reason/workerId，以及 id、状态/原因码、规则版本/结论、fence、工具名/状态、运行绑定、bot 渠道/跳过次数等元数据。bot.output 保留 status、artifacts:[{artifactId,fileName,sha256}]、unknowns:string[]；清单不含文件字节。reason 原本是字符串时保留；由 error.code 生成时为 {code}。result、工具输出、模型文本、调用参数和错误详情正文不内联。Circle 的 eventLine 和 bot.output 两处读取继续可用，交付正文照旧从 /v1/tasks/{id}/result 读取；Circle 不需要改为读取事件全文，也不使用 admin events。

有 taskId 的所有 kind 都带 content:{sha256,size,downloadPath,retained?}，即使该条原 payload 本来只有元数据。按需 GET /v1/tasks/{taskId}/events/{seq}/content 回读原 payload 的 canonicalJson UTF-8 字节，Content-Type=application/json、x-content-sha256 等于对这份实际响应字节算出的 content.sha256；无 API 信封，与 knr_/evd_/art_ 下载使用同一字节核对方式。内容路径沿用任务 scope/private/run 委托权限，并与窗口校验共用快照；其它身份不能借路径读取，事件过窗为 CURSOR_EXPIRED。taskless 的 bot.admission-failed 当前仅通知/SSE 对原主体可见，payload 只含 botAssetId、occurrenceKey、原因码等元数据，没有 content；admin events 当前只列 taskId 非空的事件，不生成 /tasks/null 路径。

content.retained 是原 payload 已有的 B 引用列表，每项为 {evidenceId|artifactId,sha256?,fileName?,downloadPath}，引用自己的 SHA，不能与 content.sha256 混用。execution.environment.observed 附环境 JSON artifactId；task.delivered、bot.output 附已留存的 evidence/artifacts（含工具原件 knr_、运行/网关 evd_ 与交付 art_）。例如环境制品仍从 /v1/artifacts/{id}/content 下载，knr_ 原件从 /v1/knowledge/records/{id}/content 下载。它们在事件裁剪后仍按 B 的现行权限可读，但不声称单个原件包含整条事件或全部交付结论；交付完整状态仍从 result 获取。未有 retained 的事件全文只在同一 outbox 保留窗口可读，不新增永久保存承诺。运行中的原样 outbox、内部兼容观察与最终结果不改。

worker 离线检测默认 90000 毫秒，可由部署运行配置 CIRCLE_HUB_WORKER_OFFLINE_MS 设正整数；GET /v1/workers 及兼容 /v1/admin/workers 返回旧数组，每项 {workerId,draining,lastSeen,offline,workerOfflineAfterMs}，GET /v1/queues 同样披露 workerOfflineAfterMs。列表需 admin.manage，限定授权范围中的 worker；它仍属于管理类登记簿的权限例外；本轮已接入 view=page 统一分面页，不带 view 保留上述旧数组。这个检测阈值决定是否进入 workerOffline，范围 slaMs.exceptions 决定是否超 SLA，两者独立；不根据 worker 的业务结果猜离线。

GET /v1/assets/{id}/harness-export?target=circle|<sourceHarness> 仅批准后的可读原语可用，返回 files 的相对目标路径/base64/sha256、warnings、provenance:{assetId,version,sha256,sourceHarness}。Circle Skill 原件移动到 .circle/skills/{name}/，字节不改；Instruction 投影为 AGENTS.md。Circle 尚无 Agent/Command 原生安装时明确 warning；MCP prompt 可读取批准的 Skill/Command。同来源 harness 由公开库导出；其不支持的跨 harness 映射继续 warning。这里只是冻结与装载投影，云运行仍用既有技能试跑/提交/批准接口；不自动批准或把原件搬运称作已执行。

`POST /mcp` 是官方 @modelcontextprotocol/sdk 1.32.1 的 Streamable HTTP JSON transport，协议协商 2025-11-25；[传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。每请求带 hub 会话 Bearer；Origin 若存在须同 hub 原生地址。无会话 id 的 stateless 模式，GET/DELETE 405；Accept 同时支持 application/json、text/event-stream。官方纯 SDK 客户端、原始 JSON-RPC 客户端已验收，既有 Circle REST 扩展保持。

MCP tools/list 为调用者专业目录与 hub 平台控制 Tool，inputSchema 保持各专业工具原形；effect/minimumRole/approval 留标注/_meta。专业 tools/call 复用 C 的受理/幂等/事件及 B 原返回证据。所有调用 `_meta["hub/idempotencyKey"]` 必填；body 另有 key 时须相同。approval:true 首次没确认返回 isError 与 CONFIRMATION_REQUIRED，details:{argsDigest:canonicalHash(args),summary}；复调 `_meta["hub/confirmation"]={argsDigest}` 与当前 args 一致才执行，否则 CONFIRMATION_STALE。它是同一操作者确认，不能成为变更集审批人或替代角色/绑定/Hook/租约。响应 _meta 回显 hub/idempotencyKey 和 evidenceId 数组。

平台 Tool 名保留 hub. 命名空间：hub.tasks_submit、hub.sources_upload、hub.skillpacks_submit、hub.approvals_decide、hub.skillpacks_run、hub.tasks_status、hub.tasks_result。写回执与原动作在同一 C 事务落库，重放不再写，改参数为 IDEMPOTENCY_MISMATCH；审批失败尝试也保留。控制返回以 SHA 入 B，mcr_ 为传输回执证据，不称业务事实或模型质量验证。

resources/list/read 支持 hub://evidence/{knr_|evd_|mcr_}、hub://source/{knr_|src_}、hub://artifact/{art_}；逐次沿用 B 的 scope/来源 readers/私有任务/个人凭据权限，mcr_ 仅原操作者可读。列表在授权集合分页，nextCursor 原样续读且绑定身份。prompts/list/get 为批准可读的 Skill/Command 原件投影，返回资产 SHA/版本出处，不替换未声明参数，不执行原语；列表同样分页。

GET /v1/scopes/{scopeId}/permission-export 返回 [Grok 的规范](design/permission-export.md)定义的 hub-permission/1：范围 twoPersonRule/singleAdminMode 原样披露、roleOrder=[guest,member,administrator]、可见 provider 的 tools name/effect/minimumRole/approval，不存 disposition。读权限和当前调用目录仍由平台执行；机器 scope 串不冒充人的角色，根管理员没有子范围资料权时不能借导出读取。未实现各 harness 的本地许可文件改写。

## 派发前拒绝与两次环境观察

网关接入修复新增完整 gatewayRefusal 与两次环境观察的来源披露；分类与租约规则已并入[派发前拒绝与远端租约](design/approvals-and-enforcement.md#派发前拒绝与远端租约)及[派发与两次环境观察](design/approvals-and-enforcement.md#派发与两次环境观察)。

| 保留的接口字段 | 实现变更 |
|---|---|
| execution.gateway.submit-intent | C 的提交意图事件，设备事实仍来自外部回报 |
| error.details.gatewayRefusal | 原始 reason / error / stage / code 保留；不再把所有 environment 拒绝猜成 BUILD_MISMATCH |
| waitingReason / result.error | 增加 build-mismatch / gateway-refused / workbook-contract 的修复入口与事实 |
| execution.environment.observed | observationSource=gateway.env_prepare，留提交前环境原件；case_submit 后续内部核验另留拒绝事实 |
| remoteLeaseReleased / leaseReleaseError | finally 释放的真实成功 / 失败字段，不覆盖主错误或宣称远端停止 |

## 内部历史批准修订绑定（A1）

A1 补齐内部 `AssetRevisionPin={assetId,version,sha256,digest?}`。SourceArtifacts.snapshot / ProductModules.load 的末尾 pin 及 ToolProviders.resolve 的 selector 可选精确修订；digest 是模块清单摘要，不与资产 SHA 混用。没有新增 HTTP 路由，公开 methodAssetId 仍是资产 id。

装载修复改为读取历史批准 pin；旧 assetId 字符串仍选该资产最新 approved/running，不能称冻结，多实现未指定则 SOURCE_NOT_APPROVED。缓存调用也重核选定批准版与最新批准版 readers 的交集，draft reader 修改不撤旧 pin；角色 / 已批准 reader 撤销、disabled/retired 或批准摘要失效继续生效。内部 pin 只覆盖该批准清单的自有 SourceRevision，basis / 企业 ACL / 其它来源未被旁路。

旧 task / methodAssetId、SAR 稳定 id 的公开失效语义、原生 1.1.1 字节均未自动迁移。版本与批准 pin 的设计见[方法版本、摘要与批准修订](design/execution-flow-packs.md#方法版本摘要与批准修订)；后续 A2 / A3 的实现与验收分别见[有界 transition](design/execution-flow-packs.md#附录-a2有界-transition-内部契约)及[阶段进度](server-s2-progress.md)。

## A3：通用模块执行与受控原件

A3 已通过既有 POST /v1/tasks/submit 接入 `module-execute/1.0.0`（驱动 `module-execute/1`），未增加执行专用 HTTP 路由。通用机制见[执行流设计附录](design/execution-flow-packs.md#附录-a3通用驱动接入与证据边界)；本节保留客户端输入与后续修复记录，完整验收见[进度 72–86 节](server-s2-progress.md#72a3-复核修复与通用错误登记)。

提交 input 为 `{flowId,methodPin,resources,sources?,value?,controlledBytes?,deadlineMs?}`；methodPin 显式 `{assetId,version,sha256,digest?}`，resources / sources 是别名到精确 pin 的映射，controlledBytes 每项 `{slot,role,source,path}`。所选 flow 文件为 `circle-packs/flow/1`，含 `{id,version,driver:"hub-execution-transition/1",transition:{path,export},initialState,deadlineMs?}`；入口属于冻结 tools[]。来源 path / role 取批准清单，客户端不传端点、秘密或自制字节回执。

provider 沿既有 connector-instance 与批准 execution runtime-profile，configuration 使用 `hub-provider/1` / `transport:"streamable-http"` / `runtimeProfileType:"execution"` / runtimeProfileRef / receiptPolicy。精确形状在[ProviderPolicy](../packages/execution/src/flow-contracts.ts)：submitTool / statusTool / resultTool / reconcileTool、taskIdArgument、remoteIdPath / requestHashPath / inputSha256Path / byteHashesPath / statePath、runningValues / terminalValues、receiptSchema；lease 含 acquireTool / heartbeatTool / releaseTool、idPath / fencePath / ttlSecondsPath、idArgument / fenceArgument；refusal 含 stagePath / preDispatchStages / dispatchedPath / remoteIdPath / codePath / reasonPath，字段路径均为字符串数组。使用现有 JSON-RPC tools/list / tools/call，不宣称任意 MCP 初始化或会话协商已兼容。

受控 `provider.call.byteArgs={参数名:slot}` / Tool byteSlots 已实现，不能覆盖普通 args。请求摘要包含所用 B 原件身份，step key 不含参数摘要；普通字符串 32 KiB、受控原件合计 8 MiB、完整 Tool 输入 / 输出 24 / 16 MiB、总步骤 / 转换 256 项。B 上传的 16 MiB 不等于单流程原件预算。实现摘要覆盖冻结模块 digest / flow / 驱动版本 / 精确依赖，旧 run 不换 parser。

| 修复组 | 保留的实现变更与接口边界 |
|---|---|
| H1 `4e84ba0` | input.deadlineMs → 批准 flow.deadlineMs → 默认 3600000 毫秒，正整数且最多一小时，冻结进 run。waiting-review 不按执行期限清理，批准消费后刷新；accepted 真过期明确 failed / UPSTREAM_TIMEOUT / sideEffects:none，意图写超过真实期限仍 unknown。 |
| M4 `f7a418b` | 任务 savepoint 与运行器独立捕错；步骤累计预算先整批拒绝、不留下半批写，pending 不因预算检查被中止。 |
| H2 `8cf4998` | B 拒绝原件含 `{schema:"hub-provider-refusal/1",tool,phase,refusal}`，C 核绑定 submit 与持久 remote_identity；已提交后的 status / heartbeat 外观拒绝不撤派发事实、不释放潜在远端租约。 |
| M5 `90e8bfd` | C 从本任务 / 修订 / stepId 已完成连续前缀授予 occurrence，输入新增可选 `expectedOccurrences:[{stepId,nextOccurrence}]`，pending 不推进；首次 0、跳号 999 或 hub. 身份拒绝。same requestHash 重用，改参数 / 原件同 key 仍 IDEMPOTENCY_MISMATCH；合法 next 是新步骤，facts.occurrence 来自 C 行。 |
| M6 `37d845c`、注册用例 `49f8f98` | 迁移 41 增加 capabilities / required_worker_capability；新 worker 声明 flow.invoke，旧 `{}` 仍可执行原生工作。严格对象拒绝顶层未知键（如 workerId）为 INVALID_PAYLOAD，capabilities 内未知操作名 / 重复项也拒绝，身份由认证 policy 决定，拒绝不污染已有登记。 |
| M3 `d57e96c` | status 终态先独立持久，再取 result / 解释；ok:false 或坏 identity / SHA / schema 留 B 并记解释失败，不把 D 已证终态降为 unknown。终态后中断收尾保 succeeded、释放 null；仅 expiryAfterTerminal / 有终态 SHA / 尚无最终 reportHash 的同 worker / fence / 修订可补记一次，精确重报去重、异 hash 拒绝，不复活失败任务或重派。 |

后续复核补项（详见[进度 79–86 节](server-s2-progress.md#79hook-资源确定性与轻预检)）：

- beforeDispatch / afterResult 的资源改由本任务同修订 subject.operationId 关联，不按 JSONB 顺序；其它 verify 只接受唯一可确定资源。零资源纯 transition / Tool 不再构造无用 HookBinding。写出口强制 beforeDispatch，afterResult 绑定终态原操作和整份交付候选 canonical SHA；默认执行链与 executionIsChange 一次消费沿设计，run 委托的 privateOwnerId / parentRunTaskId 不变。
- provider 授权扩至真实 submit / lease acquire-heartbeat-release / status / result 链，普通读只核自身，reconcile 核 reconcile / release；轻预检与短期令牌活性沿同一链。`lightweight:true` 首次 full 后复用不可变 frame 字节，每次仍重核角色 / readers / pin / profile / 凭据 / 租约 / fence；contentReference 沿 content ACL。冷 Hook 代码读取不冒称所有 B 零读取。
- outcome.error 改为独占动作批次，混有后续动作在新入队前 INVALID_PAYLOAD；原报告仍保留。交付新增 `executionObservations` 小元数据（operationId / terminal / remoteLeaseReleased / 原件引用），不靠产品转录释放事实。
- 历史事实只沿原 worker / fence / inputRevision 核冻结资源定义 SHA、已持久 request / input / byteHashes 和 B 终态原件，不读端点 / 秘密或新执行许可。停用 source / resource 不再阻止未知写及时冻结，也不丢终态释放 / 解释事实；新派发和独立 reconcile 仍走 live 授权。
- worker 报告顶层 error / output.resultError 及其 details 规范为 F 错误码，未知 INTERNAL_ERROR；output.result 全树 opaque，嵌套业务 error / resultError 也保原值，inline / pointer 回读一致。完整 API JSON body 以 canonicalJson UTF-8 留 B（不含认证头）；其字节 SHA 与契约解析后、投影前 reportHash 是不同转换口径，同 hash 幂等 / 异 hash 拒绝。

本轮只用 Meridian 与另一份合成模块，未执行 APV 新 flow。原生 apv-case-execute **1.1.1** 的文件 / 摘要 / 旧 task 绑定保持；APV 新 Tool / flow、部署切换和退役由独立 circle-packs 与维护者接续。历史合成验收及维护者外部观察见进度，不据此推定真实设备、模型或任意 MCP 服务兼容性。

### APV 外部模块接入验收（C 前置）

从任意 Hub 检出的仓库根目录运行以下单文件验收；依赖使用该 Hub 工作树的锁定版本，不在产品包仓库运行安装脚本：

```sh
CIRCLE_HUB_APV_MODULE_ACCEPTANCE=1 \
CIRCLE_PACKS_CATALOG=../circle-packs/modules.json \
CIRCLE_PACKS_REF=apv-execution-flow \
node --test --test-concurrency=1 tests/acceptance/a3-apv-module-flow-synthetic-provider-protocol.test.ts
```

catalog 路径按实际独立包检出位置在运行时提供。REF 可为本地分支或提交，优先于 CIRCLE_PACKS_COMMIT；均未指定时沿已有验收 pin。入口将 ref 解析一次为 Git commit，按该提交核对完整模块清单、文件 SHA 和 digest，要求 products/apv 为 1.3.0。它不 checkout 或改产品包工作树。未设置启用开关时明确 skip，跳过不计通过；显式启用后的目录、ref、清单、版本或模块 ABI 错误为失败。

初次冻结 1.3.0 的 `702d039` 时，v2 描述的 id 仍指旧 flow，显式开启在静态接法校验报红。后续冻结 `5cdbc2b` 后已通过真实临时 PostgreSQL 完成原件上传、模块安装与独立变更集批准、派发、终态、纯 Tool 解析和交付：case_submit 一次，原件只经 xlsx_b64 的 byteArgs、字节 SHA 一致，设备和主机步骤 observed、两个检查点 passed、unmapped 为空。该冻结提交验收为 **1 fail / 0 skip**，因为包未发 verify.workbook；device / host Hook 的真实处理器回执及 B 字节 SHA 已核对。保留三个 verify 挂点完整性断言，不以 delivered 冒充整条验收通过。默认单项 skip 保持普通全套可运行，跳过不计通过。

分支随后前进到 `6a8cb799125a749e69ba4b6f32de8ee1a92437ab`，验收按该 SHA 冻结 APV 1.3.0（digest `54c681c1e8380cad5509c7dbf18774052b432d0b903c59ebaeb6748239a2df48`），完整 **1/1 通过，无 skip**。三个 verify 挂点的实际处理器决定与 B 证据 SHA、56,413 字节原件的 byteArgs / SHA、单次 case_submit、逐步 / 两个检查点和 unmapped 全部原断言通过；旧 `5cdbc2b` 红记录保持。此结果仅属于下面的 synthetic provider protocol，不能代替严格 cexg 验收或批准现网切换。

二轮复核发现上述路径仍携带流程外预生成的 workbookBook / 命令投影，不能证明正式 flow 自行读取全部原件。夹具现改为只提供本场景的 build、冻结 pins 和四个 B 受控槽：workbook、command-tree、command-check、function-contract；不提供 book、命令清单、client、tree 或 present。command-check 为 `{result:{build,buildId,sourceSha256,ruleVersion,commands:[...]},evidence:[]}`，由独立合成树经确定性 commandCheck 计算，sourceSha256 对应树原字节，未伪造 evd；正式产品依原件算 Hook 布尔，不能自造命中。

相同命令缺树、合法主机不在已批准床、合法契约中方法 disabled 三个负例与正例共四项。它们要求正式 Workbook Tool 读取原件、真实 C frame 的 expectedOccurrences、实际 B 投影 / 动态 hub.result.* 槽及后续 byteSlots，逐项核源 SHA；负例须有对应 Hook 的真实 block 与 B 决策、`HOOK_FAILED` 和 `error.details.code`，解析 / schema 或错挂点拒绝不能算通过。合成工作簿保留 33 KiB 描述以触发实际大投影，不为绿删小；小结果原有 inline 表示仍合法，槽必须来自 C 的实际回报。

新二轮门禁固定 `6a8cb7` 为 **0 pass / 4 fail / 0 skip**：包仍未正式读 B 工作簿，全部先停在 verify.workbook，且误把顶码写为 COMMAND_NOT_IN_TREE；case_submit=0。来源缺失 / 不在床 / disabled 的预期规则尚未被正确路径到达。旧 1/1 正向旁证保持为当时记录，不套为新门禁绿。默认四项 skip，不访问外部包或启动 PostgreSQL；与严格文件同跑为纯协议 **1 pass、5 skip**。新 ref 需另行冻结后重验，运行命令不变。

本验收只使用 A3 合成协议：env_prepare / bed_topology 可独立只读，status/results 接受 worker 携带的可选租约字段，回执声明合成的 request_hash / input_sha256 / byte_hashes / state，用于原操作机械关联；xlsx_b64 和 expires_in_s 使用网关的字段名。它不证明现网网关已支持这些关联字段、参数或调用时序。实际网关的两个准备观察要求远端租约；后续可选 receiptPolicy.prepare 的方向见[执行流设计 A2 附录](design/execution-flow-packs.md#附录-a2有界-transition-内部契约)的驱动注入形状小节，本轮未实现，也不宣布现网切换。

### C 严格 cexg 协议目标验收

第二条使用与 cexg 0.3.1 Tool schema 同形的自写合成 provider，与第一条的 synthetic provider protocol 分开：

```sh
CIRCLE_HUB_CEXG_PROTOCOL_ACCEPTANCE=1 \
CIRCLE_PACKS_CATALOG=../circle-packs/modules.json \
CIRCLE_PACKS_REF=apv-execution-flow \
node --test --test-concurrency=1 tests/acceptance/c-cexg-protocol.test.ts
```

未设置开关时，纯协议夹具 **1 pass**、主兼容验收 **1 skip**；不开启主验收时不读取外部模块或启动 PostgreSQL。显式启用仍冻结一次 ref，目录 / ABI 错误不变成 skip。夹具只用文档示例与运行时生成的模拟值；认证值随机生成，监听地址仅由本机临时端口构造，没有真实配置、凭据或床地址。

严格输入不放宽：env_prepare / bed_topology / case_submit 必需 lease_id/token，提交原件字段为 xlsx_b64、module 可选，case_status / case_results 仅 task_id、拒绝额外字段。原始成功回报保持 submit 的 sha256/case_ids、status 的 state、results 的 ready/xlsx_sha256/cases；不填三种 A3 hash，不给 submit 或完成 results 填 state。当前批准策略仍沿未改驱动的旧 schema，正是待修兼容边界之一；后续必须同步批准的 policy 映射与机械核验，不能在夹具原件补字段做绿，也不在本轮定义未来 schema。

冻结 `5cdbc2b` 的实际结果为 **1 pass / 1 fail / 0 skip**：原件与模块登记、另一身份批准完成，主目标在 `C.validateBatch:env_prepare` 缺租约而 failed / INVALID_PAYLOAD，provider RPC、case_submit 与 write intent 都是零。主断言仍要求成功完成执行，没有把拒绝标成通过。提交、status/results 与原始回执的后续缺口尚未到达；完整清单见[中英 C 待办](design/execution-flow-packs.md#c-阶段待办同形网关协议兼容)，本轮未改驱动或网关，也未证明真实设备兼容。
