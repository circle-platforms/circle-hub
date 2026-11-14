# 兼容矩阵

英文译文在 [compatibility.en.md](compatibility.en.md)，两者有出入以中文为准。

三个仓库各自版本化：circle（agent）、circle-hub（MCP 服务器）、circle-packs（包）。谁依赖谁、以什么为准，都写在这里；改动任何一行都是一次有意识的升级，不是顺手为之。

## 现状（2026-11-14）

| 部件 | 版本 / 提交 | 以什么为准 | 说明 |
|---|---|---|---|
| circle-hub | 网页控制台（管理员也在这里管理 Hub；工作流与技能页面迁至 `/console/workflows` 与 `/console/skills`，新增 `/console/team` 与 `/console/teams` 别名；`/console/api/*` 仅保留 `GET /console/api/stream`，一次性登录链接已退役；新增 `/console/rebuild` 与 `/console/settings?tab=hub#reset-rebuild` 重置重建界面）、自带 HTTPS、一键安装脚本、个人知识空间与全 Hub 共享的公共空间、团队与工作流／业务系统资源分配（含全 Hub 范围包读取修复 `packsFor(WHOLE_HUB)`）、按名字引用的独立密钥库元数据与 `VaultReadinessError` 非阻塞启动诊断（不登记使用者；更新业务系统地址不再要求重新输入密钥，已有密钥按管理员配置的新地址发送）、声明式部署（`circle-hub apply` / `export` 与 `deployment@2`、`deployment-sync-intent@1`）、受保护重置与不兼容库降级启动（`circle-hub reset` 写入可试恢复的 `circle-hub-backup@3` 标准备份、`needsRebuild` 503 门禁、`init-admin --password-stdin` 原子替换旧操作令牌）、确定错误的派发拒绝诊断（“放行条件里有 N 条错误。”），以及版本 1 基线（今晚不启用M2迁移或测试环境新分配守卫）；发行 0.3.0（2026-11-04）是重建后的第一个发行，带安装包；此前的 0.2.0 是已退役的服务器 | [Hub r4 进度](hub-r4-progress.md) | 所有者的持久部署自 2026-11-04 起从 main 部署（决定 145），私有集成分支已封存；团队暂不设各自独立的知识空间或记忆，只用于工作流与业务系统资源分配；`reset --definition` 在清空全部账户的重置前于预览阶段拒绝（须走 `reset --scope all` → `init-admin` → `apply` 三步路径）；为密钥增加可发送目标地址约束列入路线图；当前已知四处待修缺陷（选择性 `reset` 吞 `ResetBlocked.problems`、`export` 含内部编号且未发包缺 `directory`、`apply` 缺少原子预检与实体名提示、`/console/rebuild` 文案写 `setup-code --rebuild`）记入今日“历史”；2026-11-13 重整变更待合入后随下一次发布与部署生效 |
| 合约 | 通用模型第 82 版（`MODEL_VERSION`）；6 个 MCP 工具输入 schema 未变更、输出 schema 允许保留额外字段 | `contracts/model.json`、`contracts/codes.json`，生成物在 `contracts/generated` | `npm run verify:contracts` 核对生成物与来源一致；`SCHEMA_REGISTRY` 新增 `team-id@1`、`team-assignment-subject@1`、`resource-assignment-subject@1`、`secret-sidecar@1`、`secret-metadata-file@1`（并将 `VariableUse` 区分为普通变量 `var` 决定与 `{ kind: 'secret', name, version }`）、`deployment@2`、`deployment-sync-intent@1`、`protected-deployment@1`、`reset-scope@1` 与 `reset-scopes@1`；词表新增 `reset_scope` 轴（`history`、`knowledge`、`packs`、`config`、`all`），`permission_kind` 新增 `resource_assign`（业务系统资源分配），`knowledge_space_kind` 与 `knowledge_search_scope` 将 `team` 显示为“公共空间”（内部代号仍为 `team`）；不兼容重置后 `keys/` 与 `vault/` 保持保留 |
| MCP | `@modelcontextprotocol/sdk` 1.32.2 | 根 `package.json` | 六个工具，streamable HTTP；MCP 标准授权（授权码或设备码）或 Bearer 令牌 |
| Circle | 作为普通 MCP 客户端连接，不需要 hub 扩展 | MCP 协议与工具的 schema | Circle main 已合入六项通用 MCP 客户端改进并删去内置 Hub（circle#309，2026-10-26）和按 MCP 标准授权在浏览器登录（circle#396，2026-11-02）；Circle 里不出现 Hub 专用的界面或标签（D06 R[1]）；修改 Circle 需要所有者明确授权，范围见 [AGENTS.md](https://github.com/circle-platforms/circle-hub/blob/main/AGENTS.md) |
| circle-packs | 见其 CHANGELOG | circle-packs 仓库 | 存放已退役服务器用的包（`modules.json`、`product-line/1`、`hub-*/1`），重建后的 Hub 不读取它们；第一个里程碑不改这个仓库 |

## 包函数的隔离

按 [Hub r4 架构](hub-r4-architecture.md)，任务包里的函数在受限的子进程里运行（由 rules 包实现，待复核）：Node 权限模型禁止写文件和起子进程，只许读解压后的包；架构简报记录了在 Node 24.17 上核实过权限模型不限制网络，所以子进程另在 macOS `sandbox-exec` 下运行并禁止网络；另有时间、内存和输入输出大小的限制。在 Linux 上，这一层是 bubblewrap 加管理员装载的 Hub AppArmor 策略（见 [rules 包说明](https://github.com/circle-platforms/circle-hub/blob/main/hub/rules/README.md)）。没有可用的操作系统隔离的地方默认拒绝运行包内函数（`SANDBOX_UNAVAILABLE`）。其他平台上的等价隔离尚未确定。

公开 CI 在 Ubuntu 上运行。拉取请求只跑快的检查（`Types`、`Generated contracts match the model`、`Docs and CI checks`；其中 `Docs and CI checks` 以完整 Git 历史 `fetch-depth: 0` 运行 `npm run test:docs`，包含 `package-boundaries`、`package-cycles`、`core-names-no-pack`、`no-compat-paths`、`doc-set` 与浅克隆失败关闭的 `pack-version` 检查，`Reference archive` 已移除）；完整的测试由合并队列在将成为 main 的那个提交上运行，每次推送到 main 也再跑一遍。在拉取请求上，各分片和汇总它们的检查（`Unit tests`、`Acceptance on a temporary PostgreSQL`、`Linux isolation`）都跳过，必需检查把跳过算作通过；在合并队列和 main 上，每个汇总检查要求它的所有分片都通过。默认单元测试（`npm run test:unit`）不再纳入 `scripts/**/*.test.ts`（`scripts/real` 真实系统／诊断脚本）；单元测试任务从 PostgreSQL 的 apt 源安装 18 版客户端，所以备份、恢复和部署的用例在那里运行。包内函数的沙箱用例，包括对真实监听的本机服务器验证的断网，由 `Linux isolation` 任务运行：合并队列和每次推送到 main 都会触发，它安装 bubblewrap 和 AppArmor，为本任务的 Node 生成并装载 Hub 的 AppArmor 策略，隔离不可用就直接失败，然后运行按跳过条件从源码选出的单元和验收测试文件。它不改 `kernel.apparmor_restrict_unprivileged_userns`，启动器策略自带的 `userns` 规则已经够用。其他单元和验收任务没有隔离，这些用例在那里跳过。Ubuntu 上没有 `sandbox-exec`、plutil 和 launchd，所以 `sandbox-exec` 本身、plutil 和 launchd 的检查在 Ubuntu 上跳过；密钥文件在每个平台上都一样，它们的用例在那里运行。这些用例由 `macOS-only paths` 工作流在 `macos-15` 上运行，沙箱用例也在那里经 `sandbox-exec` 再跑一遍：每次推送到 main、每晚一次，也可以手动触发；拉取请求不触发它，它也不是必需检查。所以合并队列的检查是 bubblewrap 与 AppArmor 下沙箱的证据，但不是 `sandbox-exec`、plutil 和 launchd 的证据；拉取请求自己的检查对两者都不是证据。跳过不算通过；每个阶段仍在本机 macOS 上完整运行一次，命令、计数和跳过的用例记在 [Hub r4 进度](hub-r4-progress.md)里。CI 的任务摘要列出每个跳过的用例。

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

各仓库的标识改名和兼容基线变更都是单独的决定，各留一条记录在本页的“历史”里。

## 已退役

下列内容属于已退役的任务与审批服务器（截至 0.2.0），对重建后的 Hub 不再成立或不再相关，原表见 Git 提交 `ca66002fb6bfc3220547d0fdd895bfae83345943` 的本页：验收用的 Circle 运行时 fd8524a 及 `CIRCLE_BIN` / `CIRCLE_COMMIT` 门禁；Circle 发行绑定 v1.7.3 和 hub 扩展的目标基线；hub 扩展所用的客户端接口（客户端接口交接，见 Git 历史）；hub 验收用的 circle-packs 原件，以及 circle-packs CI 固定的 hub 依赖集；执行网关 cexg；产品包 Tool/Hook 的 macOS seatbelt 进程隔离及其验收路径；`circle-packs/modules/1`、`product-line/1`、`hub-*/1` 与 `/mcp` 端点这些 schema 和契约；“hub 先、circle 的 hub 扩展随后、packs 最后”的旧发布顺序。

自 2026-11-13 起退役并移除的参考与归档内容：`foundation/circle`（Circle 1.0.4 源基线，原上游提交 `9d23c09a0f8de2f71920b32b23db9af6c9a41100`；`NOTICE` 与 `THIRD_PARTY_NOTICES.md` 改为指向该上游仓库与许可链接以保留署名）、`references/`（含 `source-manifest.json`）、`tools/verify-reference-archive.ts` 与 `.test.ts`、`npm run verify:references` / `test:references` 脚本，以及公开 CI 的 `Reference archive` 检查任务。

同日（2026-11-13）另退役并移除：控制台 `/console/packs`（含 `/console/packs/<id>` 与 `/console/packs/-/publish`）以及第二处管理入口页 `/console/admin`、`/console/admin/packs`、`/console/admin/resources`、`/console/admin/secrets`、`/console/admin/knowledge` 与 `/console/admin/calls`（工作流改至 `/console/workflows`，通用技能改至 `/console/skills`，团队页改在 `/console/team` 与 `/console/teams` 别名；`/console/admin/jobs/<id>`、`POST /console/admin/do/*` 与 `/console/results` 在当前基线仍保留）；控制台 JSON 读写接口（`hub/server/console/api.ts` 与 `api-write.ts`，`/console/api/*` 下仅保留 `GET /console/api/stream`）及一次性登录链接（`POST /console/api/login-links` 与 `/console/login/<code>`）；密钥使用者／发送地址登记（`SecretConsumer` 及记录库作为密钥值／版本权威的旧路径）；数据库历史 1–33 号增量迁移合并为新库单一 `baseline`（`version: 1`），并删除 8 份历史升级专用测试、旧 CLI 技能绑定命令（`skill bind-legacy` 与 `pack bind-skills`）、仅用于测试的解析器基线兜底及已退役的 `v1` 编译校验脚本；同日 17:15 所有者决定撤回旧库自动升级设计（`circle-hub upgrade` 分支未合入主线，转为“重置和重建”路径，密钥就绪诊断亦不再指向不存在的 `upgrade` 命令）；307 份过时过程文档退出文档集（改为按 `.github/checks/doc-set.json` 校验固定清单），`scripts/**/*.test.ts` 不再纳入默认 `npm run test:unit`。

## 历史

- 2026-11-14：核心RUN_SUPERSEDED改法更新引起格式技能协议快照重新生成，按集成者15:27授权发布补丁候选：mindmap-format 1.0.25、workbook-format 1.0.23、xml-format 1.0.23、html-format 1.0.22。由各包生成器更新清单大小和摘要，算法与接口不变；case-compile及recompose的mindmap-format内嵌版本声明需由包所有者对齐后才能通过整体合约检查。

- 2026-11-14：按集成者14:57裁定，今晚撤出未获正确交互设计的M2/C2迁移与单独upgrade预检/应用入口，仍只使用原版本1基线；测试环境新分配守卫关闭，保留第二批工作流/预订规则。此前本日有关迁移2/读取级别2的记录仅为未部署候选，不是今晚行为。部署定义@2、运行导出引用、披露和包文件agents/等其余第三批变更保留。

- 2026-11-14：模型82登记五种调用错误类别，协议错误码分类与成句函数统一生成在protocol.ts，server和dispatch共用；类别显示词由labelOf读取。含混码与待裁项保留未分类，SOURCE_UNAVAILABLE保持未知形；本项不改六工具输入结构。

- 2026-11-14：新增保权迁移2与最低读取级别2，升级预览和应用使用操作令牌实际管理员；保权完成与迁移兼容分别核对后才启用测试环境权限守卫。旧的严格读取版本会拒绝新迁移，不能作为保留新权限规则的降级目标。公开部署定义改为唯一deployment@2，执行器以管理员显式名字区分同一目标上的多条定义；不转换deployment@1，受保护恢复格式保持独立。upload_file说明明确普通工作簿使用declared，client_captured只用于操作记录喂入、不作普通运行输入；输入取值未变。

- 2026-11-14：模型81在包文件允许路径中增加agents/，用于随包保留子代理定义；现有包无需增加文件。文件仍按清单核对大小和摘要，目录与链接限制不变。此变更不增加Hub的子代理执行能力。

- 2026-11-14：运行资料导出 run-export@1 增加运行记录引用 run_reference 与可沿用已受理结果引用 accepted_result_reference。结果按开始运行的已受理提交选择规则读取，并与正文同记录；导出身份限制不变，不新增按运行编号补齐所有输入的能力。

- 2026-11-14：部署定义 @1 允许同一目标上的多个执行器，导出完整保留各执行器。应用定义时有编号的仅按编号核对；未指定编号且目标不唯一，或多条声明解析到同一执行器，均在配置写入前拒绝。未新增格式转换或数据库迁移。

- 2026-11-14 第二批：成员权限与环境分配只读投影、管理表单和原因诊断已接线；新的环境分配执行守卫固定未启用，原工作流权限、租约、血缘和核对不变。本批不含新数据库迁移或保权写入器；旧版仍可读取本批的原有数据，exe 分配目前仅为预览。服务关停会释放装配拥有的租约连接池，并在原预算内等待运行资料响应完整发送；不宣称任意强杀或真实设备跨重启自动恢复。
- 2026-11-14 第一批：关停在原预算内等待已受理请求及其响应完成；入场前拒绝返回 503 与 Retry-After。MCP 不支持的后续协议头保留 SDK 状态码并给可操作说明；tools/list 只增加 HTTP 私有不存储头，不增加私有元数据或承诺客户端缓存失效。管理员可用授权上传引用登记执行器和命名文档，技能安装/卸载可经命令登记表触发；六工具输入、数据库结构和既有权限不变。本条不声明已解决关停后定时器或完成环境权限迁移。

- 2026-11-14：模型80新增 `resource-assignment-subject@1`，`resource_assign` 可向账户、团队或全体明确分配 `exe_` 测试环境；旧团队主体合同与普通业务系统资源的分配边界保持不变。环境使用判定重读当前账户和授权，管理权不等于使用权。

- 2026-11-14：`list_task_packs` 增加 `member_capabilities` 成员权限投影，与控制台使用同一读取入口；`submit_result.dispatch` 增加派发结果、缺失事实和下一步的结构化诊断，按实际调用者角色过滤。六个工具的输入格式不变；新增输出字段不表示客户端已消费，也不表示环境已就绪、作业已执行或设备通过。

- 2026-11-14：case-compile 本地版本升为 3.19.1：SKILL.md 第 3 节合并命令块把 `fidelity-brief` → 新子代理写 `.verdict.json` → `fidelity-apply` → `submit-plans` 串在同一流程，authoring-brief 计划外壳说明草稿交 Hub 前走完保真核对，`submit-plans` 本地复用 `functions/fidelity.ts` 预拦 `fidelity_missing`、`fidelity_stale` 与 `fidelity_shape` 并打印三步指令（不把必拒草稿发给 Hub 消耗修复轮次，Hub 核对仍为准）；另在 SKILL.md 明示先查 `contract.json` 的 `cell_inputs`/`cell_methods` 并厘清 `RESTORE_FROM` 对 `{}` 的表述；同时为 `functions/text.ts` 与 `functions/project.ts` 补齐拒绝 `pointer`（如 `/parameters/plan_run`、`/inputs/plan_result`、`/inputs/workbook`，不再回落到 `/inputs/subject`）并在 SKILL.md 与 `tables/codes.json` 分行写明脚本合并第二次 `start_run` 的 `predecessor`、`parameters.plan_run`、`inputs.plan_result`、普通上传 `inputs.workbook` 及通过 `submit-plans` 重交；`tables/runtime-profile-format.json` 保持不变以不改变既有角色校验；同步生成器身份、四份合成工作簿样例和清单。未发布或部署，其它包版本不变。
- 2026-11-13 晚：同步行为变更与当前基线已知限制。派发拒绝文案（`hub/dispatch/refusal-text.ts`、`hub/server/text.ts`）改为“放行条件里有 N 条错误。”：只列出已确定判定为错误的条目，把受阻未核对条目汇总为一句“另有 M 条因为上面的错误还没有核对。”，披露双边期望/实测值（对非管理员隐藏执行器期望、保留运行侧核对值）并按发起人／管理员身份给出下一步建议，已诊断拒绝不再附带“原因还没查清”或“已记下”。重置前备份（`hub/platform/reset/backup.ts`）改为先校验应用角色权限并写出可试恢复的 `circle-hub-backup@3` 标准备份。空库无管理员时执行 `circle-hub apply` 不改动配置并明确指引先运行 `circle-hub init-admin [<名字>] --password-stdin`（说明会自动原子替换旧操作令牌）。**安全行为变化**：修改业务系统资源的地址（`origins` / `allow_plaintext`，`hub/connectors/resources.ts`）不再强制分开或要求重新输入密钥，已有按名字引用的密钥库密钥将直接发往管理员配置的新地址（为密钥增加目标地址白名单约束列入路线图）。同时记录当前基线待修的四处已知缺陷：选择性范围 `reset`（`history`/`knowledge` 或被配置引用的 `packs`）失败时吞掉 `ResetBlocked.problems`；`export` 在 `teams[].members` 输出内部 `usr_…` 编号且未发布包缺 `directory`；`apply` 缺少全文件原子预检且差异提示仅有下标路径、缺少实体名字；`/console/rebuild` 文案仍写未实现的 `circle-hub setup-code --rebuild`（实际直接用 `circle-hub setup-code`）。
- 2026-11-13：依 17:15 所有者以“重置和重建”取代自动升级旧库的决定与 18:50 批准，通用模型升至第 79 版（新增 `reset_scope` 词表轴：`history`、`knowledge`、`packs`、`config`、`all`），六个 MCP 工具输入 schema 与模型描述不变、输出 schema 改为允许保留额外字段（C7）；`contracts/generated/schemas/` 新增 `deployment-sync-intent@1`（共 154 份 schema 文件），`deployment@1` 增加可选 `knowledgeSync` 目标；重置编排迁入 `hub/server`（`hub/platform` 仅保留备份、归档与建空库原语），`apply`/`export`/`reset` CLI、启动期 `needsRebuild` 503 门禁与 `/console/rebuild`、非阻塞 `VaultReadinessError` 启动降级、异步 `/console/reset/*` 状态查询、`init-admin --password-stdin` 空输入拒绝与无管理员时原子替换旧操作令牌已接线（清零账户的 `--scope all` / 非 `--keep-config` 重置不再接受 `--definition`，改由三步恢复路径完成）。
- 2026-11-13：入库控制台重置界面与路由（`hub/server/console/reset.ts` 与 `reset-actions.ts`：`/console/rebuild`、`/console/settings?tab=hub#reset-rebuild`、`rebuildNeededBanner`、`POST /console/admin/do/reset` 的 `RESET_ACTIONS` 及 `ConsoleOptions.rebuildNeeded`）。
- 2026-11-13：入库声明式部署与受保护配置快照实现（`hub/server/cli-apply.ts` 的 `applyDeployment`、`exportDeployment`、`applyCommand`、`exportCommand`、`exportProtectedConfiguration`、`applyProtectedConfiguration` 与 `createResetConfigurationPorts`，在 `private-config-snapshots/<uuid>.json` 生成 `0600` 权限快照）。
- 2026-11-13：新增 C12 密钥库就绪诊断（`hub/records/errors.ts`、`hub/records/vault.ts`、`hub/connectors/connectors.ts` 与 `hub/server/variables.ts` 的 `VaultReadinessError` 与 `VaultReadinessIssue`）：公开错误剥离密钥名与条目标识，仅在私有连接器说明及 `var`/`secret` CLI 诊断中输出 `.issues` 与 `.adminMessage` 并指引恢复 `vault/metadata/<entry>.sealed` 或归档覆盖重设 `circle-hub secret set --name <name> --reason <理由>`（当前基线不存在 `VAULT_ENTRY_MISSING` 或 `VAULT_METADATA_CORRUPT` 协议错误码）；修复 `hub/records/authorizations.ts` 中 `packsFor(WHOLE_HUB)` 对全 Hub 产品启用与技能安装的读取；新增 `npm run test:quick`（`tools/quick-test-set.ts`）。
- 2026-11-13：`SCHEMA_REGISTRY` 与 `contracts/generated/schemas/` 新增注册 `deployment@1`、`protected-deployment@1`（`contracts/src/deployment.ts`）、`reset-scope@1` 与 `reset-scopes@1`（`contracts/src/reset.ts`），并更新 `contracts/src/variables.ts` 版本递增校验提示用词。
- 2026-11-13：通用模型从第 51 版升至第 78 版（`MODEL_VERSION`）：第 52–74 版新增 `team-id@1` 与 `team-assignment-subject@1`、`permission_kind` 的 `resource_assign`（业务系统资源分配）、`knowledge_space_kind` 与 `knowledge_search_scope` 的“公共空间”标签（内部代号 `team` 不变），按决定 172 补充 `C02` 三个归属问题、标明 `T03`/`V01`–`V08`/`K01`–`K05`/`P05` 迁移边界、补正 `C9` 归属并取消 `P11` 旧包免检豁免；第 75–78 版按 C12 取消密钥使用者登记与记录库取值依赖，资源和执行器只按 `${secret:名字}` 引用密钥库认证元数据。
- 2026-11-13：密钥库元数据独立于记录库（C12）：新增 `secret-sidecar@1` 与 `secret-metadata-file@1` schema，`secret@1` 去除 `consumers` 并改由密钥库认证保存版本、`digest_rule`、长度、`set_by`、`set_at` 与 `revoked`（未知设置人或时间保持 `null`）；`VariableUse` 将普通变量 `decision` 与密钥 `{ kind: 'secret', name, version }` 分开记录；连接器、派发、知识与控制台设置页改按名字读取认证后的密钥库版本，不再校验使用者列表。
- 2026-11-13：新增团队管理与业务系统资源分配（六项所有者规则：多团队并集生效、保留直接按账号分配工作流、删团队时逐条追加撤销决定而不取消已冻结运行或远端作业、团队暂不设各自独立的知识空间或记忆、普通成员只见自己所在团队名字、未分配业务系统资源默认拒绝包括管理员在内的所有账号业务读取）；新增 `circle-hub team`、`pack assign|unassign --team`、`resource assign|unassign (--team | --all)` 命令与控制台 `/console/team`、`/console/teams` 页面及操作；共享知识空间页面与提示文字统一改称“公共空间”。
- 2026-11-13：`hub/records/migrations.ts` 将 1–33 号历史增量迁移合并为新库单一 `baseline` 迁移（`version: 1`，包含 `teams` 与 `team_members` 表）；删除 8 份历史升级专用测试、旧 CLI 命令 `skill bind-legacy` 与 `pack bind-skills`、仅用于测试的解析器基线兜底，以及 `scripts/real/` 下已退役的 `v1` 编译校验脚本。
- 2026-11-13：控制台将工作流页面与技能页面分别迁至 `/console/workflows`（含 `/-/publish` 与详情页）与 `/console/skills`，退役 `/console/packs` 与第二处 `/console/admin` 页面入口（`/console/admin/jobs/<id>`、`POST /console/admin/do/*` 与 `/console/results` 在当前基线仍保留）；删除 `api.ts` 与 `api-write.ts`（U5，`/console/api/*` 仅保留 `GET /console/api/stream`）并退役 `POST /console/api/login-links` 与 `/console/login/<code>`；新增共享命令参数定义（`hub/server/command-parameters.ts`）与管理表单生成器（`hub/server/console/command-form.ts`，U2）；拆分 `hub/server/console/index.ts` 为职责明确的请求与页面模块。
- 2026-11-13：`Docs and CI checks`（`npm run test:docs`）新增 5 项校验（`package-boundaries`、`package-cycles`、`core-names-no-pack`、`no-compat-paths`、`doc-set`），`docs` CI 任务改用 `fetch-depth: 0` 完整历史以让 `pack-version` 在浅克隆下失败关闭；按 `.github/checks/doc-set.json` 固定文档集（清理 307 份过时文档并新增 `docs/quickstart.md` 与 `docs/edit-pack.md`）；`scripts/**/*.test.ts` 退出默认 `npm run test:unit` 套件。
- 2026-11-13：移除仓库中的 `foundation/`（Circle 1.0.4 源基线）与 `references/`（含 `source-manifest.json`）及校验脚本 `tools/verify-reference-archive.ts`（含测试）；从 `package.json` 退役 `verify:references` 与 `test:references` 脚本并自 `test` 中移除；从公开 CI（`.github/workflows/checks.yml`）与检查脚本移除 `Reference archive` 任务及相关路径豁免；`NOTICE` 与 `THIRD_PARTY_NOTICES.md` 改为引用上游 `qingshanfeihu/circle`（`9d23c09a0f8de2f71920b32b23db9af6c9a41100`）仓库、MIT 许可与第三方声明链接以保留适配代码的署名。
- 2026-11-13：case-compile 本地版本升为 3.19.0，顺序步骤 expects 增加可选 op:not_found，按已声明执行器方法生成及回读不存在检查；文字来源限本条原始期望，或本条配置后按有向逆操作撤销的名字。不改变分块写法和复核规则，其它包版本不变，未发布或部署。

- 2026-11-13：case-compile 本地版本升为 3.18.4，恢复模型判断期望的设备原话要求：text 为设备实际会输出的一行原文，对应原始期望及选择理由写入 rationale；同步生成器身份、合成样例摘要和清单。其它包版本不变，未发布或部署。

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
- 2026-11-10：模型到第 41 版（决定 150）：已受理的新提交下发请求时，同一运行此前各次提交下发、仍在等待回应的请求作废；请求显示状态加“已作废”。记录种类、协议码、MCP 工具和迁移都不变，已有的请求记录不改写。
- 2026-11-10：模型到第 42 版（决定 152，所有者 2026-11-05 定）：业务系统的应答里有未核看的疑似凭据、而这个应答能说明对象存在时答“X 存在，内容待核看”，新增协议码 `SOURCE_PENDING_REVIEW`，`system@1` 加可选读取字段 `object_route`。这项改动在自己的分支上是模型第 41 版、决定 149，合入 main 时顺延。source-read 工作流源码升为 0.1.9：0.1.7（内容待核看）和 0.1.8（规格目录入口）两处改动之和，行为没有再变。
- 2026-11-11：模型到第 43 版（决定 153）：存下校验结果时另追加一条结果摘要记录，新增记录种类 `result_summary`（`result-summary@1`）；任务列表和总览的统计读摘要而不读整条结果，已有的结果记录不改写，没有摘要的结果照旧读整条结果，后台补写。协议码、MCP 工具和词表轴不变。同一天 Hub 的迁移在主线上编号 32（#319）：给已存的请求和了结请求的记录补两种索引项（`runs.request.settled`、`runs.request.plain`），只加索引项，不改记录；摘要记录本身不需要迁移。2026-11-12 与我们线合并时该迁移改号为 33（我们线的 `feeding_node_index` 保留为 32）。
- 2026-11-11：模型到第 44 版（决定 154，issue #194）：来源内容不再做凭据扫描，不因看起来像凭据而只保留、拒收或送管理员核看。业务系统的应答、成员上传、写进知识空间和记忆的文字、运行参数、要派发的内容，都照原样交给有权读的人、包函数和模型。对外可见的变化：`upload_file` 不再因内容像凭据返回 `CREDENTIAL_IN_UPLOAD`；读业务系统不再因此返回 `SOURCE_PENDING_REVIEW` 或只保留；记忆和知识空间的写入不再返回 `MEMORY_CREDENTIALS_DETECTED`、`SPACE_CREDENTIALS_DETECTED`；`start_run` 不再因参数像凭据拒绝。这些协议码仍然登记，此前存下的记录和回执里有它们。新记录的扫描结论写 `credential-scan@4`（不检查、无命中）。此前按 `credential-scan@3` 存下并命中的记录不改写，指名读它时仍是原档位；同一内容重新读取或上传会产生可读的新记录。不变的部分：Hub 自己写下的东西（调用日志、备注、资源与执行器配置、变量、包文件）仍不写入凭据；Hub 发出的密钥被应答回显时仍只保留。记录种类、MCP 工具、词表轴和迁移都不变。管理员可配置的遮盖字典是后一步，还没有做。
- 2026-11-11：模型到第 45 版（决定 157，issue #34）：把“通用技能包”写进模型原文（C02 的定义和 R[2]、T01 的定义），新增 C02 R[3]：Hub 核心不导入产品包的代码，需要直接用一项通用能力时只经通用技能包的公开入口，并在产生的记录里写明所用技能包的包名、版本和模块的 SHA-256。对外可见的变化只有一处：由 Hub 自己的目录遍历绑定来源的知识生产（`knowledge seed`），生产记录的 `detail` 多一个可选项 `directory_skill`（`id`、`version`、`module`、`sha256`），命令输出多一行“目录遍历 …”。此前的生产记录没有这一项，不补写。记录种类、协议码、MCP 工具、词表轴和迁移都不变。
- 2026-11-12：模型到第 46 版（决定 158，所有者采用界面用词评审表）：只改文字。词表 `attribution` 的标签由“归责”改为“原因归类”；`entry_kind` 的 `pitfall` 标签由“教训”改为“常见误区”；`source_attribution_status` 的标签和两个取值由“署名”改为“确认”（未确认／已确认为团队来源）；`sync_mode` 的 `local` 多一个界面用语“仅保存在客户端设备”，标签不变。协议码 `SHARE_UPLOAD_UNSIGNED` 的说明和修复提示换了文字，代码不变。停用包版本的动作在所有文字里只叫“退役”：`circle-hub pack retire` 的输出、发布校验的拒绝说明、`start_run` 读不到包版本时的说明、结果有效条件里的“（版本已退役）”，原来写“下架”。读旧结果时的两条提示改为“下一步处理安排未记录”“未写明缺少什么”（原来是“出口未写”“缺失事实未写”），按文字匹配这两条提示的客户端需要跟着改。记录种类、取值代码、协议码的代码、MCP 工具和迁移都不变；已存的记录不改写。四个通用技能包重新签名（xml-format 1.0.21、html-format 1.0.20、mindmap-format 1.0.21、workbook-format 1.0.21），knowledge-contribution 升为 1.3.21。
- 2026-11-12：模型到第 47 版（决定 159，issue #194 第二步）：管理员可配置的遮盖字典。Hub 经连接器读业务系统的文本应答时，命中规则的片段先换成“[标签已遮盖 *****]”再保存，只保存替换后的字节。对外可见的变化：配置了规则之后，`start_run` 的来源、`get_nodes` 和 `resolve_reference` 给出的业务系统内容里，命中的片段是占位而不是原值；这些原文的 `sha256` 是替换后字节的摘要；原文记录多一个可选字段 `masking`（`dictionary`、`rules[].rule`、`rules[].count`），只有被替换过的应答才有。没有配置规则或没有命中时，内容、摘要和记录与以前完全相同。成员上传、写进知识空间和记忆的内容、同步内容、运行参数和派发内容不替换。新增命令 `circle-hub mask list | set | remove | test`。记录种类、协议码、MCP 工具、词表轴和迁移都不变；已保存的记录不改写。
- 2026-11-12：模型到第 48 版（决定 160，#241）：只改显示规则。返回给模型的任务文字里，没有运行的动态层前面的符号由 `？` 改为 `○`（颜色和“未知”的含义不变，`？` 只用于看过而没有结论）；一条要求项没有任何层结果时写“未记录各层结果”，原来是破折号。按文字匹配这两处的客户端需要跟着改。控制台里缺失的值写明原因，不再显示破折号。记录种类、取值代码、协议码、MCP 工具和迁移都不变。
- 2026-11-12：模型到第 49 版（决定 161，issue #194 第三步）：凭据命中的核看、接受和撤回去掉。命令 `circle-hub source` 整个去掉，按它写的脚本要改。读业务系统不再答“X 存在，内容待核看”（`SOURCE_PENDING_REVIEW`），也不再给管理员发核看请求；控制台记录页的“来源核看请求”页签去掉。此前按 `credential-scan@3` 只保留的记录仍只保留，原件只有管理员能用 `circle-hub original export` 取出；此前已经接受的仍可读。要用被扣留的内容，按原对象重新读取，会得到一份可读的新记录。运行里对只保留来源的提示和请求改为“按原对象重新读取”，原来写“管理员接受”，按文字匹配的客户端需要跟着改。协议码都保留登记；记录种类、MCP 工具、词表轴和迁移都不变。四个通用技能包随协议文字升补丁版本（html-format 1.0.21，mindmap-format、workbook-format、xml-format 1.0.22）。
- 2026-11-06（我们线；合并后决定 162 至 164）：团队成为分配的主体（工作流和业务系统资源可分给团队，管理员默认可用全部工作流），每个团队有自己的知识空间和记忆；凭据扫描命中的接受可以以一个业务系统资源为单位，撤回或失效后，产品知识树里依据它的条目显示“没有权限阅读”，不再给文字；词表 `audience_scope` 加取值 `team_members`。没有新的协议码、记录种类或 MCP 工具。当时我们线模型到第 42 版；2026-11-12 并入合并后的第 51 版。
- 2026-11-06（我们线；合并后决定 165 至 167）：工作流由通用技能模块、验收要求和数据绑定组成；`skill@1` 可声明模块，`pack@1` 可声明 `embeds`，发布时核对内嵌文件。没有新的协议码、记录种类或 MCP 工具。当时我们线模型到第 43 版；2026-11-12 并入合并后的第 51 版。
- 2026-11-12：执行器定义的设备读取规则可选声明残留读取命令及收尾、表头、失败行模式；未声明时仍只读取版本和接口。残留或读取结果未知时停止上机验证。
- 2026-11-12：本地集成升至 case-compile 3.17.0、command-tools 1.1.0、recompose 1.2.0、test-bed 1.3.0；共享重组代码对应的 recompose-authority 与 recompose-adjudication 升至 1.1.4。重组结果明确接受旧 1.1.3 和上述新版，生成器与样例同步；技能先于内嵌它的工作流发布。产品命令策略新增可选持久状态与互斥组合，执行器新增可选残留读取及帮助读取声明，投影与运行结果可携带设备帮助，MCP 开始及提交答复的 record 保留记录引用。Circle skill-tool-fields 本地提交 3aa1e6d 支持技能工具范围且所有子代理均无 question；连接仍为普通 MCP。模型和代码表未改，根 hooks 提案未应用；本条是本地兼容记录，不是发布或部署。 MCP 答复使用两块 text：第一块白话，第二块“供模型引用”保留完整答复、原始用例对应及资料缺失上下文，规程也在第二块；Circle 因此能从普通文字内容继续取号。
- 2026-11-12：检查后 case-writers 类型声明修正改变包内文件字节，case-compile 本地候选由 3.17.0 补升 3.17.1，生成器、四份合成 Excel 样例和清单同步；其它五包版本不变。版本安排仍按派活方本轮要求执行，未发布或部署。
- 2026-11-12：验收后 test-bed 帮助说明和拒绝文字移除预订编号，本地候选由 1.3.0 补升 1.3.1，机器参数、字段、前驱绑定及权限判断不变；清单与两份合成样例同步。版本安排为派活方要求，不是发布或部署。
- 2026-11-12 上午：case-compile 本地版本升至 3.17.2，生成器、四份合成 Excel 样例与清单同步。按所有者本人本日上午决定，原始用例的否定结果直接用 not_found，包含本条先捕获再使用的形式，不另立判定标准、不走评审员；其它判据及已有结构检查不变。本次未上线，需第25轮完成后安排。
- 2026-11-12 11:10 更正：原 C1 撤销，运行器合约、测试环境配置和执行器定义不改。case-compile 本地补升 3.17.3：生成侧按本构建手册和命令树用已开放设备命令完成原动作，允许指定名字时复用同条生成值；未增加任意捕获值回填命令参数的能力。生成器、合成样例及清单同步。现有执行器仍指定 3.16.0 的核验身份，与新包不同，上线脚本在实际写入前停止；本次未上线。
- 2026-11-12 11:20：按派活方澄清准备新的执行器副本，仅将 case-compile 核验身份同步为 `case-compile.workbook_verified@3.17.3`。上线脚本先核对候选身份，在六包发布后更新执行器，再安装完整技能。配置 DNSSEC 动作仍关闭，原运行器合约和测试环境配置不变；本次只备副本，没有执行生产更新。
- 2026-11-12 下午：case-compile 本地候选升至 3.18.0，新增 SELECT_CELL 和普通步骤的 input_register。数据行按声明的字面分隔形状识别，多列 where 条件逐格精确相等；G 为人可读参数，H 保存单格、I 在同条用例回填。动态参数另记 command_templates，不伪装成静态值；明确的动态地址位置保留未知。执行侧自有组件 1.0.0 增加 case_submit_cell，原提交工具及共用框架保持，原格式与 runtime-contract@2 分别导出，模板规则标记随新原件重绑定。需独立部署和切换配套执行器规则；当前只有本地代码与合成验证，未发布或部署，其它包版本不变。
- 2026-11-07（我们线；合并后决定 171）：没有任何条件信息的知识条目不再带适用条件字段；当时我们线模型到第 44 版；2026-11-12 并入合并后的第 51 版。
- 2026-11-12：将主线并入我们线并合入 #341：通用模型到第 51 版（第 50 版基础上并入决定 161／模型第 49 版；两边内容都留；六个共用词取主线；我们线的团队空间、技能模块与空适用条件保留）；主线的 `request_listing_indexes` 迁移改号为 33，我们线的 `feeding_node_index` 保留为 32；我们线上曾与主线撞号的决定 150–164 改号为 162–176（决定 149 与主线 152 为同一条，对照表见 [Hub r4 进度](hub-r4-progress.md)）。合约一行改为第 51 版。不是发布或部署。
