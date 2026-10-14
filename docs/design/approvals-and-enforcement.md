# 审批与执行链

## 只有一个审批概念：变更集

一次提交 = 一个变更集 = 一次决定。变更集里可以有多个对象的资产：一个模块里的技能包、产品线清单、一条规则、一个连接器实例，独立审批人看一次、决定一次，决定绑定所有资产摘要的合集；通过后每个资产的 lifecycle 原子更新，驳回则全部 declined。

- 审批请求绑定三项：`inputRevisionId`（任务输入修订）、`targetIdentity`（各项 sha256 的有序摘要）、`actionDigest`（动作与参数的摘要）。任一变化，请求失效，重新申请。
- 申请人 ≠ 审批人。平台不是审批人：记录里只写「按规则 X vN 核验」，不写 approved。
- 变更集**引用**的东西不重批：技能包引用的连接器、原件、网关都是已批准的资产。平台核验只检查引用的都在、都是 approved / running；没就绪就把请求挂成 blocked 并列出原因，依赖变化时重核。
- 同一资产的新变更集取代旧的：旧请求关闭为 superseded。
- 要重批的只有两种情况：字节变了（新版本），或动作变了（登记方法 ≠ 在设备上执行）。
- 审批请求与其等待输入共用有效期：默认一天，可按部署配置调整（一秒到三十天）；普通澄清输入的有效期独立（默认五分钟）。延长有效期不解除修订、目标身份、动作摘要与执行出口复核。
- 每一次已授权的回应尝试都记入决定，包括被拒绝的尝试；对同一请求的重复决定是 `DECISION_CONFLICT`。每条决定记录保持作出时的策略与资格上下文，不随后续回应或策略修改重写。
- 待批草稿对同租户、同授权范围且持 approve 权限的人可见，供其审阅定义与摘要；这不把审批人加进 readers，不授予原件、知识内容、凭据或运行的权限。凭据引用保持私有，审批完成或停用后不再借待批可见。
- 引用的资产不是 approved / running 时，变更集保持 open 并标 blocked，原因逐项列出；批准它是 `DEPENDENCY_NOT_APPROVED` 并附原因。依赖的生命周期变化经持久队列触发重核，重启后同样重核。
- 回应必须原样回传绑定三项；修订、目标身份、动作摘要任一不同即失效。驳回一个已被取代的旧申请，沿该申请自己的绑定回 `approve:false`：核对的是它的修订、申请人、摘要与当时的资产版本，不要求原申请人仍有权限。驳回使该请求 declined、其登记任务正常结束——这是治理流程的完成，不代表内容获批；新版本的批准与执行资格不受影响。
- 单项资产的登记接口（资产、技能、模块）各自自动产生单项变更集；涉及多项的变更必须走变更集的审批接口一次决定，不能逐项批准。
- 任务的待回应输入绑定当前输入修订：回应与替换二选一，不借自然语言消息隐式修改；对旧修订的回应是 `INPUT_REVISION_STALE`，超期是 `INPUT_EXPIRED`；终态与 unknown 的任务不接受输入替换，新的工作用新的提交表达。输入修订换版后，旧的执行绑定与等待原因随之作废。

## 运行时没有审批，只有执行链

变更集批准的那一刻，人已经决定了三件事：方法（字节摘要）、它声明要碰的资源（writes）、谁能用它（范围策略）。之后每次运行，平台做的不是决定，是执行人定好的策略：

1. **权限**：这个人在这个范围有执行权，资源策略允许他——策略是数据，批过一次。
2. **绑定**：方法版本 approved、资源版本 running、原件 approved；领取时钉住 pin。
3. **核验**：确定性规则——命令在绑定的树里、函数契约、自毁规则、资源回报的构建 = 绑定的构建。
4. **租约**：资源租约 + fencing，解决的是冲突，不是授权。
5. **审计与证据**：每一步原样留痕。

本地 Circle 跑和 hub worker 跑走同一条链：只有 worker 碰外部系统，模型跑在哪里不影响。

领取之后、投递之前还有一道强制复核：平台重新取回当前的规则原件再核一次，结果必须与批准的摘要一致，普通查询留下的旧缓存不能放行。复核记录与当前操作和 fence 绑定持久化，被一次性消费之后才授权派发意图——派发意图只证明平台准许了这一次提交，不证明资源已经派发。

## 结果只有三种

| 结果 | 条件 | 平台做什么 |
|---|---|---|
| 通过 | 五步都过 | 执行，产物带 sha 交付 |
| 报错 | 脚本能 100% 证真的失败 | 返回固定错误码和事实（哪条命令、哪棵树、规则版本、两个构建值、evidenceId）。申请人改输入能修的，任务停在 waiting-input 并写 waitingReason；否则 failed |
| 未知 | 脚本确定不了 | 状态 unknown，披露观察到的一切，**不重发**；申请人选择核对（reconcile）、标记失败或放弃 |

审批人在这些情况里做不了任何有意义的决定：他不能让命令出现在树里，也不能让设备变成另一个构建。所以运行时没有「异常审批」，也没有「预授权」。

### 错误码目录

可证真失败的标识全部固定；客户端按码分支，不解析自由文本。本表与 `packages/contracts/src/index.ts` 的注册表逐项核对，HTTP 状态与类别以注册表为准；包可经 `registerErrorCodes` 扩展注册表，见表末两条注。

| 组 | 码 | HTTP · 类别 | 含义 |
|---|---|---|---|
| 受理与请求 | `INVALID_PAYLOAD` | 400 · validation | 请求形状或取值非法；非法取值不静默截断 |
| 受理与请求 | `BODY_TOO_LARGE` | 413 · validation | 请求体超过上限 |
| 受理与请求 | `UNSUPPORTED_VERSION` | 400 · validation | 能力包未安装，或钉住的流程版本没有运行器 |
| 受理与请求 | `RESULT_TOO_LARGE` | 413 · validation | 结果超过上限；不截断冒充全量 |
| 受理与请求 | `SKILLPACK_CHECK_FAILED` | 422 · validation | 技能声明的工具与试跑记录或当前目录不符 |
| 受理与请求 | `IMPORT_NOT_DECLARED` | 422 · validation | 模块出现声明外的 import |
| 受理与请求 | `TARGET_NOT_FOUND` | 404 · target | 目标不存在 |
| 受理与请求 | `RATE_LIMITED` | 429 · transient | 超过速率上限；不回显凭据或用户名 |
| 身份与权限 | `UNAUTHENTICATED` | 401 · permission | 凭据无效或过期 |
| 身份与权限 | `FORBIDDEN_SCOPE` | 403 · permission | 越出授权范围 |
| 身份与权限 | `FORBIDDEN_ACTION` | 403 · permission | 未持有该动作 |
| 身份与权限 | `FORBIDDEN_TARGET` | 403 · permission | 目标越出已认证的策略 |
| 身份与权限 | `PERMISSION_DENIED` | 403 · permission | 执行链的权限拒绝 |
| 身份与权限 | `SELF_APPROVAL` | 403 · permission | 申请人不能批准自己的请求 |
| 身份与权限 | `SHARING_REQUIRED` | 403 · permission | 共享或提升需要显式许可 |
| 身份与权限 | `APPROVAL_REQUIRED` | 409 · permission | 需要已批准且激活的登记 |
| 身份与权限 | `CONNECTOR_DISABLED` | 409 · permission | 连接器已停用 |
| 身份与权限 | `IDENTITY_UNMAPPED` | 409 · permission | 身份无法映射到授权主体（在册，暂无抛出处） |
| 身份与权限 | `OBJECT_NOT_VISIBLE` | 404 · permission | 对象对当前身份不可见 |
| 身份与权限 | `ASSET_NOT_VISIBLE` | 404 · permission | 资产对当前身份不可见 |
| 绑定与冲突 | `IDEMPOTENCY_MISMATCH` | 409 · conflict-stale | 同一幂等键带了不同内容 |
| 绑定与冲突 | `INPUT_REVISION_STALE` | 409 · conflict-stale | 回应针对旧的输入修订 |
| 绑定与冲突 | `INPUT_EXPIRED` | 409 · conflict-stale | 回应超过有效期 |
| 绑定与冲突 | `DECISION_CONFLICT` | 409 · conflict-stale | 同一请求的重复决定 |
| 绑定与冲突 | `APPROVAL_STALE` | 409 · conflict-stale | 审批绑定的修订或记录已变化 |
| 绑定与冲突 | `SOURCE_HASH_MISMATCH` | 409 · conflict-stale | 来源字节的 SHA 与登记不符 |
| 绑定与冲突 | `TOOL_NAME_CONFLICT` | 409 · conflict-stale | 工具名冲突 |
| 绑定与冲突 | `RUNTIME_VERSION_MISMATCH` | 409 · conflict-stale | 运行器的可执行文件或修订核对不符 |
| 绑定与冲突 | `TARGET_IDENTITY_MISMATCH` | 409 · target | 目标身份与钉住的值不符 |
| 租约 | `FENCING_STALE` | 409 · lease | fence 已不是当前租约 |
| 租约 | `LEASE_EXPIRED` | 409 · lease | 执行租约已过期 |
| 租约 | `RESOURCE_BUSY` | 409 · lease | 资源因 unknown 冻结，新投递被拒 |
| 来源 | `SOURCE_ABSENT` | 404 · source-absent | 来源不存在 |
| 来源 | `SOURCE_FORBIDDEN` | 403 · permission | 来源无权限；普通调用的收敛码 |
| 来源 | `SOURCE_LOGIN_EXPIRED` | 401 · authentication | 来源登录失效 |
| 来源 | `SOURCE_UNREACHABLE` | 503 · source-unreachable | 来源不可达 |
| 来源 | `SOURCE_NOT_APPROVED` | 409 · dependency | 来源未批准，含明文例外失效后的配置失配 |
| 执行 | `COMMAND_NOT_IN_TREE` | 422 · execution | 命令不在绑定的树里 |
| 执行 | `DESTRUCTIVE_COMMAND` | 422 · execution | 命中自毁规则 |
| 执行 | `BUILD_MISMATCH` | 409 · execution | 回报的构建与绑定的构建不符 |
| 执行 | `GATEWAY_UNREACHABLE` | 503 · execution | 网关不可达 |
| 执行 | `LEASE_UNAVAILABLE` | 409 · execution | 租约不可用 |
| 执行 | `RUNTIME_FAILED` | 502 · execution | 运行器失败或私有执行请求被拒绝 |
| 执行 | `SANDBOX_UNAVAILABLE` | 503 · execution | 没有受支持的隔离适配器 |
| 执行 | `HOOK_FAILED` | 422 · execution | Hook 处理器未返回合法判定 |
| 执行 | `RECEIPT_PROCESSING_FAILED` | 500 · execution | 回报处理失败，不带内部细节 |
| 依赖与证据 | `DEPENDENCY_NOT_APPROVED` | 409 · dependency | 引用的依赖未批准或未运行 |
| 依赖与证据 | `EVIDENCE_INSUFFICIENT` | 409 · semantic-insufficient | 证据不足以支撑结论 |
| 依赖与证据 | `ARTIFACT_VERIFICATION_FAILED` | 409 · semantic-insufficient | 制品或证据与待证声明核对不符 |
| 暂时与兜底 | `UPSTREAM_TIMEOUT` | 504 · transient | 上游超时；只读操作可换新键重试 |
| 暂时与兜底 | `INTERNAL_ERROR` | 500 · internal | 内部兜底；未注册的码回落到它的状态与类别 |

包经 `registerErrorCodes` 注册的码：`CURSOR_EXPIRED`（409 · validation）与 `NOTIFICATION_STREAM_LIMIT`（429 · permission）由 tasks 包注册；`INVALID_EXECUTION_WORKBOOK`（422 · validation）、`COMMAND_VALIDATION_FAILED`（422 · validation）与 `GATEWAY_REFUSED`（422 · execution）由执行产品包注册。

抛出但未注册的码：`CONFIRMATION_REQUIRED`、`CONFIRMATION_STALE`、`MODEL_PROXY_UNAVAILABLE`、`MODEL_UPSTREAM_REJECTED`——它们回落到 `INTERNAL_ERROR` 的 HTTP 状态与类别，只保留码本身。

### 报错与等待输入

申请人改输入能修的失败停在 waiting-input：来源未批准、网关不可用、租约不足、构建不符各写各的 waitingReason，待回应列表里有对应请求，申请人用原输入接口交新修订；修订保留私有归属与委托关系，清掉旧的执行绑定与等待原因。命令缺失、参数违规、权限拒绝这类改输入修不了的，直接 failed。

### 来源失败的分类

来源失败对普通调用收敛：不存在与无权限统一报 `SOURCE_FORBIDDEN`，持诊断权限（sources.diagnose）的身份才看到完整分类。只有确认不存在才记入不存在缓存；登录失效、权限拒绝、源不可达都不当作缺失。失败的 details 只定位调用者自己提交的引用，不泄露记录的存在性、归属或内容。

### 读取的超时

声明 effect=read 的操作，其上游超时、同步等待超时、回报未知或租约失联，一律 failed + `UPSTREAM_TIMEOUT`：retryable=true、sideEffects=none，不冻结资源，也不要求独立副作用核对；换新键或修改查询可重试。写操作维持原规则：unknown、冻结、独立核对。

### 未知的纪律

失去租约、worker 断开、投递后取消、超时：操作转 unknown，资源冻结，新投递报 `RESOURCE_BUSY`；不重发、不自动重派，旧 fence 的回报被拒绝。取消只是一个请求，本地观察到的进程退出不等于远端停止，`remoteStoppingVerified:false` 如实写出。核对由另一个 worker 用原身份做只读核查：终态与输入摘要都对上才 reconciled、交付并解冻；核查未见终态，只有核查操作自己 failed，原任务保持 unknown、资源保持冻结。没有远端任务身份的投递断线不能自动恢复，先在资源侧对账，不盲目重投。

### 派发前拒绝与远端租约

资源在租约、环境、契约校验阶段的明确拒绝——回执没有任务身份、没有已派发标记——是可证真的 failed，不冻结资源；原始理由与完整回执保留在 gatewayRefusal，有明确码用明确码，否则 `GATEWAY_REFUSED`；不把环境阶段的拒绝一律当作构建不符，没有阶段信息的文字不猜派发状态。带任务身份或已派发标记的回执、提交之后任何阶段的失败、没有可证阶段的错误，一律 unknown，保留可能仍活跃的远端租约。只有证明未派发或确认终态之后才释放远端租约；释放结果如实记录（remoteLeaseReleased true/false，失败保留其原因），不覆盖主错误。

## 生产设备要两人规则怎么办

不另造概念：资源在登记时声明 `executionIsChange: true`，对它的执行提交先登记为 execution-submission 草稿资产（冻结输入修订、方法摘要、资源版本、原件 id、工作簿 sha），作为变更集的一项，批准后才进入执行链。实验床默认不声明，直接走执行链。一个概念，两种声明。这样的批准只能被对应的操作消费一次，一个决定不能重派给另一个操作。

## 凭据与资源

- 凭据只写不读：登记或轮换时进保险箱，执行时由 worker 注入，回给客户端的一切都过脱敏。
- 模型密钥也不进 harness 进程：worker 为每次运行起一个只绑回环临时端口的模型代理，harness 的凭据文件里只有该端点和一次性 nonce；代理核对 nonce、剥掉入站凭据头、注入真实密钥、只转发到已批准 runtime-profile 里的模型端点，运行结束即关闭。代理不记请求体，事件里只有元数据；起不来或上游拒绝以固定错误码失败，绝不退回把真实密钥写进文件。出口掩码（run token、nonce、模型密钥）是最后一道，不是边界。
- 凭据模式三种：平台签发的短期令牌、外部 OAuth、静态密钥。只有一个调用方的资源（例如 hub 的 worker 调用的网关）用静态密钥，本地比对，不回调平台。
- 端点、CA、超时在平台主机的运行 profile 文件里，不在数据库，不在 Git；runtime-profile 作为资产绑定 profile 名、版本和配置摘要，依赖要求 approved / running。
- 本地取消 ≠ 远端停止；超时先查原操作和现场；确认不了就保持 unknown。
- 静态密钥模式：值有最小长度要求，登记与轮换只写不读，响应只有引用与模式；worker 在每次已核授权的调用前取当前值注入。批准且 running 的共享资源允许当前授权成员使用其绑定密钥，成员不因此看到凭据的元数据或明文。停用凭据、资源修订、角色撤销、租约或 fence 变化都触发重新核对。
- 平台签发的短期令牌（run token）：只授权本次运行声明的工具、范围与任务，绑定操作与 fence；由持有效租约的 worker 续期，截止不超过该操作的期限；任务结束、取消、租约过期、旧 fence 或输入修订变化都立即失效。它经本机私有 IPC 交给子进程，只存在于内存与进程环境，不落盘；不能走会话续期或注销接口，也不能借它登记资产、提交别的任务或审批。单个 worker 同时只容纳一个运行槽，该槽同时服务这次运行的子工具调用。
- 外部 OAuth：签发方与端点只在仓库外的签发配置里，连接器配置引用它，请求不能传任意端点；远端端点必须 HTTPS（回环合成测试除外），CA 每次核验，不跟随重定向。设备码与客户端凭据两种授权成功后只返回凭据引用与到期元数据，值不进 API、事件、审计或仓库；不同范围或所有者不能互借。续期在私有单写者锁内原子替换：未轮换时保留旧的刷新令牌；回执未知或结果不完整时停止重放、标记轮换待定并要求重新登记，避免旧令牌重放吊销整族；明确的 5xx 保留原会话；既无 expires_in 也无配置默认期限时，到期时间为未知，不虚构期限。
- 明文例外：非回环且带认证的资料源默认必须 HTTPS。确需内网纯 HTTP 时，管理员在对应 runtime-profile 资产的配置里声明 `allowPlaintextAuthentication: true`，该版本经独立审批人决定后才生效——即使范围允许普通自决，这条例外也不能自批；在运行文件里直接加这个字段不授予例外。当前版本不再 approved/running 或配置摘要不匹配时，调用是 `SOURCE_NOT_APPROVED`；未批准的 HTTP 认证是 `SOURCE_FORBIDDEN`，不附带原地址或凭据。每次获准的明文认证，在派发意图、审计与取回的证据里永久标记 `plaintextAuthentication: true` 及批准它的资产版本引用；缓存重读保留标记，后续撤销不改写历史证据。
- 模型代理的边界：只绑一个回环临时端口，一次性 nonce 仅本次运行有效；目标由当前批准的运行配置钉住，Host、查询串与路径不能换目标，入站凭据头全部剥离。请求与响应各限 16 MiB，SSE 按流透传，不记体、不把模型流量存为证据；事件只记 upstreamHost、statusCode、requestBytes、responseBytes、durationMs、requestNumber。起不来或断连是 `MODEL_PROXY_UNAVAILABLE`，上游拒绝或超限是 `MODEL_UPSTREAM_REJECTED`；取消、超时、unknown、本地结束都关闭代理，关闭之后迟到的事件不覆盖已观测的本地退出。
- 隔离边界：Skill、Tool、Hook 共用同一条主机隔离边界——未信进程及其后代的文件读写、网络出口与进程信息都受限，只开放本次运行目录、固定 harness 的受信代码与依赖、明确的 CA 与回环端点；不能直接或经符号链接读 vault 或运行配置。没有受支持隔离适配器的系统以 `SANDBOX_UNAVAILABLE` 失败，不退回同用户任意执行。Hook 与 Tool 在同一 tool-host 子进程执行：十秒与 16 MiB 的返回上限、256 MiB 堆上限；Hook 按最多 200 个待核对象一批顺序执行，首个 block 即停；待核对象先按严格 schema 校验，主机命令行只按字面解析。
- 出口掩码：产物与事件对 run token、代理 nonce、模型密钥按字节替换，其余字节原样保留，记录 sanitized 并重算 SHA。掩码是最后一道，不是边界。
- worker 的排空与替换是合作式：收到替换请求的 worker 停止领取新活，已在途的领取可以做完再退出，不为赶升级期限强杀设备操作；替换只换进程，不动数据。独立部署的 worker 由它自己的进程管理器排空与替换，平台的替换请求标志不代表它已升级。

## 执行链在设备执行上的固定规则

执行链是通用的；它在「表格驱动设备执行」这类工作上的每一步规则如下。允许的设备方法、检查点种类、主机名集合、设备命名规则都是产品契约声明的闭集，内容在 packs，不进本标准。

### 核验

- 任务先核验后领取：平台用保留的原字节重新定位构建、解析完整命令路径与重载，重读工作簿全部设备命令（含初始化行），执行确定性的命令核对；missing、参数违规、不能证明的输入都是 failed。
- 关口只接受字面行：方法闭集由产品契约声明，闭集之外、输入变量、临时寄存器替换、模糊的调用与未验证的函数，一律 `INVALID_EXECUTION_WORKBOOK`，必须先展开成可核对的字面行；禁用的生命周期方法不放行。一次执行的分派条数有上限，设备索引再受当前设备数限制。
- 主机方法闭集来自资源声明与产品契约，主机命令按字面 shell 实参契约解释：多行整体为一个参数，单行只在引号外按逗号分隔，外层引号去掉，关键字参数只许契约声明的键。输出寄存器保留供后续检查点，输入寄存器替换禁止。闭集可由批准的 Hook 用资源声明里的允许主机集合收窄，省略或空数组沿用产品契约；运维也可用主机命令策略按主机收窄（精确命令名单、字节与超时上限、是否允许多行）——收窄不扩展，策略随运行配置钉入目标身份，改变后旧批准失效。角色没有已验证映射的主机方法明确拒绝，不按名称推断。
- 错误定位形状固定：row（从 1 起）、autoid、object、method，非字面单元格另带列；整本格式错误对应字段为 null。不回显主机命令与寄存器内容。

### 派发与两次环境观察

- 投递前平台强制重新取回当前命令原件并再核对一次，结果必须与批准的树和命令证明一致；随后取资源租约，做环境核对（构建、设备数、就绪），不满足就拒绝投递。不自动换构建、换测试床或初始化设备。
- 环境观察（`execution.environment.observed`，observationSource 为提交前的环境自检）只证明提交前那一刻的外部核对；资源随后可以再做它自己的环境与契约核验，第一次 passed 不覆盖第二次的拒绝，第二次的原始理由原样保留。

### 设备归属与日志解析

- 工作簿里的设备序号按设备管理地址在配置里的顺序确定，设备名不是排序依据。有序地址的来源按优先级取：环境自检回报的有序地址字段、拓扑的绑定地址集、拓扑设备的名字规则；前两个只在实际返回时使用。第三个来源成立的条件：全部设备名符合产品契约的命名规则、序号集合与设备数精确一致，且每条日志的地址唯一落在对应设备的接口地址集合里。名称任意、序号缺失/重复/越界、地址归属不唯一，都不归属：对应设备步 unknown、unmapped=device_map_unavailable。不据任意主机名或命令文本猜设备序号；共享地址不归属任何设备，也不推进任何设备的命令游标。
- 解析按设备推进命令游标：同一条命令跨设备或在同一设备重复出现，各有自己的日志区间；拿不到命令只让对应步骤 unknown。每个检查点只由明确的日志帧与工作簿行匹配，数量、模式、方法、时效或用例身份不匹配就是 unknown/unmapped。整案结论不扩大为逐步结论：整案通过不证明每一步通过；任务 status=succeeded 不等于测试全部通过；缺失证据交付 partial。主机方法的日志按主机名匹配，与设备索引是两条独立路由。

---

本文是 circle-hub 的设计规范之一，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权：引用、借鉴须署名 Circle Hub 与 qingshanfeihu 并注明原始出处链接。见[设计规范索引](README.md#许可)。
