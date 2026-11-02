# 任务：Hub 上的个人与团队空间（决定 84 第二阶段）

依据：决定 84（所有者 2026-11-02，14 个待定问题全部按建议定下），设计页 [`knowledge-workflows.md`](../design/knowledge-workflows.md)“分阶段”第 2 项，以及“两个空间”“授权”“条目”“来源与组织”“索引”“版本与引用”“权限与安全”各节。本任务只做 Hub：个人空间先只在 Hub 上，经控制台和 Circle 读写，暂不同步；提交共享、同步、上传署名等在后续任务。

## 做法

- 工作树 `circle-hub-spaces`，分支 `kw-spaces-local`，从“工作流改名”分支（PR #125）的头部开出；`node_modules` 已链接，不要运行 `npm install`；只在本机提交，Claude 审查并跑过相关检查后推送、开 PR，合并由所有者决定。
- 先在本页“实施方案”一节写出数据结构、合约改动、接口与页面的具体做法，然后直接动手，不必等确认；做的过程中改了方案就同步改本节。
- 规则同 [`console-walkthrough.md`](console-walkthrough.md) 与 `AGENTS.md`：
  - 枚举、记录类型、拒收码和界面用语只取自 `contracts/generated`；需要的新词表、记录类型和拒收码按决定 84 写进 `contracts/model.json` 与 `contracts/codes.json` 并生成，在 `changes` 里写明来源。
  - 跨包只经各包 `api.ts` 调用；已应用的迁移不改，只追加。
  - 核心代码不写产品名；测试只用合成数据（地址在 192.0.2.0/24）。
  - 界面文字用规范术语，说明性文字放悬停提示。
- 验证：每步跑 `npm run typecheck` 与受影响包的测试；改合约跑 `npm run verify:contracts`；改迁移跑迁移相关测试；改文档跑 `npm run test:docs`。不随意加 SHA 校验与全量回归。
  - 改动波及读取权限、登录、迁移、记录回放或 MCP 工具答复时，再跑受影响的验收场景（`tests/acceptance/` 中相关文件）。
  - 这是 PR #124 的教训：定向测试漏掉了跨包的验收场景、冻结版本的升级回放和并发建用户，CI 才发现。
  - 测试中的成员用 `testConsoleCredentials` 以合成密码登录控制台。
- 可以分多次提交，每次提交是一个能独立说明的步骤。完成后在本页“做了的”“验证”写明，并在 `docs/hub-r4-progress.md` 记为决定 86（Hub 个人与团队空间的实施，依据决定 84）。

## 要做到的（验收标准）

1. **空间**：
   - 每个成员有一个个人空间，Hub 有一个团队空间。
   - 两者的条目格式、内容寻址存储、目录树、版本历史与索引相同，区别只在读取权限。
   - 团队空间的“/产品/…”一支显示现有产品知识树（按现有产品指针解析），现有数据不迁移、不改哈希，原有 `tree:` 引用照常可解析。
2. **条目**：
   - 字段同设计页“条目”一节。
   - 产品线改为适用条件里的可选维度（改 K01 R[4]）；没有产品包时也能在团队空间和个人空间建目录、写条目。
   - 状态取自新词表：已核验、未核验、已撤回、被取代。修改就是写一条取代旧条目的新条目。
3. **写入**：
   - 成员能把条目写进自己的个人空间：经 Circle（现有工具与工作流，必要时新增一个用于个人知识的工作流），也能在控制台手动添加。
   - 有依据的条目由 Hub 逐条核对引文与路径后记为“已核验”；没有依据的笔记与判断记为“未核验”。
   - 团队空间的写入本阶段只有现有渠道：管理员导入、产品包同步。
4. **授权**：
   - 个人空间默认只有本人可读。
   - 本人可以把整个空间或某个目录授权给全体管理员或指定成员只读，并可随时收回；授权与收回写入记录。
   - 未获授权的人读取时，回应与“不存在”相同（C6）。
   - 任务只读发起人自己的个人空间，以及已授权给发起人的内容。
5. **读取**：
   - `get_nodes` 和 `resolve_reference` 能读个人空间与团队空间，并按授权检查。
   - 团队知识全体成员可读，产品目录沿用产品线读者的规则。
   - 任务开始时锁定团队空间与发起人个人空间在 Hub 上的当前版本。
6. **全文搜索**：
   - 按设计页“索引”一节实现：PostgreSQL 自带的 GIN 索引，中文按两字切分，不加扩展和依赖。
   - 控制台搜索可选范围：个人、团队、共享给我的、全部；结果标出可见范围。
   - Circle 可用的检索只在不带 `run` 的读取里提供；带 `run` 时拒绝检索、仍按地址读取（决定 60）。不新增第七个工具，在现有工具上加参数即可，并写进工具说明。
7. **版本与差异**：
   - 每个空间一条版本历史（谁、何时、因何）。
   - 控制台“版本差异”从版本历史中选“从”和“到”，默认上一版本与当前版本，列出新增、修改、删除的条目及路径。
   - “知识版本”与“产品版本”在界面上分开叫。
8. **控制台**：
   - 知识库页分“个人”“团队”“共享给我的”三栏，含目录浏览、条目详情（依据与核验结果、状态、被引用次数）、授权管理（本人）和搜索。
   - 导入分两个入口：管理员“导入团队知识”（现有导入），成员“导入个人知识”（把本人的文件导入个人空间，原文进个人空间，条目由 Circle 起草）。
   - 悬停提示写明各空间谁能看到；同步到 Hub 的个人内容在服务器备份中存在，提示里写明。
9. **容量**：个人空间在 Hub 上默认每人 1 GiB，管理员可调整；超出时拒收新写入并给出明确提示。
10. **测试**：
    - 覆盖本人、他人、管理员、被授权者、收回授权后的读取。
    - 覆盖同一内容在不同空间、缺出处、凭据命中、旧引用重放、分页与大小上限。
    - 覆盖带 `run` 的检索被拒绝。

## 不在本任务

提交共享（第三阶段）；Circle 本机知识库与双向同步（第四阶段，Circle 仓库）；上传署名、原文归档、成员停用与删除的处理（第五阶段）。为后续阶段预留的合约可以一并写好，但不实现其行为。

## 实施方案

1. **合约与版本**：模型升为 17，按决定 84 改 K01 的必选产品线约束，增加空间、条目核验状态、搜索范围与授权对象词表，以及空间版本、条目、授权、原文归属、容量设置的追加记录和拒收码。旧产品条目与树的版本 1 格式保留，新空间采用一套共用条目格式；生成器及必要的技能镜像清单同步生成和升补丁版。
2. **存储与回放**：追加迁移 9，建立可从追加记录重建的空间搜索投影，中文按两字切分并建立 PostgreSQL GIN 数组索引。空间 ID 为 team 或成员 ID，个人空间按需建立，团队空间唯一。版本记录固定空间、目录内容、前版、操作者、时间与原因；版本记录摘要作为新空间根，树和条目仍按内容寻址，因此相同内容在不同空间不会混淆授权。旧产品根和旧引用不变，团队的产品目录按现有指针动态挂载。
3. **知识服务与权限**：通过 records 的公共 API 提供搜索投影；knowledge 的公共 API 提供空间目录、写入、替代／撤回、历史、差异、授权／收回和容量设置。个人写入在数据库事务与空间业务锁内完成，核对来源、引文、路径和凭据；无依据为未核验，有依据逐条通过后为已核验。历史与索引中的读取同样检查当前授权，目录按完整路径分段判定，管理员没有个人空间的默认读权。个人凭据来源不可授权，授权前扫描凭据。默认个人容量 1 GiB，管理员只调整限额。
4. **MCP 与运行**：仍为六个工具；upload_file 增加可选个人条目载荷（可只提交条目），普通文件上传行为保留；个人导入文件显式归入个人空间。get_nodes 增加空间选择、目录及无运行搜索参数；带 run 的搜索明确拒绝。空间树通过现有 tree: 读取与 resolve_reference 路径解析。start_run 的新记录可选保存团队与本人个人空间的版本锁，旧运行无此字段仍可回放；任务读取个人内容按发起人及当前授权限制，不借管理员身份扩大范围。
5. **控制台**：知识库新增个人、团队、共享给我的三栏，空间目录与详情、手动添加、原文导入、版本历史与差异、本人授权管理；全站搜索增加四种知识范围。管理员原导入改称导入团队知识；个人导入不生成条目，显示原文引用供 Circle 起草。界面种类、状态与范围使用生成标签，说明放标题悬停；显示备份中存在个人内容的事实。现有产品浏览和来源管理继续保留在团队区域。
6. **提交与验证**：按相互依赖的合约／迁移／知识服务／MCP 与运行核心、控制台与跨包验收、文档收尾分步签署本机提交。各步跑类型检查与受影响测试；迁移检查包含冻结升级回放，权限及 MCP 变动跑新增跨包空间验收以及现有读取权限、控制台安全、知识同步、旧引用、重启／并发相关受影响场景。一次只运行一个重套件；如环境缺少隔离能力如实列出跳过，不追加全量回归、任意来源 SHA 检查或阶段 3 行为。

7. **安全审查修复**：按所有者 2026-11-02 的优先级调整，在变基后的 `8155532` 上修复本页八项审查意见。模型 18 登记阶段性个人依据拒收、原文无法检查与索引超限代码；团队目录以空账户署名表示 Hub 登记。迁移 10 只整理可重建的索引，保留既有记录、根及迁移 SQL。第三阶段改动先 stash，第二阶段修复报告后再变基继续；第三阶段必须用全部实际读者检查替代临时防护。

## 发现

- 已按协调者补充变基到 `workflow-rename-local` 的 `36d691d`（含动态技能版本读取和生成 `PackKind` 修正）。测试中的仓库技能版本用 `repositorySkillVersion`，不固定发布版本。
- 团队管理员手动导入可不带产品包，但依据须为团队连接的业务读取原文；上传署名留待后续阶段。管理员没有个人空间的默认读权。
- 全文索引只读已保存的陈述、数据与逐字引文，不触发业务系统读取；旧产品记录没有引文文本时不补造。单页节点／字节上限沿用知识服务设置，单个目录超限时拒绝整页，按具体条目或已知下级目录地址读取。
- 容量按空间受理的内容与历史快照逻辑字节计量，不冒充磁盘占用；撤回保留历史。既有迁移的来源文件冻结断言随追加迁移更新，未增加数据 SHA 校验。

## 做了的

- 安全审查第 2 项：在复用旧回执之前检查个人 `tree:` 与 `src:` 依据，包含运行冻结的原件采集；使用注册的 `SPACE_RESULT_GROUNDS_PRIVATE` 拒收，不增加模型修复轮数。仅事实工作流的自动结果也在存运行和共享结果前检查；第三阶段将替换此临时规则。
- 安全审查第 4 项：追加迁移 10，词项按不可变条目记录保存一次，版本只留引用关系，未变条目不重新读取或分词。单条索引上限 1 MiB、每个空间历史索引上限 64 MiB，按词项逻辑字节计量，不冒充 PostgreSQL 磁盘占用。`ensure` 与搜索／启动运行的读取不排在生产或空间写队列后。导入按完整下一版本预查容量，再用同一连接登记文件、来源和版本；容量不足时不落原文。
- 安全审查第 7 项：向已授权目录导入原文时做与授权相同的完整字节检查；凭据命中拒收，无法检查的 ZIP、PDF、图片使用 `SPACE_CONTENT_UNINSPECTABLE`。这类文件仍可导入未授权的个人目录，随后授权也会被拒收。
- 安全审查第 8 项：团队空间的初始化和产品目录登记由 Hub 署名（`by: null`，页面取生成的 Hub 用语），不署为触发读取的成员；普通管理员导入仍记录实际管理员。合约禁止个人版本使用空账户署名。
- 本轮模型升为 18，四个技能只同步生成协议与清单，html-format／mindmap-format 1.0.5、xml-format／workbook-format 1.0.6，业务代码不变。下方较早的实现提交号是变基前记录，本轮基线为 `8155532`。

- 安全审查第 5、6 项：个人版本历史仅本人可列出，目录或整个空间的只读授权都不包含审计历史；页面据实说明。个人节点统计在 HTML 和 JSON 共用入口核对所有者，只有本人得到节点及条目的引用计数，且计数使用所属个人空间的索引。

- 安全审查第 1、3 项：来源读取先保留独立采集的原有权限，空间来源仅补充；空间范围核对与普通来源读取分开，私有副本不改变既有来源、原有读取档位的结构摘要或运行范围。运行内文本解析只在声明的输入中查找，不把整个冻结空间的原文列为候选。

- 已完成模型 17 与五个显示／授权轴、五种空间记录、共用条目和目录对象格式、六工具参数扩展；同步四个技能生成镜像和补丁发布清单，业务代码未改。
- 已追加迁移 9 与可重建的 GIN 双字索引，实现个人／团队目录、来源与引文核验、状态、替代／撤回、历史差异、按目录授权与收回、容量、现有产品指针挂载。
- 已接通新运行的团队／本人版本锁，地址读取与来源读取按发起人和当前账户重查权限；个人引用次数独立计数，不进入团队条目统计。

- 已完成控制台三栏、目录／详情／原文、条目添加／替代／撤回、本人授权与收回、历史选择差异与四范围全文搜索。管理员原导入入口改称“导入团队知识”，团队页可调整个人限额；悬停写明读权与服务器备份。详情页可直接修改，自动带入原条目、全部依据与版本冲突检查，不手抄摘要。
- 表单写入统一沿用密码会话、首次改密、同源与 CSRF 检查；管理员无法读取未授权的个人原文或条目，成员不能伪造他人空间写入或额度调整。

## 验证

安全审查收尾（2026-11-02；按分组记录，不累加重复执行的测试）：

- `npm run typecheck`、`npm run verify:contracts` 通过；`npm run test:docs` 287 项通过，0 跳过；系统署名新增合约检查连同 `contracts/src/spaces.test.ts` 共 3 项通过。
- 存储与空间组：`hub/records/{space-index,migrations.snapshot,roles}.test.ts`、`hub/knowledge/{spaces,spaces-review,operation-records-upgrade}.test.ts`、`tests/acceptance/46-knowledge-spaces.test.ts`，27 项通过，0 跳过。覆盖迁移 8→10 与 9→10、冻结旧运行／回执回放、索引去重和两级超限、五次空目录写入不重读词项、容量预拒收不留原文、HTML／JSON 历史与计数边界、私有副本反事实、运行内文本范围、无关索引写入等待时读取／检索／新运行仍完成、自动事实结果的阶段性防护。
- 相关包组：合约 `{model-w04-w10-v07,vocab-axes,spaces,tools,tool-shapes,run-history}`；存储 `{objects,artifacts,space-index,migrations.snapshot,roles}`；知识 `{spaces,spaces-review,operation-records-upgrade}`；运行 `{start,submit,exact-retry,scope-retry,citations}`；控制台／MCP `{mcp,text,readers-sharing,console-api,console-knowledge,console-password}`（各文件均为 `.test.ts`），`node --test --test-concurrency=1`，278 项通过，0 跳过。
- 受影响跨包验收：`node --test --test-concurrency=1 tests/acceptance/{06-user-without-pack,12-console-security,13-idempotence,14-knowledge-sync,15-aliasing-end-to-end,17-hub-restart,19-concurrency,30-shared-results,33-r5-t1t3-knowledge-qa,39-r5-t9-2-skill-packs,46-knowledge-spaces}.test.ts`，32 项通过，0 跳过；覆盖仅函数读取来源的结构摘要在导入私有副本前后保持一致，以及旧技能锁与普通结果分享。
- 最后复查：类型、生成物及 287 项文档再次通过；`contracts/src/spaces.test.ts`、`hub/server/readers-sharing.test.ts`、`hub/runs/engine/exact-retry.test.ts` 共 9 项通过，0 跳过。
- 审查修复仅运行定向测试；没有运行全量单元／验收、Linux 隔离作业、备份／恢复／部署、`verify:references`／`test:references`，这些没有计为通过。没有新增 SHA 数据校验；只随新增迁移更新既有迁移源文件冻结断言。


历史与计数权限：`npm run typecheck` 通过；`node --test --test-concurrency=1 hub/runs/engine/citations.test.ts hub/server/console-api.test.ts tests/acceptance/46-knowledge-spaces.test.ts` 17 项通过，0 跳过。覆盖目录／整空间授权不显示历史、本人引用计数为 1、被授权者的 HTML 不含计数且 JSON 不返回数值。

安全审查复查：`npm run typecheck` 通过；`node --test --test-concurrency=1 hub/knowledge/spaces.test.ts hub/runs/engine/exact-retry.test.ts hub/server/readers-sharing.test.ts tests/acceptance/46-knowledge-spaces.test.ts` 19 项通过，0 跳过。新增跨包断言覆盖导入私有副本前后的读取、精确引用范围一致，以及运行内不能按文本查找未绑定的空间原文，仍可解析声明的输入。

分步定向检查（2026-11-02，均为合成数据、临时 PostgreSQL 和临时钥匙串文件）：

- `npm run typecheck`、`npm run verify:contracts` 通过。
- 合约相关十个文件（含 `spaces.test.ts`、`annotations.test.ts`、工具形状及发布形状）205 项通过；四个通用技能的九个解析／迁移测试文件 119 项通过，均 0 跳过。技能版本从仓库清单读取。
- 存储／迁移／升级回放：`space-index.test.ts`、`migrations.snapshot.test.ts`、`roles.test.ts`、`store.test.ts`、`operation-records-upgrade.test.ts`、`citations.test.ts` 首次定向组 28 项通过，0 跳过；新增个人引用隔离后另行复查。
- 既有读取、运行启动与重放、来源重试、MCP 与答复相关 14 个文件 162 项通过，0 跳过（详见收尾补充）。
- 新增空间核心、迁移、权限、引用计数与冻结升级回放复查组 19 项通过，0 跳过；覆盖缺失索引重建、超大节点、产品挂载差异与团队撤回。
- `npm run test:docs` 287 项通过，0 跳过。
- 控制台相关七个既有文件加新增 `46-knowledge-spaces.test.ts` 共 60 项通过，0 跳过。新增场景覆盖官方 MCP 客户端、团队与本人版本冻结、后写来源拒读、原文逐字引文、原始记录绕权拒绝、密码会话、伪造空间写入、管理员无默认读权、授权收回、CSRF／异源、额度、导入、历史差异与表单大小。
- 既有跨包验收 `node --test --test-concurrency=1`，场景 06、12、13、14、15、17、19、30、33、35、39 共 29 项通过，0 跳过；覆盖既有权限／登录边界、幂等、同步／别名、重启、十路并发、结果共享、知识问答、构建差异及四个技能缺失／卸载后的旧引用。
- 详情页修订入口、引用计数可见范围与上传边界复查：空间核心 8 项及控制台相关既有 55 项通过；新增场景最终定向重跑 5 项通过，均 0 跳过。上传限额夹具初设 2 KiB 导致技能包初始化失败，调整为 256 KiB 后，新场景全部通过；仍明确检查超限拒收，没有放宽产品限额。
- MCP 文本与权限收尾：`spaces.test.ts`、`mcp.test.ts`、`text.test.ts`、新增验收 46 共 126 项通过；独立范围复查（`exact-retry.test.ts`、`readers-sharing.test.ts`、46）11 项通过，均 0 跳过。核验状态与依据出现在 Circle 实际读取的文本中；不存在和未授权的空间引用不以不同诊断泄露存在性。
- 人工布局检查：用合成页面和独立临时 Chrome 配置检查 1440 像素桌面、420 像素窄屏；修复目录长摘要导致的横向溢出。目录与编辑页的视口／文档宽度分别为 420／420 和 1440／1440。截图只验证页面布局，不作为实时连接的证明；内置浏览器宿主不可用，改用临时无头 Chrome 完成。
- 第二步 `npm run typecheck`、`npm run verify:contracts`、`npm run test:docs` 通过；文档 287 项、控制台壳层／CSP 与页面 22 项通过，均 0 跳过。
- 未运行：全量单元／验收回归、Linux 隔离作业、备份／恢复／部署套件、`verify:references`／`test:references`。本任务没有改隔离、备份恢复、部署或来源归档工具；迁移已跑冻结升级回放与运行角色检查，未把这些未运行项目记为通过。


定向命令与文件清单（所有命令均在任务工作树、本机 Node 24 下执行；分组之间不累计重复测试）：

- 合约：`npm run gen:contracts`、`npm run verify:contracts`；`node --test --test-concurrency=2`，文件为 `contracts/src/{spaces,annotations,vocabulary,vocab-axes,model-w04-w10-v07,tools,tool-shapes,published,shapes,run-history}.test.ts`（205 通过）。
- 技能：`node --test --test-concurrency=1`，`packs/skill/html-format/functions/{html,migration}.test.ts`、`mindmap-format/functions/{kityminder,migration}.test.ts`、`xml-format/functions/{xml,resource,migration}.test.ts`、`workbook-format/functions/{xlsx,migration}.test.ts`（119 通过）。
- 存储／升级：`node --test --test-concurrency=1`，`hub/records/{space-index,migrations.snapshot,roles,store}.test.ts`、`hub/knowledge/operation-records-upgrade.test.ts`、`hub/runs/engine/citations.test.ts`（初组 28 通过）；新增核心与计数检查在其后通过，见上。
- 既有后端：`node --test --test-concurrency=1`，`hub/knowledge/{read,unversioned-read,rows-read,view-scope}.test.ts`、`hub/runs/engine/{start,legacy-summary,exact-retry,exact-prefetch-submission,scope-retry,maintenance-citations}.test.ts`、`hub/server/{mcp,text,readers-sharing,read-diagnostics}.test.ts`（162 通过）。
- 控制台：`node --test --test-concurrency=1`，`hub/server/{console-knowledge,console-search,console-manage,console-places,console-password,console-api,console-api-write}.test.ts`（55 通过）；`hub/server/{console,console-page}.test.ts`（22 通过）。
- 新空间与文本：`node --test --test-concurrency=1 hub/knowledge/spaces.test.ts hub/server/mcp.test.ts hub/server/text.test.ts tests/acceptance/46-knowledge-spaces.test.ts`（126 通过）；`node --test --test-concurrency=1 tests/acceptance/46-knowledge-spaces.test.ts hub/server/readers-sharing.test.ts hub/runs/engine/exact-retry.test.ts`（11 通过）。
- 既有验收：`node --test --test-concurrency=1 tests/acceptance/06-user-without-pack.test.ts tests/acceptance/12-console-security.test.ts tests/acceptance/13-idempotence.test.ts tests/acceptance/14-knowledge-sync.test.ts tests/acceptance/15-aliasing-end-to-end.test.ts tests/acceptance/17-hub-restart.test.ts tests/acceptance/19-concurrency.test.ts tests/acceptance/30-shared-results.test.ts tests/acceptance/33-r5-t1t3-knowledge-qa.test.ts tests/acceptance/35-r5-t1t3-build-diff.test.ts tests/acceptance/39-r5-t9-2-skill-packs.test.ts`（29 通过）。加新增场景 46 的 5 项，定向验收共 34 项通过，0 跳过。
- 收尾：`npm run typecheck`、`npm run verify:contracts`、`npm run test:docs`；检查 Git 差异与签署提交。所有已执行分组均 0 跳过；没有把未选入的套件计入通过。

本机实现分步提交：`cab0033`（合约、存储与知识／运行核心）、`3e8ee67`（控制台与模型文本、跨包验收及范围复查）；本页与决定 86 随收尾提交补齐验证。第三阶段 `kw-share.md` 和 Circle 仓库均未改；没有推送或创建 PR。

## 审查意见（Claude 2026-11-02，独立安全审查）

没有发现高危泄漏：没有授权的人（包括管理员）读不到别人个人空间的内容；目录范围、收回、缺失与无权限的同一回应、运行隔离、搜索的参数化与复核都核对过。以下 8 项已用合成数据的探针复现（探针在 Claude 的草稿区，不入库），请在本分支修复，每项附回归测试，并在本页“做了的”“验证”补写：

1. **（中）私有副本改变别人对来源的读取**：`hub/server/tools.ts:552`、`hub/runs/engine/exact.ts:143,246,322`、`hub/knowledge/spaces.ts:744-756`。只要某份字节在任一空间存在，`src:` 读取就被转到 `spaces.source()`，在运行中只认该运行的输入，不再回到原有读取规则。后果：成员能判断“别人是否私下存了同一份文件”，也能通过导入副本让别人运行里的来源变得不可读。要求：私有副本不得改变任何人对已有来源的读取结果；先按原有规则判定，空间来源只作补充。
2. **（中）运行结果可能把个人内容暴露给全体管理员和被分享者**：`spaces.ts:420-440`、`hub/runs/engine/readers.ts:17`、`hub/server/console/pages.ts:233`。第三阶段的“依据须对结果的全部读者可读”还没有，结果原样存储并展示。要求：在本阶段先加最小防护——提交结果时引用个人空间的 `tree:` 或 `src:` 一律拒收（拒收码按合约登记），第三阶段再以完整规则取代；本阶段不得单独部署而缺少这道防护。
3. **（中）`resolve_reference` 在运行中可按文本检索，绕过决定 60**：`exact.ts:108`、`hub/runs/engine/preview.ts:178`。冻结空间里的全部原文都被当作候选。要求：运行中的文本解析只在该运行声明的输入中进行，空间原文不作候选；补“带 run 的文本解析不返回空间原文”的测试。
4. **（中）搜索索引随“条目 × 版本”增长且不计容量，并占用全局写队列**：`spaces.ts:116-122,468-479`、`hub/knowledge/context.ts:98`、`start.ts:627`。五次空目录写入增加 25 行、约 5.67 MB 索引，只计 6,865 字节容量。要求：索引按条目内容（或按变更）存一次，版本只记引用关系，不为每个版本重写全部条目；索引占用计入容量或设上限；读取路径（`ensure()`、搜索、`start_run`）不排在单一的全局写队列后面。另：`importFile` 先存文件再查容量，失败时会留下文件，要先查后存或失败时清除。
5. **（低）被授权某个目录的人能看到全部版本**：`spaces.ts:441-447`。要求：只显示涉及授权目录的版本，或不向被授权者显示历史；原因文字不得误导。
6. **（低）被授权者能看到个人目录的被引用次数**：`hub/runs/engine/store.ts:73`、`hub/server/console/citations.ts:54`、`pages.ts:598`、`api.ts:248`。要求：个人空间的引用计数只给本人。
7. **（低）向已共享目录导入文件跳过了授权时的凭据检查**：`spaces.ts:706-720` 对比 `211-231`。要求：导入到已共享目录时做与授权相同的检查；无法检查的文件（如 ZIP、PDF、图片）给出准确的拒收码，不要沿用 `SPACE_CREDENTIALS_DETECTED`。
8. **（低）成员的读取会以该成员名义写入团队版本**：`spaces.ts:131-137`。要求：产品目录登记由系统身份记录，或改在发布、同步产品包时登记，不记在随机读取者名下。

## 第二轮审查意见（Claude 2026-11-02，独立复核 1b14f5ed）

第一轮八项中七项确认修复；第 2 项对结果已生效，但同一类个人内容仍经其他途径到达管理员和被分享者（下面第 1、4 项）。迁移 10 用迁移 9 的真实数据做过升级实测，安全。另外，第一轮修复的 CI 失败已由 Claude 在 9716a3b 修正（手写授权动作、索引锁命名空间、两处测试），后续不要重复这些写法。请在本分支（`kw-spaces-pr`，工作树 `circle-hub-spaces-pr`）修复以下各项，每项附回归测试，并在本页“做了的”“验证”补写：

1. **（中）个人导入可作为运行输入**：`start_run` 经 `artifacts.source` 绑定 `src:` 输入（`hub/runs/engine/inputs.ts:111`），私有文件名写入绑定标签（`inputs.ts:129`），由内容投影出的条目标签写入运行记录，管理员和被分享者都能读到；之后每次提交都被防护拒收，运行永远无法完成。要求：第二阶段在 `start_run` 拒收个人空间导入的输入（与仅事实运行的启动防护一致），第三阶段再按实际读者规则放开。
2. **（中）索引上限**：上限是常量（`hub/records/space-index.ts:6-7`），管理员无法调整；单空间总量按全部历史引用行计算（`space-index.ts:64-66`），撤回或被取代的条目永远占用额度；产品知识以 `team` 空间建索引（`hub/knowledge/service.ts:174`），与团队条目共用额度。超限后：团队条目写入以 `SPACE_INDEX_LIMIT` 拒收；新的产品构建之后，所有 `all`/`team` 搜索都抛出 `SPACE_INDEX_LIMIT`（`spaces.ts:503` 未转换，该构建的索引也不会标为完成），控制台 `/console/search` 无防护地调用 `spaceSearch`（`console/search.ts:157`），整页显示通用 500。要求：
   - 额度只计当前有效条目（或当前版本引用），撤回、被取代的条目不再占用；
   - 产品知识的索引不占团队条目的额度；
   - 上限可配置（随 Hub 的限额配置），并与个人容量设置的说明一致；
   - 单条超限与空间总量超限分别给出不同的拒收说明和处理办法；
   - 搜索遇到未完成或超限的索引时降级：跳过该范围并如实说明，不抛出到整页；控制台搜索页不得因此 500。
3. **（中低）个人导入被拒后没有拒收记录**：`importFile` 在自身事务中入库（`spaces.ts:722`），拒收记录（`#refuseUpload`）写在同一事务中随之回滚（`artifacts.ts:263, 686`）；向已授权目录导入时 `#inspectSource` 在入库前抛出，同样不留记录。复核实测：普通上传、未授权目录导入、已授权目录导入的拒收记录在修复前为 1/1/1，修复后为 1/0/0。要求：恢复 B02 要求的拒收记录，三种情形都留下一条。
4. **（低，第三阶段处理）被拒提交的原始参数仍可读**：提交先存档再检查（`submit.ts:206`），管理员和被分享者可通过 `rec:<提交>` 读到其中复制的引文（`hub/server/readers.ts:80`）。防护阻止了受理，没有阻止披露。由第三阶段的实际读者规则一并解决，并在 `kw-share.md` 记录。
5. **（低）写入串行与开销增长**：所有空间共用一个进程级写队列（`spaces.ts:60`），每次索引追加都对该空间全部引用行求和（`space-index.ts:64-65`）。实测：收回授权会等待无关成员的写入；空间有约一百万引用行时，目录写入从 25–44 ms 增至 231–655 ms；引用行磁盘占用约为计入容量的 2.7 倍。要求：按空间分队列（同一空间仍串行）；总量用累计值维护，不再逐次求和；README 如实写明引用行的占用。
6. **（低，纵深防护）`recheckProduction` 存储重新评估的事实结果时未经防护**（`start.ts:801-806`，由 `maintenance.ts:103, 190, 296` 调用）。目前找不到触发路径，但 README 说明每个自动事实结果都经检查。要求：同样经过防护。

另：验收场景 14 在复核中两次运行失败一次（同步未产出构建，随后重跑产出、版本差异无可比较），本分支未改同步代码，原因未查明。请排查并修复不稳定的原因；不能修复时在本页如实记录。

复核所用的探针在 Claude 的草稿区，不入库；需要时可以向 Claude 要具体步骤。

### 第二轮实施与验证

协调者 2026-11-02 指定在 `circle-hub-spaces-pr`／`kw-spaces-pr` 的 `43e0f49b` 上修复第二轮第 1、2、3、5、6 项和验收 14；第 4 项已记入第三阶段 `kw-share.md`，不在第二阶段扩大成完整读者规则。第三阶段当前步骤保存在 `34879865`，没有推送或创建 PR。

- 第 1 项：按实际采集记录在绑定输入时拒收个人空间导入，判断类与事实类工作流一致；拒收发生在文件名、投影标签进入运行之前。原文元数据记录也先检查原文读权，管理员不能借记录输入绕过私有原文权限；相同字节的独立普通采集仍可绑定。临时规则由第三阶段完整读者核对替代。
- 第 1 项验证：`npm run typecheck` 通过；`hub/runs/engine/start.test.ts` 和 `tests/acceptance/46-knowledge-spaces.test.ts` 的 22 项通过，0 跳过。加入的回归覆盖普通／钉住采集／记录形式、管理员无默认读权、拒收不保存运行及同字节普通来源正例。同期第 6 项的新夹具因复制了旧运行的喂入边界而失败，正在修正；没有把该失败计为通过。
- 第 6 项：`recheckProduction` 在追加重新评估结果前执行同一临时防护，拒收只追加带代码的验证动作，保留原运行与旧结果。真实装配的旧运行夹具明确绑定个人采集，重验不能追加结果；相同字节的独立普通采集可以重验。去掉新运行不应继承的旧喂入边界后，`npm run typecheck` 和 `hub/runs/engine/{production-guard,start-result}.test.ts` 6 项通过，0 失败、0 跳过。
