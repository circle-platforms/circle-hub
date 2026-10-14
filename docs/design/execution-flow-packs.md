# 执行流迁入产品线包

本文是待维护者复核的迁移设计，不是已经可用的装载能力。本轮三个事项中的执行流迁移只授权设计，尚未授权代码实施；维护者复核通过并确认实施后才写验收和代码。本轮不移动执行代码、不改网关、不改独立产品包。

目标是让 `packs/apv/execution` 的产品解释和流程选择由独立仓库的 `products/apv` 拥有，同时保留 hub 对权限、批准修订、派发、租约、未知结果与证据的控制。产品包提供纯函数 Tool 和 Hook；网络、凭据、数据库与任务推进仍由 hub 执行。装入第二条产品线时不添加产品专用 controller 或 worker 分支。

本设计沿用[产品线包典范](product-line-pack.md)、[harness 原语规范](harness-primitives.md)及[审批与执行链](approvals-and-enforcement.md)。不增加 REST 路由、权限类型、Hook 挂点或事件接口。

## 现有装载器能做什么

`packages/modules/src/verify.ts` 校验 `modules.json` 的完整文件集、逐文件 SHA、清单身份和模块 digest；`Modules.install` 将产品线模块的原件交给 B，登记为 `knowledge-source` 资产并生成变更集。登记不代表批准。

`ProductModules.load` 从批准的来源制品取出冻结文件，核对 `product-line/1` 的 `tools[]`、`hooks[]`、`flows[]` 与 `resources[]`。`ProductModules.call` 经 `callFrozenTool` 在受限 Tool 子进程内调用声明文件的导出函数。相对 import 必须留在冻结文件集中；外部依赖必须在对应文件的 `tools[].imports` 中声明，并与 hub 支持的精确版本一致。`node:*`、hub 源码、任意依赖和计算出来的 import 均被拒绝，错误码为 `IMPORT_NOT_DECLARED`。

当前装载器没有运行完整执行流的能力：`flows/*.json` 只是被解析的数据，`ToolProviders.resolve` 只按 `flow.id` 找到模块并返回绑定；`CaseExecution` 仍在 hub 进程中注册 `cases.*`、执行 SQL、生成凭据注入并推进任务；worker 仍直接调用 `executeCases`。现有 `products/apv` 已有工作簿读取 Tool 和 Hook，但这不代表 controller、worker、结果解释已由模块接管。

因此不能把现有 `controller.ts`、`worker.ts` 换一个目录后直接 import。它们使用的数据库、文件系统、保险箱与网络能力超出 Tool 边界。必须先拆分产品纯函数和通用驱动器，再经同一个模块装载路径运行。

## 代码与语义归属

| 现有内容 | 迁入产品包 | 留在 hub |
|---|---|---|
| `workbook.ts`、`function-contract.ts`、`dialect.ts` | 工作簿结构、函数契约、对象和参数解释 | 原件读取、SHA 核对、字节与解压上限的通用设施 |
| `environment.ts` | 构建字段解释、设备映射来源和可证边界 | 取环境回报、冻结原始返回、核验来源与绑定 |
| `results.ts` | 日志归属、逐步与检查点解析、未映射原因 | 保存原始结果与解释产物；不给整案结论冒充逐步事实 |
| `refusal.ts` | 特定框架文本和旧协议的解释 | 是否已派发、是否可证未派发、失败或 unknown、冻结与释放的最终判定 |
| `controller.ts` | 输入语义、产品阶段转换、选择哪些 Tool 与交付项 | 受理、幂等、修订、批准版本解析、操作登记、提交意图、事务、任务状态和变更集 |
| `worker.ts` | 产品调用顺序、参数构造、终态语义、结果解释 | MCP 传输、端点和 CA、密钥注入、两层租约与心跳、fence、取消、超时、回报 |
| `contracts.ts` | 产品输入与输出结构、流程版本、公开能力描述 | 原语登记和受控装载；验证 effect、角色和资源声明 |
| `migration.ts` | 不进入可执行产品模块 | 已部署迁移保持字节不变；旧表只为旧任务保留，新持久状态由通用驱动器管理 |

hub 的通用驱动器不识别 APV 对象、命令树格式、Excel 标记、设备命名规则或框架日志正则。产品 Tool 不接收数据库事务、保险箱引用、访问令牌、模型密钥、可调用的原始节点地址、运行 profile 的端点或 CA 文件路径。

这个边界不能破坏格式解析所需的事实。环境和日志原始证据的原字节由 hub 保管，SHA 不因脱敏投影变化；hub 按本次绑定和权限，把必要事实或受控字节输入交给环境 / 结果解析 Tool。需要建立“日志地址 → 设备序号”的关系时，投影必须保留一一对应的地址标识，不能将两边分别抹除或替换为同一个占位符。若给出授权范围内的日志字节，Tool 可读取其中的地址文本用于确定性解析，但它没有网络能力，不能将地址变成连接目标。公开返回仍按现有脱敏边界处理并保留原始证据引用。

## 产品包布局与 import 边界

沿用 `products/<line>`，在现有清单中登记执行所需的 Tool，不新建另一种模块：

```text
products/apv/
  product-line.json
  tools/
    execution-contracts.ts
    execution-transition.ts
    environment.ts
    results.ts
    refusal.ts
    workbook.ts
    function-contract.ts
    dialect.ts
  hooks/
    device-command-tree.ts
    host-destructive.ts
    host-policy.ts
    workbook-contract.ts
  flows/apv-case-execute.json
  resources/case-gateway.json
  tests/
```

Tool 文件均列在 `tools[]`，每个文件自己的外部依赖由该条目的 `imports` 声明；相对依赖一起冻结。散列使用沙箱提供的 `crypto.subtle.digest`，不引入 Node 内建模块。现有依赖集、进程堆上限、输入输出字节上限及批次预算继续适用；产品包不能声明更高权限来扩大它们。

`modules.json` 的 `files` 和 `digest` 覆盖全部模块字节，包括 Tool、Hook、流程、资源声明与测试。Tool 不能从正在变化的包工作树读取文件，也不能从未列入目录的路径加载实现。包作者负责修改和发布独立仓库；hub 只实现装载与验收，不复制独立包中的真实原件或业务配置。

## 待实现的内部驱动契约

这是复核后需要补齐的通用能力，不是当前 flow JSON 已有的字段。保持 `product-line/1` 和 `circle-packs/flow/1` 的原语身份，明确 flow 对已声明 Tool 导出函数的引用及输入输出结构；语义变化升级流程版本，不能靠清单的宽松字段静默生效。

产品的 transition Tool 是一个确定性状态转换：输入为冻结绑定、产品状态、当前输入以及已留存且可核对的观察；输出为下一份产品状态和一批待执行动作。它不能直接改任务 phase、执行 RPC、写入证据或批准资产。出入参使用 JSON 和冻结字节，状态不能藏进进程全局变量。字段形状、允许的动作类型和大小上限在实现前作为内部契约确定并用 schema 校验。

通用驱动器只解释有限的动作类型：调用本模块声明的纯 Tool、向已绑定 provider 调用其 `provides` 中声明的 Tool、等待已登记操作的观察、请求既有 Hook 核验、提出带固定错误码的结果或交付候选。产品流程所需的操作登记、等待、提交意图及状态更新仍由 hub 完成。流程不能让 hub 执行任意 JavaScript、SQL、shell、URL 或新 Hook。

每次 provider 调用都重新核对角色、provider 的已批准声明、Tool 的 effect / minimumRole、冻结参数摘要、当前输入修订与资源身份。产品不能将写 Tool 标成 read，也不能通过参数指定另一个端点、资源或凭据。资源模板是声明样例；管理员实际登记并批准的资源版本才是运行绑定。

通用 driver 持久记录状态与每步动作身份；步骤幂等键由任务、输入修订、冻结方法和步骤身份共同生成。已经持久化的写派发意图不因 worker 退出或 Tool 重启被重复执行。任何不符合内部协议的 Tool 输出都在下一次副作用前被拒绝。

## 租约、拒绝与未知结果

hub 继续维护操作租约、fencing token、资源冲突和 worker 的领取授权。远端租约是网关返回的另一层租约，由通用资源调用器维护；产品 Tool 可以解释公开回报，但不能取得令牌、跳过心跳或替 hub 执行释放。

只读效应超时为 `failed + UPSTREAM_TIMEOUT`，不冻结资源。写效应的派发结果不可证时为 unknown，不重派；同资源有 unknown 写时保持冻结。任务取消只证明本地取消，远端停止另记事实。

派发前的明确拒绝需要来自绑定 provider 的原始回报，并满足已核对的协议事实：未返回远端任务身份、未报告已派发、拒绝阶段可证在派发之前。产品的旧框架文本解释保留原始回报引用，hub 不因 Tool 自报 `noDispatch` 就解除 unknown。若协议不能证明未派发，保守记录 unknown；反过来，也不把所有环境阶段拒绝猜成 `BUILD_MISMATCH`。码无法证实时沿用 `GATEWAY_REFUSED` 并披露原始原因。

已知派发前拒绝和已观察终态按现有语义释放远端租约，并记录释放是否成功；不确定派发、runner lost、取消或超时不伪称远端已停止。reconcile 使用原操作身份、独立 worker 和原始回执，不通过新产品版本重放写动作。

D 的可证终态必须先独立持久化，再交给产品 Tool 解释。远端任务身份、绑定的工作簿 SHA、终态回报和释放事实一旦被核实，parser 抛错、超时、超限、返回无效协议、缺设备映射或 `afterResult` 解释失败只能影响解释结果：解释失败、partial 或具体步骤 unknown。它们不能把已证执行终态改为 D 的派发 unknown，不能冻结资源，不能触发另一次 `case_submit`；修复后的纯 Tool 可针对同一份冻结原件重新解释，不重新上机。若终态本身不能核实，才按上一段保留 unknown。

当前原生 controller 的成功回报处理中，结果 parser 或 `afterResult` 抛出的 `ApiError` 仍会因已有 submit intent 被捕获成 unknown。这是迁移时必须修正的边界；本轮仅记设计，不修改现有实现。

## Hook 与结果解释

五个挂点保持 `verify.deviceCommand`、`verify.hostCommand`、`verify.workbook`、`beforeDispatch`、`afterResult`，入出参不另定。三个 verify 挂点的 `binding.resource` 仍包含批准版本的 `assetId / version / sha256 / declaration`；主机闭集与策略来自资源声明，由产品 Hook 判定。

环境和结果 Tool 只输出有来源的观察。设备归属保持优先读取有序 `env_prepare.conf.device_ips`；取不到时产品按其支持的拓扑字段建立可证映射。日志行只能在被证明属于本设备或主机的序列中匹配；共享地址、缺字段、重名或无法排序留下未映射项。整案 PASS 不扩大为逐步 PASS，静态重放不替代框架检查点。

原始环境、拓扑、状态、结果、日志与会话字节由 B 按 SHA 留存；解释 Tool 的输出也是独立产物，带所用模块、Tool、流程和原始证据的摘要。hub 校验任务与工作簿身份、原件 SHA、远端任务身份和终态观察，再推进交付。产品结果不能覆盖原件、修改旧证据或把模型判断写成设备事实。

本迁移不扩展已经冻结的事件投影。已有事件只带批准的元数据与引用，正文沿用 result / content 回读路径。

## 方法版本、摘要与批准修订

现有原生 `apv-case-execute` 版本为 `1.1.1`，流程为 `apv-case-execute/1`。它的 `implementationSha256` 是 hub 内选定实现文件与依赖源码的摘要，不能直接等同于独立模块 digest。

模块迁移采用新的实现版本。模块 digest 仍按 `modules.json` 定义计算；执行实现摘要由版本化的算法从执行相关 Tool 的相对依赖闭包、所用 Hook、流程定义、入口映射及所用 hub 精确依赖版本构造。算法和文件列表本身须被冻结，不能取运行时目录最新字节。一个用于模块完整性，一个用于执行实现身份，两者同时留存，不混用；摘要算法变化也升级实现版本。

批准沿用 `knowledge-source` 模块资产的变更集，不另加一次“执行流审批”。冻结的方法绑定至少包含已有方法字段及模块身份：`methodAssetId`、资产版本与 SHA、模块 digest、能力 id、实现版本与摘要、流程版本、所调用 Tool 的冻结路径与导出函数。来源、资源和输入修订继续分别冻结。批准的是整份资产摘要，执行只核验批准事实。

新受理解析最新可用的 approved / running 修订，存在多个可用实现时要求显式绑定，不能依赖 SQL 返回顺序。草稿登记不改变已批准实现；新批准版本可供新任务选择，但不修改旧任务的绑定。运行中按冻结 pin 读取该历史批准修订，旧修订仍可用就继续；旧修订停用或其批准摘要不再成立才停止新的派发，已派发后的不确定结果仍按 unknown 处理。

这是设计提出时的缺口：`ProductModules.load` 及 `SourceArtifacts.snapshot` 原先沿 `assets.current_version` 取原件，不能仅保存 `methodAssetId` 后每次读 current。A1 已补内部精确批准 pin 读取；指定资产版本与 SHA 可锁住历史批准修订，不指定 pin 则取该资产最新 approved / running 修订，同时重核当前权限与 readers。后续驱动器仍须把冻结 pin 持久绑定并传给装载入口，不能因新草稿或模块安装而让已派发任务改读新 parser；原生旧任务路径未迁移。

## 现网任务的迁移路径

1. 先实现通用驱动与冻结历史修订入口，以合成产品线证明可运行。保留原生 1.1.1 兼容驱动，新驱动不接管旧操作。
2. 包作者在独立仓库登记执行 Tool 与新版 flow，更新 `modules.json`。管理员经既有模块安装入口冻结文件，独立审批人批准；配置文件存在不代表可运行。
3. 对新提交显式选新版模块资产作为 `methodAssetId`。新方法摘要、流程版本或资源声明不同，就重新生成输入修订及操作绑定；不复用旧 command gate、派发意图或 execution-submission。
4. 已受理、已派发、unknown 和待核对任务继续使用原 methodAssetId、原实现摘要及原回执表。历史任务和 evidence 保留原版本；不改数据库把它们“迁移成功”。需要改方法的未派发任务由申请人明确修订或重新提交。
5. 原生兼容驱动在没有待执行、在途、unknown / reconcile 任务前不移除。若先停用旧实现，任务返回真实缺少实现或批准的错误，不回退到新版写设备。未知历史必须保留可读回执和独立核对能力。
6. 最后由维护者确认退役原生入口与文件；旧 migration 20 及后续已部署迁移不改字节。旧回执表可只读保留，新通用持久状态通过新增迁移建立，不让产品包携带可执行 SQL。

本轮标识改名已采用冻结兼容口径：`EXECUTION_GATEWAYS` 的旧 lookup 在 hub 内部集中适配，编译器 creator 的旧字符串暂时保留，原生 Execution `1.1.1` 与既有实现摘要不变。执行流正式迁入模块时再升级实现版本并修改这些冻结字节；设计复核前不执行迁移。旧任务不改数据库重绑。

## 实现顺序与验收

复核通过后先写验收，再实现每个边界；针对性用例由实现方跑，全套由维护者在独立工作树跑。所有网络资源、工作簿、日志和模型均为合成，不投递真实设备。

| 阶段 | 必须证明的结果 |
|---|---|
| 纯 Tool 拆分 | APV 工作簿、环境、结果解释输出与冻结回归一致；没有 Node / hub import；声明外 import 装入时拒绝 |
| 通用驱动 | meridian 的独立 flow、状态转换 Tool、资源模板、五个 Hook 经同一模块安装与变更集运行；不新增产品分支 |
| effect 和调用边界 | 未声明 Tool、越权资源、参数改端点、把 write 降为 read 均在派发前被拒；模块看不到任何令牌和密钥 |
| 持久步骤 | 在每个意图/回报边界中断，重启后不重复写派发；旧 fence 迟到被拒；相同输入幂等复用 |
| 失败和 unknown | 只读超时不冻结；原始派发前拒绝 failed 并释放；尚无可证终态时，带远端 task id / 已派发事实或不确定断开保持 unknown 不重发；已证终态正常释放，释放失败如实记录 |
| 终态与解释隔离 | 已证终态后分别注入 parser 抛错、超时、超限、无效协议、缺映射和 `afterResult` 失败：`case_submit` 只调用一次，资源 `frozen=false`，终态与释放事实仍可读；只重算冻结原件，解释失败不变成派发 unknown |
| 绑定修订 | 草稿不影响新旧运行；批准新版仅供新受理；旧方法、来源或资源失效阻止新派发；旧操作不会换 parser 或方法 id |
| 结果证据 | 双设备同命令各自匹配；一台缺命令仅该步 unknown；映射缺失、共享地址和检查点歧义保留未映射；逐案、逐步、检查点分开 |
| 变更集 | executionIsChange 的冻结提交只消费一次；默认资源直接执行链；产品包不能自行批准或绕过 Hook |
| 双产品交替运行 | APV 与 meridian 具有不同对象/回报形状；两份模块分别冻结、批准、停用，同一 hub 核心与合成 MCP 网关支撑两者 |

meridian 现有 `tools/project.ts`、五个 Hook、`flows/fixture.json` 与资源夹具只有装载验收，不足以证明执行流迁移。后续将其扩成完整合成执行流程，至少覆盖准备、派发、终态与未知核对，使用自己的命令与结果格式；同一套驱动器也完成 APV 流程。验收必须断言 APV 旧入口未参与 meridian 运行，不能只检查清单能加载。

本文的主体迁移设计及 A2 契约已获维护者复核通过。A3 已授权，只用 Meridian 与另一份完全合成模块证明通用驱动，不实施 APV 新产品代码；B 产品执行流迁移由独立包负责，C/D 尚未授权。旧任务仍不改数据库重绑。

## 附录 A2：有界 transition 内部契约

`packages/contracts/src/execution-transition.ts` 提供 schema factory，由 F 的 index 在共享 ID、SHA、散列与错误定义初始化后实例化导出。文件仅依赖 zod，不反向 import B、D、E。`ExecutionTransitionAssetPin` 的字段与 A1 的 `AssetRevisionPin` 同形：`{assetId, version, sha256, digest?}`；资产身份不另定义。方法 pin 另带能力 id、流程版本和执行实现摘要。此处只定义和验证数据，不注册驱动器、HTTP 路由、Hook 或能力，不改变原生 `1.1.1` 的字节与摘要。

输入为 `{schema, binding, currentInput, state, observations, controlledBytes}`，输出为 `{schema, state, actions}`，schema 固定为 `hub-execution-transition/1`。binding 带 taskId、inputRevisionId、inputSha256、method pin 及按键命名的 resource / source pin。currentInput 为 `{value, sha256}`：value 由 C 按本任务不可变 inputRevisionId 读取、核对归属和权限后注入，`canonicalHash(value)` 必须同时等于 currentInput.sha256 与 binding.inputSha256。自报值和摘要相等只证明内部一致性，不证明它属于该修订；后续驱动器必须向 C 重核，不能信任客户端自配的摘要。工作簿在输入中使用 B 原件引用，不把全文塞 JSON。state、当前输入 value、facts、args、subject 与结果候选只能是有限 JSON；不接受 NaN / Infinity、undefined、BigInt、函数、class / Date / Map 实例、循环、稀疏数组、符号、访问器、原型键或 JSON 序列化会丢掉的属性。产品不能借状态修改 hub phase。

所有动作的顶层对象严格校验，都带 `stepId / occurrence`；同一输出内不能重复这个步骤身份：

| kind | 专属字段 | 后续驱动器必须核验的边界 |
|---|---|---|
| `tool.call` | `path, export, args, byteSlots?` | 路径与相对依赖属于冻结模块的 `tools[]`，导出可用；受控槽存在且只读授权原件 |
| `provider.call` | `resource, tool, args, byteArgs?` | resource 来自本次冻结绑定，Tool 在批准 provider 的 provides 中；实时权限、effect、minimumRole、输入 schema 和摘要均成立；byteArgs 参数由授权 B 原件填入，不能覆盖 args |
| `operation.wait` | `operationId` | 原操作属于本任务 / 当前修订，读取原观察，不重新提交写动作 |
| `hook.verify` | `event, subject` | event 仅五个现有挂点；继续用现有 `validateHookInput` 核对精确 subject，由 hub 注入批准 binding |
| `outcome.error` | `code, facts` | code 已登记；事实可回到冻结原件；不能据产品自报决定 D unknown 或冻结资源 |
| `delivery.propose` | `status, result, references` | status 只有 succeeded / partial；候选结果和 B 引用都经证据与交付项核验，不直接交付 |

上述对象不提供 endpoint、凭据、密钥、CA、effect、fence、批准决定或冻结指令字段。`args` 仍可包含合法的产品数据和日志字符串，A2 不用危险禁词推测其语义；schema 合格不代表允许派发，A3 才根据已绑定 provider 的输入结构和执行链核验实际动作。Hook 的有界 JSON subject 同样不是允许任意形状派发。

`provider.call.byteArgs` 是可选的 `{参数名: slot}`。例如 `{payload_b64:"payload"}` 只声明对应原件槽，不让模型或 transition 复制 base64。参数名非空，符合普通 JSON 键预算，排除控制字符与 `__proto__ / constructor / prototype` 这类原型注入键；合法的实际参数名称仍由 provider 的 inputSchema 决定。byteArgs 与 args 有同名字段即拒绝，驱动器不能覆盖原参数。普通 args 中超过 32 KiB 的 base64 与其它长字符串一样拒绝，不通过 byteArgs 扩大普通 JSON 预算。真正派发前由 hub 从 B 按当前权限、批准来源 pin 和 SHA 读取原件，填入对应参数，再核对 provider 输入结构及完整 wire；读到原件并不等于获得运行权限。

observations 为 `{operationId, reference, facts}`。原件 reference 是四种严格形状之一：sourceRevisionId / artifactId / evidenceId / recordId，加 kind、sha256、size；没有客户端下载 URL。controlledBytes 的每个槽为 `{slot, role, encoding:"base64", reference, contentBase64}`，slot 唯一，base64 必须规范，解码长度与 reference.size 一致，原字节 SHA 与 reference.sha256 一致。role 对应模块需要的原件角色；A3 还必须核对这些引用属于已批准来源的原件清单、满足当前授权、且字节确实由 B 读取。客户端自己构造一份 SHA 正确的 JSON 不能获得原件权限。

受控日志字节可以包含解析所需的地址文本；纯 Tool 没有网络能力，不能把它改成节点连接目标。若采用脱敏 facts，环境与日志的设备标识必须仍能一致匹配。observations.facts 中出现 `terminal`、`pass` 等字符串也只是一份待解释数据；D 终态须由 hub 对绑定 provider 的原始回报、原操作、工作簿与远端任务身份核实并持久化，不能由客户端或产品 Tool 自证。解析失败不改变这个已证终态。

下表是授权输入清单，不是新的产品专用 schema。role 由模块声明，hub 将对应 B 引用及必要字节放到受控槽；只有 hub 重核后的 facts 才能作为执行链事实，合同字段合格不代替核验：

| 消费者 | 可接收的授权 B 原件 | 必要事实与排除项 |
|---|---|---|
| 环境解析 Tool | env_prepare、bed_topology 的冻结返回 | 任务 / 输入修订、冻结方法 / 来源 / 资源 pin、绑定工作簿 SHA、远端任务身份（若已存在）；构建与设备映射所需的原始字段或一致脱敏标识。没有凭据、网络端点、CA 文件路径或可调用句柄 |
| 结果解析 Tool | case_submit / case_status / case_results 原始返回、每案 log / sessions、工作簿；需要解释核对时可按角色读 command-check 原件 | 任务 / 修订、远端 id、工作簿 SHA、冻结 pin，以及 D 独立核实并持久化的终态、远端租约释放事实；缺失字段留下未映射。sessions 在本批未覆盖，不宣称其原始形状已验收 |
| transition Tool | 上述 B 原件的引用与已核对事实；确需格式解释时显式选择受控字节槽，command-check 不内嵌进 state | 步骤身份、冻结绑定、原操作观察、D 终态 / 租约状态。只提出动作和解释候选，不取得密钥、租约 token、端点、CA 或 provider 对象 |

步骤 key 由 hub 派生为 `canonicalHash({taskId, inputRevisionId, methodPinDigest, flowVersion, stepId, occurrence})`，其中 methodPinDigest 是冻结方法 pin 的 canonicalHash，flowVersion 必须与该方法一致。产品不能指定原始 key 或自行跳到另一 occurrence。请求摘要另覆盖 frozen binding（包括 inputSha256）与 action（含 args），参数变化不能通过把 argsDigest 放进 key 变成另一笔写操作；currentInput.value / sha256 也不掺进 key，修订身份由 C 维护不变性。重复 key 的异内容由后续持久驱动器以 `IDEMPOTENCY_MISMATCH` 拒绝；A2 只提供两种散列的合同函数，没有建立步骤存储或派发入口。

`executionTransitionRequestHash(binding, action, byteBindings?)` 的第三参可提供仅引用的 `{slot, role, reference}`，也兼容完整 controlled entry；有正文时仍核对规范 base64、解码大小和 SHA。provider.byteArgs 与 tool.byteSlots 引用的每个槽都必须在其中；重复槽、缺槽、错 SHA 或总量超现有 8 MiB 上限拒绝。散列加入所用槽的 role 和 reference（kind、原件 id、sha256、size），不加入 base64 正文；同名槽换原件会改变 requestHash，未用且合法的槽不改变它。后续驱动器从授权 B 查询得到仅引用的绑定即可计算散列，不必把大原件送进 transition；客户端自己声明的 ref 不因此变成已授权原件。step key 的组成保持不变。

### 驱动注入形状

以下是当前 A3 驱动给 transition 的实际注入形状，不是新的 HTTP 提交体。入口仍收 [FlowSubmission](../../packages/execution/src/flow-contracts.ts)，[C 构造完整 frame](../../packages/execution/src/flow-driver.ts) 后，[worker 作为一个参数调用 transition](../../packages/execution/src/flow-worker.ts)。纯 Tool 不从环境读取配置，也不接收 worker 的 provider、凭据或租约对象。

| 字段 | 当前来源与消费方式 |
|---|---|
| `currentInput.value` | C 冻结的**整份 FlowSubmission**，包含 flowId、methodPin、resources、sources、value、controlledBytes 及可选 deadlineMs。产品自定义值位于 `input.currentInput.value.value`，不是直接位于 `input.currentInput.value`。其 SHA 同时绑定 currentInput.sha256 / binding.inputSha256 |
| `binding.resources` / `provider.call.resource` | resources 是提交中按别名登记的资源 pin；动作的 resource 填该别名，例如 `bed`，不是 assetId、URL 或 provider 对象。C 解析实际批准的资产与运行配置，逐次核权限、完整协议工具角色及 effect |
| `state` | 模块 flow.initialState 起始、产品上次输出的 state 后续持久化；不是 Hub 任务 phase。产品不能在 state 内创建或恢复 D 租约 |
| `observations` | C 保存的 `{operationId,reference,facts}`。facts 带 stepId/status/result 等已记录字段；用逻辑 stepId 定位观察后保留其 operationId，不能用工具名、数组下标或虚构 id 替代原操作关联 |
| `expectedOccurrences` | Hub 按当前任务/修订的持久步骤计算 `{stepId,nextOccurrence}`。新 step 从 0 起；已完成连续 occurrence 才允许下一项。产品按 [occurrence 核验](../../packages/execution/src/flow-occurrences.ts) 提案，不能跳号、使用保留的 `hub.` stepId 或靠换 occurrence 重派 unknown 写 |
| `controlledBytes` | B 授权原件的 slot / role / reference / 规范 base64。Tool 动作的 byteSlots 按声明顺序解码并追加到 args 尾部，成为实际字节参数；不是路径或可联网句柄。provider.byteArgs 按参数名映射槽，在派发时由 Hub 填入 base64 |

下面的完整 frame 使用合成占位 pin；它展示字段与摘要关系，不是批准记录或可直接运行的资源配置。currentInput 的摘要与整份 value 的 canonicalHash 一致；payload 的原字节 SHA 和 17 字节长度也一致。实际 frame 只能由 C 注入，不能从这个示例复制身份来取得权限。

```json
{
  "schema": "hub-execution-transition/1",
  "binding": {
    "taskId": "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "inputRevisionId": "inrev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "inputSha256": "f6abf0fd6ebbde51ccbe34c18865e60a5fa65e0c8f19c0583744af963cbbe764",
    "method": {
      "assetId": "ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "version": "1.0.0",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "capabilityPackId": "synthetic-flow",
      "flowVersion": "synthetic-flow/1",
      "implementationSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    },
    "resources": {
      "bed": {
        "assetId": "ast_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "version": "1.0.0",
        "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    },
    "sources": {
      "payload": {
        "assetId": "ast_cccccccccccccccccccccccccccccccc",
        "version": "1.0.0",
        "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      }
    }
  },
  "currentInput": {
    "value": {
      "flowId": "synthetic-flow",
      "methodPin": {
        "assetId": "ast_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "version": "1.0.0",
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "resources": {
        "bed": {
          "assetId": "ast_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "version": "1.0.0",
          "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
      },
      "sources": {
        "payload": {
          "assetId": "ast_cccccccccccccccccccccccccccccccc",
          "version": "1.0.0",
          "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        }
      },
      "value": {
        "expectedBuild": "synthetic-build"
      },
      "controlledBytes": [
        {
          "slot": "payload",
          "role": "payload",
          "source": "payload",
          "path": "payload.txt"
        }
      ]
    },
    "sha256": "f6abf0fd6ebbde51ccbe34c18865e60a5fa65e0c8f19c0583744af963cbbe764"
  },
  "state": {
    "stage": "prepare"
  },
  "observations": [],
  "controlledBytes": [
    {
      "slot": "payload",
      "role": "payload",
      "encoding": "base64",
      "reference": {
        "kind": "source",
        "sourceRevisionId": "src_dddddddddddddddddddddddddddddddd",
        "sha256": "2d7c09188d414c888f37b661e27aecdd54231e027ea2c8ad9c1e313aab34c5d9",
        "size": 17
      },
      "contentBase64": "c3ludGhldGljIHBheWxvYWQ="
    }
  ],
  "expectedOccurrences": []
}
```

例如准备阶段可提出一个已批准的只读观察，结果通过它自己的 operationId / B reference 进入下一次 frame：

```json
{
  "schema":"hub-execution-transition/1",
  "state":{"stage":"environment-requested"},
  "actions":[{"kind":"provider.call","stepId":"environment","occurrence":0,"resource":"bed","tool":"env_prepare","args":{"device_build":"synthetic-build"}}]
}
```

env_prepare 与 bed_topology 并不是 Hub 硬编码的特殊 Tool：名字、read effect 与输入结构来自该 provider 的批准声明。bed_topology 的观察同样由它自己的 provider.call 产生。缺少显式租约映射时，worker 的普通 read 分支直接调用只读 Tool，**不自动取得远端租约**；显式 argumentsByTool 要求租约的 read 会临时 acquire / read / release。若该服务的观察接口要求先持有远端租约，裸 read 动作不能凭空满足它，也不能让 transition 传入 lease token。这样的观察须由已批准且实际可独立读取的 provider Tool，或 Hub 管理的写协议所留存的原件提供。本示例不证明任一既有网关无租约可调用这两个名字。

C4 已在 receiptPolicy 增加**可选 prepare 阶段**（当前字段见文末 C4）：由批准的工具名与参数映射决定调用，worker 在同一远端租约内、submit 之前执行，Hub 持久化准备观察，再以这份观察供 beforeDispatch 核验。ProviderPolicy 已定义 prepare 列表与相应 worker 事件；精确映射和证明边界见 C4，产品不能在 args 中自行补租约权限。

时序也需要在 C 实施时调整并验收：当前强制 beforeDispatch 位于 C 预检、早于 worker acquire/准备；未来要让该出口在准备观察已经持久化后再次核验，且仍在提交意图与 submit 之前，不让旧的出口通过记录替代新观察。prepare 不证明已派发，也不把准备成功扩大为提交成功。原生 APV 路径的 execution.environment.observed 来自其提交前 env_prepare；网关 case_submit 内部仍可再次观察或拒绝，属于另一调用/时间点。未来通用 prepare 的观察也保留独立原件与操作身份，不拿这两种既有观察冒充新增阶段已经完成。当前真实 env_prepare/bed_topology 需要远端租约，因此前面的裸 read 示例仅说明参数形状，不能作为现有真实网关可执行路径。

对于写 provider.call，worker 按绑定 receiptPolicy 自动 acquire / heartbeat / submit / status / results / release，C 持久化意图、身份、终态与释放事实。transition 不接管这套租约状态，也不把 acquired token 放进下一轮参数。取得受控结果字节后，可提出 `tool.call`，普通 args 放小型格式参数，byteSlots 引用 frame 中真实存在的槽；例如 `args:[{"format":"synthetic"}]`、`byteSlots:["payload"]` 会得到 `parse({format:"synthetic"}, bytes)` 这类位置参数调用。槽不存在、role/来源不符、SHA/大小不符，或实际 wire 超限均拒绝，不能让模型转抄 base64 绕过关口。

两个出口挂点的当前行为不同：

- **beforeDispatch**：C 在每个 write 的 intent 前强制执行模块已附处理器，binding.resource 为该实际操作的冻结资源，subject 为 `{input:<整份冻结 FlowSubmission>,operationId:<本次写操作 id>}`；通过证据绑定操作后才准许意图。产品不提出 hook.verify 也不能省略这一出口。
- **afterResult**：当前驱动不自动调用处理器。模块若附有 afterResult，产品须先提出 `hook.verify`，subject 为 `{result:<最终候选>,operationId:<该终态写的原操作 id>}`，等待成功回执后再单独提出 `delivery.propose`。C 对每个已证终态写检查真实 Hook 成功证据，且 subject.result 的 canonical SHA 必须等于交付候选；缺失或正文不同为 EVIDENCE_INSUFFICIENT。before/after 的资源由当前任务/修订的实际 provider 操作确定，不能选 JSONB 第一项；其他三个 verify 在多资源且无唯一归属时拒绝歧义。没有处理器时不添加缺省产品规则。

`delivery.propose` 与 `outcome.error` 各自必须独占动作批次，不与待执行动作同批。`outcome.error.code` 必须已经在 F 错误目录注册；产品 Tool 不能 import Hub 或在执行时自行注册码，未登记的错误动作由合同拒绝。Hook 的规则 code/facts 是保留的产品判定数据，不因此成为新平台错误码；worker 报告的错误通道另由 C 投影到已登记码，完整原回报仍留 B。

这份注入说明沿用 A2 的全部预算：state 256 KiB、input metadata 512 KiB、transition output 256 KiB、普通 JSON 字符串 32 KiB、数组/动作 256 项、深度 16、controlled 解码合计 8 MiB，以及实际 Tool wire 输入 24 MiB / 输出 16 MiB；上述示例没有新字段容量或隐式扩容。expectedOccurrences 是现有可选合同字段，产品若不使用重复步骤也不能据其缺席自造许可。完整字节只在实际执行所需的 frame 中给出；轻预检重核授权与原件引用，不向 transition 改发另一种协议。

### C 阶段协议差异与实施清单

以下保留实施前协议差异；当前落实情况以文末 C1–C5 及驱动 schema 为准，严格合成验收不等于现网部署。

下面是用户确认并经本机网关源码只读核对的协议形状；只记录键名、类型与行为，不引入地址、配置值或真实回报。它不是已经实现的新 ProviderPolicy schema，也不是任意 MCP 服务都应采用的统一回执。C 后续实现须用已批准的通用 policy 描述差异，不能把这些产品工具名写成 Hub 分支。

| 网关工具 / 回报 | 原生形状与约束 |
|---|---|
| `lease_acquire` | 请求 `{}`；回报有 `lease_id:string`、`token:integer`、`expires_in_s:number`。TTL 字段不是 expires_in 或 Hub 自行推断的期限 |
| `lease_heartbeat` / `lease_release` | 请求只含当前 `lease_id` / `token`；release 成功体有 released=true |
| `env_prepare` | read 工具，但要求 `lease_id` / `token`；可带 `device_build`。不带预期构建时 build_checked=false，不能代替绑定构建的核验 |
| `bed_topology` | read 工具，但要求 `lease_id` / `token`；可带 `refresh:boolean` |
| `case_submit` | 必须是 `xlsx_b64` + `lease_id` / `token`，可选 `module`；不是 payload_b64，module 省略时由网关取其配置默认值 |
| `case_status` / `case_results` | 请求**只含 `task_id`**；公开 inputSchema 的 additionalProperties=false，不接受额外 lease_id/token |
| 正常 submit 成功体 | 有 task_id、sha256、bytes、case_ids、deliver_epoch、submit_autoid、module；**没有 state，也不回显 request_hash/input_sha256/byte_hashes** |
| status 回报 | **仍有 state**（running/done/lost 等），以及 task_id、rc、log_tail；不能概括成所有网关 raw 都没有 state |
| 完成后的 results 回报 | 有 task_id、channel、rc、xlsx_sha256、cases 等；完整结果的 channel=ready；当前完成结果分支没有 state 或上述三项通用 hash。未完成 / runner_lost 的分支可以有 state；不能因一次省略而给所有 results 分支造相同字段 |

成功工具包装仍有 ok=true；ok 不是上述 state/hash 字段的替代。channel=ready 说明结果渠道齐备，不是“所有用例通过”。rc 是 runner 退出事实，逐用例与逐步判定仍由产品解析；终态与解释结果继续分开。

C 的后续工作须分别覆盖以下边界，而不是改弱某个合成夹具使它继续绿色：

1. **逐工具租约参数映射**：当前 generic worker 给 submit/status/results/reconcile 的参数附加同一租约对象，这与 status/results 的严格入参不兼容。后续 policy 必须能声明哪些调用注入租约、哪些只传远端任务 id，不能对所有工具一律加 lease，也不能让产品获得 token 后自己拼参。
2. **注入与 schema 顺序**：当前 C 在租约尚未获得时按 provider inputSchema 校验产品 args；真实 case_submit 又把 lease_id/token 列为 required。受理核验须区分产品实参与已声明的 worker 注入实参，最终以实际注入后的完整参数核对批准 schema / wire；批准 schema 也必须容纳实际租约字段。不能为过关删掉远端 required 或放开 additionalProperties。
3. **submit 参数与 module 策略**：受控 workbook 槽映射到 xlsx_b64，module 的来源、是否可省略及约束由批准 policy 决定；产品不能靠重命名普通字符串参数绕过 B 字节 / SHA 核对。此处只确认需要参数映射，不定义未来 JSON 键或 ABI。
4. **回执与终态映射**：当前 A3 成功观察要求一个同时有 state 与三项通用 hash 的回执，现有网关正常 submit / 完成 results 不提供这些字段。后续按批准 policy 使用实际 state 或 channel/rc 观察，分别绑定各阶段身份和原件；不得向 raw 补写未返回的字段，或把 RPC 元数据当作网关已回显的证明。state/channel/rc 的路径与判定须逐工具声明；query_error、missing_after_done 等不能任意当作 done 或结果成功，已由独立 status 证明的 D 终态也不能因结果渠道失败而改写。
5. **原生证据绑定**：现有原生 1.1.1 提交核对 sha256 与冻结工作簿、case_ids 与工作簿用例身份；随后 status 的 task_id/state=done 与 results 的 task_id/xlsx_sha256 绑定原投递，channel!=ready 仍可留下 partial。这些 sha256/case_ids 是该网关协议的映射目标；Hub 应经批准 policy 按冻结原件 SHA 与已批准方法导出的用例身份核对，不在通用驱动器内写死 APV 字段或解析 Excel。精确 predicate/schema 留给 C 实施设计。后续兼容应保留这些可证关系，不把现网没有的三项 hash 设为唯一可接受证据。这里记录现有做法，不授权更改原生字节或将框架结论扩大成每步通过。

同租约的 prepare、持久化观察与 beforeDispatch 在 submit/意图之前重核的方向见上节；当前普通 read 不取远端租约，这一缺口不能由模块裸调 env_prepare/bed_topology 规避。afterResult 仍按用户确认的显式 hook.verify 与 delivery 证据闸执行，不在本待办改为自动调用。

C 的目标验收采用完全合成、与上述协议同形的严格网关：required 租约、status/results 仅 task_id、真实字段名、submit 无 state、完成 results 无通用 hash、status 有 state。默认跳过的是尚未开始实施的 C 兼容验收；显式启用后在当前实现上必须出现可复现的红例，不把 skip/todo 当作通过。后续逐项实现后才将这些边界转绿，并核对 RPC 参数、B 原件与实际派发次数。A3 的合成协议通过只能证明其已测协议，不能替代这条同形验收，更不能证明真实网关 / 设备已接入。本轮仅补待办与验收目标，不实现、注册未来 schema、改网关或投递真实环境。

### C 二轮待办：运行预算与受控来源门禁

本节只补 C 的设计待办，不改变 F 常量、Hook 动作 schema、驱动器或独立产品包。旧前置投影路径的 `5cdbc2b` / `6a8cb799` 旁证只覆盖它们当时的 synthetic-provider-protocol 接法：输入还携带流外生成的工作簿/命令投影。`6a8cb799` 的旧正向路径通过，不表示正式 flow 已读取全部受控原件，或下面二轮来源、错误与规模门禁已经全绿。严格 cexg 同形验收也与该旁证分开，不据其推定现网兼容。

当前 `arrayItems=256` 同时限制单批 actions / 普通 JSON 数组、runOnce 的 generation / 总 flow_steps，以及 validateBatch 的累计步骤 key。每批大小、每次运行的转换次数和持久步骤总数是不同预算，不能用同一个常量代替它们。以已有 21 案数字为例，216 个设备命令 + 21 个主机命令 + 1 个工作簿核验 = **238 个核验 subject / Hook 动作**；主机 subject 各经过两个已附处理器时，实际处理器判定数为 216 + 42 + 1 = **259**，不是 259 个持久步骤。

设 H 为核验动作数、O 为其它持久动作数、T 为 Hub transition 次数，则总持久步骤为 `H + O + T`。旧排程的 H=238、O=5（env/map/submit/parser/afterResult）、T=7，共 **250**；可选 topology 的观察与转换再加 2，为 **252**。若读取工作簿、命令核对、函数契约三个原件各需一个 Tool 与一次转换，再加 6，预估 **256 / 258**。这是在旧排程上串行加三次原件读取的可复核估算，既非新 flow 实测，也非不可优化的下限；批量读取可以改变 O/T。当前总步骤 256 只给旧路径留 6 / 4 项余量，不能拿一案通过证明整批有容量。

推荐 C 将每 run 步骤预算单独命名并有界化。按上述最大估算留两倍余量，`pow2ceil(2 * 258)=1024`；若只取 `pow2ceil(258)=512`，余量为 254 项，不能称两倍余量。转换次数另按实际排程测量：本估算 T=7+1+3=11，`pow2ceil(2 * 11)=32` 可作为待确认档位，不能把它当成任意产品流程的通用容量。单批 / 单个 JSON 数组的 256 项及所有字节预算不因 per-run 提额改变。

只提高步骤计数仍不够：当前 frame.observations、expectedOccurrences、交付 references 仍各最多 256 项，metadata 总量仍 512 KiB，Tool wire 仍 24 MiB / 16 MiB。C 必须配套设计有界观察窗口与受控原件投影，保留历史 B 原件和准确引用，不截断冒充完整，也不能隐藏未核步骤或丢弃 unknown 写。相关容量与失败路径都要独立验收后才决定常量；本轮不扩大现有合同。

优先方案是保留当前“一项 hook.verify 对应一个 subject”的动作契约，分离每 run 计数并明确观察窗口。另一方案是给 hook.verify 增加 subjects 数组，但那是 F 契约变更，不是现有字段：必须逐项验证实际任务/修订、方法/来源/资源 pin 与原操作关联，固定 item 身份及输入索引，并在 B 留每项真实决定的索引/摘要关系。首个 block 后只记录实际处理过的前缀，余项明确未核 / 未运行，不能变成 pass；完整失败或部分回报都要保原件、覆盖整批最坏输出的字节预算、处理器数量、顺序、超时与堆上限。不能用一个无归属的 batch binding 套到多资源，或以部分成功满足整批派发/交付关口。精确新字段与部分证据协议留给 C 的后续设计，本轮优先不改 F 动作形状。

本轮合成接法可使用以下原件角色约定；它们是 SourceArtifact.files.role 的通用字符串，不是平台强制产品词表。现有旁证使用 workbook、command-tree、function-contract；新增 command-check 是二轮合成约定，不表示旧模块已经支持读取它：

| role / 槽 | 原件与消费边界 |
|---|---|
| `workbook` | 冻结工作簿原字节；批准的纯 Tool 从 B 字节派生用例、设备命令和主机分派，不用客户端预投影代替原件读取 |
| `command-check` | 保留同步 command_check 回执原形的 result.ruleVersion / result.commands 及实际 sourceSha256。正式 flow 按原字段核对绑定输入、构建/来源与命令身份，再由批准方法派生 Hook 所需布尔；不能预造 present:true，role 名或上传批准本身也不证明一次工具调用发生 |
| `command-tree` / `function-contract` | 对应树与函数契约原字节；由批准的产品 Tool 解释，Hub 不解析产品格式。command-check 不能免去所需的树/契约对应核验，角色与槽名不自动授予读取权限 |
| `hub.result.<stepKey>` | C 对大 JSON 或超长字符串结果生成的动态 B 原件槽，位于 observation.facts.result.original.slot/reference，frame 再按权限取回并注入 controlledBytes；小结果目前可以直接在 facts.result 内联，**并非所有 Tool 输出都有该槽** |

Tool 的 byteSlots 从当前 frame 中选择真实槽，按顺序追加字节参数；不能猜动态槽名、假定 result 总为内联，或把 artifact id / 下载路径当作 slot。正式解释在小结果和原件指针两种表示下都要按实际形状读取并核 SHA，证据不齐保留未映射，不能拿旧投影正向路径充当二轮门禁证明。

三条错误与绑定口径也按当前源码保留：

- `outcome.error` 顶层 code 只能使用已登记的平台码。HOST_SET_UNDECLARED、HOST_NOT_IN_BED、COMMAND_NOT_LITERAL、HOST_COMMAND_OUTSIDE_POLICY 四个 APV Hook 规则码不是直接可用的顶层平台码；它们保留在产品 facts，再进入 error.details（例如 details.code），顶层可用已登记的 HOOK_FAILED。不要把产品 facts 伪装成另一条 Hub error/resultError 通道。
- `receiptPolicy.inputSha256Path` 比较的是 `canonicalHash(整份 FlowSubmission)`，不是 workbook SHA。A3 合成 provider 回显 input_sha256，当前真实网关不提供这一回显；不能把 xlsx_sha256 改名或拿来替代完整输入摘要。
- provider 拒绝时，worker 从 error.details 删除 gatewayRefusal，把原件保存在 B 的 `{schema,tool,phase,refusal}` envelope；C 回读后，小型原文在 `observation.facts.result`（内层 raw），大型表示走 facts.result.original 的引用，其 B 原文仍是 envelope，须取 refusal。state.errors 若记录原拒绝，应取这些实际字段与来源引用，不假设普通 worker 错误 details 总有原文。独立已证终态后的结果失败可以由 C 另附解释事实，但不能据此改写所有拒绝回报的形状。

### 数字来源与初版预算

维护者对真实 21 案批次只提供数字统计；没有提供原件内容、真实地址或业务字段。gateway-results 原字节 149702，其中 results 147339、environment 670、status 958、submit 688；topology 9970，workbook 7209，解释产物 119582。逐案日志 UTF-8 最大 10234 / 合计 106734，JSON 转义后最大 10420 / 合计 109125，最多 167 行、最长行 127 字节。本批共 119 步、216 条设备命令、21 条主机命令、26 个检查点；每案最多 7 步、23 条设备命令、1 条主机命令、2 个检查点。最高 JSON 深度为 7，最大数组为 216。command-check 原件 4219626，其中两个 raw base64 段为 2577744、1527460；剩余部分 114422。

`pow2ceil(n)=2^ceil(log2(n))`。JSON 字节与深度预算先留两倍余量，再进二次幂档位；数组按实测最大项数、受控字节按所列原件总量进档位。具体公式如下，这是一组可复核的容量选择，不把单个样本当成所有合法批次的最大规模：

| 预算 | 派生公式 | 初版上限 |
|---|---|---|
| state JSON 总字节 | `pow2ceil(2 * 114422)` | 262144（256 KiB） |
| input metadata 总字节 | `pow2ceil(2 * 208866)` | 524288（512 KiB） |
| output protocol 总字节 | `pow2ceil(2 * 119582)` | 262144（256 KiB） |
| 普通 JSON 字符串 / 键的 UTF-8 字节 | `pow2ceil(2 * 10420)` | 32768（32 KiB） |
| 每个数组 / 单批动作条数 | `pow2ceil(216)` | 256 |
| JSON 总深度 | `pow2ceil(2 * 7)` | 16 |
| controlled 解码字节总量（单件也受此限） | `pow2ceil(149702 + 9970 + 7209 + 4219626)` | 8388608（8 MiB） |

208866 是 **请求估算**：38846 冻结源码原字节加 170020 参数 JSON；未计源码 JSON 转义与实际信封。119582 是解释文件原字节，不是已经测得的 stdout 信封大小。预算不以这两个估算代替实际 wire 校验。样本含中文与转义字符，NUL / 其它控制字节为零，合同用例也覆盖 UTF-8 而不只用字符长度。

metadata 预算包含完整输入中除 controlled contentBase64 之外的字段：绑定、currentInput 的 value / sha256、state、facts、身份和原件指针；state 是其子预算，不额外叠加。controlled 的 base64 不被普通字符串 32 KiB 上限误拒，但规范 base64、逐槽解码长度、SHA、8 MiB 解码合计仍逐项核对。command-check 的 XML/base64 留在 B，不能随 transition state 每轮复制增长。输出预算包含完整 output，不能把每个动作预算相乘成无界容量。

所有新预算还须同时满足现有 Tool 宿主 **24 MiB 输入 / 16 MiB 输出**。准确序列化后的 wire 要包括冻结 files、imports、base64、参数和信封全部 UTF-8 字节；`checkExecutionTransitionWire` 只接收实际字符串或 Uint8Array，采用固有长度读取而不是任意对象自报 byteLength，单独核验真实字节数，不以源码字节加 args 的估算代替。各个分预算合格不保证同时装满也能通过总 wire，超出时拒绝，不截断、不改生产通道上限、不回退到无隔离进程。

B 的 16 MiB 上传上限不意味着每个 Tool 或受控槽都能容纳这么大的原件；这里的 8 MiB 原件合计、32 KiB 普通字符串与其它七项预算不因 byteArgs 改变。provider 字节映射从 B 的已核对引用读取，而非让模型把上传内容复写到 args；解析 Tool 确需完整字节时仍通过有界 controlledBytes，不能借仅引用散列绕过内容读取与 wire 限制。

该批 **没有 sessions 字段**，不代表 sessions 合法容量为零，也不证明已覆盖其真实形状。A2 不加入 session / 设备专用容量假设，使用受控字节与通用 JSON 预算；超过预算按解释失败披露，已证 D 终态不受影响。更大结果的分批或范围输入属于后续独立设计与验收。

可导出的 JSON Schema 描述严格字段、动作联合、数组和字符结构；UTF-8 总字节、普通对象/循环检查、canonical base64、解码 SHA 和注册错误码还要由同一合同解析器核验。A2 的合成边界验证不是执行链验收；没有跑通驱动器、对接实际设备或取得部署成功的结论。

## 附录 A3：通用驱动接入与证据边界

驱动入口是既有任务提交路径的 `module-execute` 能力，不借产品名分派。C 保存 flow_runs / flow_steps，定义与状态、步骤 key / requestHash、操作 / fence、派发意图、原远端身份、原件引用和终态分别持久。真实 worker 经已冻结 tools[] 的 import 边界运行 transition / 纯 Tool / Hook；只有通用 provider 连接器可以取运行 profile 和注入凭据。operation.wait 只读取本任务同修订的原操作，不注册另一笔远端写。

资源声明使用已有 connector-instance、runtime-profile 与凭据登记。`hub-provider/1` 的 receiptPolicy 是受批准的通用协议数据：有限 Tool 名单、入参 / 回报 schema、状态词表、身份与摘要字段路径、租约和派发前拒绝字段路径。hub 不解释设备名、工作簿函数或产品日志；它机械核对 worker 观察的 provider 回报与原请求身份。effect / minimumRole 来自资源已批准 provides，不能被产品动作或远端目录悄悄改写。实际接口形状见 [交接文档](../client-api-handoff.md#a3通用模块执行与受控原件)及 [驱动数据契约](../../packages/execution/src/flow-contracts.ts)。

原件进入网络参数前由 C/D 按 B 清单与当前权限重新取字节、核 SHA / 大小，byteArgs / byteSlots 只引用受控槽。派发意图先持久；失联时不使用步骤重试去重放写动作。未知写及独立核对失败保留冻结，明确未派发的失败与读取超时不冻结。执行变更的申请内容含实际 Tool、字面参数摘要、原件引用和三类 pin，独立批准仅消费一次；默认资源仍不产生审批。

写出口强制执行已附 beforeDispatch Hook，并在意图前绑定实际资源、输入、操作与通过证据；产品省略 Hook 动作不构成豁免。afterResult 的实际成功回执同时关联终态原操作与最终交付候选的 canonical SHA，每个已声明挂点对应的写都须核验整份候选，不能验证甲正文后交付乙正文。未附处理器时仍不添加缺省规则。独立核对的证据保留真实子操作身份，产品逻辑步骤继续指向原操作。租约过期的统一处理器按 Store 实例共享，避免同库其它运行器绕过通用终态 / 意图分类；带处理器的路径按 task → operation → flowrun 锁序推进。

观察终态与取得结果正文是两个不同事实。status 回报已满足批准的终态与身份核验时先保存 D 终态，再取结果和解释；后续失败保留真实解释错误，不把 status 内容当成结果或生成默认成功行。provider 的解析后 JSON 以 canonicalJson 原字节留 B，worker 事件和回报用绑定操作 / stage 的指针；C 回读核 SHA / 大小。原件、大文本 / NUL 的小投影和产品解释各自保留身份，既不把正文写进 JSONB，也不以脱敏预览覆盖原件。这个 canonical 化是明确的转换，不宣称保留了原 HTTP wire 的空白与字段顺序。

方法摘要的版本化算法覆盖冻结模块 digest、flow、驱动版本与支持的精确依赖版本；模块清单已覆盖 Tool / Hook / 相对依赖的完整文件集合。批准历史 pin 与最新批准 readers 的交集继续逐次核验，草稿不改运行绑定；新受理要显式选方法，旧任务不自动升级。运行资源和 runtime-profile 也冻结实际修订，不把配置文件存在当作批准。C5 将总步骤预算独立为 1024，转换仍 256 代，单批数组仍 256；超限明确失败，不无限产生空转换。

A3 的验收前提仍是 macOS seatbelt、临时 PostgreSQL 和合成网关。两份合成模块分别冻结 / 批准 / 停用并交替执行，只证明此通用驱动与它们的协议；原生 1.1.1、APV 新模块、真实设备、真实模型及任意 MCP 服务兼容性不由这些验收推定。完整验收结论只记 [阶段进度](../server-s2-progress.md)，本附录不记录部署成功。

---

本文是 circle-hub 的设计规范之一，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权：引用、借鉴须署名 Circle Hub 与 qingshanfeihu 并注明原始出处链接。见[设计规范索引](README.md#许可)。

### C2：批准的普通参数与原件参数映射

receiptPolicy.toolArguments 以工具名、目标参数名为键，每项只能是 `{literal: 有限JSON}` 或 `{inputPath: [字段路径]}`。路径从 C 冻结的整份 FlowSubmission 开始，例如 `['value','build']`；不读取环境变量、profile、凭据或产品 transition state。声明由资源修订批准并被冻结，参数由 C 入队与 D 实际调用各重算；产品 args 与批准映射重名时拒绝，而不是悄悄覆盖。未声明工具、原型路径、访问器、循环、非有限数、超 32 KiB 字符串或其它 A2 预算拒绝。

receiptPolicy.byteArguments 以工具名、实际 wire 参数名为键，值是 action.byteArgs 的逻辑参数名。例如 `{case_submit:{xlsx_b64:'workbook'}}` 对应产品动作 `byteArgs:{workbook:'workbook'}`；已有动作直接使用 xlsx_b64 时可以不声明映射。映射必须一对一覆盖所有逻辑原件参数，不能漏掉或复制同一参数；目标与普通参数 / 租约权限冲突时拒绝。C 的请求摘要仍绑定原动作与获授权的 B 引用，D 在调用时取原字节，wire byteBindings 和回执核验使用实际参数名。不会为工作簿扩大普通 JSON 字符串预算。

status/results/reconcile 仍由 taskIdArgument 注入持久远端身份，并只按工具明确声明的租约映射补字段；目标为只收 task_id 的工具时，argumentsByTool 对这些名字写空对象。不将 lease_id/token 或 submit 的 module/base64 带入观察调用。

### C3：按阶段核验 provider 回执

APV 合成模块验收把冻结包资源模板中的完整 receiptPolicy 原样登记并经另一身份批准，核批准摘要及配置的 canonical 摘要，不只复制参数或租约映射后回退 echo 协议。合成原始 submit / status / results 分别提供实际阶段的工作簿 SHA / 用例身份、状态与结果 SHA；这是合成协议接法验收，不证明真实网关或设备兼容。

严格 cexg 合成状态夹具的 raw state 词表为 queued / running / done / lost；批准的 completion 将 queued / running 视为非终态，只将带有限整数 rc 的 done 视为已观察退出。lost 的形状合法，但不证明完成，核验以固定 EVIDENCE_INSUFFICIENT 停止轮询并保留未知写、原件与远端租约；done 缺 rc 或 rc=null 同样不可证。非零整数 rc 只表示 runner 退出事实，不自动生成整案或逐步通过结论。此词表属于该批准协议的测试数据，不是新增通用 uncertainValues 字段，也未改变原生路径。

`receiptPolicy.receipts` 分 submit / status / results / 可选 reconcile，每项声明自己的 receiptSchema、remoteIdPath，以及可选 sha256Path / caseIdsPath / completion。completion 为 `{path,runningValues,terminalValues,rcPath?}`：path 可以指向 state、channel 或有限整数 rc，词表互斥；rc 只是 runner 退出事实，ready / rc=0 都不扩大为逐用例通过。未声明 receipts 时继续完整旧 echo 协议；新模式不要求网关不存在的 request_hash / input_sha256 / byte_hashes，也不把工作簿 SHA 当整份 FlowSubmission 的摘要。

新模式要求批准的 `identityProjection:{stepId,path,export,byteArgument,sha256Path,caseIdsPath,idPath?}`。byteArgument 是映射后的实际 wire 参数。C 在意图前从本任务 / 输入修订的成功 tool.call 查询实际 action、方法 pin、请求摘要、受控槽引用及 B 投影原件，核对其确实接收同份工作簿，再按字段路径取 SHA 与身份列表。来源不是 caller value；投影原件、operationId、方法 pin、原件 SHA 和身份保存在 receipt_facts（迁移 42），此时不产生 remote_identity。submit 必须核原件 SHA / 身份，results 必须核原件 SHA，随后阶段均核持久远端身份；历史报告重新核冻结证据，撤权不抹已发生事实。

D 成功回报先按 SHA 冻结原件，再做阶段校验；不匹配原件仍留存为未验证证据。已 submitted 后的查询 / 心跳拒绝不能当派发前拒绝，仍 unknown、不释放也不重派；已证 status 终态先持久化，随后 results 拒绝或 SHA 错误仅使解释失败，终态与释放事实保留。已证终态后的不完整结果渠道可由批准产品方法解释为 partial，不猜设备结果。原生 1.1.1 不参与本链。

已证终态后的解释错误或完整 worker 报告失联 / 过期，C 保留 D 的 succeeded / reconciled、terminal 原件 SHA 与实际释放事实（未取得释放回执时为 null），并记 `interpretationStatus:"failed"`、error、unmapped 和 B 引用。批准的 transition 继续消费这些事实，通过既有 afterResult / 同候选字节核验提出 partial；已知解释缺口的 succeeded 候选被拒，Hub 不自动调用模型、Hook 或制造交付。迟到的原 fence 报告只按既有补充边界加入 B 原件与释放事实，不改已交付候选及其 partial / unmapped；旧输入修订的记账也不写入新修订的解释观察。治理或候选合同违例仍可使任务 failed，未证终态的写仍 unknown，不借解释路径解冻或重派。

### C4：同租约准备观察与派发出口

批准的 receiptPolicy 可声明 `prepare:[{tool,args?}]`，均须在资源 provides 中唯一声明为 read；参数经过 toolArguments 和逐工具租约映射，工具链 minimumRole 也包括这些准备调用。worker 在该写操作同一 acquire / heartbeat 租约内，按批准顺序调用准备 Tool，再持久化每份 canonical JSON 原件的 SHA / 大小 / 指针；准备不会产生 submitted 身份。

迁移 43 的 prepare_ref 保存操作、输入修订、fence、请求摘要、资源 pin、租约摘要、顺序、实际参数摘要和原件引用。C 独立回读 B、重算映射与摘要，完整准备后才调用 beforeDispatch；subject 为 `{input,operationId,preparations:[{index,tool,reference,result}]}`。准备 result 在 Hook 入口去除凭据 / 租约字段及 NUL，并标 sanitized；原件保存在 B，不把原文秘密或 NUL 放进 JSONB。超 Hook JSON 预算明确失败，不截断为通过。出口证明绑定本次 preparationDigest / fence，intent 还核同一 leaseDigest；旧出口证据不能豁免新观察。

准备失败、撤权或 Hook 拦截在意图前落 failed，无提交 / unknown 冻结；本地取消仍不证明远端停止。清理仅用本次已取得的凭据调用批准的 lease_release，不授新 dispatch；明文例外清理的有限 transport 元数据仍按冻结 runtime 修订核验并永久写审计 / 证据。释放失败照实记 false。已派发不确定写仍不清理、不重派；原生 1.1.1 不改。初始环境观察来自模块的独立 read，写租约里的 prepare 是更晚的一次观察，gateway submit 内部还可独立观察 / 拒绝，不能互相冒充。

### C5：运行容量、观察窗口与结构投影

运行预算独立为 1024 个持久步骤 / 256 代转换；单批动作、普通 JSON 数组仍最多 256。这是按 21 案最大估算 258 步留两倍余量后取整为 1024；256 代保持既有通用档位，32 代只属先前具体排程估算，未改为全平台默认。同 key 重放不新增预算，跨上限整批原子拒绝，不先派发前缀。

模块只有显式声明 `historyMode:"controlled"` 才能使用超窗历史。可选 observationWindow / expectedOccurrenceArchive 为 `{total,returned,complete,archive?:{slot,reference}}`；全集由 C 以 SHA 留作 B 制品，并经真实 `flow-history` / `flow-occurrences` 受控槽送给需要它的 Tool，计入原有 8 MiB 总量。内联最多 256，窗口保留意图、unknown、已消费授权与活动步骤；无 worker 回报的活动记录标明 hub-step-ledger，不伪称 provider 结果。关键记录自身超过 256 则明确失败，1024 不表示可内联任意数量的写历史。未声明窗口协议的旧模块超窗也明确拒绝。

全集原件仍逐项重核当前 B 可见性、SHA 与大小；受控槽同名只有相同 role / reference 才可复用。轻预检保留输入修订双摘要验证、冻结请求引用与来源授权。交付引用查询本任务 / 输入修订的全部观察和 C 生成的历史 B 绑定，再核 B 权限；不以退出内联窗口为由拒合法旧引用，也不接受跨修订 / 隐藏对象。

结构投影除 256 KiB 与 32 KiB 字符串外，也检查 UTF-8 键、256 项数组和实际 frame 包装后的 16 层深度。小体积 257 项结果亦走已有 hub.result 原件槽；结果从包装深度 5 计，错误元数据从 6 计，省略的元数据给 SHA / 大小 / reason，原始工作者回报继续保留。预算不扩大，数据不静默截断。来源框架、设备与产品解析仍归模块，原生 1.1.1 字节不变。

### C1：逐工具租约注入与 schema

`receiptPolicy.lease.argumentsByTool` 以工具名为键，每项为 `{idArgument?,fenceArgument?}`；空对象或未列工具不注入任何租约参数。整份映射缺席则保持旧协议的全局名字。只有资源已声明、schema 有对应字段的 Tool 可获注入，目标不得相互冲突或覆盖普通 / 字节 / 远端身份参数；acquire 不可注入尚未取得的身份。

C 入队只延后批准映射字段的必需性约束，保留其它字段验证；无法安全延后的顶层组合 / 跨字段 schema 失败封闭，不删除约束伪造许可。D 真正调用前按实际 lease、普通映射与原字节填入后完整验证批准 schema / wire。需要租约的普通 read 临时 acquire / read / release，并核 acquire / heartbeat / release 的角色；status/results 的空映射保证只传已声明远端身份。

C5 的 ledger / B 绑定也要求一致的数据库锁序：通用 flow 的任务→run→operation / step，claim 在 task 被锁住时跳过候选，不先占 operation 等上级锁。同 Store 的 flow 前置锁回调供两个 executor wrapper、心跳与过期实例共用；无注册回调的原生路径不新增 flow 锁。锁是序列化边界，不能替代身份、范围、fence、期限或源授权检查；本实现不靠重试死锁推进任务。


### 失败 Tool 观察与空成功结果

C 记录的失败观察必须有 `facts.error`，保留有界的 `{code, registered:true, message, details}`。`registered` 只表示投影后的平台码属于 F 登记簿，不证明报错原因或设备效果；未登记的回报码投影为 `INTERNAL_ERROR`，并标 `reportedRegistered:false`，任意原码仅保留在 B 的完整 worker 报告。错误详情超过元数据预算时，仅 `details` 变为含 SHA、大小和省略原因的摘要，不再连同分类码整体省略；超长 message 使用有界说明，原错误仍可从 B 核对。失败回报没给 error 时，C 用 `INTERNAL_ERROR` 和 `details.missingError:true` 披露缺失，不猜真实原因。成功 Tool 返回 `{}` 仍是成功的空结果，不附失败 error。上述投影不改变回报原字节、fence、读写效果或独立已证的 D 终态。


### 独立核对之后的普通结果读取

普通只读 provider 动作调用批准 policy 的 `resultTool` 时，C 先找到同任务、输入修订、资源 pin 和远端 id 的唯一已证终态写操作。C 生成并持久化内部 `resultBinding`，冻结父操作 id、原请求/输入摘要、完整 byteHashes、原件投影证明及真实 submitted / terminal B 原件 SHA；读动作自己的摘要和空 byteArgs 不代替原写身份。worker 和 C 回报各自按 `receipts.results`（旧 echo policy 保持兼容）核对结果；核对后的父观察可提供已验证的终态 status 原件，仍须回读并验 SHA。没有真实 submitted 原件证明的旧运行、未独立核对的 unknown 写、歧义或跨任务/修订/资源关联都拒绝，不能靠当前 input.value 补造证明。

坏 SHA、错误远端 id 或回报前关联失效落只读 failed，并保留原件和有界登记错误，不冻结资源、不重派原写，也不把读标成 D 终态。只有父证明重新核实后才追加父的解释缺口；完整缺口表按 SHA 存 B，父只带有界摘要、数量和真实制品引用，追加回读旧表并去重，不覆盖既有原件、终态和租约释放事实。解释缺口的 partial 交付仍由产品 transition 提议并经过交付闸，平台不伪造成功用例。

首次实际派发与 C 回报完整回读并核 SHA；已有绑定的 lightweight 预检只重核父元数据、分区、pin、状态、远端 id、请求及原件引用和绑定摘要，不读 B 字节，也不缓存活授权。`sourceByteProofSha256` 在单原件/投影时是该原件 SHA，多 byteHashes 的旧 echo 情形是整个映射的摘要，完整映射仍逐项保留。
