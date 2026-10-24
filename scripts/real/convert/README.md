# 离线接入转换

这些 TypeScript 命令由集成者对只读副本运行，不联网、不读取环境或凭据，不执行发布命令。必须指定仓库外的 `--out` 暂存目录；符号链接指向仓库也拒绝。新文件权限为 0600，不覆盖已有文件。标准输出只含个数、声明的 JSON 指针、SHA-256，以及检查完成的接入文档最后一行的发布命令（固定名 runner-contract、bed-topology、runtime-profile）。发布前切换到暂存目录，集成者核对后自行执行该命令。失败退出非零；不会把源数据或底层异常打印到终端。

```
node scripts/real/convert/check-runtime-contract.ts <合约副本> --expect <网关钉住的摘要> --out <暂存目录>
```

合约通过 case-compile 原格式解析器重算身份，输出保留原字节。`--expect` 由集成者从部署网关只读获取，不从本地副本自证，不在脚本中预设。打印摘要为原字节摘要，合约自己的规范摘要仍保留在文档中。

真实动作由集成者运行。本分支只有下述合成全链路和离线管理脚本测试，没有真实联机或上机结果。

```
node scripts/real/convert/bed-topology.ts <网关原始 RPC 回答> --definition <执行器定义> --out <暂存目录> [--read-index 0] [--capture-index 0] [--bed-name <明确台架标识>]
```

从执行器定义读取 capture_pointers；read-index 0 是主只读核对，1 起对应 precheck_reads，capture-index 选择其中的指针（默认均为 0）。不猜字段名。原始 JSON-RPC/流式回答先用派发公开的同一解码器读取，再按该指针取值、调用核心 RFC 8785 摘要函数；标准输出同时打印指针、原件字节摘要和规范内容摘要。请求号变化只影响原件摘要，内容没有变化时规范摘要不变。指针下必须包含拓扑、服务和观察，派发核对同一指针才覆盖这三者。管理员把打印出的内容摘要登记进对应只读核对条件；已有常量摘要不符则拒绝转换，要求重新采证并更新定义。

选中内容是含 `topology.devices`、`topology._bed.conf`、`services` 和 `observation.unregistered_neighbours` 的完整回答。源中文设备标签只在转换表中出现一次；设备名、服务主机名和台架名转小写，撞名拒绝。`_mask_assumed` 为真、地址没有前缀、未知标签、重复地址、缺服务或邻居观察均拒绝。保留地址只来自 IPv4 ARP 邻居观察，只保留本台架设备接口网段内的邻居，逐项变成单地址范围，重复观察合并；网段外邻居仅记到私有 topology-accounting.json，屏幕打印排除个数。服务源协议只按一张表转换：http、https → tcp，dns → udp；表外整份拒绝，指出服务序号与 proto 字段。屏幕打印这三类服务个数、保留与排除个数。清单必须同时通过 test-bed 和 case-compile 的解析器；不借助管理地址推断接口，不填默认网段。topology-accounting.json 另留两个摘要和所选指针，便于管理员登记时逐项核对。

```
node scripts/real/convert/runtime-profile.ts <环境预检回答> <清单> <合约副本> --out <暂存目录> [--decisions <角色决定文件>]
node scripts/real/convert/runtime-profile.ts <填写后的配置> <清单> <合约副本> --check --out <新暂存目录>
```

预检须明确 `ready: true` 和正整数 `device_count`。草稿的版本、合约摘要、台架名、设备数来自输入；全部合约启用组合都进入覆盖核对，候选、内部和禁用组合不加入；零参数方法先待明确决定，不能传入凭据的方法列为未开。参数角色、工作簿字面量、座位顺序、主机映射、等待上限、折叠名单和拒绝表不能从签名推出，用 `null` 与 `pending` 的缺失事实和补取动作表示。集成者填写后清空已经落实的 `pending`，再次 `--check`。发布用通过检查的 `runtime-profile.json`；不要发布 `.draft.json`。

可选角色决定文件为 `{ "allowed": […], "unopened": […] }`。`allowed` 每项包含 `{object, method, parameters: {参数名: 角色}}`，可另带本转换器核对的 `unsupplied` 可选参数名单；角色只读包格式表，不按函数名猜。无法归入现有角色的组合放 `unopened`，每项 `{object, method, parameters: [{name, missing, reason, next}]}`，写明哪个签名参数缺什么事实、为什么现有检查无法覆盖、下一步怎样另开包角色和检查任务。可选脱敏参数不传入、不定角色；其他未定角色参数先写 null。零参数方法不自动开放，必须在 allowed 项明确写 reviewed:true 或选择带方法级事实说明的 unopened；所有待填项落实前不能发布。

检查先证明全部启用组合恰好落在 allowed 或 unopened 一边，不重不漏、无禁用组合；allowed 的每个可能传入的参数都有包表角色，显式永不传入的可选参数按 unsupplied 核对，再调用包的配置解析器核身份及形状。额外核对座位序号小于预检设备数。只说明已启用组合的覆盖情况，不以草稿代替部署事实核对；拒绝命令文本由集成者填写，不在脚本预设。

```
node scripts/real/convert/auto-cases.ts <脑图原件> --out <暂存目录> [--case-rule marked] [--profile <运行环境配置>] [--autoids <逗号分隔的编号>]
```

先调用包公开的 normalizeMindmap，再用核心 KityMinder 解析后直接调用包的 extractCases，case_rule 默认 marked，也可显式 tagged，必须与计划运行一致。不给 `--autoids` 时，只选 auto 文字恰好为 YES 的五个，保留文档次序；不是五个则报实际数量并停止。给了 `--autoids` 就只选这些编号：每个都必须在 auto 正好为 YES 的集合里、与原件文字精确相等、互不重复，数量必须是 5；输出仍按文档次序，不按参数里的次序，并在 auto-cases.json 记下「选择来源：集成者显式列出」。缺失、重复或不精确的 autoid 拒绝。输出 auto-cases.json 含规则、编号列表及规整前后摘要，标准输出仅个数、变换条数和摘要。集成者先只读确认脑图是否已有平台文档号，再按任务页绑定；本脚本不猜文档号、不上传。

输入必须是 KityMinder JSON，或本工具两种规整能还原成它的原件（文件头两个 U+FFFF、单元素数组包装）。敏捷平台的原始应答信封 `{code,msg,data}` 不能解包：解包 data 不在这两种变换里。Hub 的敏捷平台系统包对 `agile:mindmap` 另存了 content 制品，那才是内层 KityMinder JSON。应当喂 content 制品，不要喂 original。`circle-hub original list` 只列出读取时收到的 original，导不出 content 这个名字。先让资源读出制品摘要，再按摘要导出：

```
circle-hub resource read <资源> mindmap <文档键>
circle-hub original export <产物 content 那一行的摘要> --out <仓库外文件>
```

`resource read` 的屏幕行是 `产物 content <摘要> <字节数> 字节`。把导出的文件交给本命令。不要把 original 的摘要交给 `original export`。

探测只由执行器定义声明，不放进 runtime-profile。6a125df0 的 profile probes 扩展及旧草稿脚本已撤回，case-compile 的同版本字节回到工作簿分支的基线。执行器定义的 version/interfaces 两项形状由 dispatch-gateway 分支确定；它合并以后再接 probes.ts，当前没有猜造兼容形状或跳过测试。

## 管理派发脚本（只由集成者运行）

```text
node scripts/real/accept/device-run.ts --config <暂存配置> --out <仓库外批次目录> --executor <exe_…>
```

本分支没有运行这条真机入口。它只运行显式配置的 Hub 管理 CLI，不调 MCP、不填槽、不生成或上传工作簿、不占台架、不设置时长、不续租。Circle 会话按 SKILL 完成每例独立占用、计划、修复、生成、上传及核验；终态后也由 Circle 经 test-bed 释放。本脚本逐例等集成者输入核验运行号和“确认派发”，核对唯一 autoid、固定部署文档、清单摘要、计划与占用前驱。第一例释放后停止；后四例须先更新执行器定义，并输入“已用首例证据更新认证”。这一步是人工确认，不是机械核对认证字段；dispatch-gateway 的认证字段合并以后再换机械核对。

配置是仓库外 JSON，相对文件路径以配置所在目录为准：

```json
{
  "cli": { "command": "circle-hub", "arguments": [] },
  "definition": "executor.json",
  "selection": "auto-cases.json",
  "contract": "runtime-contract.json",
  "inventory": "test-bed-manifest.json",
  "profile": "runtime-profile.json"
}
```

CLI 必须指向待验收的同一部署，管理员身份由集成者按现有 CLI 方式提供；配置不接受密钥或模型参数。三份文档只打印 `doc put` 行，固定发布名 runner-contract、bed-topology、runtime-profile；集成者先发布检查通过的原件，再由 Circle 按这三个名字绑定。不要发布带 pending 的 profile 草稿。执行器先由管理员登记；其证明声明须填写 `proof.warrant_id` 为当前包核验函数的完整身份（从已发布包的检查声明及回执核对），不把目录或引文函数当工作簿证明。

第零步按 `ExecutorDefinition` 补默认值后用核心 RFC 8785 算摘要，与 `executor list` 对给定编号打印的摘要逐字比较，并要求 HTTPS、固定 CA、启用且登记齐全。每次更新执行器后重跑；派发前再核一次，过程中变更就停止。本脚本不自称机械核过“只有运行权限”，该核对由 dispatch-gateway 承担。

原始命令回答先写私有 0600 文件，再解释；标准输出仅阶段、码、摘要、命令提示及逐用例结论（限定信息按结果源原样保留）。结果源里的 side_effects 块原样输出，当前旧派发实现的 executor_declarations 块也原样保留为声明。没有日志标记不推断没发生。批次目录保存检查点：派发前先记 pending，收到预留作业摘要立即落盘；中断后同一目录只允许 `job resume` 查原作业，不重发。未知或冻结不释放、不进入下一例，明确给出管理员对账动作。终态结果按原件摘要、作业与 autoid 再核一次；等 Circle 提供本例释放运行号并读回租约后才继续。

## 合成验收与依赖

`tests/acceptance/28-device-run.test.ts` 使用真实 Hub、临时 PostgreSQL、回环 Messages API 脚本化模型和回环网关；包经自带 pack-files staging 后走真实注册器；合并 trunk-fixes 后，客户端源码与发布清单都在 tools/，转换和验收统一导入这一布局，暂存保持原字节。此前 scripts → tools 映射布局下直接发布源码目录会缺 tools，属于当时的验收搭法问题，未修改包清单来绕过。覆盖三份文档、预检、独立占用、模型被驳回后修复、在客户端子进程运行发布包 tools/generate-workbook.ts、上传核验、顺序派发及释放；额外启用方法与另一台设备地址通过；原件单字节修改在核心解析边界被拒，另外可解析但内容不一致的工作簿在包核验被拒；缺工作簿不能派发；丢回执冻结、管理员对账后只读继续。

逐台探测、按请求记录自动恢复、带阶段的未上机拒绝、副作用日志标记等验收仍依赖 dispatch-gateway；没有提前写跳过占位。当前合成结果不能认证真实网关、设备或结果归属。


首段开发时的本机合成验证（历史快照）：全链路 6、管理脚本离线单测 13、转换 24、派发包全量 57，均通过、零跳过；类型检查零错误，生成物核对 68 文件一致。全仓词表扫描 16 项中 15 通过、1 失败：命中的是接手前就存在的 8 处（knowledge 的 lists/read/test-support/views、runs/engine/submit、server/tools），均未被本分支修改；没有加例外或为它们改越界文件，交集成者与各包主人清理后重跑。没有真实台架结论。

部署发布检查要求 synthetic 显式为 false；允许设备命令或主机 shell 时，对应拒绝表必须非空。拒绝表文字由集成者从部署规则补取，覆盖决定 35 的整机命令类别；非空只证明提供了筛查文字，不自证其完整性。缺哪一类会指出 denied/device 或 denied/host 和补取后重跑 --check 的动作。

未完成的 runtime-profile 草稿只打印计数和摘要，绝不打印 doc put。集成者补齐草稿事实并运行 --check 后，只有通过的 runtime-profile.json 才打印发布命令。

参数覆盖按能实际传入的参数核对：可选脱敏参数默认不传，不给角色；普通可选参数只有在该 allowed 项的 unsupplied 名单里显式声明永不传入时才可省角色。必需参数不能列入名单，名单不许重复、含签名外参数或与角色重叠。包原有的参数绑定/角色核对会拒绝实际传入这些参数。必需脱敏参数及只有脱敏参数的方法保持未开，草稿明确认证接入的缺口与补取动作。

零参数启用方法也等待集成者显式决定：草稿不自动放进 allowed，pending 指出缺方法语义和效果事实。明确开放可列为 {object,method,parameters:{},reviewed:true}；明确未开则用 parameters:[]，另填方法级 missing、reason、next。没有决定时，即使删掉 pending，完整覆盖核对也不能通过。

用例选择与计划运行同一抽取规则：任何抽取用例含不精确数值编号即拒绝；每个入选编号必须在全部抽取用例中只出现一次，不只比五个 YES。传 --profile 时按同份配置的 workbook.autoid_pattern 核对入选编号；未提供配置时不声称核过网关的编号位数，集成者在计划前应带同份配置重跑。

原脑图先走同一份 normalize-mindmap.ts 的公开规整：仅去掉头部两个 U+FFFF、转换单元素数组包装。选用例使用 case-source.normalized.json 那份字节，仅作本工具的私有核对副本；另存变换说明及规整前后摘要。交给 Circle 的是原始导出文件，由 Circle 按 SKILL 运行 normalize-mindmap.ts；集成者把 Circle 输出的 before_sha256 与本工具 sha256、after_sha256 与 normalized_sha256 逐项比较，一致后在上传说明保留原件摘要和“客户端规整”说明。不要把本工具的规整副本当原始输入交给 Circle，否则会丢失原件摘要和变换说明。屏幕只加变换条数和规整摘要，不显示原件内容；无法规整时明确要求补取原件并重跑该工具。

解析器拒绝时逐项打印安全字段指针、固定问题类别和下一步，原始问题消息里的源值不进屏幕。源台架标识仅转小写仍不合清单格式时，管理员可显式给 --bed-name（1–64 位小写字母、数字、连字符）；不自动删扩展名或改符号。topology-accounting.json 私有保存原标识、清单标识及是否显式映射，供管理员核对执行器和清单；原观察的两个摘要不受映射影响。输入文件不可读、JSON 损坏和暂存输出已存在也分别指明补件、重导出或更换新目录的动作。

转换入口比较实际文件路径，支持从软链接工作树调用；输入缺失时仍非零退出，不能无输出地假成功。作为模块导入不会执行 CLI。

首轮复核合成验证：转换脚本 37 项、管理脚本回归 13 项，共 50 项通过、零跳过，类型检查通过。八条均先补改前失败的回归，再修正通过；没有执行真实入口或触碰真实系统。


决定 40：草稿与配置检查共用 case-compile 的 tables/dispatch-roles.json，派发方式精确匹配，参数角色只能从对应行取；不按方法名推断。角色列表为空的组合自动列 unopened，缺失事实与下一步原样取该表，即使 reviewed:true 也不能开放。requires_method_review 为真的方法及所有零参数方法，在草稿 allowed 项的 reviewed 指针留下 pending，说明内部动作没有经过角色与拒绝表核验，并要求集成者逐个只读审阅后显式决定。只保留决定文件中的布尔 true，不自动补 true；角色齐全不代表方法已经审阅。选择不开放则列 unopened 并填完整事实、原因和下一步。reviewed 字段名从 runtime-profile-format.json 的 method_review_field 取，--check 同时核对该决定并调用包的 parseProfile；删除 pending 不能绕过审阅。此决定是集成者的开通声明，不证明真实设备上的内部动作安全。

决定 40 的本机合成回归：新增三条先失败后通过，转换脚本 40 项、管理脚本 13 项、真实 Hub 配临时 PostgreSQL 和回环假网关的全链路 6 项，共 59 项通过，零失败、零跳过；类型检查通过，69 份合约生成物一致，case-compile 包清单摘要新鲜。全链路夹具同步显式审阅声明，并按当前发布包版本登记核验函数身份，避免沿用旧版本身份。没有运行真实入口或接触真实系统。

收尾诊断：runtime-contract 与 runtime-profile 使用包解析器给出的固定原因，保留安全字段指针（含 reviewed）和修正动作；dispatch/status/kind 的格式缺口要求核对并另开格式表任务，摘要不符则补取网关钉住的合约及摘要。清单解析器的源值仍不显示在终端；完整问题列表保存到 --out 下的 parser-diagnostics.json（0600，不覆盖），请集成者私下核对该记录后重跑。转换器不通过匹配异常消息猜原因。


另一家族第 12 条：逐用例输出原样保留结果源的 missing_fact、missing_facts、reason、next_action、qualifier（nature/provenance/marks）、accepted_as_fact 和 limits，不用脚本写死的建议覆盖具体动作。无判定行只要求已存的 missing_fact 或 missing_facts，以及 limits 中的“未排除本地操作”限定；reason、next_action、qualifier、accepted_as_fact 等补充元数据有则原样抄，没有不补造，也不据此阻断当前派发服务的结果。缺少必需缺口或限定时，点名字段，要求管理员核对派发服务版本与原作业记录、修复结果导出后重读，保留检查点且不重发。批次结束或重读已完成批次时，重新导出每份结果原件，核对字节摘要、作业、工作簿摘要和用例身份后，逐份汇总实际限定信息；不从固定标签推导。仅作离线管理脚本回归，没有运行真实入口。
