# 离线接入转换

这些 TypeScript 命令由集成者对只读副本运行，不联网、不读取环境或凭据，不执行发布命令。必须指定仓库外的 `--out` 暂存目录；符号链接指向仓库也拒绝。新文件权限为 0600，不覆盖已有文件。标准输出只含个数、声明的 JSON 指针、SHA-256，以及三份接入文档各自最后一行的发布命令（固定名 runner-contract、bed-topology、runtime-profile）。发布前切换到暂存目录，集成者核对后自行执行该命令。失败退出非零；不会把源数据或底层异常打印到终端。

```
node scripts/real/convert/check-runtime-contract.ts <合约副本> --expect <网关钉住的摘要> --out <暂存目录>
```

合约通过 case-compile 原格式解析器重算身份，输出保留原字节。`--expect` 由集成者从部署网关只读获取，不从本地副本自证，不在脚本中预设。打印摘要为原字节摘要，合约自己的规范摘要仍保留在文档中。

真实动作由集成者运行。本分支只有下述合成全链路和离线管理脚本测试，没有真实联机或上机结果。

```
node scripts/real/convert/bed-topology.ts <网关原始 RPC 回答> --definition <执行器定义> --out <暂存目录> [--read-index 0] [--capture-index 0]
```

从执行器定义读取 capture_pointers；read-index 0 是主只读核对，1 起对应 precheck_reads，capture-index 选择其中的指针（默认均为 0）。不猜字段名。原始 JSON-RPC/流式回答先用派发公开的同一解码器读取，再按该指针取值、调用核心 RFC 8785 摘要函数；标准输出同时打印指针、原件字节摘要和规范内容摘要。请求号变化只影响原件摘要，内容没有变化时规范摘要不变。指针下必须包含拓扑、服务和观察，派发核对同一指针才覆盖这三者。管理员把打印出的内容摘要登记进对应只读核对条件；已有常量摘要不符则拒绝转换，要求重新采证并更新定义。

选中内容是含 `topology.devices`、`topology._bed.conf`、`services` 和 `observation.unregistered_neighbours` 的完整回答。源中文设备标签只在转换表中出现一次；设备名、服务主机名和台架名转小写，撞名拒绝。`_mask_assumed` 为真、地址没有前缀、未知标签、重复地址、缺服务或邻居观察均拒绝。保留地址只来自 IPv4 ARP 邻居观察，只保留本台架设备接口网段内的邻居，逐项变成单地址范围，重复观察合并；网段外邻居仅记到私有 topology-accounting.json，屏幕打印排除个数。服务源协议只按一张表转换：http、https → tcp，dns → udp；表外整份拒绝，指出服务序号与 proto 字段。屏幕打印这三类服务个数、保留与排除个数。清单必须同时通过 test-bed 和 case-compile 的解析器；不借助管理地址推断接口，不填默认网段。topology-accounting.json 另留两个摘要和所选指针，便于管理员登记时逐项核对。

```
node scripts/real/convert/runtime-profile.ts <环境预检回答> <清单> <合约副本> --out <暂存目录> [--decisions <角色决定文件>]
node scripts/real/convert/runtime-profile.ts <填写后的配置> <清单> <合约副本> --check --out <新暂存目录>
```

预检须明确 `ready: true` 和正整数 `device_count`。草稿的版本、合约摘要、台架名、设备数来自输入；所有合约启用组合都会列出，候选、内部和禁用组合不加入。参数角色、工作簿字面量、座位顺序、主机映射、等待上限、折叠名单和拒绝表不能从签名推出，用 `null` 与 `pending` 的缺失事实和补取动作表示。集成者填写后清空已经落实的 `pending`，再次 `--check`。发布用通过检查的 `runtime-profile.json`；不要发布 `.draft.json`。

可选角色决定文件为 `{ "allowed": […], "unopened": […] }`。`allowed` 每项沿用包的 `{object, method, parameters: {参数名: 角色}}`，角色只读包格式表，不按函数名猜。无法归入现有角色的组合放 `unopened`，每项 `{object, method, parameters: [{name, missing, reason, next}]}`，写明哪个签名参数缺什么事实、为什么现有检查无法覆盖、下一步怎样另开包角色和检查任务。脱敏参数不能定角色。未决定的组合仍列在草稿里，参数角色为 null，不会自动启用。

检查先证明全部启用组合恰好落在 allowed 或 unopened 一边，不重不漏、无禁用组合；allowed 每个参数都有包表角色，再调用包的配置解析器核身份及形状。额外核对座位序号小于预检设备数。只说明已启用组合的覆盖情况，不以草稿代替部署事实核对；拒绝命令文本由集成者填写，不在脚本预设。

```
node scripts/real/convert/auto-cases.ts <脑图原件> --out <暂存目录> [--case-rule marked]
```

核心 KityMinder 解析后直接调用包的 extractCases，case_rule 默认 marked，也可显式 tagged，必须与计划运行一致。只选 auto 文字恰好为 YES 的五个，保留文档次序；不是五个则报实际数量并停止。缺失、重复或不精确的 autoid 拒绝。输出 auto-cases.json 含规则及编号列表，标准输出仅个数与源字节摘要。集成者先只读确认脑图是否已有平台文档号，再按任务页绑定；本脚本不猜文档号、不上传。

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

原始命令回答先写私有 0600 文件，再解释；标准输出仅阶段、码、摘要、命令提示及逐用例结论（总带“未排除本地操作”）。结果源里的 side_effects 块原样输出，当前旧派发实现的 executor_declarations 块也原样保留为声明。没有日志标记不推断没发生。批次目录保存检查点：派发前先记 pending，收到预留作业摘要立即落盘；中断后同一目录只允许 `job resume` 查原作业，不重发。未知或冻结不释放、不进入下一例，明确给出管理员对账动作。终态结果按原件摘要、作业与 autoid 再核一次；等 Circle 提供本例释放运行号并读回租约后才继续。

## 合成验收与依赖

`tests/acceptance/28-device-run.test.ts` 使用真实 Hub、临时 PostgreSQL、回环 Messages API 脚本化模型和回环网关；包先经自带 pack-files staging 把源码 scripts 原字节映射到发布 tools，再走真实注册器。直接发布源码目录会缺 tools，属于验收搭法问题，未修改包清单来绕过。覆盖三份文档、预检、独立占用、模型被驳回后修复、在客户端子进程运行发布包 tools/generate-workbook.ts、上传核验、顺序派发及释放；额外启用方法与另一台设备地址通过；原件单字节修改在核心解析边界被拒，另外可解析但内容不一致的工作簿在包核验被拒；缺工作簿不能派发；丢回执冻结、管理员对账后只读继续。

逐台探测、按请求记录自动恢复、带阶段的未上机拒绝、副作用日志标记等验收仍依赖 dispatch-gateway；没有提前写跳过占位。当前合成结果不能认证真实网关、设备或结果归属。


本轮本机合成验证：全链路 6、管理脚本离线单测 13、转换 24、派发包全量 57，均通过、零跳过；类型检查零错误，生成物核对 68 文件一致。全仓词表扫描 16 项中 15 通过、1 失败：命中的是接手前就存在的 8 处（knowledge 的 lists/read/test-support/views、runs/engine/submit、server/tools），均未被本分支修改；没有加例外或为它们改越界文件，交集成者与各包主人清理后重跑。没有真实台架结论。
