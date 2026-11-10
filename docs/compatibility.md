# 兼容矩阵

英文译文在 [compatibility.en.md](compatibility.en.md)，两者有出入以中文为准。

三个仓库各自版本化：circle（agent）、circle-hub（MCP 服务器）、circle-packs（包）。谁依赖谁、以什么为准，都写在这里；改动任何一行都是一次有意识的升级，不是顺手为之。

## 现状（2026-11-05）

| 部件 | 版本 / 提交 | 以什么为准 | 说明 |
|---|---|---|---|
| circle-hub | 公开 main：网页控制台（管理员也在这里管理 Hub）、自带 HTTPS、一键安装脚本、个人与团队知识空间；发行 0.3.0（2026-11-04）是重建后的第一个发行，带安装包；此前的 0.2.0 是已退役的服务器 | [Hub r4 进度](hub-r4-progress.md)、[当前状态](hub-status-2026-11.md) | 所有者的持久部署自 2026-11-04 起从 main 部署（决定 145），私有集成分支已封存 |
| 合约 | 通用模型第 40 版（`MODEL_VERSION`） | `contracts/model.json`、`contracts/codes.json`，生成物在 `contracts/generated` | `npm run verify:contracts` 核对生成物与来源一致 |
| MCP | `@modelcontextprotocol/sdk` 1.32.2 | 根 `package.json` | 六个工具，streamable HTTP；MCP 标准授权（授权码或设备码）或 Bearer 令牌 |
| Circle | 作为普通 MCP 客户端连接，不需要 hub 扩展 | MCP 协议与工具的 schema | Circle main 已合入六项通用 MCP 客户端改进并删去内置 Hub（circle#309，2026-10-26）和按 MCP 标准授权在浏览器登录（circle#396，2026-11-02）；Circle 里不出现 Hub 专用的界面或标签（D06 R[1]）；修改 Circle 需要所有者明确授权，范围见 [AGENTS.md](https://github.com/circle-platforms/circle-hub/blob/main/AGENTS.md) |
| `foundation/circle` | Circle **1.0.4** 源基线，冻结 | `references/README.md` 的来源记录 | 只是源码参考，不装、不跑它的安装器；不是 hub 的运行依赖 |
| circle-packs | 见其 CHANGELOG | circle-packs 仓库 | 存放已退役服务器用的包（`modules.json`、`product-line/1`、`hub-*/1`），重建后的 Hub 不读取它们；第一个里程碑不改这个仓库 |

## 包函数的隔离

按 [Hub r4 架构](hub-r4-architecture.md)，任务包里的函数在受限的子进程里运行（由 rules 包实现，待复核）：Node 权限模型禁止写文件和起子进程，只许读解压后的包；架构简报记录了在 Node 24.17 上核实过权限模型不限制网络，所以子进程另在 macOS `sandbox-exec` 下运行并禁止网络；另有时间、内存和输入输出大小的限制。在 Linux 上，这一层是 bubblewrap 加管理员装载的 Hub AppArmor 策略（见 [rules 包说明](https://github.com/circle-platforms/circle-hub/blob/main/hub/rules/README.md)）。没有可用的操作系统隔离的地方默认拒绝运行包内函数（`SANDBOX_UNAVAILABLE`）。其他平台上的等价隔离尚未确定。

公开 CI 在 Ubuntu 上运行。拉取请求只跑快的检查（`Types`、`Generated contracts match the model`、`Docs and CI checks`、`Reference archive`）；完整的测试由合并队列在将成为 main 的那个提交上运行，每次推送到 main 也再跑一遍。在拉取请求上，各分片和汇总它们的检查（`Unit tests`、`Acceptance on a temporary PostgreSQL`、`Linux isolation`）都跳过，必需检查把跳过算作通过；在合并队列和 main 上，每个汇总检查要求它的所有分片都通过。单元测试任务从 PostgreSQL 的 apt 源安装 18 版客户端，所以备份、恢复和部署的用例在那里运行。包内函数的沙箱用例，包括对真实监听的本机服务器验证的断网，由 `Linux isolation` 任务运行：合并队列和每次推送到 main 都会触发，它安装 bubblewrap 和 AppArmor，为本任务的 Node 生成并装载 Hub 的 AppArmor 策略，隔离不可用就直接失败，然后运行按跳过条件从源码选出的单元和验收测试文件。它不改 `kernel.apparmor_restrict_unprivileged_userns`，启动器策略自带的 `userns` 规则已经够用。其他单元和验收任务没有隔离，这些用例在那里跳过。Ubuntu 上没有 `sandbox-exec`、plutil 和 launchd，所以 `sandbox-exec` 本身、plutil 和 launchd 的检查在 Ubuntu 上跳过；密钥文件在每个平台上都一样，它们的用例在那里运行。这些用例由 `macOS-only paths` 工作流在 `macos-15` 上运行，沙箱用例也在那里经 `sandbox-exec` 再跑一遍：每次推送到 main、每晚一次，也可以手动触发；拉取请求不触发它，它也不是必需检查。所以合并队列的检查是 bubblewrap 与 AppArmor 下沙箱的证据，但不是 `sandbox-exec`、plutil 和 launchd 的证据；拉取请求自己的检查对两者都不是证据。跳过不算通过；每个阶段仍在本机 macOS 上完整运行一次，命令、计数和跳过的用例记在 [Hub r4 进度](hub-r4-progress.md)里。CI 的任务摘要列出每个跳过的用例。

## 密钥存放

所有者 2026-11-03 定下（决定 137）：Hub 不再使用 macOS 钥匙串。macOS 和 Linux 一样，密钥库主密钥和操作令牌各是数据根 `keys` 目录下的一个 32 字节文件（目录 0700，文件 0600，属于服务账户），不进备份。`CIRCLE_HUB_KEYCHAIN_SERVICE` 和 `CIRCLE_HUB_KEYCHAIN_ACCOUNT` 已停用：进程里设了其中任何一个（空值也算）就不启动，并说明密钥现在在哪里。部署设置保留 `keychain_service` 和 `keychain_account` 两个字段，现在用来给密钥文件命名，所以回滚到的发布读的还是同一份设置文件。密钥还在钥匙串里的 macOS 部署，在运行含这项改动的发布之前先把它移出来：用先前发布的 `circle-hub key export --confirm` 通过管道交给新发布的 `circle-hub key import`，然后运行 `circle-hub operator-token reissue`。

## 合约

| 合约 | 定义方 | 使用方 |
|---|---|---|
| 通用模型 | `contracts/model.json` | 生成器 `tools/gen-contracts.ts`；`tools/show-element.ts` |
| 词表、协议码与核心违规码、引用形式、记录种类 | `contracts/generated/vocabulary.ts` 与 `protocol.ts`，由模型和 `contracts/codes.json` 生成 | Hub 的全部包；标签只经 `labelOf` 取得 |
| 记录、结果、任务包文件与表的 JSON Schema（键为 `name@major`，全部登记在 `SCHEMA_REGISTRY`） | `contracts/src/*.ts`，其中 `pack`、`knowledge`、`resources`、`tables` 四份由拥有它们的包编写，改了之后由该包运行 `npm run gen:contracts`，把生成物和改动一起交，合约包复核生成的差异；生成到 `contracts/generated/schemas` | Hub；任务包作者；任何读取校验结果的客户端 |
| 六个 MCP 工具的输入、输出与注解 | `contracts/src/tools.ts`，生成到 `contracts/generated/tools.json` | 任何 MCP 客户端 |
| 任务包的文件布局 | 模型格式提案里的包文件清单（`PACK_FILE_PATHS`） | 任务包作者；Hub 的发布校验 |

## 发布顺序

1. Hub 先：模型或合约变化时提升对应 schema 的主版本（`name@major`）并更新本页；发布需要所有者另行决定。
2. Circle 不随 Hub 同步发布：它只是 MCP 客户端，依赖的是 MCP 协议和工具的 schema。
3. 任务包各自带版本，上传时自动跑包内的正例与反例（发布校验），不过不发布。

升级 `foundation/circle` 基线和各仓库的标识改名都是单独的决定，各留一条记录在本页的“历史”里。

## 已退役

下列内容属于已退役的任务与审批服务器（截至 0.2.0），对重建后的 Hub 不再成立或不再相关，原表见 [ca66002 的本页](https://github.com/circle-platforms/circle-hub/blob/ca66002fb6bfc3220547d0fdd895bfae83345943/docs/compatibility.md)：验收用的 Circle 运行时 fd8524a 及 `CIRCLE_BIN` / `CIRCLE_COMMIT` 门禁；Circle 发行绑定 v1.7.3 和 hub 扩展的目标基线；hub 扩展所用的客户端接口（[客户端接口交接](client-api-handoff.md)）；hub 验收用的 circle-packs 原件，以及 circle-packs CI 固定的 hub 依赖集；执行网关 cexg；产品包 Tool/Hook 的 macOS seatbelt 进程隔离及其验收路径；`circle-packs/modules/1`、`product-line/1`、`hub-*/1` 与 `/mcp` 端点这些 schema 和契约；“hub 先、circle 的 hub 扩展随后、packs 最后”的旧发布顺序。

## 历史

- 2026-11-09：派发意图的内部字节唯一键加入核验后的血缘根（多轮仍带轮次/尝试号）；原全局S键和索引不改写，按原reservation完整绑定读取，同血缘保持原重试/未知规则，独立任务不继承别的血缘轮次/窗口。旧未知的物理目标占用仍全局阻止；无法核验归属的旧记录保守拒绝。外部六工具/合约schema不变；旧二进制回滚仍保守地按全局S阻止独立任务，不能用回滚恢复本修复的跨任务隔离。
- 2026-11-09：case-compile源码升为3.9.19，主合成脑图/计划改为随附冻结合约和命令树已声明的单条间隔配置；ID与引用重新派生，旧多命令样例作为拒绝对照保留。沿用包/生成器同版约束，工作簿生成器身份同步case-compile@3.9.19，四个合成工作簿样本重算版本相关字节/摘要；生成、校验算法与schema未变。新核验须匹配任务包及生成器版本；不重写历史结果、冻结合约/配置/命令来源，不自动升级已部署包。
- 2026-11-09：source-read 工作流源码升为0.1.8，新增可选 `spec_list` 输入，接受既有 manual-store 的 `manual:spec-list:configured` 只读目录清单；沿用 `workflow@1` / `system@1`，无核心或schema升级。要求启用、获准的手册库资源配置 `spec_folders`，不会自动配置或发布。main此前0.1.6，未合入#190已占0.1.7；0.1.8不包含该提案或证明生产已升级。

- 2026-10-13：建立本页。改名尚未开始；验收 Circle 提交 8b2ceb6；foundation/circle 1.0.4；circle 主线 1.1.1。
- 2026-10-13 晚：7420 就地升级到 server-s2 8e212a6（§5，迁移 28）；circle 主线 1.2.1；circle-hub 与 circle-packs 改为 Apache-2.0，提交需签署；circle-packs 验收固定提交 316760a（products/famx 1.2.0）。

- 2026-10-14：将 Circle 最新公开发行 1.4.1、扩展目标基线 1.2.1 与固定 RPC 验收提交分列；原验收提交与冻结参考均未升级。circle-packs CI 的 hub 依赖集固定为 dc93c69826f73f16d2f20f7520ba4c6663d014ac；本地合成测试结果另行记录，不作为真实产品或生产验收。
- 2026-10-14：Hub CLI 改为 `circle-hub`，部署变量改为 `CIRCLE_HUB_*`；旧 `CIRCLE_SERVER_*` 仅在新键不存在时作弃用回退，新键空值也不回退。Circle 的扩展标识、命令与注入协议保留，路由/schema、旧工作树路径与历史来源不改；Circle 与独立包的版本升级另行确认。
- 2026-10-14：经维护者确认，包装载验收从 224daa6（FAMX 1.2.1）升级到 ba06eed（FAMX 1.2.2）；按冻结清单核原字节并运行，产品线 31/31、四技能 57/57、catalog 工具 4/4。该提交 README/CI 合并入口的 61 项是后两类之和，三类分别记录。

- 2026-10-15：准备 Hub 首个仓库发行 0.1.0。验证栈 1b4a6dc 使用 packs d91b23d 的 products/famx 1.4.0，既有固定验收输入另列，不混用。批量流程交付成功，设备结果 13 pass / 8 fail，不表示设备验收全绿；这是当时首版准备快照；维护者随后确认 D 直接实施，最终状态见下条。

- 2026-10-15：D 移除原生能力与 worker；migration 20 原字节保留，migration 44 令旧回执只读，兼容编译器升为 1.1.0。维护者确认 RPC 验收固定 fd8524a / Circle 1.7.0，只验收 hub 协议；Circle 打包客户端独立绑定 v1.7.1 / 259364f。v1.7.0 tag 的发行遇到刷新视图时序失败，保留该 tag 而未发布，1.7.1 仅在原集成上加入已合入主线的独立刷新修复。packs 的工具名消费者独立升版，发行不自动激活新模块。

- 2026-10-15：Hub v0.1.0（8f3b839）、packs v0.1.0（1f8948c）及 Hub v0.2.0（2f9cd20）已发布。7420 滚动到 v0.2.0 的同一提交；19 条历史任务与 2450 份原件前后 SHA 不变，旧回执只读。模型配置不变的脚本 runtime 升到 fd8524a / 1.7.0，新 profile 由另一身份批准，旧 profile 字节不改；没有新模型或设备任务。Circle 打包发布和应用安装另按其正式发行页与本机回执核验，不以 tag 或排队冒称已交付。

- 2026-10-15：Hub main a0a42bb 的完整全开电池实际退出 0，contracts 20/20、methods 282/282、acceptance 403/403、references 7/7，共 712 项，全部零 fail / skip；同提交三项 CI 成功。Circle 1.7.1 曾安装到本机，实际界面发现冷启动集成未加载及超限视图丢对象两个问题，其正式发行取消，没有 1.7.1 Release。客户端绑定改为 1.7.2 / 1914c58，修复可信启动初始化与完整视图字节投影，RPC pin 仍为 fd8524a；正式发布与本机应用验收按各自回执判断，不能由版本绑定代替。

- 2026-10-15：1.7.2 / 1914c58 已在本机通过冷启动与大视图验收；随后隔离环境确定性证明关闭后后台读仍可能重建目录，正式 Release 取消，原 tag 保留。客户端绑定改为 1.7.3 / ae0b0d5：待安装宿主有界 drain、token 异步返回后 abort 检查及 closed dataDir 不创建目录三层保护；三条旧实现红例与九项修后定向检查分列。Windows 的一次 ENOTEMPTY 不据此唯一归因，临时目录清理重试不替代关闭后真实副作用断言。固定 RPC 提交与 Hub 的源码、包、迁移和既有业务结果均不变。

- 2026-10-16：维护者决定撤除改名前 Hub 环境变量的弃用回退，改名前的名字不再在任何地方受支持。Hub 进程只读取 `CIRCLE_HUB_*`；server、supervisor、worker、CLI 或开发与 PostgreSQL 脚本的环境中仍有旧前缀变量（值为空或已同时设置新名也算）时拒绝启动，错误逐个给出对应的 `CIRCLE_HUB_*` 名，不输出值。仍以旧名配置的既有部署，须先改用 `CIRCLE_HUB_*` 名重新部署，才能升级到这一变更之后的版本。Circle 扩展协议、固定 RPC 验收提交、路由、schema 与迁移不变。

- 2026-10-21：旧的任务与审批服务器实现退役（00a5022），Hub 按通用模型重建为标准 MCP 服务器（建设中）；本页的现状、合约和发布顺序改按新设计写，旧内容改列在“已退役”一节。Circle 作为普通 MCP 客户端连接，不再需要 hub 扩展。先前临时部署的历史记为丢失，不迁移。
- 2026-10-22：Circle 一行写明修改 Circle 需要所有者明确授权和范围；恢复“Ubuntu CI 跳过的隔离与平台用例不算通过”的说明，改按重建后的沙箱、钥匙串、launchd 和备份恢复写；写明各包改了自己的合约文件后由谁重新生成。
- 2026-10-29：CI 说明改为现状：Ubuntu 单元测试任务安装 PostgreSQL 18 客户端，备份、恢复和部署在那里运行；需要 macOS 的用例由不在拉取请求上触发的 `macOS-only paths` 工作流运行。
- 2026-10-29：包内函数的沙箱用例改由 `Linux isolation` 任务在每个拉取请求上以 bubblewrap 与 AppArmor 运行；隔离一节写明 Linux 上的这一层。
- 2026-11-03：加“密钥存放”一节（决定 137：不再用 macOS 钥匙串，每个平台都用密钥文件，`CIRCLE_HUB_KEYCHAIN_SERVICE` 和 `_ACCOUNT` 停用）；CI 说明不再把钥匙串列为只在 macOS 上运行的路径。
- 2026-11-03：按所有者当天批准，拉取请求只跑快的检查，单元、验收和 `Linux isolation` 的分片改在合并队列和推送到 main 时运行；拉取请求的新推送取消它的旧运行，其他运行从不取消。
- 2026-11-04：发布 hub v0.3.0，重建后的第一个发行，带 macOS 和 Linux 的一键安装包；所有者的持久部署从这天起由 main 部署（决定 145）；合约一行改正为模型第 37 版。
- 2026-11-05：合约一行改正为模型第 40 版。AGENTS.md 写明兼容性事实变化时本页和英文页在同一个拉取请求里更新。Hub 的迁移到 31，加运行状况和追踪用的表。Circle 1.14.0 的打包版在模型请求超时后不重试，修复随 Circle 的下一版发布。
- 2026-11-09：MCP 标准授权加设备码（RFC 8628，所有者当天的决定）：授权服务器元数据声明 `device_authorization_endpoint` 和设备码授权；客户端在 `/oauth/device_authorization` 取设备码和用户码，用户在控制台 `/console/device` 输入用户码，经同一个授权页确认，客户端轮询 `/oauth/token` 取得令牌。授权码流程不变；登记时客户端仍须带回调地址。
