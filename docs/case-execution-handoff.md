# FAMX 工作簿执行交接

> **历史文档**（2026-10-21 标注）：本文描述已退役服务器的原生用例执行路径，只作记录保留；第一个里程碑不做设备执行。现行范围见 [Hub r4 简报](hub-r4-brief.md)。

> 历史接口记录：0.2.0 已退役本文的内置 famx-case-execute 入口与 cases.* worker。新执行使用独立产品模块及 module-execute；旧任务、制品和回执只读保留，不自动改绑。当前边界见 [执行流设计](design/execution-flow-packs.md) 与 [客户端交接](client-api-handoff.md)。

本页是 FAMX 原生执行路径的变更记录与操作说明。通用规则已并入设计文档，见下表；工作簿字面闭集、框架主机名、参数与设备命名约定仍暂留本页，待执行流迁入独立产品包时一并移交。裁剪对照见 [handoff 到设计文档的对照表](design/handoff-map.md#case-execution-handoffmd)。

| 通用规则 | 设计出处 |
|---|---|
| 变更集、默认运行不审批、executionIsChange | [审批与执行链](design/approvals-and-enforcement.md#生产设备要两人规则怎么办) |
| 角色、Tool minimumRole、来源 readers 与资源策略 | [角色登记与资格披露](design/roles.md#角色登记与资格披露) |
| 核验、派发前复核与两次环境观察 | [核验](design/approvals-and-enforcement.md#核验)、[派发与两次环境观察](design/approvals-and-enforcement.md#派发与两次环境观察) |
| unknown、独立核对与远端租约 | [未知的纪律](design/approvals-and-enforcement.md#未知的纪律)、[派发前拒绝与远端租约](design/approvals-and-enforcement.md#派发前拒绝与远端租约) |
| 原件、外部来源、SHA 与证据 | [B 的原件与证据规则](design/object-standard.md#四b-的原件与证据规则) |
| 凭据、HTTPS、明文例外与 worker 排空 | [凭据与资源](design/approvals-and-enforcement.md#凭据与资源) |
| 实现升版、登记与历史方法绑定 | [技能包与模块的登记契约](design/product-line-pack.md#技能包与模块的登记契约) |
| 设备归属与结果解释 | [设备归属与日志解析](design/approvals-and-enforcement.md#设备归属与日志解析) |

## 版本与验收记录

原生能力包为 `famx-case-execute/1.1.1`，flowVersion 仍为 `famx-case-execute/1`，实现目录为 `packs/famx/execution`。它消费既有网关的 HTTP JSON-RPC 服务，不调用 `init_device`，不在 hub 中导入或运行旧客户端、SyntheticReference 或 Python。`1.0.0` 升到 `1.1.1` 时 implementationSha256 已变化，部署者须据 GET `/v1/packs` 的实际 version/flowVersion/implementationSha256 登记并批准新的 `hub-tool-implementation/1` 方法资产；旧任务的 methodAssetId 不自动迁移。产品线模块按自身冻结字节与 flow 绑定，此次原生升版不要求其自动重批。

A3 通用驱动轮的原生 `1.1.1` 字节保持不变；它不表示 FAMX 已切换到新的通用执行流，迁移边界见 [执行流迁入产品线包](design/execution-flow-packs.md)。本代理只做合成资源的本地核验，未部署或访问真实系统；用户决定验证栈 `7420` 仍保持 `e1ca68d`，不因本轮或本页更新自动升级。

早期接入记录曾为「只完成合成网关验收，真实网关上游核验不可达，等待恢复与凭据登记」。后续维护者已报告真实网关冒烟与用例投递；早期阻塞不能当作当前可达性结论，合成验收也不能替代真实工作簿或设备结果。具体运行观察保留在 [阶段进度](server-s2-progress.md)，本页不为历史观察补判设备结论。

## 原生提交操作

先上传 `case.xlsx`，或引用当前身份可读的编译 artifact，再提交：

```json
{
  "scopeId":"<授权 scope>",
  "title":"执行已编译工作簿",
  "idempotencyKey":"<本次投递的唯一键>",
  "capabilityPackId":"famx-case-execute",
  "input":{
    "sourceRevisionId":"<上传返回的 src id>",
    "sourceSha256":"<上传返回的 SHA-256>",
    "gatewayAssetId":"<测试床网关资产 id>",
    "methodAssetId":"<批准后的方法或 product-line 模块资产 id>",
    "commandSourceAssetId":"<构建来源资产 id>",
    "build":"<版本工具返回的 buildId>",
    "platform":null
  }
}
```

sourceRevisionId 与 artifactId 二选一。sourceSha256 可省略，由 server 钉住；module 可选，只接受字母/数字/下划线/连字符；deadlineMs 默认一小时、范围 1000–3600000。build 优先用 buildId，构建名必须唯一，可用 platform 消歧。工作簿必须是单表「执行」、隐藏行一精确标记 `FAMX_EXCEL_CONTRACT | famx.excel.runtime | v1` 和九列执行契约；第一阶段两表七列结构工作簿不可执行。

命令核对可绑定上传的外部来源：分别 POST `/v1/sources` 上传命令 XML 和函数契约 JSON，再 POST `/v1/assets` 登记 kind=knowledge-source。configuration.schema=`external-source-artifact/1`，metadata 为 `{packageId:"famx",buildName:"<预期构建名>",platform:"<可选平台>"}`；两份 files 的 role 分别为 command-tree、function-contract，各带 path/sourceRevisionId/sha256。完整配置示例见 [通用外部来源制品](client-api-handoff.md#通用外部来源制品)。批准后生命周期响应及 GET `/v1/assets/{assetId}` 顶层返回 sourceArtifactId（sar_ id），绑定来源的 versions 返回同一 buildId。buildsite.command_heads/param/check 的 build 填 sar_ id；执行 input.commandSourceAssetId 填该来源 assetId，build 填 sar_ id。绑定读取的 origin=uploaded-artifact、live=false 是来源标识；上传者的 buildName 仍是预期关联声明。

FAMX 消费者解析 XML 与函数契约 JSON。函数契约资料包含完整、唯一的 e/f/status 条目；FAMX 产品关口只有 enabled 才满足，disabled/internal/absent 均拒绝并定位工作簿行，此判定由已批准的产品线 Hook 执行；树与函数契约 SHA 记录在 command-check.json 及执行绑定中。主机、方法与设备树的治理规则随已批准模块与资源声明生效，hub 的解析器不在零 Hook 时补内置主机白名单；旧运行文件中的策略不能被当成新资源声明的授权。下面保留的是原生 `1.1.1` 的产品输入兼容资料，不另定通用平台默认规则。

## FAMX 字面契约与框架路由

设备对象为 `FAMX_n` 或 `Segn_tmp`，字面方法为 cmd/cmd_config/cmds_config/cmd_enable；check_point 的产品方法为 found/not_found/abs_found/found_times，time 对象支持 sleep。初始化行也参与设备命令核对。输入变量、设备命令中的临时寄存器替换、模糊 execute 与未验证的设备函数需先展开；原生格式拒绝返回 `INVALID_EXECUTION_WORKBOOK`。禁用生命周期方法不因函数原件中出现同名条目而获得执行资格。最多 5000 条显式设备/主机分派，设备索引再按网关 device_count 核对。

此前已核对的客户端主机方法名单为 clientc/clientd/cliente/routera/routerb/server213/server231/server232。E=test_env 时 F 是框架主机方法，G 是字面 shell，I 输入寄存器替换禁止，H 输出寄存器保留；主机直接作 E 时支持同类字面 cmd，模糊 execute 须展开。当前是否启用某主机，由函数契约、批准的 Hook 与资源 allowedTestHosts 声明核对，不从旧框架反射任意方法。console 虽可出现在函数契约中，其角色仍需床配置证据；该版历史关口因没有已验证角色映射而明确拒绝 console，不能按名称推断它是 DUT 或 SQL 主机。该资料只有只读契约结构，没有主机地址或框架代码。

G 的框架实参形式：多行整体为一个参数；单行仅引号外逗号分隔，外层引号去掉，kwargs 只允许 prompt/timeout，timeout 为 1–3600 整数。cmd_config 的换行按运行时规则去除后再核对。设备实际命令与测试主机 shell 分别列入完整 command-check.json；有执行变更集时，action.args.hostDispatch 披露数量、主机与摘要。shell 不作为 FAMX 命令树命中回执。

原生错误定位字段保留为 INVALID_EXECUTION_WORKBOOK.details 的 row（Excel 从 1 起）、autoid（当前用例头字符串）、object（E）、method（F），非字面单元格另带 column。初始化 autoid 为 null，整本格式错误不能定位的字段为 null；不回显 G 或 H/I 内容。同步拒绝与后台失败使用同一定位形状，运行时策略拒绝另带 policy 字段名。

历史 profile 支持按主机配置 hostCommandPolicies：allowedCommands 为解析实参后的完整命令精确名单（省略不限、空数组全拒）；maxCommandBytes 范围 1–16384；maxTimeoutSeconds 范围 1–3600，省略 timeout 的框架默认值为 10 秒；allowMultiline=false 拒绝多行。未配置策略时，不曾把 shell 程序名收窄到只有 dig：dig、curl、循环和测试主机状态命令都须按启用方法与字面原件核对。这些字段保留供旧运行配置维护；当前主机闭集与收窄策略的治理位置是已批准模块 Hook 与资源声明，不把仅存在于运行文件的值视为已批准。

既有网关 case_submit 冻结并运行原工作簿，框架按 E/F 派发。E=test_env/F=routera 调用 Env.routera，再按床配置 env.RouterA 找测试主机，通过 SSH 执行 G；routerb 对应 env.RouterB，其余启用方法对应其同名 env 配置项。F 是小写方法名，不能换成测试床任意标签或地址。H 捕获的返回可供后续检查点使用。FAMX_0/FAMX_1 分别取 comm.ssh_ips 顺序的第 0/1 台，设备标签不是排序依据；主机方法与 DUT 索引是两条独立路由。

重启步骤的既有核对结论仍保留：Env 没有 reboot，FAMX.reboot 在函数契约中 disabled；不能把 test_env/reboot 改成 routera/reboot 去重启测试主机。已核对的网关工具没有普通重启能力，init_device 是清空并重建基线，不能代替重启。相关用例保留未实现或需要决定的结论，删去步骤不能证明原用例完整通过。普通 DUT 生命周期协议的接入不在本页交接范围。

原生阶段与字段定位：核对操作名为 cases.verify；命令树 Hook 的拒绝码为 COMMAND_NOT_IN_TREE。执行变更集记录的 action.args 包含 build/buildId、treeSha256、commandReportSha256、commandCheckArtifactId/Sha256；commandReportSha256 是确定性证明摘要，commandCheckArtifactSha256 是完整 command-check.json 的字节 SHA。投递顺序为网关租约、env_prepare、case_submit；环境观察来源字段为 observationSource=gateway.env_prepare。通用执行链规则见页首设计链接。

## 仓库外配置与身份更正

CIRCLE_HUB_EXECUTION_GATEWAYS 指向仓库外配置。平台签发模式的网关资产 configuration.serviceClientId 配置与服务客户端登记、bundle/blob 操作见 [资源身份交接](resource-identity-handoff.md)。该模式不配外部 issuer、不登记个人刷新令牌。网关资产仍是 connector-instance，configuration 保留 `{packageId:"case-gateway",productLineId:"famx",runtimeProfileRef:"<配置引用>"}`，declaration.reads 包含 test-bed、writes 包含 device-config；底层写工具不直接暴露给模型。

以下是既有手工令牌会话兼容配置，所有占位由运维填写；采用平台签发模式时省略 issuer：

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

兼容 issuer 使用 POST `/token` 的 refresh_token grant；另一 CA 用 issuerCaFile/issuerCaSha256。CA 文件和 DER 指纹由用户或运维在运行时提供并核验。执行网关使用受信 HTTPS；资料源的明文例外不放宽执行网关或外部签发方，信任与轮换规则见 [凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。

历史手工会话登记教程仍适用已验兼容接口：POST `/v1/assets/{gatewayAssetId}/credentials`，value 为含 access_token、refresh_token、expires_at（Unix 秒）、scope 的 JSON 字符串，可含 server 供签发来源核对。返回 credential asset id 放入网关新修订 declaration.credentials，再批准并激活；应为 hub 单独授权会话，避免另一客户端消费同族刷新令牌。重新登录对 credential reference id POST `{version,value}`，引用与连接器修订不变。rotationPending、invalid_grant 及续期并发规则见设计；网关 503（含 introspect 上游不可达）对应 SOURCE_UNREACHABLE，401 对应 SOURCE_LOGIN_EXPIRED。

签发方更正记录：原网关实际信任的是 HTTPS 签发服务，与网关证书共享实验 CA，维护者确认本机可达；此前“明文 HTTP”来自旧客户端配置，不能描述网关现状。更正后，circle-hub 接管签发、旧服务退役的用户决定不变，无需为旧地址开放 HTTP 例外。地址、配置构建名、CA 原件与指纹值只保留在运行时；历史客户端配置或 healthz 样例标签都不是床实际构建的证据。

## 原生结果字段与设备归属记录

原生事件名为 execution.commands.rechecked、execution.gateway.submit-intent/submitted/status；交付 result.result 含 executionStatus/channel/rc、cases[{autoid,verdict,steps,checkPoints}]、logSpan、unmapped、parserVersion。制品为 command-check.json、gateway-results.json、execution-results.json；case log/sessions 留在网关原件。设备解析器版本为 framework-checkpoints/2，接收独立归属输入 `{environment,topology}`；worker 在已有租约内按需读 bed_topology(refresh:false)，与 env_prepare 一起存 gateway-results.json。

FAMX 检查点日志的四种组合为 Success/Fail × successed/fail，分别对应 found/not_found 的通过或失败；支持跨行模式，收尾重列不重复计数。设备行取去时间戳后的管理 IP 匹配 sends command；主机行按 test_env 主机名匹配 executes command。逐设备命令游标、logSpan 与缺映射时的处理规则见 [设备归属与日志解析](design/approvals-and-enforcement.md#设备归属与日志解析)，不再在此重复通用判定。

1.1.1 的归属来源更正记录：旧部署的 env_prepare 没有有序 IP，bed_topology 也不输出 applies_to——后者曾只是生成器输入，不能因设计列了候选就当成实际回报。原生解析按实际存在的字段取 conf.device_ips → applies_to.device_ssh_ips → topology.devices。前两项是有序地址，对应 FAMX_0、FAMX_1 等；第三来源要求 env_prepare.device_count，全部 type=负载均衡 设备的 name 匹配 `^FAMX([0-9]+)$`，数量和序号集合恰为 0..device_count-1。日志 IP 去 CIDR 前缀长度后在对应设备 ipv4 中唯一匹配；共享虚拟地址不归属任何设备，也不推进两边游标。第三来源的 deviceMap.source 为 gateway.bed_topology.devices。

conf.device_names 的边界仍适用：拓扑名字来自床配置；改成任意名字会破坏第三来源的完整 FAMX<index> 规则，不能由地址落在某设备 ipv4 中进一步猜 FAMX_n。维护者后续已报告 cexg **0.3.1** 实际部署、env_prepare 返回 conf.device_ips（conf 顺序）；收到该字段时走第一来源，不受 device_names 改名影响。没有实际返回有序字段时，仍受第三来源约束，不能补造地址。

运维记录：dev-stack 排空没有截止时间，消息抵达时已在途的 claim 仍可能做完一笔才退出；不强杀设备操作赶升级，单 worker 退出保留数据库。独立 worker 的 drain/替换由其部署管理器完成，CLI 标志不等于进程已升级；通用排空规则见 [凭据与资源](design/approvals-and-enforcement.md#凭据与资源)。
