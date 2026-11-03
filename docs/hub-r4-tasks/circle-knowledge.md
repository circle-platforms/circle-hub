# 任务：Circle 本机知识库、个人记忆、个人工作流与双向同步（决定 131、135 第四阶段之二，Circle 仓库）

依据：决定 131（所有者原话：“两个都放，前提是circle支持知识库，也支持知识库同步，同步是hub和circle双向的（多客户端可共享，用户自己选择方式）”），决定 135（记忆纳入：个人记忆随本人的各个 Circle 同步，团队记忆供全体成员的 Circle 加载），设计页 [`knowledge-workflows.md`](../design/knowledge-workflows.md)，以及 Hub 端同步接口 [`kw-sync.md`](kw-sync.md)（第 2–9 节与第 13 节的审查结论）写进合约的接口：`contracts/src/sync.ts`、`contracts/src/sync-canonical.ts` 与共享样例 `contracts/test-fixtures/sync/v1/`。界面按《Circle 设计规范》（Circle 仓库 `docs/design/circle-design-system/`）。本页在 Hub 仓库，代码改在 Circle 仓库。

## 做法

- **仓库与分支**：
  - Circle 仓库在上一级目录的 `circle`（`../circle`）。不要动它的工作目录（那里有别人未提交的改动）。
  - 开工前先 `git -C ../circle fetch origin`，再开自己的工作树 `../circle-knowledge`，分支 `knowledge-sync`。
  - 基于工作台视觉统一（决定 142，分支 `workbench-graphite-local`）之后的代码：已合并就从最新的 `origin/main` 开，未合并就从那个分支开，避免两边同时改 `apps/workbench`。
  - PR #396（MCP 标准授权）已于 2026-11-02 合并。
  - 只在本机提交，推送与建 PR 先问所有者（经 Claude）。
- **遵守 Circle 仓库的 `AGENTS.md` 与 `CONTRIBUTING.md`**：
  - 只用临时的 `CIRCLE_HOME`，不碰真实的 `~/.circle`；测试用 `ScriptedModel` 或本地 HTTP 网关。
  - 提交是一句祈使句的英文，`git commit -s`，显式路径。
  - 用户可见的改动在 CHANGELOG 的 `## Unreleased` 写一行；桌面界面文字走 `t('…')` 并给出中文，终端保持英文。
  - `docs/` 只写代码现在的行为，未完成的写进 `docs/known-issues.md`。
- **验证**：
  - 每步跑 `npx tsx --test` 受影响的测试文件。
  - 收尾跑 `npm run check` 和 `npm run check:apps`。
  - 守护测试必须过：工具文档与 `BUILTIN_TOOL_INFO` 一致、提示词预算（`tests/prompt-budget.test.ts`）、命令覆盖（`apps/workbench/test/coverage.test.ts`）。
- **记录**：先在本页“实施方案”写出做法再动手；完成后在本页写明做了的与验证，并在 Hub 仓库 `docs/hub-r4-progress.md` 记为决定 139（Circle 端的实施，依据决定 131、135）。
- **界面用语**：桌面的中文文字按《Circle 设计规范》的“文字”一节，用主流软件的说法（例如“同步方式”“仅保存在本机”“同步到 Hub”“有冲突”“上次同步”“团队记忆”“我的记忆”），不用“你”，不出现哈希、指针、版本号等内部概念。

## 已知的仓库事实（Claude 2026-11-02 只读调查）

- **存储**：
  - 存储统一用 `node:sqlite`。旧版本会把 `circle.sqlite` 的 `user_version` 改回去，所以知识库要放在独立的数据库文件里，遇到更新版本的文件就拒绝打开（参照 `apps/desktop/src/workspace/task-store.ts`）。
  - FTS5 的 trigram 分词至少要 3 个字，两个字的中文词搜不到；不要用 `Intl.Segmenter`，不同运行时的 ICU 版本不一样。建议与 Hub 相同：把文本按两字切分后存入 FTS5，查询也按同样规则切分。
- **两个数据目录**：
  - 终端用 `~/.circle`，桌面用自己的 `runtime-home`（`apps/desktop/src/main.ts:103-110`），两者各算一个客户端，各自与 Hub 同步。
  - 同一数据目录可能被多个进程同时打开，同步只能由一个进程负责，用租约（参照 `src/session_lock.ts`）。
- **后台连接**：
  - 现有 MCP 连接只在模型对话里用（`src/mcp_loader.ts` 的 `McpManager.servers` 是私有的），后台同步要自己的客户端，需要从 `mcp_loader.ts` 导出少量连接函数。
  - 这个文件刚经 PR #396 大改，改动尽量小，并沿用 #396 的连接与令牌刷新方式。
- **设置**：同步方式加在 `src/settings.ts`。注意 `loadSettingsFromDict` 要从原始数据里解析新键（:134），不要放进 `PROJECT_KEYS`。桌面的保存处理在 `runtime-controller.ts` 的 `save-settings`，设置分区在 `apps/workbench/src/model/settings-sections.ts`。
- **技能**：
  - 个人技能在 `<home>/skills`。个人技能的 `hooks.json` 不经确认就会执行（`src/hooks.ts:691-703`），所以从 Hub 同步下来的技能不得自动带入钩子，须本人确认。
  - 同名、软链接和优先级冲突要有明确规则。
- **工具与命令**：
  - 新的模型工具用 `src/tools.ts` 的 `add`，说明写在 `src/prompts/tools/<name>.md`，同步更新 `BUILTIN_TOOL_NAMES` 和工具文档。
  - 斜杠命令加在 `BUILTIN_SLASH` 与 `HANDLERS`，并在桌面的 `COMMAND_UI` 登记。
- **旧 hub 扩展**（1.13.0 删除，`b74af61b^`）：可以借鉴单次在途的令牌刷新、连接状态的写法、下载按哈希校验、指针比较并交换；要避开懒加载、刷新重叠和 64 KiB 的视图上限。

## 要做到的（验收标准）

1. **本机知识库**：
   - 个人条目与原文按内容哈希存放，目录树与版本（当前版本指针）同 Hub 的格式。
   - 有全文检索（中文按两字切分）。
   - 本机用与 Hub 相同的确定性程序核对引文与路径；哈希前的规范形式与 Hub 合约一致。
2. **模型可用的工具**：
   - 在本机知识库里搜索、读取、写入条目，以及对一条已核验的条目发起提交共享（调用 Hub 的提交共享）。
   - 写入工具要经本人确认；搜索与读取是只读的。
   - 任务中仍按地址读取（决定 60），检索只用于问答。
3. **同步**：
   - 用 Hub 的同步 HTTP 接口（`/api/sync/v1/…`），以本人经 MCP 标准授权取得的同一令牌认证，沿用 #396 的令牌存储与刷新。同步不经 MCP 工具，模型调用不到。
   - 同步方式记在 Hub 上，Hub 默认“同步到 Hub”。Circle 读取状态（`GET /state`）并可修改：先预检（`/mode/check`），再切换（`/mode`）。切到“仅保存在本机”前展示预检结果（个人内容量、将失效的分享），本人确认后才提交，并说明本机副本不受影响。终端用 `/knowledge` 命令，桌面在设置里。
   - 补齐对象、分批上传下载、续传、比较并交换、三方合并与冲突标记，都按 Hub 合约与共享样例实现。规范形式与对象编号用共享样例逐字节核对：样例复制进 Circle 的测试并记下摘要，Hub 的样例变了，这边的测试必须失败。
   - 冲突由本人在终端或桌面选定一个版本，或编辑后提交，算一次新的修改。
   - 后台同步有节流与退避，状态显示在页脚：已同步、等待同步中、无法连接、需要重新登录、有冲突。
   - Hub 返回“已切换为仅保存在本机”或代次变化时，停止上传，不把旧的本机快照自动传回。

4. **个人工作流与通用技能**：
   - `skills/` 里的技能可以选择同步：补上 `pack.json` 作为个人通用技能。
   - 个人工作流随个人空间同步。
   - 从 Hub 同步下来的技能不自动启用钩子。
5. **记忆**：
   - 会话开始时自动加载两类记忆，接入 `src/memory_sources.ts` 现有的说明文件机制，受提示词预算（`tests/prompt-budget.test.ts`）约束：
     - 团队记忆：经 `get_nodes.memory` 的会话模式读取；
     - 本人的个人记忆：本机的个人记忆按同步方式，经同一个同步接口（记忆修订对象）与 Hub 双向同步，冲突规则与知识相同。
   - 加载顺序固定：先团队，后个人，最后是本机的 AGENTS.md 等文件。超出预算时如实截断并提示。
   - 他人分享给本人的个人记忆只能查看，不自动加载。
   - 记忆写入工具要经本人确认；拒收（凭据、超限）把原因如实告诉本人。
6. **桌面**：设置里有同步方式与上次同步时间；知识库页面可以浏览、搜索、处理冲突；记忆页面可以查看团队记忆、编辑本人的记忆。页面按《Circle 设计规范》的组件与交互规则实现，界面文字有中文，用语遵守规范的“文字”一节。
7. **测试**：
   - 用 Hub 合约里的共享样例，覆盖：两个客户端交替离线修改与合并、冲突选定、指针竞争、断点续传、哈希不符、令牌过期后重新登录、切换方式。
   - 记忆：团队记忆与个人记忆的加载顺序与截断、同步与冲突、凭据拒收、他人分享的记忆不被加载。
   - 覆盖多个进程同时打开一个数据目录时只有一个负责同步，以及 Windows 上改名失败的重试（CI 覆盖）。

## 实施方案

状态：方案已获 Claude 审查通过（`5b4b29aa`），按第 8 节六阶段实施，第 9 节边界以其后的“Claude 审查结论”为准。Step 0 的提交只有只读调查和本页方案；第一阶段开始安装依赖和实现，实际完成范围见下方记录。每阶段记录命令、首次失败、修正、跳过及边界，完成后先报告。

### 1. 基线、协议来源与改动范围

- Circle 工作树已经由 Claude 建好：`../circle-knowledge`，分支 `knowledge-sync`，当前 `ee7466ed13584e1df6ca75b7f5cfeeeeea5947fc`，与当前本机 `workbench-graphite-local` 同基线；检查时工作树干净。不重新开树、不切换共享检出、不自行重放或变基视觉工作；此前截图证据早于视觉分支变基的说明保留。
- 记录工作树为本树 `circle-knowledge-notes`，本轮只修改本页。Hub 同步树 `../circle-hub-sync` / `kw-sync-local` 始终只读；观察时 HEAD 为 `b1030729e7ab01303aa3b5d2947991c744dca189`，有另一窗口正在修改的 records 文件，不触碰、不提交这些修改。Hub HTTP 在其第 5 步到位以前，用 loopback 假服务器验证 Circle 协议客户端，不能提前声称与真实 Hub 联调通过。
- 已读 Circle `AGENTS.md`、`CONTRIBUTING.md`、`desktop-i18n.md`、TUI 合约，知识/工作流设计，`kw-sync.md` 第 2–9、13 节，以及 `sync.ts`、`sync-canonical.ts`、严格 JSON 实现和共享样例。第 13 节覆盖前文建议：新旧账户默认 `hub`；原文/引文保真；团队独立副本不会因个人清除而撤回；不采用按代次加密。
- 使用现有 Node 24、`node:sqlite`、文件系统、`proper-lockfile`、Ajv、MCP SDK 等依赖，不加依赖。批准后先按锁文件依次运行根目录 `npm ci`、`npm --prefix apps/workbench ci`、`npm --prefix apps/desktop ci`，替换复制来的依赖；记录安装结果，清单/锁文件不变。
- 新功能主要放 `src/knowledge/`（协议、存储、检索、核验、合并、同步、包清单与会话记忆适配）。必要接入限于 `src/settings.ts`、`mcp_loader.ts` / `mcp_auth.ts`、`memory_sources.ts` / `system_prompt.ts`、runtime/tools/审批、现有技能加载、TUI 命令与状态；新增工具说明和相应测试。桌面接入限于 workbench 的导航/页面/设置/状态、model 类型/命令/工具信息、i18n 与样式，以及 desktop 的 runtime-controller、worker/bridge 类型和受限 IPC、原生测试。新增当前行为文档、CHANGELOG Unreleased 与必要的构建资源复制；不更改设计系统、同步协议、Hub 实现、发布流程或依赖。
- 本页承担计划和过程交接；最终把决定 139 的实际完成范围交 Claude 汇入 Hub 总进度，不在本阶段修改其他任务或总进度页。全部测试使用临时 `CIRCLE_HOME` / `CIRCLE_WORKBENCH_DATA_DIR`、合成文件与脚本模型；本机提交均 `-s`、显式路径，不推送、不建 PR、不部署或安装。

### 2. 本机存储、版本与并发

- 使用 `<Circle home>/knowledge/` 下独立的 `knowledge.sqlite` 与私有对象目录，不往 `circle.sqlite` 加表，不复用会把版本降回的旧初始化逻辑。追加本模块迁移，事务检查 `PRAGMA user_version`，较新版本拒绝写入并提示升级；数据库、WAL/SHM 与对象目录均纳入权限和恢复检查。
- 不可变对象保存协议的规范封套字节，以 SHA-256 寻址；来源块保持原始字节，另核对原文的总大小和 `raw_sha256`，不能把封套 ID 当原文摘要。采用同目录临时文件、写完并落盘后原子改名，再在数据库事务中登记引用；中途失败不产生可读的半份对象。无引用临时文件可恢复清理，不能清掉已提交历史或活跃传输所用对象。
- 目录、条目、原文、记忆、包清单都有持久随机 `item_id`，修改/重命名/移动沿用身份；修订记录父项。页和快照按协议排序，空目录也保留。数据库保存快照头、版本关系、当前对象头、冲突、核验观察、搜索投影、传输会话/操作回执、客户端 ID 和同步基准；派生投影可以重建，不把可修改的缓存当正文。
- 本机编辑也使用期望头比较并交换，正文和当前头/索引在同一事务更新；删除写显式 deletion 修订，缺少清单项不是删除。目录环、重复根、归一化后同级重名、移动和删除对新增子项均有检查；冲突保留候选，不擅自改名或丢弃一侧。本人选定/编辑后以全部冲突头为父项写新修订，原版本仍可查看。
- 终端 home 与桌面 `runtime-home` 各有自己的客户端 ID 和库。同一个 home 内的多个进程共享数据库，短事务处理本机写入；同步用基于真实 home 路径的独占租约，参考 `session_lock.ts` 的原子 mkdir/心跳/失效通知，不靠 PID 猜测。持租约者失去所有权立即停止发新请求并停止推进本机同步基准；其他进程只观察状态，过期接管从持久回执恢复。
- 远端关联按选定服务器及已确认授权绑定隔离；不把访问令牌值写入知识库或用作目录名。刷新令牌不新建本机空间；重新登录、换账户/服务器或远端代次变化时先暂停旧绑定，不能把原账户内容自动合并上传给新账户。合约没有可写 owner 字段，客户端不自行添加或信任设备名来判断本人。

### 3. 搜索、读取与本机核验

- 以 SQLite FTS5 存储确定性预分词结果，采用 Hub `knowledgeTokens` 的同一规则：仅检索文本 NFKC、小写化，按 Unicode 字符对切分，单字保留，排序去重，写入与查询一致。不用 trigram 或 `Intl.Segmenter`；两字中文、单字、拉丁文、emoji 边界与混合文本有固定样例。检索归一化绝不用于来源或引文。
- 索引陈述、结构化数据及引文，按目录、类型、状态与适用条件筛选，有界分页。投影增量更新并可重建，未解决冲突默认不作为当前搜索/输入命中。结果显示本机/团队/与我共享的真实范围，搜索不完整时如实提示；仅本机检索不发送搜索词给 Hub。
- 搜索用于问答找线索；任务入口只接受具体不可变地址及锁定版本，不把关键词命中自动放进任务输入。读取按地址核对对象图、目录关系和所需原件，旧地址仍指向旧版本；本机地址与 Hub 的 `tree:` / `src:` / `rec:` 各自保留类型和映射，不凭同步 ID 伪造 Hub 引用。
- 本机确定性核验复用/适配 Hub 的可移植规范编码、路径、片段定位、逐字匹配和凭据扫描算法，记录来源、许可及版本，不 import Hub 的服务、数据库或业务模块。规范 Schema 镜像配现有 Ajv；Zod 的自定义约束（Unicode、base64、排序唯一、长度/图关系等）不能因 JSON Schema 导出未表达而漏验，须补语义校验和反例。
- 解析器必须实际可用且版本匹配才可给出本机“已验证”；先对本轮引入的内置解析器逐个对照 Hub 行为和正反样例，实际支持清单写入文档。只有 pack 清单、缺原文、未安装解析器、错引文或冲突，均显示“待验证”及可处理原因；临时 I/O 则记核验未完成。不得为了核验自动读业务系统或执行下载脚本。
- 引文在所声明解析器定位的原始来源片段上逐字匹配，空白、大小写、NFC 形式都不模糊匹配；来源/引文传输字节不改 BOM、CRLF 或 Unicode。核验观察包含规则/扫描器/解析器版本和具体原因，独立于不可变对象；只证明引文与路径等程序条件，不把陈述含义由判断变成事实。Hub 接收后仍独立重验，本机结果无共享资格的权威性。

### 4. 模型工具、本人确认与工作流

- 拟提供精简的 `knowledge_search`、`knowledge_read`、`knowledge_write`、`knowledge_share` 与 `memory_write` 工具；说明写入 `src/prompts/tools/`，同步 `BUILTIN_TOOL_NAMES`、`BUILTIN_TOOL_INFO`、工具行及文档。只读工具不创建内容或触发同步；有任务锁定上下文时拒绝把搜索作为任务依据。
- 本机知识/记忆写入、删除、启停与冲突解决走现有本人确认机制，展示确切对象和变更；用专门的必须确认路径，不因 auto 模式或普通写权限而绕过本人确认。拒绝/取消不改正文、头、索引或待同步队列。确认后再按期望版本检查，期间有新改动则重新确认，不能覆盖。
- 分享工具只对指定的已验证、无冲突个人条目发起 Hub 现有 `upload_file.share_entry` 操作。先展示去向与后果；已有 Hub 条目映射时确认后调用，由 Hub 再验。尚未上传的本机条目须先有合约允许的原文与条目传输路径，不能把同步封套 ID 当 `share_entry` 的 root/entry。仅本机模式的单次分享只应上传这次所需数据，不把整个个人空间打开同步；当前入口缺口见本页发现及审查边界，未解决前明确返回未完成，不擅自改 Hub 协议。个人凭据来源不能变成团队依据；被拒收保留本人内容并返回安全原因，不能把本机验证标记直接提交为成功。
- 同步 HTTP 操作、令牌、模式切换/清除和后台调度不做模型工具；模型写 `confirm:true` 也不算本人确认。工具返回有界结果和继续读取入口，保留请求/实际存储效果/远端回执区别，不能因界面提示成功就当作写入完成。
- 本机个人工作流以合约 `pack.json` 及实际文件保存，工作流与通用技能分栏；现有 `<home>/skills` 不自动迁移或扫描上传，须本人选择并补齐合法清单。按 pack 文件清单核对相对路径、大小、摘要、必需文件，拒绝路径穿越、软链接逃逸及大小写同名冲突；与现有技能同名不静默覆盖，保持现有优先级，安装替换需显式处理。
- **固定协议边界**：`pack_manifest` 同步清单/版本/文件摘要，不含代码。另一客户端仅收到清单时显示尚未安装，不能声称工作流已可执行。实际包文件可沿已有获授权的 MCP 包文件入口取得，逐个校验并由本人安装；未发布的本机文件没有传输接口时保留“仅清单”状态，不借 bytes 对象扩展协议传代码。工作流的验收仍由 Hub 按锁定版本执行，不在 Circle 伪造验收通过。
- 同步下载与本机生效隔离：不把目录直接落进会自动执行的 `skills/`。钩子默认不启用；同步不能生成本机批准摘要，实际安装/钩子内容变化后仍必须本人确认。尚未安装的清单、禁用或有冲突的包不进入模型技能列表。

### 5. HTTP 同步客户端、认证与方式切换

- 同步绑定本人明确选定的既有 MCP 服务器连接，默认不向所有 MCP 服务器探测或发送知识。仅在该服务确实支持固定同步协议时建立后台客户端；服务器地址、HTTP 前缀和授权资源保持明确绑定，不让项目设置、模型参数或重定向选择凭据去向。
- 最小化导出 `mcp_loader.ts` / `mcp_auth.ts` 的连接/授权能力，沿用 #396 的私有令牌存储、标准 OAuth/PKCE 和刷新方式。后台客户端不读取 `McpManager.servers` 私有字段，不复制第二套账户或持久令牌库；刷新单次在途并与 MCP 连接协调，跨进程仍用私有存储锁。显式 Bearer 连接继续使用配置的凭据引用，绝不把模型 API key 当同步令牌。
- 同步只向绑定的服务 origin/路径发送 Bearer，拒绝跨源重定向携带凭据；沿用既有网络信任/TLS，生产不降级验证，loopback HTTP 仅用于合成检查。401 先按原授权机制处理刷新，失败后暂停并显示“需要重新登录”，不循环登录、不在后台自动弹浏览器。注销、停用、撤销及更换绑定立即终止旧任务并清掉可失效的会话缓存，令牌不进 renderer、日志或模型上下文。
- 流程为 state → 幂等 client 登记 → session → 冻结 inventory 分页 → missing/upload/download → 本机三方合并 → commit → 安全回执与本机基准。下载对象先核对规范字节/摘要/类型/大小，图完整后才原子更新本机当前投影；上传中断不改当前头。每个变更请求持久化操作 ID、精确请求摘要和会话进度，丢应答先查询 operations，同键异载荷不重用。
- 严守 8 MiB 对象、1 MiB 字节块、64 个批次对象、500 项页及 24 小时默认会话等合约上限，并按 state 返回的更小实际限制与 wire 大小分批；容量满、429/Retry-After、过期会话、损坏正文均分开处理。重建过期会话保留本机修订，不能把暂存进度当成功提交。
- CAS 409 重新读取状态/快照，与共同基准按稳定 ID 合并后生成新候选和新操作；不能只换 expected_state 重送旧快照。不同对象修改取并集、相同修订去重、同项修改保留全部头；删除对修改、目录竞争、记忆冲突同理，不按时间或模型意见选胜者。本人选定/编辑形成新修订才算解决。
- 变更触发后台合并节流，空闲有界轮询，网络/服务错误采用有上限退避并响应取消，429 至少等待服务端指示，不忙循环。只在确认 commit 成功后更新上次同步时间；上传成功或仅检测到状态不算已同步。页脚/设置由权威状态派生：已同步、等待同步中、无法连接、需要重新登录、有冲突；未知不显示成功。
- `src/settings.ts` 保存选定连接与本机偏好/已观察方式，`loadSettingsFromDict` 显式解析新键，不放入 `PROJECT_KEYS`。**Hub state 是同步方式的权威**，默认 `hub` 不等于尚未连接的 Circle 可以擅自上传。
- 切到 local：先 `/mode/check` 展示个人内容量、失效的文件夹分享和待完成分享、本机副本不受影响，再由本人确认提交 `/mode`，带 check、expected_state 和幂等键；影响变化需重做预检。202/等待清除中不能显示已完成。团队独立副本保留，旧私人来源关联失效；离线备份不能远程擦除，按实际边界提示。
- 遇到 `local`、清除中、`SYNC_EPOCH_CHANGED` 或状态中的代次变化，立即停止旧代次的上传/提交/后续下载，不用旧队列初始化新代次。本人重新选择 hub 后才可用保留的本机副本初始化新代次；不重放旧授权。远端清除不删本机文件。切换失败/清除未完成有持久状态和 operations 恢复，不猜测成功。

### 6. 会话记忆加载与旧文件兼容

- 在会话准备阶段异步读取 `get_nodes.memory` 的团队 `for_session` 列表，再以列出的明确版本分页读取；仅接纳允许自动加载、enabled、无冲突且当前可读的团队记忆。本人记忆来自本机库，经同一修订对象协议同步，不另走一次 MCP 个人记忆加载而重复注入。
- 顺序固定为团队记忆 → 本人记忆 → 本机指令/记忆文件（AGENTS.md、CLAUDE.md、MEMORY.md 等）。在 runtime 准备结构化快照，传入 `memory_sources.ts` / prompt catalog，保持构造提示词不自行发网络；`system_prompt.ts` 中现有 project instructions 也要协调顺序，不是只在现有 memory 字符串前随意拼接。
- 记忆是带来源和范围的会话偏好，不是 system 指令、任务依据或可执行脚本。封装/转义边界，不能由正文闭合标签伪装成高优先级指令；不能据此修改系统/用户指令优先级。锁定会话加载的文档/版本及顺序；后台同步不在一半回合中替换提示词，下一会话或本人显式刷新才采用新版本。
- 保留 Hub 的单篇 24,000 字节、每空间 48,000 字节和 20 篇默认接收限制；本轮建议另设**团队与本人合计最多 48,000 UTF-8 正文字节的自动加载预算**，并受模型上下文可用预算进一步限制。按稳定次序裁剪到字符边界，计入标题/路径/封装和截断提示开销，提示遗漏篇数/字节；本机文件原有单文件 24,000 字节上限保留。守护测试的 7,000-token 空会话工具/系统提示预算不放宽，新工具说明精简。
- 团队不可连接/分页版本已失效时，不把缓存声称最新；停止该次加载并提示未完成，可用的本人记忆仍加载。本人的 disabled/deleted/冲突记忆不加载，明确报告冲突数量；他人分享的记忆仅浏览，哪怕可读也不自动加载。不把记忆变成知识依据或 Hub 运行输入。
- `memory_write` 先本人确认，再做与 Hub 一致的凭据扫描、篇数/标题路径正文大小和期望版本检查；编码包裹的凭据同样拒收。拒收只保留安全原因/位置，不把敏感正文写进库、索引、对象暂存、日志或待同步队列。
- 现有 `/memory` 的项目/账户 MEMORY.md 读写兼容，不自动搬迁或上传旧文件；新结构化“我的记忆”独立展示。本人显式导入才分配持久身份、去重映射并避免同一份内容被文件和结构化机制重复加载；不改写或删除本人原文件，不把项目 AGENTS/MEMORY 自动变成个人同步内容。

### 7. 终端命令与桌面页面

- 终端新增 `/knowledge` 的浏览、检索、导入/编辑、版本/冲突和同步设置入口，复用既有 `/memory` 并提供结构化记忆入口；工作流入口登记必要命令。同步本人确认、冲突选定、模式预检在终端也能完成，命令注册同时更新 `BUILTIN_SLASH`、`HANDLERS`、桌面 `COMMAND_UI`，终端文字始终英文。
- 桌面导航新增知识库、记忆、工作流入口；Circle 自身页面组合已批准的 WorkbenchShell、PageHeader、ListRow、Inspector、SourceBlock、Input/FilterChip、Dialog、EmptyState/Toast，不另造 Hub 专用侧栏或把普通 MCP 连接重命名成 Hub。只有本任务明确授权的同步方式文案显示“同步到 Hub”。
- 知识库：以“我的”本机内容为主，浏览文件夹、搜索、筛选、打开条目/原文、版本记录、编辑和处理冲突；团队/与我共享通过获授权的既有 MCP 查询，范围分开且不把他人资料混入个人同步。没有 Hub 连接时本机仍可用。
- 记忆：区分“团队记忆”“我的记忆”；团队只读展示，注明本次是否加载；本人可编辑/启停/处理冲突；与我共享的记忆仅查看。工作流分“工作流”“通用技能”，区分本机可用、仅有清单、待安装和有冲突，显示验收要求而非执行节点图。
- 设置新增同步分区：选定连接、同步方式、上次成功同步时间、状态与登录入口；切 local 使用真实预检数据确认，不依赖静态提示。页脚显示有界状态，不铺常驻说明；失败提示给处理方式，未完成/未知如实显示。renderer 只接安全状态和显式请求，经 worker/controller → 受限 preload/IPC 调用本机服务，不可直接拿文件路径、SQL、凭据或任意 HTTP URL。
- 保持 232px 导航、surface-1 主区、380px surface-2 详情；1180px 以下详情切入可返回页面/覆盖层，760px 以下导航收起，避免四栏。列表选择与路由保存对象标识，刷新/返回能恢复；无选中显示真实概况，长路径/标题/引文/冲突文本各自滚动，主操作与确认不裁切。
- 新文字全部 `t('…')` / `tn()` 加 zh-CN，状态“已验证/待验证”、范围“我的/与我共享”、动作“分享到团队…”；不出现内部哈希、代次、指针或版本号。中文与 Latin/数字/占位符单空格，主动处理用“正在”，外部等待用“等待”。原始内容、工具名、文件路径和代码不翻译。沿用唯一调色板、点/字分色、hover/pressed 文字边框提升、键盘焦点和减少动态效果规则。

### 8. 共享样例、测试与分阶段提交

**协议和样例锁定。** 第 1 阶段复制 `contracts/test-fixtures/sync/v1/` 到 Circle `tests/fixtures/knowledge-sync/v1/`，记录上游仓库、提交、相对路径、许可与每文件 SHA-256；同步镜像需要的生成 JSON Schema、协议路由/词表值及编码参考，同样记录来源，不依赖相邻 Hub 工作树才能运行正常测试。2026-11-03 只读观察值如下（实施复制前再次核对，差异先报告）：

| 上游文件 | SHA-256 |
| --- | --- |
| `contracts/src/sync.ts` | `ef2d4f3b03506e2e7cc40fb0c3355f6d583ae4167688d9c0ec15a7662a89b95b` |
| `contracts/src/sync-canonical.ts` | `0dab40c9a407ef5e993df6436104b02a1214b3e246e97b743a3f26684047324e` |
| `contracts/src/sync-json.ts` | `e010426a6471a6790e4cff458615079e8761b1386908df4a210527001f443377` |
| `contracts/test-fixtures/sync/v1/README.md` | `682b44356b6704e96459f3dc1c741289f598db48a9cbab8a94557818b67e6c5b` |
| `contracts/test-fixtures/sync/v1/encoding.json` | `838f5ea2726972f1cf8dc58e3c8833a32d05de299ddc3ea21d56589050a725c7` |
| `contracts/test-fixtures/sync/v1/http.json` | `1ec8ebaf910ad93f0c8a4942978cbcddcfeb0ada6ac2f03a75a7eddef8e9d9e6` |
| `contracts/test-fixtures/sync/v1/scenarios.json` | `5c72d53b283dc86076c2b4547c903b0e109b7f1a8388e29364e6e8024b3e46c7` |

常规回归重算复制样例摘要并逐字节验证期望编码和对象 ID；另提供显式输入 Hub 源码目录的对照检查，在复制/交接/联调时执行，上游变化就失败并报告。没有上游输入的离线 CI 只能证明受钉住的协议版本一致，不能声称自动发现远端所有变化；不以可选“上游不存在就跳过”伪装对照已通过。新增 Circle 场景独立存放，不改共享样例来适配自己的实现。

| 阶段 / 本机提交边界 | 主要验证与交接 |
| --- | --- |
| 1. 协议镜像、规范编码、独立本机库与索引 | 共享编码/路由/合并样例；严格 JSON 重复键、NFC 碰撞、非法 Unicode/UTF-8、非规范 base64/对象、排序唯一、类型和大小限制；原文 BOM/CRLF/分解字符及跨块/空文件保真；独立库升级/较新版本拒开、事务失败/崩溃恢复、两字中文查询与索引重建 |
| 2. 本机核验、知识/记忆工具、个人包 | 本人确认与拒绝零副作用、并发版本变化、凭据编码/超限拒收且无正文残留、缺来源/错引文/未知解析器不验证；任务只按地址读取；包路径/软链接/重名和钩子不自动启用；工具文档/信息守护与 prompt-budget |
| 3. 后台同步与冲突 | 严格依合约的 loopback 假服务器：两客户端离线交替修改、不同项并集/同项冲突/删除对修改/目录移动、本人解决生成新修订、CAS 竞争、请求重放/异载荷、丢应答查回执、分页/续传/过期/取消、错误哈希/容量/429、仅本机/代次变化停止旧上传；子进程验证同 home 单持有者、租约丢失与崩溃接管 |
| 4. MCP 授权复用、记忆加载和终端 | 合成 OAuth/直接 Bearer：单次刷新、刷新失败/注销/重登录、同源约束与不泄漏；团队→本人→文件真实下一次模型请求顺序、版本分页/截断预算、冲突/disabled/他人分享不加载、离线/加载失败提示；已有 `/memory`、命令覆盖不回退 |
| 5. 桌面页面、设置与状态 | 单元/组件的列表检索、来源详情、编辑/冲突、工作流清单/安装与预检切方式；真正 Electron 的桥、存储重开、两进程同步状态，中文/英文 × 深浅色 × 宽窗/1024px，含窄导航、长内容、键盘/焦点/减少动态效果；截图和实际效果分开记录 |
| 6. 本地打包、Hub 联调与收尾 | `npm run check`、`npm run check:apps`、三包格式和差异检查；完整 desktop/interface 及相关 live/记忆/知识原生流程，开发与本地包分别验收，绑定源码/构建/ASAR/截图摘要并逐项记跳过；Hub 第 5 步接口可用且获确认版本后，在隔离 loopback 测试 Hub 上重复共享场景与实际客户端往返，不连接所有者部署 |

每阶段使用 `npx tsx --test` 执行受影响的确切测试文件，两应用各运行类型/单元测试；新增行为以真实下一模型请求、落盘字节、当前头、进程/租约、HTTP 实收请求与持久回执证明，不只看提示。守护 `tests/prompt-budget.test.ts`、工具文档与 `BUILTIN_TOOL_INFO`、`apps/workbench/test/coverage.test.ts` 必须通过，不增预算或移除失败检查。

Windows 仅在 Circle 的现有跨平台实现/CI 中覆盖本机原子改名遇共享占用的有界重试、数据库/租约和真实效果，不新增 Hub 的 Windows 支持或 CI。macOS 本轮实际结果不当作 Windows/Linux 已通过；平台/现有 guard 的跳过逐项列出。Hub 端本身的核验、权限、清除和数据库原子性不能由 Circle 假服务器绿灯代替；服务尚未到位时客户端可报告合约测试通过，完整联调明确待完成。

### 9. 本次提交请审查的实现边界

1. 固定 v1 只有包清单同步；工作流/技能代码的取得与安装沿已有获授权入口，无法取得的本机独有代码不声称跨机可运行，不扩同步对象载荷。
2. 本机核验只对实际可用且有版本对照的解析器给结果；不能安装/无法解析时保留待验证，不用模型或模糊引文替代核验。
3. 建议团队与本人自动加载合计 48,000 UTF-8 字节上限，另受模型上下文预算约束；原文件机制保持兼容且不自动上传。
4. 先依固定合约与 loopback 假服务器交付可测试客户端，Hub 第 5 步后再做真实测试 Hub 的联调；无接口时不把整体双向同步记为验收完成。
5. “仅本机的条目也可单次分享到团队”需要 Hub 确认传输入口：`share_entry` 当前仅收既有 Hub root/path/entry，而 local 方式禁止个人同步/写入。请协调该单次分享路径；Circle 不自行开同步、不新增 Hub 接口，也不把此验收项静默删掉。

### Claude 审查结论（2026-11-03）

方案通过，按第 8 节的六个阶段实施，每阶段完成后报告。对第 9 节五个边界的决定：

1. **工作流与通用技能**：同意。v1 只同步清单与版本；代码沿已有获授权入口取得，由本人安装；取不到的本机独有代码显示“仅有清单”，不声称跨机可用。
2. **本机核验**：同意。只有实际可用且与 Hub 版本对照过的解析器才给“已验证”，其余显示“待验证”和原因。
3. **记忆自动加载预算**：同意。团队与本人合计最多 48,000 UTF-8 字节，再受模型上下文预算限制；原有的记忆文件机制保持兼容，不自动上传。
4. **联调顺序**：同意。先按合约与本机模拟服务交付并测试客户端；Hub 第 5 步的接口可用后，在隔离的测试 Hub 上做真实往返。之前不把双向同步记为验收完成。
5. **仅保存在本机时的“分享到团队”**：不提供。
   - 仅本机方式下 Hub 上没有本人的个人副本，也不接受个人写入。“分享到团队…”按钮显示为不可用，悬停提示说明需要先切换为“同步到 Hub”，并给出切换入口。
   - 不为此新增 Hub 接口，也不临时打开同步。
   - 同步到 Hub 方式下照常调用现有的分享到团队。
   - 验收标准第 2 条按此理解：“发起分享到团队”只在同步到 Hub 方式下提供。

## 发现

- Circle 当前 HEAD 为视觉统一变基后的 `ee7466ed`，尚无结构化知识库；已有 MEMORY.md 文件机制及 `/memory` 应保留，不能当作已实现结构化同步。
- SQLite 主库版本处理、两个 home、可参考的会话租约、设置解析与 hooks 自动执行等已知风险均在当前源码核对到对应接入点；知识同步的独占租约尚需新增。`settings-sections.ts` 目前无知识/同步分区，桌面需新增实际入口，不能只写命令文档。
- 同步 JSON Schema 可镜像并由现有 Ajv 使用，但自定义 Zod refine 不会全部变成 JSON Schema；纯 Schema 校验不足以实现固定协议，需严格编码与图/排序/base64 等语义检查。
- `get_nodes.memory` 已有会话模式与显式版本分页，分享条目已有 `upload_file.share_entry`；后台同步路由须与这些 MCP 模型工具分离，不恢复旧 hub 扩展。
- 当前共享样例给出编码、合并/传输预期和路由，不是实际 HTTP、权限、清除、容量或原子性通过的证据；Circle 需补独立 fake server 和真实客户端效果测试。
- `kw-sync.md` 第 8 节的“空账户默认 local”“按代次加密”和“团队共享撤回”是审查前建议，已由第 13 节覆盖。此次方案明确采用审查结论，不照搬旧建议。
- 合约缺口：`KnowledgeShareInput` 为 `root`、`path`、`entry` 加可选 `team_path`，仅能指向 Hub 已有个人条目；设计又要求 local 模式下可把本机条目连同所需原文单次分享到团队，而 local 禁止个人同步/写入。固定同步对象不提供任意团队上传代理，需要 Claude 与 Hub 端确认合法入口，不能靠自动切 hub 绕过本人选择。

该缺口已由 Claude 审查结论第 5 项解决：仅本机模式下不提供分享到团队，按钮不可用、提示先切“同步到 Hub”并有切换入口。不新增 Hub 接口，不临时同步；以上缺口描述保留为审查前发现。

### 第一阶段发现

- 三份锁文件依次 `npm ci` 完成，无依赖清单/锁文件修改。根目录安装 148 个包（审计报 2 项 moderate）、workbench 217 个包（0 项）、desktop 61 个包（5 项 moderate）；只记录锁文件安装结果，未执行 audit fix 或放宽依赖。保留 root install-scripts 提示；workbench Monaco 准备和 desktop 开发工具链 postinstall 正常退出。
- 固定协议三个源码文件和四份共享样例的摘要均与方案一致；本次镜像基于观察到的 Hub HEAD `19525b436b8250b8d7f8de8e8d5293014f7d84f3`，Hub 仍由另一窗口推进，不修改它。镜像 20 份已生成的 personal-sync JSON Schema、4 份原始样例及上游 LICENSE/NOTICE，另有从协议/词表提取的路由、常量与错误码数据；保留来源许可。
- 来源清单额外记录 10 个直接参考输入；其中 `contracts/src/spaces.ts` 是 Hub 窗口未提交的观察值，清单显式标记 working-tree observation，并同时记录该 HEAD 的已提交摘要，不把未提交字节冒充提交内容。固定 sync 文件、复制的 Schema/样例逐字节核对一致；Circle 无运行时 Hub import。
- JSON Schema 导出没有表达的排序唯一、严格 base64、包路径/同名/依赖、必须确认清除、已登记拒收码等约束已补语义校验。字段长度保留 Zod 的 UTF-16 口径，不误用 JSON Schema 的码点长度。Unicode 检查采用与 Node 24 `isWellFormed` 等价的孤立代理项判断，适配 Circle 原 ES2023 类型库，不修改编译配置。
- Hub 空空间实际使用 `pages: []` 的规范空快照；本机明确接纳空和仅有包清单的快照，目录存在时才要求唯一根目录。原文有独立的整件 32 MiB 本机资源上限（沿用本机 32 MiB 文件读取口径），与协议 8 MiB 封套、1 MiB 字节块和 Hub 部署上限分开，不靠拆块绕过整件限制。图遍历上限为 100,000 个对象、深度 512，正文缓存最多 8 MiB，原文按块核对，不整图常驻所有原文字节。
- 本阶段不实现确定性来源/凭据核验：所有搜索投影仍为 `unverified`，不从摘要或导入标记提升资格。只有实际字节/结构/路径完整性检查；来源资格、凭据拒收、模型工具、命令/页面、后台租约和 HTTP 调度分别留后续阶段，未把本机版本 CAS 当作远端 CAS/合并已验收。

## 做了的

- Step 0：只读核对 Circle、Hub 合约及设计，补全实施方案、测试与交接边界；尚未复制样例、安装依赖或编写代码。

### 第一阶段实现

- `src/data/knowledge-sync/v1/` 与 `tests/fixtures/knowledge-sync/v1/` 保存协议镜像/来源摘要和不改字节的共享样例。`scripts/verify-knowledge-sync.ts` 支持离线镜像核对，以及显式 `--upstream` 的只读对照；上游不存在/漂移直接失败，不把未对照当成功。
- `src/knowledge/` 提供规范编码/严格 JSON、类型、语义校验、内容寻址文件、对象图、独立 SQLite 存储与 FTS5 检索；`src/knowledge_assets.ts` 放在 runtime 根，以兼容 CLI 与 desktop bundle 的既有 data 复制位置，不更改打包脚本或加依赖。
- 数据库位于显式传入的 `<home>/knowledge/knowledge.sqlite`，不打开 `circle.sqlite`；独立 application ID / user_version、较新库及无关库拒开、持久客户端 ID、WAL/FULL 事务、Unix 私有权限。对象在数据库写事务内原子落盘再登记，崩溃恢复只清理本模块未登记文件/临时文件；已登记暂存与历史保留。
- 本机快照提交显式比较期望头，当前项/索引/头同事务推进；沿稳定 ID 保存修订、移动和删除，不把清单遗漏解释为删除；冲突不选默认正文，解决必须接续全部旧头；源块大小/摘要、类型关系、重复身份、目录环/路径重名有校验。
- 搜索用与 Hub 同规则的确定性 NFKC/小写/两字切分，将预分词后的 hex token 送进 FTS5；原文不归一化。支持陈述、数据和 UTF-8 引文、目录/类型/状态筛选、绑定版本与查询的分页；索引可从当前不可变快照重建，默认排除冲突或路径未解决的条目。
- 新增 33 项协议/存储测试，包括实际文件与 SQLite 效果、子进程崩溃、两个句柄 CAS、共享样例的记忆冲突头/解决修订、原文保真与大于缓存的块图、损坏索引重建、rename 共享错误的有界处理。Windows 的真实原生行为未在 macOS 声称通过；共享错误通过注入错误加实际改名验证，Windows symlink 用例保留账户能力 guard。
- 文档只描述当前后端边界；CHANGELOG Unreleased 标注基础存储尚未接入工具/页面/网络，known-issues 列出未完成集成，保留旧 MEMORY.md 和技能行为。许可证/上游 notices 与精确来源清单一并保存。

## 验证

- Step 0 实际执行：两工作树 `git status --short` / `git branch --show-current`、Circle `git rev-parse HEAD` / `git merge-base`、Hub 同步树的只读状态/提交检查、指定文档/代码读取、`shasum -a 256` 计算上述协议/样例摘要；均为只读，不运行服务或读取真实数据。
- 本页提交前运行 `git diff --check`、检查仅本页差异及提交路径。未运行功能测试或构建，未把尚未实施的项目记成通过。


### 第一阶段验证与提交

所有运行均使用临时 `CIRCLE_HOME` / `CIRCLE_WORKBENCH_DATA_DIR`、合成字节/工作区、脚本模型或本机网关；未读取真实 Circle 数据、未连接所有者 Hub 部署，未修改只读的 Hub 同步树。重型检查顺序执行。

| 实际命令 / 检查 | 结果 |
| --- | --- |
| 根目录 `npm ci` → `npm --prefix apps/workbench ci` → `npm --prefix apps/desktop ci` | 三组依锁文件顺序安装，退出均 0；清单/锁文件 diff 为空，未新增依赖 |
| `npm run typecheck`（首次） | 退出 1，3 条类型错误：两处 `String.isWellFormed` 不在原 ES2023 类型库中，一处测试 `assert.throws` 重载参数不符。已用等价孤立代理项检查及正确断言参数修正，不改变编译目标或测试含义；后续类型检查全部通过 |
| `node node_modules/tsx/dist/cli.mjs --test tests/knowledge-protocol.test.ts tests/knowledge-store.test.ts` | 首批 29 项退出 0；增加缓存/重建/边界用例后 31 项退出 0；最终新增测试数为 33，不把各次重复相加 |
| `node node_modules/tsx/dist/cli.mjs --test tests/knowledge-protocol.test.ts tests/knowledge-store.test.ts tests/prompt-budget.test.ts tests/copy-assets.test.ts` | 最终退出 0：42 项通过、失败/跳过 0（33 项新用例＋9 项既有守护）；提示词预算未放宽，实际 desktop 资源复制函数包含镜像文件 |
| `npm run check` | 退出 0：1,625 项中通过 1,615、失败 0、跳过 10，类型与核心构建完成；约 92 秒测试时长。包含本轮原有 browser-pipe-close 的通过，无测试重试 |
| `npm run check:apps` | 退出 0：workbench 337、desktop 单元 163 全部通过；runtime 821 项中通过 804、失败 0、跳过 17；类型检查与两应用构建完成。命令覆盖和工具文档/BUILTIN_TOOL_INFO 守护均在通过组中。保留既有大 chunk/CJS import.meta 警告 |
| 根目录、workbench、desktop `format:check` | 最终均通过。核心首次指出新 `store.ts` 一处链式调用排版；仅调整换行，diff 证实语义未变。最后再次执行核心 format/typecheck/build 和编译入口冒烟，四组退出均 0；未为排版重跑已通过的全量功能测试 |
| 离线镜像核对及 `node node_modules/tsx/dist/cli.mjs scripts/verify-knowledge-sync.ts --upstream ../circle-hub-sync` | 退出 0；27 项本地镜像/派生摘要一致，显式上游 36 项对照一致。含反例证明上游缺失/变动会失败，离线运行不会冒充已对照 |
| 编译后 `dist/knowledge/index.js` 的独立冒烟（临时脚本、临时 home） | 退出 0；6 个共享编码向量逐字节/ID 一致；实际提交、搜索、关闭重开后客户端 ID/快照/搜索保持；CLI dist 与 desktop dist 共 48 份镜像/许可资产摘要与源码一致，不一致 0。这不是已打包 Electron 运行 |
| `git diff --check`、文档相对链接、来源 JSON 路径检查 | 均通过；没有本机绝对路径。两应用源码、运行时/设置/旧记忆机制、终端调色板、依赖清单/锁文件均无修改 |

下列跳过逐项保留，不记为通过。本轮没有新增 macOS 跳过；新增 symlink 测试仅在 Windows 无相应账户能力时有 guard。未在本阶段运行知识/记忆原生窗口、打包应用或真实测试 Hub 往返，这些仍是后续阶段。

#### 核心 10 项跳过

1. `a Windows browser exit queued behind its deadline is observed before reporting failure` — SKIP
2. `a Windows browser still alive after deadline delivery is not reported as exited` — SKIP
3. `Windows 8.3 temporary paths preserve root identity, workspace hashes and future file writes` — SKIP
4. `on Windows a text file on another drive is not added to the message` — SKIP
5. `on Windows the real PowerShell command runs as far as listing the windows` — SKIP
6. `on Windows a window that is not DPI aware is taken whole: its picture is its own size with no empty part` — SKIP
7. `the Windows helper removes the launcher and the running version once their processes end, and keeps a folder that is not empty` — runs the script in Windows PowerShell
8. `on Windows a program left running by an ended shell is found and ended` — uses the Windows process list
9. `on Windows stopping a finished job ends a program whose parent cmd had already ended` — uses the Windows process list
10. `on Windows cancelling a running command ends a program whose parent cmd had already ended` — uses the Windows process list

#### runtime 17 项跳过

1. `on Windows a refused outside write names the process that has the file open` — SKIP
2. `Windows real ConPTY naturally exits repeated owned sessions without keeping the parent Node process alive` — requires real Windows ConPTY
3. `Windows terminal close waits for the native-exit output-flush window and preserves the complete final log` — requires real Windows ConPTY
4. `Windows TUI dark shutdown restores the main screen and cooked input before a natural exit` — requires real Windows ConPTY
5. `Windows TUI light shutdown restores the main screen and cooked input before a natural exit` — requires real Windows ConPTY
6. `the Windows installer preserves the relaunched argv through real PowerShell` — SKIP
7. `real Windows Job controls an assigned quiescent Node and inherited detached child through retained handles` — SKIP
8. `Windows native adapter fails before allocating a PTY without claiming shell exit proves owned tree exit` — SKIP
9. `Windows original ConPTY input and resistant inherited service stop use real root exit and Job-empty facts` — SKIP
10. `Windows natural completion waits for actual root ACK, wrapper exit, Job empty and original log closure` — SKIP
11. `Windows supervisor cannot preload command Node options before Job assignment` — SKIP
12. `Windows invalid supervisor authentication never starts a command and the quiescent original PTY closes` — SKIP
13. `real Windows short-path aliases preserve CAS coordination and native folder boundaries` — SKIP
14. `a save on Windows waits while another program has the file open without letting it be replaced` — SKIP
15. `Windows session release observes PID birth and real exit without weakening the strict disappearance oracle` — requires real Windows kernel process identity and ConPTY
16. `Windows signal cleanup observes the real job descendant and preserves any scratch-folder EBUSY failure` — requires real Windows kernel process identity and ConPTY
17. `a Windows owned worker transport fault remains a durable failure and stops the real program` — requires real Windows ConPTY


第一阶段 Circle 本机提交：`9e7d7659`（`Add the local knowledge protocol mirror and versioned search store`，已签署），47 个显式文件。代码只在 `knowledge-sync`，本页只在 `circle-knowledge-notes` 提交；不推送、不建 PR、不安装或发布。

第一阶段完成，等待 Claude 审查后再进行第二阶段。当前仅有协议/编码/独立存储/检索基础，不宣称模型工具、实际来源/凭据核验、自动记忆加载、桌面页面或双向同步已完成；Hub 第 5 步后才进入隔离测试 Hub 的真实联调。

### 第二阶段进展（2026-11-03）

Claude 已批准第一阶段 `9e7d7659`，本阶段范围为本机核验、知识/记忆工具和个人包，不开始同步调度、账户授权、自动记忆加载或桌面知识页面。

- 阶段开始重新运行 `verify-knowledge-sync.ts --upstream`，退出 1，首个漂移是 `personal-sync-object.v1.schema.json`。只从 Hub 已提交的 `071a61250a1b9f4be67823a5bc9d180163b95e26` 的只读归档刷新镜像；移除第一阶段 `spaces.ts` 的未提交观察标记。新增原生引用/条目间引用、未知原文文件名和核验位置/解析器锁、投影相关 Schema，复制第五份共享样例 `native-links.json` 并记录摘要。生成词表、协议码、规范编码和原有 HTTP 样例相对旧固定提交没有改动。
- 三个内置解析器 `text@1`、`json@1`、`markdown@1`、字符解码/选择器与 `credential-scan@3` 从该提交的可移植实现适配，保留 Apache-2.0 来源、HTML 数据的 BSD notice，并分别固定上游及适配字节摘要。适配严格索引类型和 ES2023 类型库，不改变解析规则、不改编译目标、不加依赖；Hub 的服务、数据库、业务模块不进 Circle runtime。上游解析/扫描用例也固定并移植；唯一不带入的是调用 Hub sandbox 的整件模型序列化预算用例，Circle 没有该 Hub 执行入口，未把它算作已跑。
- 本机核验观察与不可变对象分开，新增数据库迁移 2；记录本机规则、扫描器、解析器版本、ground 位置、匹配失败及未完成原因。只有当前无冲突、路径可定位且逐字引文匹配的条目获得本机资格；原生远端地址缺获授权 resolver、未知解析器、缺来源或路径冲突保持待验证。明确的错引文与 I/O/能力缺口区分；引文空白/大小写/NFC 形式不模糊匹配，原文/引文 BOM、CRLF、分解 Unicode 字节不改。本机观察不等于语义判断或 Hub 的共享授权。
- 写入在落盘前核对整件原文的凭据（包括跨块、编码包裹）、记忆单篇 24,000 字节、已启用内容的标题/路径/正文合计 48,000 字节及 20 篇；禁用当前文档保留但不占自动加载预算。冲突按一个文档和最大候选预留，未定位目录按上游预留 8,000 字节。核对该固定提交的 `PgMemoryIndex` 和同步服务后修正了本轮最初把禁用内容也计入的保守实现及测试，不自行加严 Hub 的 active-context 规则。拒收提案在模型会话历史/工具事件和 opaque provider replay 前仅保留安全原因，正文不进对象暂存、索引或临时文件。普通写权限、auto/accept-edits、已保存规则、钩子 allow 或模型的 `confirm:true` 都不能替代本人确认。
- `knowledge_write` 提议有界的规范修订/字节块，库存页和快照由本机生成；`memory_write` 支持新增、编辑、启停、删除及延续全部冲突头。审批展示确切规范对象，闭包固定批准字节；本人确认后在数据库写锁内再次检查期望版本，再一事务推进对象登记、观察、索引和头。拒绝/取消零正文及投影副作用，审批期间有新版本则拒绝并要求重新提案；不覆盖新内容。
- 模型工具提供有界 `knowledge_read` 地址/Schema 读取、知识搜索、知识/记忆写入及当前明确不可用的分享入口。可信宿主传入锁定任务上下文时，搜索和个人写入被拒绝，读取只允许固定 snapshot/object 白名单；没有从模型文字推断任务锁。实际 Hub 锁/授权关联留对应后续阶段。分享工具当前不会传输或切换方式；本机方式的不可用按钮、提示及切换入口仍留桌面阶段按 Claude 决定落实。
- 加入全部新 schema 后原有提示词预算用例真实报出 7,436，未放宽 7,000 上限。最终以地址/Schema 读取为常驻发现入口；知识/记忆意图或读知识之后，才把搜索/写入/分享 schema 加到该会话后续请求。工具名仍全部保留、文档/前端工具信息与中文词条同步。原有 curated 空工作区预算 fixture 计入读取工具仍受同一上限；另测真实 runtime 的首/后请求实际工具列表。完整 runtime 额外工具配置本身不属于该 curated fixture，观测总量 8,355、去掉知识读取为 8,223，未用它冒充 7,000 以下。
- 个人 pack 只同步清单，不携带代码。显式宿主安装服务要求本人批准、当前快照和已选择文件夹，核对合法/必需路径、整包 32 MiB、摘要、大小、凭据及软链接，防止同名静默覆盖；原有技能优先级保留。文件在隔离的 `knowledge/packs/`，不进自动 `skills/` 根；清单独存、文件缺失/变动、禁用或冲突均不进模型列表，下一次请求与已有技能加载入口均重新核对。安装选择页面及获授权 MCP 代码传输留后续阶段；不把本机文件检查说成 Hub 的锁定工作流验证。
- 固定协议清单不接受 `hooks.json`，安装不复制原技能的该侧文件，也不生成批准摘要；个人包即使被另加 hooks 侧文件也不自动执行。本阶段没有钩子导入/启用的新入口。原有独立技能和 MEMORY.md 不迁移、不改写、不上传。

正在顺序运行完整检查；最终结果和提交号在本节之后补记。Hub 窗口本阶段继续出现未提交的 sync/mode 合约修改，未复制，下一阶段仍须先重新漂移检查并只取已提交状态。


第二阶段补充检查：状态切换只提供 `state` 时保留原标题/正文，编辑未指定状态时保留原启停状态；新增反例覆盖。个人包发现碰到损坏/较新本机库时返回不可用，不妨碍已有独立技能或普通对话；工具的实际库操作仍明确报错，不把损坏说成空库或成功。


第二阶段补充边界：本机安装同时检查父目录各段的大小写冲突，防止在大小写不敏感文件系统上合并两个目录；此限制只在安装文件时生效，不篡改固定 wire Schema 或丢弃仅同步的清单。另有脚本模型实际调用 `knowledge_write` 的确认、持久化、下一请求与搜索资格检查；无 ground 的真实写入保留待验证，不伪造本机资格。最终受影响检查 176 项通过，失败/跳过 0。

### 第二阶段验证与提交

全部使用独立临时 home、工作区、合成资料与 ScriptedModel；未读真实 Circle 数据、所有者环境/凭据文件，未访问部署的 Hub 或真实模型。重型检查顺序执行，没有为通过检查增加超时、重试测试或放宽断言。

| 实际命令 / 检查 | 结果 |
| --- | --- |
| `node node_modules/tsx/dist/cli.mjs --test tests/knowledge*.test.ts tests/prompt-budget.test.ts tests/approval-modes.test.ts tests/builtin-skills.test.ts tests/hooks.test.ts` | 最终 176 项通过，失败/跳过 0；覆盖规范向量、三个解析器、凭据扫描、本机观察与索引、两类真实模型写入及下一请求、强制确认/拒绝/取消/并发版本、记忆配额与启停、pack 文件/软链接/同名/大小写/钩子、损坏库与原技能兼容 |
| `npm run check` | 最终退出 0：1,726 项中通过 1,716、失败 0、跳过 10；类型检查、核心构建完成，测试约 87 秒。前两次完整检查分别为 1,721、1,724 项且均通过；后续重跑源于本轮新增用例和实现修正，没有靠重试掩盖失败 |
| `npm run check:apps`（首次） | workbench 337 项中 336 通过、1 失败：共享词汇守护发现新增说明用了“核验”。改成“验证”，并把正文说明改为面向使用者的文字，保留原测试规则；该次在 workbench 停止，未把未执行的 desktop 步骤计作通过 |
| `npm run check:apps`（修正后完整执行） | 退出 0：workbench 337、desktop 单元 163 全部通过；runtime 821 项中通过 804、失败 0、跳过 17。两应用类型检查、runtime 测试及 desktop/renderer 构建完成；包括 `coverage.test.ts`、中文词汇守护和必须确认理由的中文显示。保留既有大 chunk/CJS `import.meta` 构建警告 |
| 三包 `format:check`、`git diff --check` / `git diff --cached --check` | 最终均退出 0。清单/锁文件没有差异；没有新增依赖、修改编译目标、改变终端配色或添加发布/CI 工作流 |
| 离线镜像检查及对 `071a6125` 已提交归档的显式 `--upstream` 核对 | 退出 0：44 项本地镜像/适配摘要、57 项上游输入一致。包含五份原始共享样例和移植的通用合成 Markdown 测试资料；不是对任意当前 Hub 状态的通过证明 |
| 收尾再次对当前 Hub 工作树运行显式 `--upstream` | 退出 1，首个差异为 `personal-sync-mode-impact.v1.schema.json`。当时 Hub HEAD 已推进到 `10f92a914c5e7afa30cb2c88515bb41ff05d4b7b`，`sync.ts` / mode-impact 仍有暂存修改及未跟踪 mode-result Schema；没有把这些未提交字节复制进 Circle。下一阶段仍须先检查，再只从已提交状态刷新并记录提交 |
| 编译后 `dist/knowledge/index.js` 临时脚本冒烟 | 退出 0：3 个新增原生引用向量的字节/ID 一致；实际版本 1→2 数据库升级保留客户端身份，随后记忆提交、个人 pack 安装及禁用均有真实存储效果。只在临时合成目录运行，结束后清理；不是 Electron 原生或打包应用验证 |
| 编译资产摘要核对 | CLI dist、desktop dist 各 24 份协议/许可资产，共 48 份，与源码逐字节一致；不一致 0。没有把源码存在当成资源已正确随构建复制 |

核心的 10 项跳过、runtime 的 17 项跳过与第一阶段上面逐项列出的名称完全相同，已从日志按名称比对，新增跳过 0；它们仍是平台边界，不算通过。没有运行知识页面原生截图、已打包 Electron 或实际测试 Hub 往返；这些按方案留第五/六阶段，不将本轮后端测试冒充完整双向同步验收。

第二阶段 Circle 本机提交：`a6c11845`（`Add confirmed local knowledge tools and personal pack installation`，已签署，60 个显式路径）。代码仅在 `knowledge-sync`，记录仅在 `circle-knowledge-notes`；不推送、不建 PR、不安装或发布。

第二阶段完成，等待 Claude 审查后再开始第三阶段。当前分享入口明确不可用，自动记忆加载、同步 HTTP/认证/租约、终端知识命令与桌面知识页面尚未完成；旧记忆文件与独立技能继续按原方式工作。

### Claude 对第二阶段的审查与第三阶段开工

来源：Claude 本轮指示。第二阶段 `a6c11845` 通过：写工具使用 `personApproval`，hook/auto 均不能跳过本人；`knowledge_share` 在映射阶段以前明确不可用；工具延迟加载，不扩大固定提示词预算；只有真正支持的解析器才把来源验证完成。#405 的优先修复已在另一工作树结束（代码 `169bd3cc`，视觉任务记录 `c1d8debe`，无推送），本任务恢复第三阶段，不重做已通过的第二阶段。

第三阶段固定使用 Hub 已提交状态 `5509e847`（`Expose scoped personal sync with atomic mode changes`）。Hub 工作树只读，仍有另一窗口的未提交修改；读取 `git archive 5509e847` 的临时干净归档，不从脏工作树刷新。开工先对该归档运行原 `--upstream`，退出 1，首个差异为 `personal-sync-mode-impact.v1.schema.json`；完整输入对比另见 `sync.ts` 与同步服务参考输入变化。更新方式影响 Schema、加入方式结果 Schema、记录同步 HTTP/服务/祖先合并/JCS 参考摘要后，离线与显式上游检查为 45 项本地摘要、63 项上游输入一致。原五份共享样例逐字节不变；Hub 未提交的第六份 `exchange.json` 没有复制，也不声称已冻结。

第三阶段实现和验证进行中：显式绑定的 Bearer HTTP 传输、不可变对象分批/续传、持久操作与回执恢复、本机/远端 CAS、祖先合并和结构冲突、数据库租约及后台调度。授权令牌由宿主端口注入，不保存进知识数据库，不在模型工具中暴露同步代理。标准 MCP/OAuth 复用、设置/终端状态接线留第四阶段；桌面入口留第五阶段；真实隔离测试 Hub 往返仍留第六阶段。本阶段仅用 loopback 合成服务，不能证明 Hub 本身权限、清除、原子性或实际部署可用。

第三阶段首轮故障记录：

- 首批 14 个真实 HTTP 用例中 6 过、8 失败。主因一是用 JSON 对象键插入顺序判断清单相等，导致无变化仍生成快照、状态一直待同步；改按类型/稳定身份/排序头比较。二是 `fetch` 断连接的 TypeError 被当协议损坏并暂停，改在传输层将网络错误分类为可恢复故障。三是首次状态请求 401 以前还未创建安全日志，无法持久暂停；现在先记录无正文/令牌的未绑定状态，401 后不后台循环登录。修正后原 14 项全部通过。
- 扩展受影响套件首跑 151 项，148 过、3 失败：协议摘要数量仍钉为旧的 44（本轮新增已提交的 mode-result Schema，改为 45），以及两个新子进程测试把含中文的 URL pathname 直接当路径，子进程未启动（改用 `fileURLToPath`，并保留进程退出检查）。这些是新增检查/新增镜像的接线修正，没有增超时、重试测试或放宽原协议断言。随后 42 项定向协议/HTTP/跨进程租约检查全部通过。

第三阶段实现边界补记：

- 独占同步租约实施为独立知识 SQLite 中的单例行、随机持有者标识、5 秒心跳与 30 秒失效。方案原拟参考 mkdir 租约；本次使用同库事务，使持有者检查和日志/当前头/索引推进可以同事务核对，比独立文件锁更直接地阻止失效持有者写入。原有会话租约不改，不靠 PID 判断存活；真实子进程退出/被杀、别名目录、过期接管、旧持有者释放/续期和事务中失效均有回归。
- 本机数据库只追加 migration 3，前两份 SQL 不改。未来版本拒开测试从版本 3 改为版本 4，是因为 3 现在为本轮实际版本，不是放宽较新库保护。直接本机提交仍拒绝目录重名/环/多根；同步合并可保存同名路径与删除祖先的结构冲突、抑制相关搜索投影。环、多独立根及缺依赖仍拒绝，保留已登记的两边不可变分支，不猜名字、不丢内容；不声称自动解决这些结构。
- 共享合并向量逐项验证；实际 HTTP 补充不同项并集、同项/删除对修改、同名目录、删除目录遇到并发子项、本人续接全部头解决、提交期间本机新写入及 CAS 竞争。快照相同的空闲检查不生成无穷快照链。服务端关于同路径重复陈述的结构冲突在本机同样抑制资格和搜索；远端资格观察不升级本机资格。
- 操作先保存精确请求/摘要，再发网络。上传/提交/方式切换的丢应答先查回执；没有回执才以相同 ID/载荷重放；同键异载荷由假服务器明确拒绝。分页结果的回执/状态必须一致，核验/映射/冲突各页作为远端观察另存，最多 64 MiB；未读完不推进基准。只有已确认 commit 更新成功时间和本机投影；提交期间新增本机修订仍显示待同步。
- 后台驱动有串行节流、空闲轮询与指数退避；429 不早于服务端最低等待，401 暂停，不后台弹登录。方式/代次变化停止旧队列；不同宿主绑定不发送旧账户队列，重新初始化必须显式宿主确认。`cancel` 仅取消本机请求/调度，不宣称远端停止；会保留不确定操作，`abortTransfer` 才走有回执的远端会话放弃。模式切换单独预检、本人批准精确影响、再查期望状态；拒绝/取消/预检过时无清除，成功切 local 不删本机副本，丢失启用 hub 的应答也可从此前暂停状态恢复。
- 新增分页结果测试首跑 31/32：假服务器还未生成本测试需要的合成 projections，预期 3 行实际 0。补齐假服务器的合成映射与分页（不更改生产断言），随后 HTTP/租约合计 36/36。没有用真实 Hub 实现作假服务器，不把这些结果当作 Hub 行为的独立证明。

收尾复查另补一个授权失败边界：主动模式切换原先只由周期同步统一记录故障，切换本身收到 401 时尚未立即持久暂停；从 local 启用 hub 的待恢复操作尤其不能因为允许查询切换回执而绕过登录暂停。把主动切换与周期同步接入同一故障记录，并明确让 `login-required` / `invalid` 的暂停优先于模式回执恢复。新增“本人已批准的模式切换收到 401 后零后台重放”实际 HTTP 回归；本轮 HTTP 共 33 项通过。登录及同账户恢复端口随第四阶段 MCP 授权集成完成，本阶段不发起真实登录。

首轮完整 `npm run check` 退出 0（1,762 项，通过 1,752、失败 0、平台跳过 10，含构建）；由于随后补上述边界，正在对最终实现重跑完整检查，不把较早结果直接标成最终提交通过。首轮三包格式检查只有 root 因新假服务器 projections 调用链的换行失败，按 Prettier 的最终输出修正；只是链式调用换行，不更改断言或逻辑，随后 root 格式退出 0，两应用格式也均为 0。

升级复查补记：结构冲突规则加入后，已有 version-2 库不能继续使用旧的派生索引。migration 3 现在在同一升级事务中从已验证身份的当前快照重建投影；客户端 ID、不可变对象、修订历史和当前头不变。新增真实 SQLite 版本 2→3 回归：以合成旧库保留原对象，故意修改派生 statement，升级后搜索从正文恢复，且新租约表可用；没有改动已应用的 migration 1/2。此次存储/HTTP/租约相关检查 58/58，失败/跳过 0。最终根检查须包含此新增用例；此前 1,763 项通过记录只对应升级补记以前的实现。

最终应用复核：`npm run check:apps` 退出 0，workbench 337/337、desktop 单元 163/163，runtime 821 项中通过 804、失败 0、平台跳过 17；两应用类型检查和本地 runtime/renderer 构建完成。该轮构建包括上述升级补充；未做知识页面的原生/打包验收。保留既有 CJS `import.meta` 与 renderer 大 chunk 构建警告，不因本任务修改构建配置。最终根检查正在纳入升级补充用例，结束后记录提交及完整计数。

### 第三阶段最终结果与停止点

Circle 本机提交：`ab3f0b5a`（`Add resumable personal sync with fenced leases and preserved conflicts`，`-s`，22 个显式路径），仅在 `knowledge-sync`。协议基线为 Hub 的已提交 `5509e84724b9def17839aaf5cebbd28178cc3d94`。第三阶段完成；未推送、未建 PR、未运行或修改 Hub 工作树，未连接部署 Hub 或真实模型，未安装应用。

| 最终实际检查 | 结果 |
| --- | --- |
| `node node_modules/tsx/dist/cli.mjs --test tests/knowledge-store.test.ts tests/knowledge-sync.test.ts tests/knowledge-sync-lease.test.ts` | 58/58，失败/跳过 0；其中 HTTP 33 项、跨进程租约 4 项，另含版本 2→3 实际升级、既有存储/崩溃/本机 CAS 回归 |
| `npm run check`（纳入升级补充后的最终完整执行） | 退出 0：1,764 项，通过 1,754、失败 0、跳过 10；类型检查和 CLI 构建完成，测试约 125 秒。此前完整根检查分别在新增 401 边界、升级补充之前通过；后续执行源于这些实现变更，不是靠重试掩盖失败 |
| `npm run check:apps`（完整复核） | 退出 0：workbench 337/337、desktop 单元 163/163、runtime 821 项中通过 804、失败 0、跳过 17。两应用类型检查、runtime 与 renderer/native bundle 构建完成；最后构建含升级补充。应用源码未改，实际知识页面/打包应用验收未运行 |
| 三包 `format:check`、`git diff --check` / `git diff --cached --check` | 最终均为 0；root 的最后完整格式检查包含升级补充。两应用格式和既有界面/工具/预算守护通过；依赖清单、三份锁文件、发布/CI 配置无变化 |
| 离线镜像及显式 `--upstream` 指向 `5509e847` 干净归档 | 45 项本地摘要、63 项上游输入一致。五份已提交共享样例不改字节，没有复制 Hub 未提交的 `exchange.json` |
| 跳过清单比较 | 核心 10 项、runtime 17 项的名称和原因与 `docs/workbench/validation/graphite/checks.json` 中既有平台清单逐项一致，新增跳过 0；不是 Windows/Linux 原生通过证明 |
| 最终文件与构建资源核对 | 1,727 份冻结文件摘要一致、变化 0；CLI dist / desktop dist 各 25 份协议/许可资产，共 50 份，与源码逐字节相同。只核对本机实际构建，不把源码或构建存在当成 Electron/ASAR/真实 Hub 验收 |

同步驱动目前由宿主显式选择连接、注入 Bearer 提供者并启动。尚未接入现有 MCP/OAuth 单次刷新、登录恢复、设置和终端生命周期；这正是第四阶段，不从此处启动后台真实登录或向所有 MCP 服务探测。分享工具仍明确不可用，映射回执只存为远端观察，不伪造 Hub 引用或共享资格。自动记忆加载、桌面页面和开发/打包原生验收分别留第四至六阶段，真实隔离测试 Hub 往返仍严格留第六阶段。

结构冲突保留双方身份/修订，抑制相关当前路径与搜索；本人解决仍需全部冲突头作为新修订父项。目录环、多独立根、缺依赖等非法结构拒收并保留两边已登记的不可变分支，不自动改名、丢弃或选择正文；本阶段不声称这些结构已自动解决。取消与租约失效不证明远端操作停止，只有回执能确认结果。

第三阶段结果交 Claude 审查；第四阶段尚未开始。代码工作树提交后干净，记录只在 `circle-knowledge-notes` 本页。#405 的修复仍为独立 `workbench-graphite-local` 提交 `169bd3cc`，视觉任务记录 `c1d8debe`，由 Claude 决定推送；本轮没有把它合并、变基或重放进知识分支。

### 第四阶段开工与实现记录

来源：Claude 本轮指示。第三阶段 `ab3f0b5a` 通过，认可数据库栅栏租约、回执优先恢复、保留冲突、401 暂停及版本 2→3 投影重建；继续 MCP 授权复用、会话记忆和终端命令。#405 的 `169bd3cc` 已由 Claude 推送并在 CI 中，本轮不操作该分支、远端或 CI。

开工只读观察 Hub 最新 HEAD 仍为 `5509e84724b9def17839aaf5cebbd28178cc3d94`，审计顺序补充尚未提交。再次从此提交 `git archive` 得到干净归档，对该归档运行显式 `--upstream`，45 项本地摘要、63 项上游输入一致。Hub 的暂存/未提交第六份 exchange 样例继续不复制；收尾再检查最新已提交状态，并记录最终镜像提交。

已实现：

- MCP 授权继续存在原私有 `mcp-auth.json`。补短写锁、每服务异步刷新锁、进程内单次刷新和跨进程二次读取；普通 MCP SDK 传输与后台客户端共用 SDK 的刷新请求边界。刷新保留随机授权标识，显式重新登录分配新标识；知识库只保存无令牌的绑定值。授权删除/替换时旧队列暂停，成功应答也须再核对授权，未重新选定账户不上传旧副本。后台不注册客户端、不打开登录页；重新登录须由本人主动调用原 MCP PKCE 流程。
- 会话首次加载团队 `get_nodes.memory` 的 `for_session` 分页及逐文档锁定版本，再读本机个人记忆。只接纳 team/本人、enabled、可自动加载且无冲突的内容；共享给本人的其他空间不自动加载。封装和正文转义，不作为任务输入或依据；令牌即使被分散在多页中，也在重组后拒收。会话中不随后台同步替换，显式刷新或新会话才更新；旧文件机制保持兼容。
- 按已批准方案，团队＋本人结构化记忆合计最多 48,000 UTF-8 字节，计入标题、路径、版本封装、转义、状态与截断提示；随后按实际模型完整请求的输入预算进一步收窄。文件保持原单文件上限，进入完整请求的预算计算；顺序为团队、本人、文件，没有增大提示词守护预算。
- `/knowledge` 提供本机浏览/搜索/读取、历史、冲突选择及修改、选定连接/同步/方式切换与显式重新登录；`/memory` 增加团队/本人/实际会话上下文/刷新及结构化写入、启停、删除，保留原文件 add/remove。写入、冲突解决、连接改选与清除走现有本人确认卡，auto 不跳过，批准后再做本机 CAS。桌面阶段五页面仍未接入，当前共享命令目录只如实提示终端入口，不模拟桌面成功。

首批验证：既有 MCP/记忆/提示词/同步检查 62 项全过；新增授权 9、会话记忆 8、终端 7 项分别通过，包含实际下一模型请求、跨进程刷新、取消共享刷新、PKCE 重新登录后旧队列不重放、本人确认/拒绝/并发修改、深浅色窄终端。

新增检查接线中的首次失败：测试服务器把 JSON-RPC `id=0` 当通知而未答初始化，定位后终止该本机失败运行，改成只把 `undefined` 当通知，保留原 30 秒 MCP 期限。新增 PKCE 用例又因合成服务器缺少 codes 容器而未完成，补齐合成服务后通过，未增加 5 秒等待。其余为测试脚本的 saveSettings 参数顺序、ScriptedModel 可选预算属性的 TypeScript 接线、终端主题/关闭 picker 的现有 API 名称，已按真实 API 修正，未改产品断言或延长期限；最终完整检查尚在后续记录。


### 第四阶段结果与验证

实现范围：复用既有 MCP OAuth/PKCE 和直接 Bearer 的选定连接、共享刷新、运行时生命周期；冻结团队 → 本人 → 文件的会话记忆；终端知识/记忆入口及本人确认。桌面仅更新共享命令目录与中文的真实未接入提示，不在本阶段实现知识页面。原本的知识分享工具仍明确不可用，既不新增 Hub 端点，也不临时开启同步。

**最终镜像来源。** 开工的 `5509e847` 检查后，Hub 提交了 `9f11afc6`（冻结共享 exchange 样例）和 `8afd14bb`（先限制已认证请求，再追加审计，避免错误路由/方法放大审计）。本阶段只从提交的 `git archive` 归档复制，未读取未提交控制台内容作为镜像。其后已提交的控制台整合为 `eef4ca121fa673a8067d32d74c05f923a93fd42b`；与 `8afd14bb` 对比，本镜像输入仅 generated vocabulary 的控制台标签变化，sync/canonical/memory/tools 合约未变。最后镜像记录该 `eef4ca12`，显式 `--upstream` 对其干净归档通过 **46 项本地摘要 / 67 项上游输入**。其中新增三个只读记忆契约参考输入（memory、tools、知识记忆服务），并原字节复制冻结的 `exchange.json`，SHA-256 为 `9f71c6bee0a411ad49a1de612b4a0ee5ff93f310f7287fe74b1e80611f8e8546`。正常测试不依赖相邻 Hub 工作树；原编码/路由/场景没有修改期望值。

**授权和同步。** 仍只有原私有 `mcp-auth.json`，加入随机授权标识与过期时间，不另建令牌库。直接 Bearer 的校验摘要只在该私有文件，知识数据库/设置只存不含令牌的绑定。共享刷新按 home/server/grant 单次在途，跨进程异步锁内再次读取，保留轮换或不轮换的 refresh token；最后一个等待者取消才中止实际请求，且有 30 秒刷新期限。响应后重查授权，注销期间的返回不能恢复旧授权。缓存 discovery 只用于后台刷新，失败即需要登录；无后台注册、浏览器或登录循环。显式重新登录沿原 MCP PKCE，必须重新本人选定账户才可上传保留副本。同一授权的外部修复可显式 sync 恢复原精确待处理操作。网络失败和认证失败分别处理。

**会话记忆。** 团队列表/逐文档版本、字节偏移、游标和自动加载资格均检查；空的续页/重复游标或版本失效使整份团队快照不加载，个人可继续。本人 disabled/deleted/多头和目录冲突不进入上下文。重组后扫描标题、路径、正文和当前连接凭据，避免跨页漏扫。48,000 字节计算包括转义、元数据、封装、状态/遗漏提示；UTF-8 与转义边界完整，实际模型输入预算继续收窄该上限；既有文件上限和 7,000-token 守护未放宽。冻结至新会话、reload 或显式 refresh；断开/撤销/改选移除已载团队记忆。每次模型请求边界也重新查授权，不依赖文件事件准时送达。`localContext: false` 不加载也不启动同步，headless 且不开 integrations 只读本机记忆。

**终端。** `/knowledge` 的 list/search/read、显式 workspace UTF-8 文件 import（至多 1 MiB）、history/conflicts/resolve/edit/delete/rename/move、connect/disconnect/status/sync/login/mode 均接实际服务；导入保留 BOM/CRLF，不发明 statement 或已验证结论。`/memory` 的 team/personal/loaded/refresh 与 write/edit/enable/disable/delete 接结构化记忆，原文件 add/remove/list 保持兼容。内容改动、冲突解决、改选连接和方式清除都走现有本人卡，auto、always/prefix 或模型文字不能代替当次本人批准，提交时再查本机 CAS/远端影响预览。新 edit 参数保留 Markdown 段落和尾随空白；提出的正文不写入终端输入历史。窄终端深浅两色使用现有 picker、审批卡、页脚与调色板。

收尾发现并修正：

- 扩展受影响回归首次为 309 项中 308 过、1 失败：额外 `/memory` 帮助通知遮住原列表的最后通知。合并进入原列表，保留既有断言；随后 317 项受影响回归全过。
- 增补授权移除回归暴露关闭竞态：知识客户端关闭通知在运行时关闭后排入提示词刷新，数据库已关闭。关闭回调及定时刷新加 closing 检查；下次请求与真实落盘检查仍保留。
- 首轮全 CLI 检查 1,798 项：1,788 通过、10 平台跳过、0 失败，类型/构建通过。随后新加的边界与最后修正另执行完整检查，见下方最终命令表。
- 首轮应用检查 workbench 338 项全过，desktop 类型检查失败：其 lib 不含 DOM.Iterable，Headers 无迭代器。改为 Headers.set，不改 tsconfig、依赖或断言；单独 desktop 类型检查通过。
- 追加的最后两条回归首次暴露两项：通用 slash 解析 trim 掉新 edit 正文尾随空白，现仅对新增结构化 edit 保留正文（custom/其他旧命令不改）；断网合成测试关错代理 peer 的监听器，实际 socket 归授权入口所有，改为关闭实际入口连接。原网络错误断言不改，最后两个边界用例通过后再跑完整检查。
- 文本导入拒收样例最初使用未命中既有扫描规则的普通小写连字符串，导致本人卡等待；终止本次拥有的测试进程，使用既有 scanner 回归的合成密码形式，并让检查在意外出现卡时先拒绝、再失败，避免测试挂住。没有为样例扩大或弱化扫描规则、期限及批准要求。

最终命令、数量及提交见本阶段末尾记录。所有服务与内容是 loopback 合成夹具，OAuth 与跨进程刷新使用临时私有 home；没有真实模型、真实个人数据、所有者部署、Git push 或依赖/锁文件变更。假服务器成功不证明 Hub 自身权限、清除、事务或真实部署可用。真实隔离 Hub 往返仍留第六阶段；桌面知识页面、原生开发与打包截图/凭据留第五、六阶段。


最终应用检查已通过（`npm run check:apps`，分别设置临时 `CIRCLE_HOME`、`CIRCLE_WORKBENCH_DATA_DIR`）：workbench 类型与 338 项测试、desktop 类型与 163 项单元测试、runtime 821 项中 804 通过 / 17 平台跳过，以及 desktop/renderer 构建均成功。构建仍报告已有的 bundle chunk 大小及 `src/update.ts` 的 CJS/import.meta 警告，没有更改阈值/格式去隐藏它们；此次不是 packaged/native 知识页面验收。

本机 macOS 的既有跳过（全部保留，不计为通过）：

| CLI 的 10 项 | 原因 |
| --- | --- |
| Windows browser exit queued behind deadline | Windows 事件/进程分支 |
| Windows browser still alive after deadline delivery | Windows 事件/进程分支 |
| Windows 8.3 temporary paths | Windows 短路径 |
| Windows text file on another drive | Windows 盘符 |
| Real PowerShell listing windows | Windows PowerShell |
| Window not DPI aware | Windows DPI |
| Windows uninstall helper | Windows PowerShell |
| Program outlives an ended shell | Windows 进程列表 |
| Stop finished job with ended cmd parent | Windows 进程列表 |
| Cancel running command with ended cmd parent | Windows 进程列表 |

| desktop runtime 的 17 项 | 原因 |
| --- | --- |
| Refused outside write names owning process | Windows 文件占用 |
| Real ConPTY repeated natural exit | 实际 Windows ConPTY |
| Native-exit output flush and complete log | 实际 Windows ConPTY |
| TUI dark natural shutdown | 实际 Windows ConPTY |
| TUI light natural shutdown | 实际 Windows ConPTY |
| Installer relaunch argv | 实际 Windows PowerShell |
| Real Job retained handles and detached child | 实际 Windows Job |
| Native adapter before PTY allocation | Windows 适配器 |
| Original ConPTY resistant inherited service stop | 实际 Windows ConPTY/Job |
| Natural completion root ACK / wrapper / Job empty | 实际 Windows ConPTY/Job |
| Supervisor strips pre-assignment Node options | 实际 Windows Job |
| Invalid supervisor authentication | 实际 Windows ConPTY |
| Real short-path aliases and CAS | Windows 短路径 |
| Save while another process holds file | Windows 文件共享 |
| Session release PID birth and actual exit | Windows 内核/ConPTY |
| Signal cleanup actual descendant and EBUSY | Windows 内核/ConPTY |
| Owned worker transport fault stops program | 实际 Windows ConPTY |

收尾代码审阅另明确：直接 Bearer 的 login 入口提示更改原 secret/header 并重新选连接，不假装执行 OAuth；团队接收也先检查合计正文＋标题路径 48,000 字节，再读取文档分页。相应终端 11 项、会话记忆 14 项分别通过。最终追加回归的第二次完整 CLI 检查曾为 1,802 项中 1,790 通过、10 跳过、2 失败（上述 edit trim 与关错合成监听器）；修正后两条单独检查通过，正在对最终冻结源码再次执行完整 CLI 检查，不把仅重跑失败项算完整绿灯。


**最终结果（冻结源码完整检查）。**

| 命令 / 检查 | 实际结果 |
| --- | --- |
| 临时 home/data 的 `npm run check` | 退出 0；类型检查、1,804 项中 **1,794 通过 / 10 Windows 跳过 / 0 失败**、CLI 构建成功；未启用 CI 的失败重跑 |
| 临时 home/data 的 `npm run check:apps` | 退出 0；workbench **338/338**，desktop 单元 **163/163**，runtime **804 通过 / 17 Windows 跳过 / 0 失败**；两应用类型与构建成功 |
| 三包各自 `npm run format:check` | 全部退出 0；最后 CLI 格式检查也通过，保留共享样例原字节 |
| `npx tsx scripts/verify-knowledge-sync.ts --upstream <eef4ca12 的干净归档>` | 退出 0；**46 mirrored / 67 upstream**，来源提交完整 SHA 见上文 |
| CLI / desktop 的编译后协议资产 | 各 **25** 个文件，共 **50** 个，与源码逐字节一致 |
| 两工作树 `git diff --check` | 均通过；无依赖、锁文件或版本变化 |

这次完整 CLI 检查包含授权 **13** 项、会话记忆 **14** 项、终端 **11** 项新增实际效果回归；冻结 exchange 另核对双分支合并/解决身份与原始引用核验。文件导入的回归也使用连续两个空格的文件名，路径不再按命令分词重组。没有放宽原期限、可见性、权限、内容或提示词预算断言，没有删除失败检查。

代码已在 `knowledge-sync` 本地签名提交 **`0c6d0d6784d8ad6e426345fae55c3764ae21d766`**（`Reuse MCP authorization for personal sync and load session preferences`）。代码工作树提交后干净，记录只提交本页的 `circle-knowledge-notes`；没有 push，没有改 Hub 同步工作树，也没有操作 #405。第四阶段交 Claude 审查，**第五阶段尚未开始**。本阶段证据仍是 macOS 本机、合成 loopback/脚本模型；不代表实际测试 Hub 往返、Windows/Linux 原生结果或知识桌面的开发/打包验收。


### 第五阶段开工

来源：Claude 批准第四阶段 `0c6d0d67`，授权桌面知识/记忆/工作流页面、同步设置与状态、renderer/IPC 边界，以及 zh-CN/en × 深浅色 × 宽窗/1024px 的实际 Electron 截图逐张查看。继续使用既有 WorkbenchShell 的 232px 导航、surface-1 主区、380px surface-2 详情，窄屏详情成为可返回页；组合 ListRow/Table、Inspector、SourceBlock、Dialog 与 EmptyState，不新增调色板或 Hub 专用侧栏。

开工 Hub 最新提交仍为 `eef4ca121fa673a8067d32d74c05f923a93fd42b`；从该提交的新干净归档运行 `--upstream`，46 mirrored / 67 upstream 一致，未刷新协议。两代码/记录工作树开工干净。界面操作将沿受限 preload → 现有 runtime command → worker/controller 接本机服务；预检/批准令牌由宿主持有并重新核对，renderer 不接凭据、SQL、原始磁盘路径或任意网络入口。仅本机下分享按钮不可用，提示先切同步并提供切换入口；切方式展示真实 `/mode/check` 数据后再确认。所有检查只用临时 home/data、合成资料和 loopback 服务，真实测试 Hub 往返仍留第六阶段。

### 第五阶段实现与调查

- 桌面新增知识库、记忆、工作流三页，沿用既有壳层的导航/主区/详情；知识使用两行列表，工作流使用可排序表格，详情组合来源块、近期版本与操作区。小于 1,180px 的详情有返回列表入口。来源原文保持原字节解码文本，摘录前三行折叠并可展开；长预览、搜索上限与较早历史均明确标出省略。
- Renderer 只能发送白名单操作，不能提供 home、SQL、URL、任意引用或原生路径。宿主保存不透明版本/来源能力及有期限、一次性、会话绑定的确认票据；原生文件/文件夹选择在 main，私有路径只进 worker 并沿用受保护路径规则。详情预览与完整编辑正文分开，凭据在返回边界拒绝且不回显。
- 本人知识/记忆的新增、导入、编辑、移动、删除、启停与冲突解决均先预检再确认，并做当前版本检查。团队/与我共享只读；共享记忆的查看不进入实际模型请求。个人工作流先登记符合 `pack.json` 的文件夹清单，再独立确认本机文件安装，原文件不改动、hooks 不复制；暂不把任意独立技能目录转换成协议包。
- 同步设置复用选定 MCP 连接与既有 OAuth/Bearer；模式来自实际状态。切本机前显示 `/mode/check` 的字节、失效文件夹分享、待分享未知值和保留的团队副本，确认再复查完整影响。清除期间停止传输，只做有界状态查询，确认完成前不显示完成。本机模式的分享按钮不可用，有提示与切换入口。
- 分享复用既有 `get_nodes` / `upload_file`：当前本机版本必须有已确认的远端映射，本机知识和远端原生条目都要通过验证；记忆调用固定 check-only 分支。本人确认后再次检查本机版本、账户及远端状态。旧版本 3 的完整回执可重建精确映射，不猜引用。模型 `knowledge_share` 也纳入 personApproval 与强制单次批准；拒绝和“始终允许”均不产生副本，auto 不能跳过。

首次失败及处理（最终命令与截图验收另记）：

- 旧第四阶段 renderer 回归要求“页面尚未接入”的提示；本阶段实际页面已接通，改成检查真正的知识/记忆路由，保留文件记忆兼容提示。
- 新宿主回归发现记忆历史的原文读取遗漏，补上 memory revision 的正文分支。测试继续检查实际历史正文；不放宽断言。
- 新模型分享回归发现审批策略仅列知识/记忆写入，“始终允许”可能保存分享授权；补入分享并继续断言未批准零副作用。拒绝的工具结果按既有 harness 的 `error` 状态校正新测试（并非新造 `denied` 状态），零分享断言保留。
- 首轮原生知识意图触发夹具记录的 DataCloneError：原生脚本模型仅剔除了 run/prepare，未剔除 privacy 等宿主函数。按 ScriptedModel 的数据记录方式剔除全部函数，新增实际工具数据与函数隔离回归。它是夹具问题，未改变生产模型/审批边界。
- 原生截图暴露同步状态继承旧页脚 19px 圆按钮尺寸，导致英文挤成窄列。增加有同步行时的页脚高度与按钮尺寸规则，仍使用现有 tokens。
- 首个可分享来源夹具写了不存在的第 12 行，且低层冲突种子绕过了核验观察生成；产品按预期保持待验证并禁止分享。修正合成行号/摘录和经核验发布的种子，并在启动前断言 verified，没有伪造产品资格。
- 原生编辑定位发现包裹 textarea 的 label 会包含已填正文；为内容输入补固定本地化 aria-label，并在完整正文读取期间禁用编辑，防止迟到读取覆盖输入。详情刷新保留同一选择，避免轮询造成表单短暂消失。

补充原生与大库发现：

- 弹窗入场动画的 transform 覆盖原本居中变换，首帧可能落到窗口右下方；共用 Dialog 改用独立 translate 居中。保留首帧及稳定帧的完整边界断言，截图另等有限动画/字体完成，避免半透明入场帧冒充最终外观。
- 写入后先废弃旧列表/详情能力，再取当前版本；内容/候选/目标文件夹都有稳定的本地化可访问名称，完整编辑正文读取期间禁止输入。
- 原生 700px 快速连续按键揭示 URL 选择滞后，移动改从当前焦点行计算；Enter 打开窄屏详情时焦点到返回键，返回后到原选中行。连续快速按键及两次焦点均在原生脚本断言。
- 工作流的“本机可用”按安装文件可用状态显示成功色，清单与停用为中性，文件不可用/冲突按各自状态显示；不再沿用知识待验证颜色。来源文件/文件夹不重复显示类型与状态。
- 列表原本先为整库生成能力、再取 100 行；静态检查发现超过 4,000 个对象会淘汰返回页的能力。改为只对返回页生成，保留总缓存上限，新增 4,005 条真实合成修订的分页/旧页读取回归。该新夹具首次将 inventory 仅按 ID 排序，协议正确拒绝；改用既有 itemKey 的 kind:ID 顺序，没有放宽协议或减少规模。
- 受影响设置组件首轮仍期待旧分区目录，因此发现新增“同步”后严格列表断言失败。把同步及中文名加入目录，并增加同步页的宽窄窗检查；完整列表、可见性、边界和超时保留。
- 新建测试脚手架还修正了缺少 apiVersion 的插件夹具、未完整实现 DOM Storage 的语言夹具和原生脚本模型的 TypeScript 数据类型；凭据测试从不含正文的安全列表转为检查实际正文返回边界。它们不是产品成功证据，最终验证命令单独记录。

### 第五阶段结果

收尾复查 Hub 最新已提交状态为 `410c9c44fcedef41bd1755bdbd0bef6600cd904e`。仅用 `git show <commit>:<path>` 导出固定来源的新干净归档，重新执行 `--upstream`：**46 mirrored / 67 upstream**，全部通过。协议镜像仍钉在开工的 `eef4ca121fa673a8067d32d74c05f923a93fd42b`，本阶段没有刷新来源、读入未提交契约或改 Hub 工作树。

补充收尾修正：自动刷新曾可能丢弃已追加分页，现保留加载更多的列表；原生脚本以 107 行跨真实五秒刷新周期和 IPC barrier 验证未回到前 100 行。断开连接后同时废弃远端列表与详情，原生断开/重新选择连接再连通验证没有残留远端正文。重新连接脚本首轮遗漏了重挂载后的连接选择，改为经实际控件显式选择合成 profile，未绕过禁用或可见性。逐张查看还发现一张工作流截图比详情 IPC 先完成：捕获改等真实标题，空结果和快速按键样本也等实际正文，再重跑完整原生流程，保留原超时、首帧和稳定帧边界要求。

| 命令 / 检查 | 实际结果 |
| --- | --- |
| 临时 home/data 的 `npm run check` | 退出 0；类型检查、**1,799 通过 / 10 Windows 跳过 / 0 失败**，CLI 构建成功，共 1,809 项 |
| 临时 home/data 的 `npm run check:apps` | 退出 0；workbench **342/342**、desktop **163/163**、runtime **820 通过 / 17 Windows 跳过 / 0 失败**（共 837 项），两应用类型与构建成功 |
| 最终 renderer 全量 `npm --prefix apps/workbench test` | **342 通过 / 0 失败 / 0 跳过**，覆盖最后的轮询/断开清空改动 |
| 三包各自 `npm run format:check` | 最终全部退出 0；desktop 一处排版修正后再构建与拍摄 |
| `npm --prefix apps/desktop run build` | 最终格式修正后退出 0，随后原生流程使用该构建 |
| `node --import tsx apps/desktop/test/knowledge-native.mjs` | 退出 0；**12 组实际效果、53 张截图、页面/控制台/请求错误均为零** |
| `settings-dialog-ui.mjs` / `settings-navigation-ui.mjs` | 分别 **17 组检查 / 12 个场景**通过；目录含新增同步及中文名，保留原完整列表、可见性、包含关系和超时 |
| `verify-knowledge-sync.ts --upstream <已提交状态的干净归档>` | 开工 `eef4ca12` 与收尾 `410c9c44` 均 **46 / 67** 通过 |
| 编译后协议资产逐字节比较 | CLI / desktop 各 **25** 个文件一致；锁文件、依赖、版本、镜像及共享 v1 样例均未变 |
| 回执与差异检查 | **1,139** 个源码、**2,645** 个构建文件摘要与当前字节一致，**53** 个 PNG 摘要一致；两工作树 `git diff --check` 通过 |

新增宿主知识回归 **15** 项（含 4,005 条真实合成修订的大库分页）、renderer 知识 **4** 项、模型分享 **5** 项与工具数据克隆回归已包含在完整检查；未改提示词预算测试。全部 10/17 个平台跳过名称和首次失败原因列在 Circle 的 `docs/workbench/validation/knowledge/checks.json`，没有把跳过算通过，没有删失败检查、加重试或放宽超时/可见性/权限断言。

**原生截图已逐张打开查看。** 完整矩阵是 zh-CN/en × dark/light × 1,440/1,024 CSS px，覆盖知识库、记忆、工作流、同步设置；1,024px 另保留列表/表格与可返回详情两种视图。附加来源展开、禁用分享提示、实际分享确认、切本机真实影响、冲突、版本记录、安装、空状态和 700px 快速按键/减少动画，共 53 张。最终查看未发现外层溢出、控件裁切、布局残留或未翻译的界面文案；合成原文按原文保留。设计体系的导航、surface-1 主区、surface-2 详情、SourceBlock 与 Dialog 均在实际 Electron 中检查，最终视觉审查交 Claude。

Circle 内可审阅入口：`docs/workbench/knowledge-validation.md`；原图、首帧/稳定帧测量、实际 Electron/Chrome/Node 版本、源码/构建摘要与截图摘要在 `docs/workbench/validation/knowledge/receipt.json`。回执 SHA-256 为 `86477d395db2ff21b4c7815a4a151bbc3888dfc545652fbb956706da136da53d`。不把浏览器模拟当原生结果；选择器自动化只选择脚本生成的临时原文件，不宣称手动系统选择器通过。

第五阶段只验证 macOS arm64 开发 Electron、合成模型与 loopback 协议服务的客户端行为；**真实隔离测试 Hub 往返、打包应用、其他平台与手动原生选择器仍留第六阶段**，没有部署或生产数据操作。

代码已在 `knowledge-sync` 本地 `-s` 提交 **`9c5ab2845d0796657ea517e73437272be8b2fcff`**（`Add desktop knowledge pages and confirmed sync controls`），提交后工作树干净。任务记录仅提交本页到 `circle-knowledge-notes`；没有 push，没有改 Hub 同步代码工作树，没有操作 #405。**第五阶段完成，交 Claude 审查；第六阶段尚未开始。**

### 第五阶段视觉审查修正与第六阶段开工

来源：Claude 批准 `9c5ab284` 的功能与边界，并指定五项视觉修正后在一个提交交付，再进入第六阶段。修正范围为三页的空间/层级路径与位置更新时间事实行、条目“知识”标签、单行底部操作与更多菜单、可键盘到达的本机分享说明/同步设置、危险式切本机确认与本机同步设置精简。更新时间只记录本机实际提交；协议没有远端修改时间，既有/未提供的时间明确未知，不把首次读取当成修改。数据库只追加迁移，不改已有迁移。

第六阶段固定使用 Hub `410c9c44fcedef41bd1755bdbd0bef6600cd904e` 的 `git archive` 临时副本，node_modules 只链接已有依赖；不改任何 Hub 工作树。沿该提交自带 `createTestHub` → `openTestRecords` → `startPostgres` 创建临时 PostgreSQL、临时 FileKeyProvider/vault 与随机 loopback 监听，合成账户和全新 Circle home。拒绝接触 7420/7443、真实数据或真实模型。要覆盖首次同步、两侧分叉冲突、切本机清除并恢复、401 后显式重新登录与映射后的团队分享；随后实际打包应用运行同一原生知识流程并核对源码/ASAR/截图摘要。所有结果只记实际执行，不把 fake/开发结果替代真实 Hub/打包结果。

视觉修正已完成于一个本地 `-s` 代码提交 **`edf9fc0c`**（`Refine knowledge inspectors and local-only sync controls`）。层级路径在展示时转为“我的 › …”，根行无位置、详情为空间名；三页详情事实行包含位置和已记录的本机更新时间。条目标签中文为“知识”，英文保留 knowledge。历史/分享/更多/编辑保持单行，本机禁用分享上方另有可键盘访问的同步设置入口。清除框动作标题/危险式主按钮已改，默认焦点到主按钮；同步设置隐藏重复本机状态与立即同步，只在需登录时显示重新登录。

修正验证：最终 renderer **343/343**、store **22/22**（含真实本机提交时间与远端时间未知回归）、desktop 构建、三包格式检查均通过；固定 Hub 归档 drift check **46/67**。原生完整重跑 **12 组效果、53 张截图、0 页面/控制台/请求错误**，53 张均逐张查看。首轮翻译检查发现通用 `updated {time}` 的中文冲突，改用独立事实行文案后完整 renderer 复跑通过；截图检查另补分享确认预览的根位置和危险式动作焦点。没有调整超时、断言或权限边界。新证据在 Circle `docs/workbench/validation/knowledge-review/`，原第五阶段证据保留；`knowledge-validation.md` 已链接新回执。代码工作树提交后干净，未 push。实际 Hub 往返与打包验收现在开始，尚不计为通过。

### 第六阶段真实 Hub 联调

固定 Hub `410c9c44fcedef41bd1755bdbd0bef6600cd904e` 的 `git archive`，临时展开并只链接 node_modules；归档 SHA-256 `15216cdd772bacf151a57c1273c4438c1338a223a00f52bd4f7e4d3902314bfd`，drift check **46 mirrored / 67 upstream**。Hub 工作树只读。Circle 新增可重复执行的 `scripts/knowledge-hub-acceptance.ts`，接受只读 Hub 仓库及输出回执位置；入口固定提交，使用该提交 `createTestHub` 的真实组装服务、私有临时 PostgreSQL、临时 FileKeyProvider/vault、127.0.0.1 随机端口。所有请求在脚本中拒绝非 loopback 和 7420/7443，所有账户、正文、home 和工作区均为合成；结束关闭进程并删除自己的临时目录。

实际通过的七组效果：

1. Circle 既有 MCP OAuth 的真实密码登录、同意、回调和 token exchange；桌面 prepare/confirm 选择连接，个人记忆经 `/api/sync/v1` 同步后用独立 MCP 客户端按映射逐字读取。
2. 停止 Circle 后从 Hub MCP 与本机分别编辑同一记忆，恢复同步保留两条原文修订并显示有冲突，不自动解决；随后传入明确选择的完整字段解决。
3. 映射后的记忆先 check-only、本次明确确认后分享到团队，另一合成账户读取独立团队副本。
4. 本机上传来源的知识条目虽本机/Hub 均核验通过，真实 Hub 仍返回 **SHARE_UPLOAD_UNSIGNED** 并保存拒绝回执；该拒绝必须保留，不能把来源核验等同上传署名。
5. 依 Hub 自身验收的夹具模式，以 artifacts.ingest 登记一份独立、合成的团队读取来源记录，原上传记录不改。然后同一已映射知识条目由真实分享接口合并，另一账户按团队引用读取正文与 verified 状态。这只证明该合成资格路径，不证明真实连接器或尚未实现的上传署名。
6. 切本机先真实影响预检再确认，等待清除完成，个人用量归零、本机头不动、团队副本仍可读；显式恢复同步后新 epoch，重新上传本机副本并逐字读取。
7. 撤销实际 OAuth access token 产生真实 HTTP 401，客户端暂停且未打开后台登录；由桌面登录动作再次走密码/同意/回调，重新选择后恢复同步。

首次失败与修正均在验收脚本，不放宽产品校验：目录接口只返回记忆元数据，改为按 document/version 读取正文；冲突解决不能从两个头任意推断标题，脚本补显式标题/状态；epoch 按 Hub 实施方案第 3 节规定在从本机恢复 Hub 时轮换，清除时不要求轮换；根 TypeScript 检查发现跨应用静态导入会错误套用根 NodeNext 配置，改为按 URL 通过 tsx 加载桌面边界，桌面仍由自己的 tsconfig 检查。原先期望未署名上传直接共享的失败，改成验证真实拒绝，再另设明确标注的合成团队来源成功路径，没有改 Hub、冒称真实来源或删除失败场景。

完整 CLI / 两应用检查、开发及本地包原生验收正在执行，最终命令、跳过、源码/构建/ASAR/截图摘要另记。

第六阶段完整本地检查已通过：`npm run check` 为 **1,800 通过 / 10 Windows 跳过 / 0 失败**（1,810 项），类型与 CLI 构建通过；`npm run check:apps` 为 renderer **343/343**、desktop **163/163**、runtime **820 通过 / 17 Windows 跳过 / 0 失败**（837 项），类型与应用构建通过。三包格式检查通过。完整 development `test:desktop`、interface 宽窗与 1,024px（各 **48 条命令 / 88 组检查**）、live **25** 组、browser-live **29** 组均通过；最终 knowledge 原生流程 **13 组实际效果 / 53 张截图 / 0 错误**，53 张均已逐张查看。

完整 interface 首次失败为新 `/knowledge` 缺少断言，且旧 `/memory` 仍期待只显示文件提示。按实际页面行为补页路由/标题与 preview 不能读取本机数据的明确边界断言；`/memory add` 的文件兼容断言保留。改后完整 desktop 及两种宽度的 interface 重跑通过，没有改变超时或可见性要求。另加知识原生的真实 worker 模型请求断言：团队先于个人、结构化正文中的 `<native literal>` 实际转义、停用/冲突/共享记忆排除、结构化偏好块小于 48,000 字节（本次 **851** 字节），兼容文件上下文排在之后。该新增断言首次错误地要求文件也进入结构化块；实际请求表明文件已沿原 `<memory>` 机制加载，按已批准的“原文件机制保持兼容”修正测试，没有改产品读取或原文。回执只存该块的摘要/字节数和条件，不存模型请求或会话转储。

本地 `.app` / `.dmg` 已生成，ASAR SHA-256 **`f01e3d7a543a44fa0b308a14141a5e2a3b5d1e44b30f9b1c6d803d63adcbb9dd`**。从 ASAR 读取的 **2,645** 个构建文件与本次 desktop 构建逐字节一致；CLI/desktop 各 25 份协议资产一致，**2,579** 个打包产物摘要均核对。没有安装到 Applications，没有发布或推送。打包应用的完整原生验收已启动，结果仍待本轮实际完成后补记。

### 第六阶段结果与交付边界

要求的知识/同步联调和打包主流程已完成；另行补充的终端 AX 检查有已定位的旧基线失败，不能把整个分支的所有原生路径说成全绿。

- 打包 `test:desktop` 退出 0，helper 单元 **17/17**、主桌面完成 **23** 组；既有回执在最后一组之前写出，记录 22 组，stdout 完成记录 23 组，汇总保留二者而不改计数。两种协议的脚本网关各有 5 次实际模型请求，重启、原检查点和工具批次检查通过。
- 打包 interface 宽窗 / 1,024px 各 **48 条命令 / 88 组检查**，live **25** 组，browser-live **29** 组，knowledge **13** 组 / **53** 张截图，全部退出 0。开发与打包最终各 53 张，共 **106** 张 PNG 均已逐张打开；未见知识矩阵的外层溢出、裁切或新增未翻译界面词，原合成正文保留。脚本的首帧/稳定帧边界检查与 Codex 的视觉判断分别记录。
- 打包 desktop 既有 guard 明确跳过 browser-page、browser-lifecycle、browser-key-race、terminal-panel 和 popout，共 **5** 项；其中 terminal-panel/popout 的跳过条件也含 `CIRCLE_DESKTOP_EXECUTABLE`。原 skip 信息泛写“desktop-capable session”，本次按源码条件解释。browser-live 与 packaged popout-press 另有实际运行；stock Electron 的 select-all helper 不冒称打包应用结果。全部 skip 原文在 checks.json。
- 补充运行 `native-terminal-accessibility.mjs` **退出 1**，失败为“600 real PTY output lines”。失败图中命令已输入但新终端菜单重新打开，首次 Enter 没有落在终端。核对得到本分支 `NativeTerminal.tsx` 与 **`d2e31542^`** 的 Git blob 都为 **`2365c4d05ed41220d83e4c537044b22b876867c0`**，二者文件 diff 为空，共同基线为 **`ee7466ed`**。即已批准的 #405 `d2e31542` 的菜单退出保留 xterm/dialog 焦点修复尚未进入本知识分支；`workbench-graphite-local` 当前已到 `169bd3cc`。这是本分支已知的基线产品问题，不归咎于知识改动，也不以等待更久、增加重试或减少 600 行断言转绿。保留失败结果，后续整合已审定 workbench 基线时一并处理。本次没有跨分支 merge/rebase 或重复改该已审定修复。补充流程的剪贴板已恢复、应用已关闭；失败图含本机终端路径，仅留 ignored artifacts，不进 Git。

最终可审阅入口是 Circle `docs/workbench/knowledge-validation.md`；`validation/knowledge-final/` 保存真实 Hub 回执、开发/打包各 53 张原图及源码/构建回执、全部检查/跳过/首次失败、视觉逐张清单与 ASAR/DMG/产物摘要。`checks.json` 明确记补充 AX 的 `exit: 1` / `notCountedAsPass: true` 与已审定修复依赖，没有把失败算通过。协议镜像、共享样例、依赖/锁文件、版本和提示词预算测试均未改，未放宽超时/可见性/内容/权限断言。Hub 工作树复查干净且仍为 `410c9c44`；没有接触所有者数据或部署。

本次实际结果只覆盖 macOS arm64、合成账户/资料与 scratch picker 自动化，不建立真实连接器、上传署名、生产可用性、手动系统选择器或其他原生平台的结论。第六阶段交 Claude 审查，补充终端失败和基线整合依赖保留，不把整体验收描述为无条件全绿。

第六阶段代码/测试/证据已在 `knowledge-sync` 本地 `-s` 提交 **`5c65dd62de14526b5874727addf9074f524f54dd`**（`Add isolated knowledge round trips and packaged acceptance evidence`）；此前五项视觉修正在单独的 **`edf9fc0c`**。代码提交后工作树干净，所有 106 个最终 PNG、两份回执的各 **1,139** 个源码 / **2,645** 个构建文件及 Hub runner 摘要均核对。最终目录为 **106 PNG + 6 JSON**，不含原始模型请求、日志/会话转储、本机绝对路径或补充失败图；check 汇总 SHA-256 为 **`d7edb8cecc99c16502a9a8d93db878b095ca28afb64d5146dd5295ac537505e4`**。任务记录只提交本页到 `circle-knowledge-notes`，没有 push，没有修改 Hub、Circle visual 工作树或 #405。

### 审查后 Rebase 与复验开工

来源：Claude 批准 `5c65dd62` 和 `edf9fc0c`，要求知识 PR 叠在 #405 的 `169bd3cc` 上，保留旧 head，重跑终端 AX、完整 CLI/应用检查及开发知识原生流程，合并知识 CHANGELOG 条目；只做本地提交，由 Claude push 和开 PR。

开工代码/笔记工作树均干净。已建立 **`knowledge-sync-pre-rebase` → `5c65dd62de14526b5874727addf9074f524f54dd`**，把从 `ee7466ed` 起的七个知识提交 rebase 到 **`169bd3cc37f62cb7d5001561fecf46c0247e6d33`**，新 rebase head 为 **`69614d2d`**。唯一冲突在 `components/ui.tsx`：#405 已把 Dialog 的焦点选择提取到 `model/dialog-focus.ts`，知识视觉修正仍修改旧内联函数。保留 #405 的新模块、已交互输入的选择/焦点保护与 overlay 生命周期，将知识的 `button.danger` 主动作焦点规则移到该模块，不恢复旧内联实现。range-diff 的其余提交一致，NativeTerminal 和 NativeBrowser 与新基线无额外差异。

知识的五个分阶段 Added 条目和一个 Inspector Changed 条目合并为 Unreleased 下的一条知识/记忆/工作流条目；#405 的条目保留，删除已过期的“真实 Hub 联调尚未完成”表述。复验先从 rebase 后代码重建并生成新的隔离本地包，以同一个终端 AX 脚本验证已批准修复；不使用旧 ASAR。随后串行运行 `npm run check`、`npm run check:apps` 与开发 knowledge native check，避免高负载干扰短期限。全部 home/data、模型和资料继续隔离且合成，结果与每项失败/跳过另记，历史 rebase 前证据保留。

AX 首次复验：旧失败点已通过，第一组真实效果完整通过（600 行 CJK 输出与复制、AX 树、三次可信系统开关、原 DOM/PID 和选择/滚动保持）；随后脚本在模态 Settings 仍打开时点击背后的会话，得到 15 秒 pointer-events/overlay 拦截超时，退出 1。该步骤过去未越过 600 行故障，遗漏了已改为模态的设置关闭动作。复用已有 `closeNativeSettings(page)`，通过原生可见关闭按钮关闭并等待设置隐藏后再点会话，未 force click、增时、重试或移除断言。第二次同一本地包 AX 完整退出 0，**2 组效果**通过，原 Settings 的 ALWAYS ON/AUTO、可信 false 下的 AX、原 PID/DOM、600 行完整复制均保留；剪贴板恢复、应用关闭。首次失败回执与最终回执分别保留，失败截图/原 AX 树有本机路径，只留 ignored artifacts。

补充用固定 Hub `410c9c44` 的新干净归档重跑 drift check：**46 mirrored / 67 upstream**；未修改镜像或 Hub 工作树。CLI/应用全量检查与开发知识原生流程现正在串行执行。

第一轮完整检查已退出 0：CLI **1,800 通过 / 10 Windows 跳过**；renderer **343**、desktop **163**、runtime **820 通过 / 17 Windows 跳过**，类型与构建通过。三包格式检查通过。开发 knowledge 原生流程随后退出 1：冲突编辑对话框首帧移出窗口。失败图确认是合并后的产品样式问题，非负载或超时。知识第五阶段将 `.dialog-content` 改为独立 `translate: -50% -50%`；新基线 #405 则在入场动画 `transform` 中补同一居中位移，两套方案在无 Git 冲突的 CSS 中叠加，导致动画期间二次位移。恢复到 #405 原有 `transform: translate(-50%, -50%)`，使 app.css 与 `169bd3cc` 完全一致，继续由 graphite 动画保留单一居中。原 knowledge 首帧/稳定帧边界断言全部保留，未延长等待或改可见性条件。首次原生失败图/日志保存于 ignored artifacts；随后对修正源码重新构建，先跑开发知识原生流程，再生成新本地包重跑 AX，最后重新串行跑两组完整检查。第一轮及修正后的结果分别记录，不把先前构建摘要用于最终源码。

CSS 整合修正后，开发 knowledge 原生流程退出 0：**13 组效果 / 53 张截图 / 0 页面、控制台及请求错误**。原首帧与稳定帧边界断言均通过；全部 53 张已在带文件名的九张检查图中查看，冲突编辑器、危险确认与中文窄窗 Inspector 另按完整尺寸打开。源码回执 **1,140** 项、构建 **2,645** 项及全部 PNG 摘要逐一相符；真实 worker 请求仍为团队优先、个人其次，**851 字节**结构化偏好，原文件上下文在后，转义及排除条件保持。

修正源码生成了新的本地 `.app` / `.dmg`，最终 ASAR SHA-256 **`6135a20046b8f44da9b6981728b3f75eb611e65685b62ee70363542f0652eb10`**；**2,579** 个产物摘要、**2,645** 个 ASAR 构建文件及 **50** 份 CLI/desktop 协议资产核对一致。终端 AX 在此最终新包中再次退出 0，**2 组完整效果**通过，600 行完整复制、真实 AX、系统开关和原控件、PID/DOM/选择/滚动均验证，剪贴板恢复，应用关闭，无 skip。该 ASAR 取代本轮 CSS 修正前的临时包摘要，不替换或改写第六阶段旧包回执。

新证据单独保存在 Circle `docs/workbench/validation/knowledge-rebase-169bd3cc/`，历史 `knowledge-final/` 保持不动。文档明确区分本次开发 knowledge / 打包终端 AX 与 **rebase 前**的真实 Hub 联调及完整打包知识验收；没有把后两者说成本次重跑。旧的 pre-#405 终端焦点 known issue 已由实际新包复验解除；上传未署名的真实 Hub 边界仍保留。CSS 修正后的最后一轮 `npm run check` 已再次通过 **1,800 / 10 Windows 跳过 / 0 失败**；应用完整检查仍在执行，完成后补最终结果。

### Rebase 后最终结果

CSS 修正后最后一轮命令均退出 0：`npm run check` **1,800 通过 / 10 Windows 专属跳过 / 0 失败**（1,810 项）；`npm run check:apps` renderer **343/343**、desktop **163/163**、runtime **820 通过 / 17 Windows 专属跳过 / 0 失败**（837 项），全部类型检查与最终 CLI/应用构建通过。三个包的 `format:check` 再次通过，`git diff --check` 通过。每个 skip 名称及实际 guard 原文均在新 checks.json，开发 knowledge 和打包终端 AX 没有跳过步骤。保留构建既有的大 chunk、updater CommonJS/import.meta、可选 .icon 与磁盘镜像工具弃用警告，不把警告计为新测试失败。

最终应用构建完成后再核对：开发回执 1,140 个源码、2,645 个构建、53 张 PNG 均匹配；同一 2,645 个构建文件与最终包 ASAR 逐字节一致，2,579 个产物摘要全部相符。历史 knowledge / knowledge-review / knowledge-final 证据无改动。新目录含 **53 PNG + 5 JSON**，checks.json SHA-256 **`c00db0c15c618caba5e5564be99575bba4c1173cad0489f4b7a9b48eeb12a11a`**；AX 的首次失败、修正前临时包通过与修正后最终包通过均分开记录，开发 knowledge 首次 CSS 失败也单列，不将首次失败计为通过，不发布原始日志、AX 树或模型请求。

代码与证据已在 `knowledge-sync` 本地 `-s` 提交 **`7c4a10793e07af0bcc47153552ac068ce48e9b54`**（`Preserve rebased dialog placement and refresh knowledge validation`）。该 head 以 **`169bd3cc`** 为基线，保留七个知识阶段提交及一条整合/验收提交；**`knowledge-sync-pre-rebase` 仍指向 `5c65dd62`**。Unreleased 只有一条知识功能条目、无重复 bullet，#405 的九条原有记录全保留。依赖、三个锁文件、镜像/共享样例及提示词预算测试未改；终端/浏览器组件与 app.css 均与 #405 基线一致，Dialog 仅保留知识所需的既有能力和迁移后的 danger 主动作焦点规则。代码工作树提交后干净，没有 push、PR、安装或部署操作；任务记录只在 `circle-knowledge-notes` 提交本页，交 Claude 推送并创建 stacked PR。

### 审查后证据瘦身与历史重建

来源：Claude 批准 rebase 和全部检查，指出 merge queue 使用 merge commit，要求在 push 前将新增历史 blob 压到约 10 MB 以下；原 head 保留为 knowledge-sync-pre-slim，逐个重放原提交消息/sign-off，排除四套大证据后只加一个最终证据提交，禁止 interactive rebase。

已建立 **`knowledge-sync-pre-slim` → `7c4a10793e07af0bcc47153552ac068ce48e9b54`**，另把全部原证据/完整 manifests 复制到 ignored artifacts。在原工作树从 **`origin/workbench-graphite-local` = `169bd3cc`** 重建 knowledge-sync，逐个 `cherry-pick -n`、从本次 index/worktree 去掉明确列出的四个 evidence 目录，再用 `git commit -s -C <old>` 保存原消息。八个重放提交均核对原作者、作者日期、完整消息和 sign-off 一致，且每个提交的树中均没有 evidence 目录；只在最后的新提交加入精简证据。未使用 interactive rebase。

| 原提交 | 重建提交 | 消息 |
| --- | --- | --- |
| `4b641b151a08cd8bac02d40c0bef660ea1ee2f4c` | `8caf5e9e38ba98a41923073e6a1111995fd8317b` | Add the local knowledge protocol mirror and versioned search store |
| `9d8bb1864c5e829df931cb6137d1706ffdcb36e9` | `09624f8301ab5fecbafff360ca7ebd9847163959` | Add confirmed local knowledge tools and personal pack installation |
| `ce82520168e06e6dd034a5f91319f76ed07aadf2` | `542f1d465e25b4eb6eb7277748734ac71d778003` | Add resumable personal sync with fenced leases and preserved conflicts |
| `addbaad688c8e43788553c0a8e18b78c92da845b` | `f4a7e105eeab3d202869b098a1cec6454e216490` | Reuse MCP authorization for personal sync and load session preferences |
| `5e2d26015af6529805913a096542a21203217216` | `e1727fcc72a33e8ec346123c30f90837a310b65b` | Add desktop knowledge pages and confirmed sync controls |
| `699ba76547d982e7e451d568561650ebbc51a745` | `691f965067c32a1afd8c561a667c40a525922a1a` | Refine knowledge inspectors and local-only sync controls |
| `69614d2d4d99fd23b31c91ae45431502de0c6e6e` | `c827052029356aac981f8fe8b556623c7ebc7eaa` | Add isolated knowledge round trips and packaged acceptance evidence |
| `7c4a10793e07af0bcc47153552ac068ce48e9b54` | `2b08b2caf9df8c9aefb5c03bb3561277b399f1f2` | Preserve rebased dialog placement and refresh knowledge validation |

最后单独增加 **`12eab5d3f288667f9c55351659f2dd4f63276365`**（`Retain compact knowledge validation evidence`，`-s`）。现分支只有上述八个重放提交和这一个 evidence 提交叠在 #405 基线上；旧 head 仅保留在本地备份分支，没有把旧提交合并回来。

唯一证据集为 Circle `docs/workbench/validation/knowledge/`：**15 张 1x CSS 像素 PNG + 6 份紧凑 JSON**。14 张来自已批准的 post-rebase development run；中文 local-only 影响确认框原矩阵未拍，使用原 native harness 的 ignored 副本、同一份产品/构建字节、原中文设置控件和隔离合成夹具补拍一张。补拍脚本首次因移动文件导致两个子进程 import 路径错误，修正临时脚本导入后退出 0、零页面错误；未修改产品或原测试脚本，且不把补拍说成完整验收重跑。

PNG 按原回执 viewport 等比整数 box-average RGBA 降采样，无裁切、修图或内容替换；15 张最终 PNG 均已逐张打开。保留知识 Inspector 的中英/深浅/宽窄、中文记忆与工作流、中文浅色及英文深色同步设置、中英危险确认、本机分享提示、冲突编辑、展开来源、空态和 700 px reduced-motion 键盘焦点。每张 PNG 的保存摘要、原图摘要、原/目标尺寸和来源 run 都在 receipt.json。验证了全部转换像素等于原图采样结果，尺寸逐一等于 CSS 视口。

完整 source/build/artifact/layout 清单不再进 Git。receipt.json **10,014 字节**、checks.json **12,569 字节**，artifact-receipt.json **1,002 字节**；六份 JSON 共 **34,434 字节**，使用 SHA-256 聚合摘要与计数，只有保留的 PNG 和 ASAR/DMG 保留单项摘要。聚合编码明确为按 path/file 的 JS code-unit 顺序排序原记录、JSON.stringify 后加一个 LF；当前原 helper 再生的 **1,140** 个源码和 **2,645** 个构建清单与摘要一致。Hub roundtrip 回执逐字节保留，仍明确为 pre-rebase 真实隔离 Hub 证据；完整打包知识验收同样保持历史边界。

文档已统一新路径；`docs/workbench/knowledge-validation.md` 说明压缩、保留范围、历史边界和再生方法，`validation.md` 更新索引，`docs/known-issues.md` 仅修改 Hub 回执链接。全量搜索 apps/tests/scripts 没有读取这些提交证据路径的测试或脚本，因此没有此类受影响测试需要重跑。产品、测试、脚本、CHANGELOG、依赖及各锁文件与备份 head 完全相同；指定的 `git diff knowledge-sync-pre-slim -- ':!docs/workbench/validation'` 只列上述三份文档，无代码差异。

实际复查：根、workbench、desktop 三个 `format:check` 均退出 0；**production Jekyll build 退出 0**，使用临时 Ruby **3.3.9** / Bundler **4.0.20** 与现有 Gemfile.lock 的精确依赖，不改系统或仓库依赖。系统 Ruby 2.6 初次无法激活锁定 Bundler 的阻挡保留说明；隔离工具链构建只有 just-the-docs 既有 Sass 弃用警告。**53 个本地文档链接、15 张 PNG 的尺寸/摘要/全部转换像素、聚合 manifests、JSON 解析与本机绝对路径排除、Hub 原回执相等、八个历史提交无证据目录、源码零差异** 均通过，`git diff --check` 通过。完整 CLI/应用套件按本次存储改动范围未重跑，原批准结果及全部平台 skip 名称/guard 保存在紧凑 checks.json。

最终用 Claude 给定的同一命令统计新增对象：

```sh
git rev-list --objects origin/workbench-graphite-local..HEAD | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)'
```

只合计 blob：原 **68,733,312 字节（65.55 MiB）** → 新 **7,959,832 字节（7.59 MiB，264 个新增 blob）**；PNG 原 **227 张 / 58,341,353 字节（55.64 MiB）** → 新 **15 张 / 2,477,271 字节（2.36 MiB）**。新历史中 knowledge-review、knowledge-final、knowledge-rebase-169bd3cc 的 blob 为零，15 张 PNG 仅在最后 evidence 提交进入历史；低于 10 MiB 上限。代码提交后工作树干净，仅本地提交，未 push、开 PR、部署或接触所有者数据。任务记录只提交本页到 circle-knowledge-notes。

### 已发布 PR 后续：保留 Hub 上传署名拒收

来源：Claude 已 push knowledge-sync 并建立叠在 #405 上的 #406，明确禁止再改写历史，只在其上加新提交；要求检查 SHARE_UPLOAD_UNSIGNED，在中英分享预览中原样显示 Hub message/fix，并提示上传人去 Hub 控制台署名后重新分享，不能呈现成 Circle 错误或网络重试。

原实现的分享 payload 在 MCP isError/call_result 失败时抛统一 knowledge-remote-unavailable，两个字段被丢弃；renderer 最终显示“无法打开内容，请刷新后重试”。新增严格识别的业务拒收结果，在仍有效的分享对话框内标注来源为 Hub，原样显示 message/fix，只有标题和操作指引经过 t()。正文按纯文本转义并保留空白，不把 Hub 中文内容翻译成英文。补充上传人署名指引和显式“重新检查分享”，原确认票据用后失效；无后台重试、登录或签名操作。只有这个已识别码的有效、受限、凭据扫描通过的内容能跨 DTO；其他主机异常仍不原样回显。没有改 Hub、协议镜像或添加端点。

回归验证通过：真实 MCP + desktop 服务边界的拒收原文、精确空白/换行、无本机改写、无自动重试、票据不可复用、显式再检查/确认、畸形结果和凭据过滤；针对性 backend **22/22**，renderer/i18n **15/15**，三包类型检查通过。首次 backend 两个进程因 Unicode 校验函数导入到错误模块而未启动，纠正为 unicode.js 后通过；该首次失败未计通过。完整 `npm run check` **1,802 通过 / 10 Windows 跳过 / 0 失败**（1,812），`check:apps` renderer **344**、desktop **163**、runtime **820 通过 / 17 Windows 跳过 / 0 失败**（837），构建通过；三包格式、production Jekyll、**54** 个本地文档链接与 PNG 摘要/CSS 尺寸检查通过。原平台 skip 名称/guard 未变，沿用 checks.json。

开发与本地打包各 **15 组效果 / 55 张 captures / 0 页面、控制台及请求错误**，包含中英两套严格 textContent 原文比较和无 Circle 错误条。两张拒收画面都转换成 1x 后逐张查看，只将中文窄窗图替换旧英文 tooltip，证据集仍 **15 PNG**。share-refusal.json 存紧凑聚合清单和首跑失败说明，完整 manifests、英文图和日志只在 ignored artifacts。**1,140** 个源码、**2,645** 个构建及 ASAR 文件逐字节核对；本轮包 ASAR **b3c139fc7c87d38bc8d959122489a31d5db7d55f767912a03e24ae7081e50c43**。这是合成 MCP client 展示证据，不冒称实际 Hub 签名或真实部署联调。

已新增 `-s` 提交 **520aaf63c65e2412418204ffcc938349b46f8911**（Preserve Hub upload signature refusals in the share dialog），直接接在已发布 12eab5d3 上，没有 rebase/amend/reset/push。

### 所有者收窄后续：未绑定 Hub 的个人页面

来源：Claude 后一条消息明确 supersede 前一条 owner direction：只做 binding 为空时知识/记忆页仅“我的”，隐藏团队/与我共享且不报加载错误；侧栏“未连接 Hub”点击打开同步设置。已绑定时原行为完全保留，包括仅保存在本机模式。撤销的 offline/login empty states、live-only/cache 测试、团队工作流和共享列表事项未开始实施，也没有相应待回退代码。

实现只增加主进程从 settings.knowledge_sync.binding 投影的 bound 布尔标记（不向 renderer 发实际 binding），两页按它选择可显示/请求的 scope，空 binding 的 team/shared URL 也只请求个人列表；侧栏保留原同步设置入口并显示未连接文案。每页各一项 SSR 回归在中英检查无绑定只有“我的”、无错误条，同时保留已绑定 local-only 下原三 scope。初次从根目录运行 renderer 测试误用根 JSX 配置，改从 workbench 执行；新页面 SSR 首次缺 TooltipProvider，补与 App 相同的 provider 后 **17/17** 通过。没有改断网、登录、缓存、工作流、共享枚举或 session-memory 行为。原生开发/打包未绑定流程也已通过，正在补齐最终深浅主题替换图及应用检查，完成后补提交与结果。

未绑定状态的后续复查已完成。根 typecheck、renderer/i18n **17/17**、完整 check:apps 的 renderer **346**、desktop **163**、runtime **820 通过 / 17 Windows 跳过 / 0 失败**（837）和构建均通过；三包 format:check、production Jekyll、**58** 个本地文档链接、15 个 PNG 的摘要/CSS 尺寸检查通过。本阶段未重跑 CLI 全套：上一提交的 **1,802 / 10 Windows 跳过 / 0 失败** 保留，此阶段根代码只改 DTO 接口的可选布尔字段，根类型检查已重跑。没有新增 skip 或放宽检查。

原生最初的浅色开发/打包流程各 18 组通过；补齐深色时，一次开发复验在 settings 文件的 binding 断言失败：检查只等中间关闭 snapshot，断开操作尚未完成。保留该失败及原始图/日志于 ignored artifacts，改为等待原“断开连接”按钮在完成 reload 后隐藏，再检查保存的 binding 精确为空，结束前再检查一次；未改产品断开逻辑、未轮询重试或延长超时。最终开发/打包各 **18 组效果 / 57 captures / 0 页面、控制台及请求错误**，三个新增组分别核对知识页、记忆页的真实个人行与远端 scope 不可请求、侧栏两语言入口实际打开同步设置。

两张最终 1x 原生图均已逐张打开：中文浅色与英文深色的未绑定知识页。替换原 expanded-source 和 empty-state 两图，证据目录仍 **15 PNG**；no-hub.json 只保留聚合 manifests、条件/结果与首次观察失败说明，完整清单/原图仍在 ignored artifacts。当前 **1,140** 源码、**2,645** 构建及同数量 ASAR 文件均逐字节核对；本阶段 ASAR SHA-256 **eac9710de5e541665cbb35962813f552f0b32589c430d353d613021ca6a15599**。首个 Hub 拒收证据与之前所有历史边界保留，不把新的 client 夹具检查冒称真实 Hub round trip。开发说明中遗留的“分享错误仍为 generic”文字也同步纠正为已完成的 message/fix 原文展示。

已单独新增 `-s` 提交 **10ca2fc0b00e1e19f4a74f4fc721b5caea5e0f8b**（Show personal pages when no Hub is bound），其父提交是 **520aaf63**，再接已发布的 **12eab5d3**；没有重写任何已发布提交。按相同命令复算当前分支新增 blob 为 **9,291,661 字节（8.86 MiB）**，仍低于约 10 MB。代码工作树干净，没有 push；任务记录只提交本页到 circle-knowledge-notes。所有者撤销的第 2–5 项均未实施，工作流/离线登录视图/共享列表/缓存与会话记忆逻辑没有变化。此后等待 Claude 的 CI 结果，不主动扩展其他 Hub 工作。


### PR #406 CI 修正：资源关闭顺序与终端折行

来源：Claude 转交 Windows run `41561578080` 和 Linux native run `41561578064` 的只读完整日志，要求先修 CI，不增加超时、不跳过 Windows、不改变生产持久性。本次失败的 CI checkout 为 `ed9d3fe28fd77134f41b8bac8c811b4477d6f35b`（知识 `12eab5d3` 合到 #405 `169bd3cc`）。收到消息时，后续 `520aaf63` / `10ca2fc0` 已在本机完成；保留既有历史，全部 CI 修正只追加新提交，未 push 或操作远端 CI。

**Windows：资源清理顺序错误。** `scratch(t)` 先注册删除目录的 after hook，四份早期知识测试再用 `t.after` 注册 close；Node 按注册顺序执行，删目录时 SQLite 仍开着。macOS 可 unlink 打开的数据库，Windows 的占用拒绝却会令递归 rm 的既有重试等待。日志只报 240 秒期限，没有底层文件占用栈；本机用原测试和合成 Windows EBUSY 守卫，复现同一个 frozen exchange 的 hook 失败（13 通过 / 1 失败），与 CI 现象一致，真实 Windows 耗时仍待 CI 确认。

改为现有 `cleanup(t, …)` 资源队列，先等待数据库、客户端、服务器关闭，再删 scratch；异常清理 lease holder 也等待真实 child exit。新增真实 SQLite 回归，断言 close 发生时文件仍在，之后才删除目录。完整观察 raw SQLite 和 helper 后，原组有 **124 次**开库删除（protocol 1、store 21、lease 4、sync 98），修正后为 **0**。早期只观察 exec 的探针少计 1 个仅 prepare 的句柄；下表采用最终完整探针。

**测试准备合批。** exchange 的 30 个规范对象一次 putBatch，仍逐件检查 canonical/hash；store 的 page/snapshot 一批写，原 fixture 仍验证规范字节和 identity。配额设置直接生成 20/21 份独立记忆的一份初始快照，去掉 39 份无关中间历史（78 个 page/snapshot 对象），单条创建、编辑、禁用、删除、CAS、崩溃和 reopen 的原检查保留。sync、memory、sharing 的每个 world 共用一个 scratch 根，各账户、peer、workspace、userHome 仍是独立目录。生产 apply/syncAtomic 已包住对象循环，下载也已按批；本轮不改生产事务。相对 `10ca2fc0`，src、两个应用 src、所有 package/lock 文件的 diff 均为 **0 字节**；FULL、对象 fsync、协议镜像、超时和平台 guards 原样。

**计数与本机时间。** 新的显式 preload `scripts/knowledge-test-metrics.mjs` 及可选 macOS dyld companion `scripts/knowledge-test-fsync.c` 可复现采集，不链接进 Circle。仅输出计数、basename、PID，不输出参数、token 或本机路径。native hook 保留 fsync 返回值和 errno；已校准 Node fsyncSync 为 JS 1/native 0，新 SQLite FULL 建表和插入为 JS 0/native 8，故两列相加。故意 SIGKILL 的 holder 在就绪时保留计数。

两边 tsx 均预热后，串行运行 15 文件，每边 **219/219，0 跳过**；after 另开严格清理守卫。BEGIN 含读事务，prepared 自动提交 DML 另列；fsync 是调用数，非物理刷盘次数；scratch 是 mkdtemp 根，不把每次 mkdir 都算成新目录；秒数含导入、插桩和清理，为单次本机观察，不推算 Windows。异步状态回执可令 sharing 的日志写入相差 1 次，未将此当成固定预算。

| 文件 | SQLite 打开 | BEGIN（读/写） | 自动提交 DML | fsync（Node + native） | scratch 根 | 用例子进程 + 编译器 | 删目录时仍开库 | 本机秒 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| knowledge-authorization.test.ts | 20 → 20 | 79 → 79 | 12 → 12 | 28+217 → 28+217 | 37 → 37 | 2+0 → 2+0 | 0 → 0 | 1.301 → 0.874 |
| knowledge-json-parser.test.ts | 0 → 0 | 0 → 0 | 0 → 0 | 0+0 → 0+0 | 0 → 0 | 0+0 → 0+0 | 0 → 0 | 0.085 → 0.095 |
| knowledge-markdown-parser.test.ts | 0 → 0 | 0 → 0 | 0 → 0 | 0+0 → 0+0 | 0 → 0 | 0+0 → 0+0 | 0 → 0 | 0.280 → 0.298 |
| knowledge-packs.test.ts | 84 → 84 | 109 → 109 | 7 → 7 | 72+232 → 72+232 | 11 → 11 | 0+0 → 0+0 | 0 → 0 | 1.218 → 0.862 |
| knowledge-protocol.test.ts | 1 → 1 | 35 → 6 | 0 → 0 | 60+37 → 60+10 | 5 → 5 | 0+0 → 0+0 | 1 → 0 | 0.704 → 0.529 |
| knowledge-scan.test.ts | 0 → 0 | 0 → 0 | 0 → 0 | 0+0 → 0+0 | 0 → 0 | 0+0 → 0+0 | 0 → 0 | 7.349 → 7.075 |
| knowledge-session-memory.test.ts | 158 → 158 | 242 → 242 | 77 → 77 | 122+755 → 122+755 | 48 → 12 | 0+0 → 0+0 | 0 → 0 | 1.789 → 1.771 |
| knowledge-sharing.test.ts | 116 → 116 | 237 → 238 | 35 → 36 | 208+479 → 208+481 | 28 → 7 | 0+0 → 0+0 | 0 → 0 | 1.634 → 1.934 |
| knowledge-store.test.ts | 34 → 34 | 269 → 222 | 1 → 1 | 327+373 → 327+363 | 23 → 23 | 2+2 → 2+2 | 21 → 0 | 3.687 → 3.948 |
| knowledge-sync-lease.test.ts | 11 → 11 | 24 → 24 | 5 → 5 | 0+43 → 0+51 | 5 → 5 | 7+0 → 7+0 | 4 → 0 | 0.763 → 0.739 |
| knowledge-sync.test.ts | 334 → 334 | 1154 → 1150 | 99 → 99 | 972+1585 → 972+1777 | 98 → 34 | 0+0 → 0+0 | 98 → 0 | 5.631 → 5.573 |
| knowledge-terminal.test.ts | 104 → 104 | 135 → 135 | 23 → 23 | 78+522 → 78+522 | 35 → 35 | 0+0 → 0+0 | 0 → 0 | 1.610 → 1.501 |
| knowledge-text-parser.test.ts | 0 → 0 | 0 → 0 | 0 → 0 | 0+0 → 0+0 | 0 → 0 | 0+0 → 0+0 | 0 → 0 | 0.037 → 0.038 |
| knowledge-tools.test.ts | 99 → 99 | 198 → 198 | 99 → 99 | 48+812 → 48+812 | 16 → 16 | 0+0 → 0+0 | 0 → 0 | 0.944 → 0.935 |
| knowledge-verification.test.ts | 220 → 101 | 293 → 135 | 0 → 0 | 480+495 → 324+300 | 20 → 20 | 0+0 → 0+0 | 0 → 0 | 3.200 → 1.313 |

最终合计：SQLite 打开 **1,181 → 1,062**，BEGIN **2,775 → 2,538**，自动提交 DML **358 → 359**；Node/native fsync 分别为 **2,395/5,550 → 2,239/5,520**，合计 **7,945 → 7,759**；scratch 根 **326 → 205**，mkdir 调用 **4,729 → 4,429**。必要的 **11 个 fixture child**（2 auth、2 crash、7 lease）保留，另有 2 esbuild、15 文件 worker、1 runner，两边都为 **29 个进程**。整组 **30.768 → 28.002 秒**。不是每个文件都变快；正确 close 恢复了普通 WAL checkpoint，sync/lease 的 native fsync 增加，没有削弱持久性来消除它。首轮带冷路径编译的 44.063 → 40.163 秒仅保留为原始记录，不用作公平对比。

**Linux：已到达 shell 的 echo 被视觉折行。** 只读下载 native artifact 后，failure.json 和原图都显示末尾 `ab` / `c` 跨行，composer 完整保持 `stays in the composer`。旧 innerText 查找连续 abc，因为软折行插入 LF 而失败。改读同一可见 xterm rows 的 textContent；真实 keyboard.type、强制 composer focus 的竞争、draft 原值断言及 timeout 全保留。NativeTerminal/terminal-keyboard 与 #405 无差异；knowledge IPC 分支只执行其命令，无绑定 configure 直接返回，Sidebar 状态只有 onClick、没有自动聚焦。本次证据支持测试的折行假设错误，没有新增生产焦点补丁。完整 popout 的 GPU on/off 均退出 0，各输出 `popout: ok`，无 skip；远端 Linux 重跑由 Claude 掌握。

**验证与失败记录。**

- 最终 `npm run check` 退出 0：**1,803 通过 / 10 个 Windows 专属用例在 macOS 跳过 / 0 失败**（1,813），类型与 CLI build 通过。
- `npm run check:apps` 退出 0：renderer **346**、desktop **163**、runtime **820 通过 / 17 个 Windows 专属用例在 macOS 跳过 / 0 失败**，全部类型和 native build 通过。27 个 skip 的原名/实际 guard 在 CI 回执；没有新增 Windows skip。知识 219 项和 native popout 均无 skip。
- 三包 format:check、诊断脚本/JSON 的额外 Prettier、node --check、tracer 的 clang -Wall -Wextra -Werror 均通过；locked production Jekyll 退出 0（既有 Sass deprecation 保留）。42 个本地文档链接、15 PNG 摘要/1x 尺寸、两份各 55 文件的原指标 aggregate digest、git diff --check 全通过。
- 首次 root check 曾 **1,802 通过 / 10 跳过 / 1 失败**：我试过复用扫描测试的一次重复结果，但该文件属于按字节固定的镜像，完整性检查拒绝了它；已完整撤回，不改 provenance，重新全量通过。旧 fixture 的严格守卫 13/1 是故障复现，未混入 after 的通过数。
- 采集工具早期 dyld 头文件/符号探测和构造器 Proxy 未形成有效计数；最后采用已校准的 native hook、first-SQL/close 观察和固定热缓存流程，早期不完整数值未用于上表。任务记录首次追加遇到 shell/Python UTF-8 传输错误，未改文件，改用 ASCII JSON 传输后重写。
- 本轮只在 macOS arm64 / Node 24.22.1 / 开发 Electron 验证，全部临时 home/data、合成资料、ScriptedModel 和 loopback peer；未读写所有者数据/凭据，未改 Hub 源码工作树。未重跑实际 Windows/Linux、新打包或真实 Hub 往返，不将这些写成通过。PNG 仍 15 张，历史截图、ASAR、Hub 回执来源不变。

**本地提交。** knowledge-sync 追加 `22c5e8c8`（Windows 清理、合批和采集工具）、`6494ac02`（popout 折行）及 `5461c4a1`（文档和紧凑回执），均 -s。Circle 的 `docs/workbench/validation/knowledge/ci-follow-up.json` 约 11 KB，绑定代码 head `6494ac02`、11 个变更测试/工具源的 aggregate digest。按原 rev-list/cat-file 口径，新增 blob 为 **9,507,424 字节 / 9.067 MiB**。已发布 `12eab5d3` 保持祖先，无 rebase、amend、重排或 push；交 Claude 审查并 push。

补充文档核验边界：最后的附加检查曾误将仓库内的 workbench 回执当成站点产物，因找不到 site/workbench 路径而失败。核对 docs/_config.yml 后确认 workbench 整目录本就明确 exclude；改为核对该既有排除规则、已构建的公开 index、仓库内 11 源文件 aggregate digest、15 PNG 和 27 项 skip，全部通过，未改发布配置。原 Jekyll 成功仅指既有公开站点构建，不声称发布工作台证据页。


### Claude 后续指示：保留原 popout 检查，Windows 修正优先

来源：Claude 告知 Linux native run `41561578064` **attempt 2 已通过，包含 popout.mjs**，要求只做短查；无可信的知识功能延迟路径时，记录为 #406 attempt 1 的一次间歇失败，不改测试。这项结论取代上一节对 native 断言改动的处置；attempt 2 的结果来自 Claude，未自行触发或获取新 CI。

短查未发现知识功能在 click 后引入的可信焦点/按键延迟路径：terminal-keyboard / NativeTerminal 与 #405 相同；无绑定 configure 不启动 sync client；新增 knowledge IPC 动作不处理 terminal input；状态按钮没有 autoFocus 或挂载时 focus。attempt 1 artifact 的 ab/c 跨行和完整 composer 只证明失败截图时存在这些内容，不能证明按键时序或根因。记录为 **#406 run 41561578064 attempt 1 一次间歇失败，attempt 2 未重现**。原日志节录：

```text
2026-11-03T01:52:32.8998286Z Error: timed out: the keys after the click reached the shell
```

以新 `-s` 提交 **d8923e71e0949d514d0a5a604b87d4b2be063af3** 撤回 `6494ac02` 的 popout 改动；不重写历史。已核对整个 `apps/desktop/test/popout.mjs` 与 #405 `169bd3cc` 和已发布 #406 `12eab5d3` **逐字节一致**，原 innerText、可见 rows、按键、composer 断言、timeout 全部保留。文档与 ci-follow-up.json 同步记录此次处置，并把此前 GPU on/off 的本机通过明确限定到已撤回候选版本，未将其改称恢复后原测试的复验。

**Windows 的 substantive 修正 `22c5e8c8` 完整保留**，tests/scripts 相对该提交无差异，逐文件计数和热缓存测量不变；完整 check/check:apps 结果仍是上一节记录的本机结果，实际 Windows CI 待 Claude push 后确认。本次只做恢复后的字节对照、node --check、受影响文件 Prettier、production Jekyll 和 diff 检查，均通过；按“短查即可”没有再跑 popout 或全套。证据仍 15 PNG，新增历史 blob **9,537,589 字节 / 9.096 MiB**。代码与笔记工作树干净，无 push；此后等待 Claude 的 Windows CI 反馈。


### Claude 确认软折行根因，恢复已批准的 popout 修正

来源：Claude 明确确认 attempt 1 的 shell echo 为软折行的 ab/c，innerText 在视觉行边界插入 LF 是测试读取缺陷；“不改测试”只适用于未找到可信原因的情况。此决定取代上一节的临时处置。attempt 2 是提示符宽度碰巧避开断行后通过，不能消除同一 latent defect；#405 的相同测试也有该隐患。Windows `22c5e8c8` 的先关 SQLite、后删目录根因与修正同时获确认。

以新 `-s` 提交 **cb3ebb8f315b218882c85c628d2a52c047b6eae4** 只恢复 `6494ac02` 的 popout.mjs 变更，逐字节对照一致；不撤回 d8923e71 的其他历史，不改写任何提交。读取仍限定同一组可见 xterm rows，改为 textContent；保留原 timeout、abc 期望、真实 keyboard.type、强制 composer focus 竞争及 composer 原值断言。没有生产焦点/按键代码变更，不削弱检查。

已在临时 CIRCLE_HOME / CIRCLE_WORKBENCH_DATA_DIR、合成资源和 ScriptedModel 下重新执行完整 `node apps/desktop/test/popout.mjs`：**GPU on 和 off 均通过，两个 popout: ok，退出 0、0 skip**。本轮独立回执 freshNativeRun 绑定 cb3ebb8f、实际 test SHA-256 与完整本机日志的长度/摘要；较早 6494ac02 的结果保留历史身份，不冒称新测量。Windows fixtures/scripts 相对 22c5e8c8 无 diff；src、应用 src、package/lock 相对原基线仍无 diff。

新 `-s` 文档提交 **2ac2563d** 同步更新 knowledge-validation.md / ci-follow-up.json：根因已确定、读取已纠正、attempt 2 的宽度偶然性及 #405 同一潜在问题均写明，临时恢复后再次应用的决定链保留。受影响文件 Prettier、node --check、production Jekyll、42 个本地文档链接、test/log 摘要、git diff --check 均通过。没有重复 CLI/应用全套，没有声称重新跑 Windows/Linux 或包；原完整检查与 Windows 性能表继续按其原来源有效。

仅新增 knowledge-sync 提交，未 push，未改 Hub 源码或 #405 分支；代码/笔记工作树干净。PNG 仍 **15**，按原口径新增 blob **9,569,914 字节 / 9.127 MiB**。交 Claude push 全部提交到 #406。
