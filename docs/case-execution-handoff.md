# APV 工作簿执行交接

能力包 `apv-case-execute/1.0.0` 使用既有 sources、submit、approvals、status、events、result 和 artifacts/content。实现归 packs/apv/execution，不导入或运行旧客户端、InfoTest 或 Python。现有网关只作为 HTTP JSON-RPC 服务消费；不会调用 init_device。

执行身份改用 [C 的资源客户端与短期令牌](resource-identity-handoff.md)：资源资产 configuration.serviceClientId，经独立批准后由平台在操作/fence 下私有注入，worker 每次请求前重核与临期重签。该模式不配置外部 issuer，不登记个人刷新令牌。规则原件由已批准 source-artifact 的 bundle/blob 提供，平台不解释；原网关的本地缓存仍由其管理。下面的旧手工会话说明仅保留既有已验接口兼容，用户当前部署不再接旧签发服务。

修订 3 的执行默认不审批。资源、runtime-profile、Tool/产品线模块和外部来源先由变更集批准；只有资源 declaration.executionIsChange=true 时本次冻结执行提交才再作为变更集项。Hook 按批准的模块装载，hub 自带零条；本页旧独立执行审批描述仅适用于这一资源声明。

先上传 `case.xlsx`，或引用当前身份可读的编译 artifact，再提交：

```json
{
  "scopeId":"<授权 scope>",
  "title":"执行已编译工作簿",
  "idempotencyKey":"<本次投递的唯一键>",
  "capabilityPackId":"apv-case-execute",
  "input":{
    "sourceRevisionId":"<上传返回的 src id>",
    "sourceSha256":"<上传返回的 SHA-256>",
    "gatewayAssetId":"<测试床网关资产 id>",
    "methodAssetId":"<批准后的 product-line 模块资产 id>",
    "commandSourceAssetId":"<构建来源资产 id>",
    "build":"<版本工具返回的 buildId>",
    "platform":null
  }
}
```

sourceRevisionId 与 artifactId 二选一。sourceSha256 可省略，由 server 钉住；module 可选，只接受字母/数字/下划线/连字符；deadlineMs 默认一小时、范围 1000–3600000。build 优先用 buildId，构建名必须唯一，可用 platform 消歧。必须是单表「执行」、隐藏行一精确标记 `APV_EXCEL_CONTRACT | apv.excel.runtime | v1` 和九列执行契约；第一阶段两表七列结构工作簿不可执行。

命令核对也可绑定通用外部来源制品。先分别用 POST /v1/sources 上传命令 XML 和函数契约 JSON 原字节，再 POST /v1/assets 登记 kind=knowledge-source；确切的 configuration 示例见 [通用来源交接](client-api-handoff.md#通用外部来源制品)。configuration.schema=external-source-artifact/1，metadata={packageId:apv,buildName:<预期构建名>,platform:<可选平台>}，files 中一份 role=command-tree、一份 role=function-contract，分别带 path/sourceRevisionId/sha256。另一人批准后，生命周期响应及 GET /v1/assets/{assetId} 顶层直接给 sourceArtifactId（sar_ id）；绑定来源调用 versions 也返回同一 buildId。buildsite.command_heads/param/check 的 build 填此 id；执行 input.commandSourceAssetId 填该来源 assetId，build 填 sar_ id。同一制品 id 也能绑定其他连接器工具，通用平台只管理原件和治理。

APV 消费者独立解析两份文件。函数契约数据需完整、包含唯一 e/f/status 条目，只有 enabled 才满足该关口；disabled/internal/absent 立即拒绝并给工作簿行定位。它不能使未实现的不透明函数、禁用生命周期或未确认 console 角色绕过现有执行限制。树与函数契约 SHA 同时进入 command-check.json、审批动作和投递前复核；源资产未批准、停用、修订或权限变化时不自动换源、不读取旧绑定作为新版本。

上传者声明的 buildName 是命令原件的预期关联，不代表测试床实际构建。当前床构建尚未确认，不采用历史客户端配置或 healthz 样例标签作为事实；运行时 env_prepare 必须确认构建，ready/build_checked 不满足则拒绝投递。绑定读取标 uploaded-artifact/live=false；XML 的命令存在性是脚本核对结果，真实设备行为仍以网关证据为准。

本版执行关口支持 APV_n/Segn_tmp 的字面 cmd/cmd_config/cmds_config/cmd_enable、check_point 的 found/not_found/abs_found/found_times、time.sleep。初始化行也受同一核对。输入变量、设备命令里的临时寄存器替换和模糊 execute/未验证的设备函数返回 INVALID_EXECUTION_WORKBOOK，需先展开成可核对的字面行。reboot 等禁用生命周期方法不放行。最多 5000 条显式设备/主机分派，按网关 device_count 再查设备索引。

test_env 的 F 是框架主机方法，不是 APV 命令头。闭集允许 clientc/clientd/cliente/routera/routerb/server213/server231/server232，G 为字面 shell，I 输入寄存器替换禁止，H 输出寄存器保留。引用的是用户给出的只读 Excel 函数契约结构，无主机地址或框架代码。可由已批准的产品线 Hook 使用 runtime allowedTestHosts 缩小该闭集，省略或空数组沿用专业契约；此设置进入目标身份摘要。主机直接作 E 的同类字面 cmd 分派也支持，模糊 execute 须展开。console 的角色以床配置为准，本版尚无已验证角色映射，明确拒绝，不能按名称推断它是 DUT 或 SQL 主机。

G 按框架实参契约解释：多行整体为一个参数；单行仅引号外逗号分隔，外层引号去掉，kwargs 只允许 prompt/timeout（timeout 为 1–3600 整数）。设备 cmd_config 的换行按运行时规则去除后再核对。设备实际命令与测试主机 shell 分开列入完整 command-check.json，审批 action.args.hostDispatch 带数量/主机/摘要；shell 不冒充 APV command_check hit，设备命令仍逐条由 server 核对。日志只在精确主机/命令派发行匹配时记 observed，不能据此推断协议内容或检查点已通过。

INVALID_EXECUTION_WORKBOOK 的 details 带 row（Excel 从 1 起的行号）、autoid（沿用当前用例头的字符串）、object（E）、method（F）；非字面单元格另带 column。初始化的 autoid 为 null，无法定位到具体行的整本格式错误对应字段为 null。不回显 G 命令、H/I 寄存器内容。同步提交拒绝和后台核对失败保留同一定位形状，运行时策略拒绝另带 policy 字段名。

默认不限定 shell 程序名，字面 dig、curl、循环和测试主机状态命令仍按启用的主机方法、工作簿原件及审批披露受理。运维可在网关 profile 的 hostCommandPolicies 中按主机显式收窄：allowedCommands 为解析实参后的完整命令精确名单（省略不限、空数组全拒绝）；maxCommandBytes 为字节上限（1–16384）；maxTimeoutSeconds 为 timeout 上限（1–3600，省略 timeout 的主机调用按框架默认 10 秒）；allowMultiline=false 拒绝多行。未配置策略时不增加命令/参数限制。策略不能启用未知或禁用方法；策略随 profile 钉入目标身份，改变后旧批准失效，投递前再次核对。所有策略和真实命令都在仓库外运行时配置，不由模型输入选择。

server 使用专业契约的主机方法闭集校验，不从客户端或旧框架反射出任意可调用方法。既有网关未因本次修复改动：case_submit 冻结并运行原工作簿，原 InfoTest 按 E/F 派发。E=test_env/F=routera 调用 Env.routera，再用框架床配置的 env.RouterA 找测试主机，通过 SSH 执行 G 的实际命令；routerb 同样映射 env.RouterB，其余启用方法对应其同名 env 配置项。F 使用小写方法名，不能替换成测试床的任意设备标签或地址。H 捕获的主机返回值可供后续检查点使用，返回值本身不证明检查点通过。

APV_0 与 APV_1 分别按床配置 comm.ssh_ips 的顺序取第 0/1 台，设备标签不是排序依据。绑定构建由 env_prepare 核对，device_count 再限制工作簿索引；真实标签与索引对应关系须从该床当前配置/拓扑核对，本代理未读取床配置或猜测映射。主机方法与 DUT 索引是两条独立路由。

本版不执行重启后配置保留步骤：Env 没有 reboot，APV.reboot 契约 disabled；不能把该行改成 routera 的 reboot 去重启测试主机。已核对的网关工具没有普通重启能力，init_device 是清空并重建基线，不能代替重启。涉及重启的用例应保留未实现/需要决定的结论，不能删掉步骤后声称原用例完整通过；后续需先有明确受支持的 DUT 生命周期协议，再独立绑定设备身份、审批与停止/恢复证据。

人的授权由范围角色及 Tool minimumRole 决定，保留来源 readers 和资源策略；机器兼容动作包括 tasks.submit/read、sources.read、methods.use、assets.read、credentials.use、builds.read。上传另需 sources.write，artifact 输入需 evidence.read。跨 tenant/scope 和不可见资产拒绝。原件 SHA 在受理、worker、server 读取、投递回执和结果再核对。同键/同输入重提返回同一任务；新键表示新的物理执行，仍走完整执行链；executionIsChange 资源另需变更集决定。

任务先进入 cases.verify。worker 从绑定来源读取构建列表和当前命令 XML，server 用保留的原字节重新定位构建、解析完整命令路径和重载，重读工作簿所有设备命令，包括初始化行，再执行确定性 command_check。missing、参数违规或不能证明的输入会失败，结果包含已装载 Hook 的原始 code/facts（APV 设备树 Hook 为 COMMAND_NOT_IN_TREE）；不会触碰网关。客户端或技能包的回执不是输入字段，伪造回执会被 schema 拒绝。

默认资源验证通过后直接领取执行租约；只有 executionIsChange=true 才进入 waiting-review。现有审批记录的 action.args 带构建名/buildId、treeSha256、commandReportSha256、commandCheckArtifactId/Sha256。commandReportSha256 是确定性命令证明摘要；commandCheckArtifactSha256 是完整 command-check.json 原件的字节 SHA。审批人可下载 artifact 核对，申请人不能自批。默认一天，可配置审批期限；改输入、资产修订、目标运行配置或 CA 身份使旧批准失效。

满足当前执行链与资源声明要求后，worker 在投递前强制重新获取当前 XML，server 再核对一次，结果必须与批准的树和命令证明一致；普通查询的旧 XML 缓存不能放行。server 持久化与当前操作/fence 绑定的复核记录，一次性消费后才授权 submit intent。随后取网关租约，env_prepare 核对绑定构建、设备数和 ready，再 case_submit。不会自动换构建、换测试床或初始化设备。

运行时配置都在仓库外：CIRCLE_SERVER_EXECUTION_GATEWAYS 指向以下文件（所有占位均需由运维填写）：

```json
{
  "profiles":{
    "<配置引用>":{
      "endpoint":"<网关 HTTPS /mcp URL>",
      "issuer":"<既有令牌签发服务 origin>",
      "caFile":"<本机已核验 CA 文件>",
      "caSha256":"<CA DER 字节 SHA-256>",
      "timeoutMs":60000,
      "pollMs":2000
    }
  }
}
```

issuer 使用 POST /token 的 refresh_token grant；若签发服务使用另一 CA，配置 issuerCaFile/issuerCaSha256。远端私有请求要求 HTTPS，HTTP 只给回环合成验收。每次请求重读并核对配置指纹，拒绝重定向，不关闭全局 TLS 校验。需要由用户或运维先提供并核验 CA；server 不从未验证连接自动建立信任。

上述 issuer 字段仅保留既有手工会话兼容，通用 OAuth 登记可供其他来源使用（见 client-api-handoff）。当前执行部署已由用户选择 C 自身资源签发模式，不登记外部 issuer 或个人刷新令牌。用户更正环境事实：网关原实际签发方使用 HTTPS，与网关证书共享同一实验 CA，本机可达；先前“明文 HTTP”来自旧客户端配置，不能作为网关现状。环境更正后，circle-server 接管签发、旧服务退役的决定保持不变，无需 HTTP 例外。原地址、配置构建名、CA 原件及指纹值只在运行时保留。

网关资产是 connector-instance，configuration={packageId:"case-gateway",productLineId:"apv",runtimeProfileRef:"<配置引用>"}，declaration.reads 包含 test-bed、writes 包含 device-config。该连接器不把底层写工具直接暴露给模型，执行只走能力包。资产独立审批并激活。

网关凭据按个人、按实例登记：POST /v1/assets/{gatewayAssetId}/credentials，value 是包含 access_token、refresh_token、expires_at（Unix 秒）、scope 的 JSON 字符串；可含 server，用于检查签发来源。值只写入私有加密 vault，不回到响应、事件、审计或仓库。将返回的 credential asset id 放进网关新修订 declaration.credentials，批准后激活。为 server 单独授权一份会话，避免另一个客户端同时消费同族刷新令牌。

重新登录时可向同一路径的 credential reference id POST {version,value}，仅所有者、当前修订且未停用可替换，仍不返回值。替换与自动刷新共用同一单写者锁，引用/连接器修订不变，避免未知任务因换引用而丢失原目标绑定；审计只记 id/version。它不会重新投递任务，恢复后仍由另一 worker 做独立只读核对。独立核对未见终态或回报不完整时，仅核对操作 failed，原任务继续 unknown、资源仍冻结。

访问令牌临近到期由单写者刷新，并原子持久化新访问/刷新令牌。并发运行重读同一最新值，不重复消费旧刷新令牌；invalid_grant 标失效，明确 5xx 保留原凭据。请求中断或成功结果不完整时保留 rotationPending，停止重放并要求重新登记，避免旧令牌重放撤销整族。网关 503（含上游 introspect 不可达）是 SOURCE_UNREACHABLE；401 才是 SOURCE_LOGIN_EXPIRED，不弹密码框。

事件包含 execution.commands.rechecked、execution.gateway.submit-intent/submitted/status。submitted 持久保存 remoteTaskId、原件 SHA、用例身份及 fence；worker 保持 C 和网关两层租约。result.result 返回 executionStatus/channel/rc、逐 cases[{autoid,verdict,steps,checkPoints}]、logSpan、unmapped、parserVersion；artifacts 包含 command-check.json、gateway-results.json、execution-results.json，可按 SHA 下载。原始 case log/sessions 在网关原件中保留。

每个检查点只由明确日志帧与工作簿行匹配：四种 Success/Fail × successed/fail 对应 found/not_found；支持跨行模式，收尾重列不重复计算。数量、模式、方法、日志时效或用例身份不匹配时 unknown/unmapped。命令步骤仅在明确且唯一的派发行出现时 observed；整案 PASS 不证明每一步 PASS，静态回放也不替代框架判定。用例 fail 可以是已成功交付的执行结果；任务 status=succeeded 不等于测试全部通过。缺失证据交付 partial。

超时、lost、worker 断开或投递后取消转 unknown，资源冻结，后续新投递 RESOURCE_BUSY，不自动重新 case_submit。旧 fence 的回报拒绝。取消前未派发的任务关闭审批并 cancelled；本地取消不证明远端停止。已有 remoteTaskId 时，由另一 worker 经原身份只读 case_status/results 独立核对，终态与工作簿 SHA 对上后 reconciled、交付并解冻；没有 remoteTaskId 的投递断线不能自动恢复，必须先在网关侧对账，不能盲重投。

当前只完成合成网关验收。真实网关上游核验不可达是环境阻塞，待用户/运维恢复并登记个人凭据后再做真实投递；真实 case.xlsx 由用户上传，未以合成结果冒充上机通过。

修订 3 的 static-secret 模式与明确的 HTTP 资料源例外见 [客户端交接](client-api-handoff.md#修订-3凭据模式隔离与明确的明文例外)。执行网关仍要求受信 HTTPS；资料源的明文例外不放宽网关或外部签发方。主机闭集、设备树与自毁核验由批准的产品线 Hook 决定，解析器不会在零 Hook 时补一份主机白名单。Scope 访客只能读取；没有 credentials.use 管理/直接使用权限，获准的只读 Tool 由 worker 代取自身绑定凭据。普通成员执行仍不审批，executionIsChange 资源继续用冻结变更集。
