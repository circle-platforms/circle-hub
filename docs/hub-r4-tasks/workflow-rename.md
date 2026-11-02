# 任务：界面上“任务包”改称“工作流”（决定 84 第一阶段）

依据：决定 84（所有者 2026-11-02），设计页 [`knowledge-workflows.md`](../design/knowledge-workflows.md) 的“工作流（原任务包）”一节和“分阶段”第 1 项。所有者原话：“1.用工作流 2.工作流标签里面分为两种，一种是通用的skill 一种是我们的packs”；方案文档的 14 个待定问题已全部按建议定下，其中产品包放到知识库（产品知识来源），系统包放到连接（业务系统接入）。

## 做法

- 工作树 `circle-hub-workflow`，分支 `workflow-rename-local`，从走查分支（PR #124）的头部 `7259caa` 开出。PR #124 合并后由 Claude 变基到 main。不要切换其他工作树的分支。
- `node_modules` 已链接到 `circle-hub-walkthrough/node_modules`（依赖未变）；不要在本工作树运行 `npm install`。
- 只在本机提交。Claude 审查并跑过相关检查后推送、开 PR；合并由所有者决定。
- 规则同 [`console-walkthrough.md`](console-walkthrough.md)：
  - 界面用规范术语，不用“你”“他”；进行中写作“等待××中”。
  - 种类名与状态词只取自 `contracts/generated`。
  - 说明性文字一律放在标题的悬停提示里；事实性文字照常显示。
- 可改路径：`contracts/**`（只限本任务的界面用语与版本断言）、`hub/server/**`、`docs/design/**`、`docs/hub-r4-progress.md`、本页、各受影响包 README 与 `CHANGELOG.md`。不改知识库与运行引擎的业务代码，不改协议名、记录类型、`packs/` 目录名或依赖。
  - 范围补充（Claude 2026-11-02 作为协调者，依据所有者对决定 84 的持续授权）：允许增加模型 16 的纯显示轴 `pack_status`，沿用 published／retired／enabled／inactive 四种既有发布状态，不改变记录或权限规则。
  - 同次允许同步 `packs/skill/{html-format,mindmap-format,xml-format,workbook-format}/functions/generated/protocol.ts` 与各自 `pack.json`；这八个文件加入允许路径，技能业务代码不变。html-format、mindmap-format 升为 1.0.3，xml-format、workbook-format 升为 1.0.4，并刷新发布清单。
- 验证（所有者要求）：不随意加 SHA 校验和全量回归。
  - 每项跑 `npm run typecheck` 和受影响包的测试。
  - 改了合约再跑 `npm run verify:contracts` 和词表相关测试。
  - 改了文档跑 `npm run test:docs`。
- 每项一次提交。完成后在本页“做了的”“验证”两节写明，并在 `docs/hub-r4-progress.md` 记为决定 85（工作流改名的实施，依据决定 84）。

## 要做的

1. **词表的界面用语（合约，所有者已在决定 84 中定名）**：
   - `pack_kind` 各值的界面用语改为：`workflow` 工作流，`skill` 通用技能，`product` 产品知识来源，`system` 业务系统接入。轴的界面名“类型”保留。
   - 不改代码值、协议名（如 `list_task_packs`）、记录类型和目录名。
   - 模型升为第 16 版，`changes16` 写明来源（决定 84），同步版本断言。
   - 查一遍合约里其他面向用户、写着“任务包”的用语，例如 `contracts/src/tools.ts` 里工具的界面名，按实际含义改写，并在提交说明里列出。
2. **导航与工作流页**：
   - 导航“任务包”改为“工作流”。地址可保留 `/console/packs`，或改为 `/console/workflows` 并让旧地址跳转；二选一，写明理由。
   - 页面分两栏：“工作流”列 workflow 种类，“通用技能”列 skill 种类。
   - 悬停提示：工作流标题写“规定做法与验收要求；由 Circle 执行，Hub 按验收要求判定结果”；通用技能标题写“只规定做法，没有验收要求”。
   - 工作流详情页在上方单列“验收要求”一节，列出各要求项。
   - 不画节点图。
3. **产品包与系统包移位**：
   - 知识库页加“产品知识来源”一节，列出产品包（名称、版本、状态、产品线），链接到详情页。
   - 连接页加“业务系统接入”一节，列出系统包（名称、版本、状态、对应的业务系统），链接到详情页。
   - 工作流页不再列这两类。
   - 详情页的面包屑按新归属显示：知识库 › 产品知识来源 › …，连接 › 业务系统接入 › …。
4. **其余界面文字**：面向用户的“任务包”一律改为对应说法，包括：
   - 任务页“按工作流筛选”；
   - 团队页“可用的工作流”“工作流分配”；
   - 管理操作“发布任务包”改为“发布工作流”，从知识库、连接进入同一操作时，标题分别写“发布产品知识来源”“发布业务系统接入”；
   - 记录、搜索结果、空状态和错误信息。
   代码标识符、英文注释和协议名不改。
5. **重置密码后解除登录锁定（审查遗留）**：经控制台桥接执行 `user password-reset` 成功后，清除该账户 `account:<用户名>` 的失败计数，免得成员拿到新密码还要等锁定到期。补一条测试。
6. **设计页同步**：`docs/design/console-navigation.md` 的导航说明改用“工作流”，并写明产品知识来源与业务系统接入的新位置。`docs/design/knowledge-workflows.md` 已由 Claude 写入本分支，作为本任务和后续任务的依据，不必改写；发现与代码现状不符之处记在本页“发现”一节。

## 不在本任务

个人与团队空间、授权、同步、提交共享、全文搜索等结构改动，见设计页“分阶段”第 2 至 5 项，另有任务页。

## 发现

- 第 1 项：生成器同步四份技能合约镜像后，原文档检查因版本未递增而失败；已按上述协调授权升补丁版并刷新发布清单，没有增加来源数据的 SHA 检查。
- 第 2、3 项：原 `stateOf` 硬编码四种既有发布状态；已按上述协调授权增加 `pack_status` 显示轴，页面按原字段推导后取生成标签。
- 现有目录接口对成员只返回可用工作流，移位不扩大读权；成员的原有知识读取仍保留。产品声明接口只提供当前启用版本，未启用或退役来源缺少产品线元数据时显示破折号，不从名称猜测。
- 合约的技术种类名称保留；服务器持有的界面、命令与答复文字使用新界面用语。历史记录、作者内容及其他包给出的诊断原文照常显示，不做文字替换；例如运行引擎拒绝分配产品来源时的原诊断仍使用技术名称“产品包”。未为改名修改运行引擎或知识库业务代码。
- 设计页的个人／团队空间、授权、共享、全文搜索、版本历史选择和双向同步属于后续阶段，当前没有相应存储与接口；本次没有新增这些模型、路由或能力。现有格式通用技能仍带解析脚本、按 Hub 全局安装和冻结摘要使用；不能把本次分栏描述为已经支持个人技能同步。

## 做了的

- 第 1 项：模型 16 与四种界面用语已生成；同步查询工作流、工作流分配、`SOURCE_UNAVAILABLE.fix`、`PACK_POLICY_DENIED.when` 及闭集校验提示。增加仅供显示的 `pack_status`，同步版本断言与四个技能的生成镜像及发布清单，技术名称、既有代码和协议未变。授权来源见“做法”的范围补充。
- 第 2 项：保留 `/console/packs`，避免已有链接失效；导航改名，工作流与通用技能分栏并使用约定的标题悬停说明。详情上方单列验收要求，未能读取要求时明确显示暂不可读，版本与权限仍可见；不画节点图。状态由既有字段推导并取 `pack_status` 生成标签。
- 第 3 项：知识库新增产品知识来源表（名称、版本、状态、产品线），连接新增业务系统接入表（名称、版本、状态、对应业务系统）；工作流页不列两者。详情保留原地址，面包屑与当前导航按归属显示。原有目录权限、知识读取与连接路由不变；未知元数据不猜测。
- 第 4 项：同步服务器持有的任务筛选、团队分配、记录、搜索、空状态、错误、CLI 与工具答复文案；混合种类的发布与目录文案使用“发布内容”，具体种类取生成标签。发布操作按工作流、通用技能、产品知识来源、业务系统接入显示标题与返回位置，暂存清单种类只用于显示，上传校验、命令参数、权限和接口不变。卡片名称与种类分行显示。
- 第 5 项：控制台命令桥重置密码返回成功后，按目标账户清除 `account:<用户名>` 的登录失败计数；表单被拒绝或命令失败时不清除，不影响其他账户与来源计数，仍要求首次修改新密码。
- 第 6 项：同步 `console-navigation.md` 的八项导航、两类来源归属、详情入口及共享发布操作；保留 `knowledge-workflows.md` 原文。README、CHANGELOG 和决定 85 记录当前实施、协调授权与后续阶段边界。

## 验证

- PR #125 的完整 CI 发现两处问题，由 Claude 修复：
  - 通用技能包随模型 16 升了补丁版本，而沙箱传输、旧版迁移声明与知识同步的测试仍写死旧版本号。改为经 `hub/testing/skills.ts` 的 `repositorySkillVersion` 读取仓库里 `pack.json` 的当前版本，以后升版不再牵连这些测试。
  - 工作流页的分栏函数手写了 `'workflow' | 'skill'`，被词表扫描拦下，改用生成的 `PackKind`。
  - 本机复跑：`hub/refs/skills.test.ts` 与 `cli-skill-migration.test.ts` 共 17 项，`cli-admin` 的知识同步与词表扫描 2 项，均通过、0 跳过；完整单元由 CI 复跑。

- 第 1 项：`npm run typecheck`、`npm run verify:contracts` 通过；`node --test --test-concurrency=2 contracts/src/vocabulary.test.ts contracts/src/vocab-axes.test.ts contracts/src/model-w04-w10-v07.test.ts contracts/src/tools.test.ts tools/gen-contracts.pack-vocabulary.test.ts` 118 通过、0 跳过；`npm run test:docs` 285 通过、0 跳过。
- 第 2 项：`npm run typecheck` 通过；`node --test --test-concurrency=1 hub/server/console-places.test.ts` 12 通过、0 跳过；`npm run test:docs` 285 通过、0 跳过。页面检查覆盖导航、两栏、悬停说明、验收要求顺序与不显示节点图。
- 第 3 项：`npm run typecheck` 通过；`node --test --test-concurrency=2 hub/server/console-places.test.ts hub/server/console-knowledge.test.ts hub/server/console-pagination.test.ts` 23 通过、0 跳过；`npm run test:docs` 285 通过、0 跳过。覆盖归属与面包屑、成员权限保持、退役和未启用状态及缺少元数据；新增边界用例首次用了不支持状态覆盖的基础夹具，改为显式目录夹具后重跑通过。
- 第 4 项：`npm run typecheck`、`npm run test:docs`（285 通过、0 跳过）通过；定向检查如下，最终均为 0 失败、0 跳过：
  - `node --test --test-concurrency=2 hub/server/console-places.test.ts hub/server/console-manage.test.ts hub/server/console-knowledge.test.ts hub/server/console-pagination.test.ts hub/server/console/staging.test.ts hub/server/console-systems.test.ts hub/server/console-api-write.test.ts hub/server/console-api.test.ts hub/server/console-search.test.ts hub/server/console-live.test.ts hub/server/console-results.test.ts hub/server/console-page.test.ts`：93 通过。
  - `node --test --test-concurrency=2 hub/server/cli.test.ts hub/server/mcp.test.ts hub/server/console.test.ts hub/server/assemble/sandbox-notice.test.ts`：90 通过。
  - `node --test --test-concurrency=2 hub/server/text.test.ts hub/server/text-history.test.ts hub/server/cli-local-tools.test.ts hub/server/docs.test.ts hub/server/units.test.ts hub/server/command-bridge.test.ts hub/server/variables.test.ts hub/server/assemble/sandbox-notice.test.ts`：132 通过。
  - `node --test --test-concurrency=1 --test-name-pattern='pack publish|publish needs|text from a pack|pack shapes|runs every check of publish|publishes a copy|--as|add and list a resource|update changes metadata|without the vault master key' hub/server/assemble/cli-admin.test.ts`：11 通过；模式之外未运行，不算通过。
  - `node --test --test-concurrency=1 --test-name-pattern='a connector or registry message|the operator log takes' hub/server/assemble/assemble.test.ts`：2 通过；模式之外未运行，不算通过。
  - 首次检查暴露了旧文案、旧目录位置和旧账户状态断言，已按实际行为同步后重跑；MCP 并发用例原先并行准备三个账户，触发已有的两路密码哈希上限，现仅串行准备账户，24 个并发 MCP 请求的断言保留。其他包的诊断原文断言保持原样。
  - 隔离浏览器走查后分开卡片名称与种类；`npm run typecheck` 和 `node --test --test-concurrency=1 hub/server/console-places.test.ts` 重跑通过，13 通过、0 跳过。
- 第 5 项：新增用例在修复前复现“命令成功但新密码登录仍为 429”；修复后 `npm run typecheck` 通过，`node --test --test-concurrency=1 hub/server/console-password.test.ts` 7 通过、0 跳过，`npm run test:docs` 285 通过、0 跳过。覆盖无效 CSRF、命令失败、成功后首次改密及其他账户仍锁定。
- 第 6 项：`npm run typecheck`、`npm run test:docs` 通过，文档检查 285 通过、0 跳过；已确认 `knowledge-workflows.md` 与任务开始时相同。
- 浏览器：用临时 PostgreSQL、合成端口实现与临时 Chrome 用户目录运行控制台，核对工作流页桌面 1440 像素和窄屏 390 像素截图，以及验收要求、产品知识来源、业务系统接入页面。工作流页两种宽度均无页面横向溢出；卡片名称和种类分行。没有使用个人浏览器资料、真实业务系统或常驻 Hub；这些截图不表示真实系统部署验证。
- 技能镜像的版本检查最初失败（同版内容改变），按协调授权升版并刷新清单后，上述文档检查重跑通过；首次失败不记为通过。未运行全量回归或来源相关检查。
- 未运行：全量 `npm run test:unit`、`npm run test:acceptance`；本任务未改来源或引用工具，未运行 `npm run verify:references`、`npm run test:references`；未运行部署、备份／恢复、Linux 或虚拟机验证及远端 CI。按名称筛选的 CLI 和装配日志套件中，其余用例未运行，不算通过。上面实际运行的定向用例均为 0 跳过。未运行 `npm install`，只用既有依赖链接；未推送或建 PR。
