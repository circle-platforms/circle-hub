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

## 做了的

- 第 1 项：模型 16 与四种界面用语已生成；同步查询工作流、工作流分配、`SOURCE_UNAVAILABLE.fix`、`PACK_POLICY_DENIED.when` 及闭集校验提示。增加仅供显示的 `pack_status`，同步版本断言与四个技能的生成镜像及发布清单，技术名称、既有代码和协议未变。授权来源见“做法”的范围补充。

## 验证

- 第 1 项：`npm run typecheck`、`npm run verify:contracts` 通过；`node --test --test-concurrency=2 contracts/src/vocabulary.test.ts contracts/src/vocab-axes.test.ts contracts/src/model-w04-w10-v07.test.ts contracts/src/tools.test.ts tools/gen-contracts.pack-vocabulary.test.ts` 118 通过、0 跳过；`npm run test:docs` 285 通过、0 跳过。
- 技能镜像的版本检查最初失败（同版内容改变），按协调授权升版并刷新清单后，上述文档检查重跑通过；首次失败不记为通过。未运行全量回归或来源相关检查。
