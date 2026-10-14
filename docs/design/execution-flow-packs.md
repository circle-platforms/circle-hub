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

这是现有实现的缺口：`ProductModules.load` 及 `SourceArtifacts.snapshot` 当前沿 `assets.current_version` 取原件，`ToolProviders.resolve` 也按当前版本查模块。迁移前必须提供内部的历史批准修订解析，不能仅保存 `methodAssetId` 后每次读 current。不得因新草稿或模块安装而让已派发任务改读新 parser。

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

本轮到设计复核为止。内部 transition 契约及独立包的新版本由维护者确认，并获得实施授权后才进入代码迁移；本轮不提前实施。

---

本文是 circle-hub 的设计规范之一，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权：引用、借鉴须署名 Circle Hub 与 qingshanfeihu 并注明原始出处链接。见[设计规范索引](README.md#许可)。
