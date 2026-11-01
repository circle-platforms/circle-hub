# 任务：控制台走查的修改（所有者 2026-11-02）

依据：所有者 2026-11-02 在本机控制台（0e5dfdc）逐页走查时提出的问题，原话附在每项后面。分支 `console-logo` 上已有：标志 E1、尝试读取记录等决定 81、82 的内容（PR #123），以及提交 da2eb2b（下面第 1、2、3 项已完成的部分）。

做法：

- 从本地分支 `console-logo` 开自己的工作树和任务分支（`console-logo` 已在 `circle-hub-logo` 工作树里检出，不要切换它，也不要切换主检出 `circle-hub` 的分支）。只在本机提交；推送、建 PR 先问所有者。
  实际分支为 `console-walkthrough-local`，基线 `a5a39e1`。本次可改路径：`hub/server/**`（控制台、账号入口与对应测试）、`hub/records/**`（口令存储、追加迁移及对应测试）、`hub/platform/**` 与 `install.sh`（安装初始化及对应测试）、`docs/design/**`（导航说明与知识库调研方案）、`hub/server/README.md`、各受影响包 README、`CHANGELOG.md`、`docs/hub-r4-progress.md` 与本页。合约显示状态轴及版本测试的变更须取得所有者明确授权后补入范围；不改知识库模型或业务代码，不改依赖、来源归档、Circle 仓库或部署。
- 规则同 [`console-data.md`](console-data.md)；界面文字用规范术语，只陈述事实，不用“你”“他”，进行中写作“等待××中”，内部用词要译成一般人看得懂的话；状态词只取自 `contracts/generated`。
- 验证（所有者要求）：不随意加 SHA 校验和全量回归。每项跑 `npm run typecheck` 和受影响包的测试（控制台为 `node --test "hub/server/**/*.test.ts"` 中相关文件）；改了迁移、合约或安装脚本时再跑对应的测试；改了文档跑 `npm run test:docs`。
- 每项一次提交；完成后在本页“做了的”“验证”两节写明，并在 `docs/hub-r4-progress.md` 记为决定 83（来源：所有者 2026-11-02 走查控制台）。

## 统一规则：说明性文字一律悬停显示

所有者：“这种类似的提示我不在多说 采用一个方式”。

- 只解释“怎么看”的文字（页面标题下的说明、卡片标题旁的说明、段落标题旁的说明）不在页面上直接显示，改为鼠标移到对应标题上时显示（`title` 提示）。陈述事实的文字照常显示：时间范围、截至时间、数量、面包屑、命令、属性标签（如“MCP 标准授权”“可选”）。
- 提示里涉及时间范围的，随所选的 7 / 14 / 30 天变化。
- 机制已在 da2eb2b 中加好：`ctx.chrome(…, { hint })`、`card({ hint })`、`sectionHead(title, sub, extra, id, hint)`、`section(title, body, hint)`、`button(…, { hint })`。已改完：总览、任务、知识库、任务包、连接、记录、设置、管理操作、搜索、生产结果。
- 待做：把其余页面（任务详情、知识条目、构建、版本、管理操作的各步骤页、后台任务、授权页等）也按同一规则检查一遍；以后新写的页面同样遵守。

## 要做的

1. **侧栏搜索框框中框**（已在 da2eb2b 修好：通用输入框规则不再作用于搜索框，聚焦高亮在外框）。所有者：“这里框加框有问题”。
2. **总览不应有“添加成员”按钮**（已在 da2eb2b 去掉；设置页那个保留）。所有者：“这里不应该有添加成员的按钮”。
3. **总览“今日任务”“每日任务结果”等卡片的说明**（已在 da2eb2b 改为悬停）。所有者：“这句话是废话，如果想提示最多在今日任务加互动鼠标移上去显示这个内容”“这个也一样，还要考虑用户选择 7 天 14 天 30 天的问题”。
4. **任务页没有任务时不显示筛选**。所有者：“这里很奇怪，没有任务包还筛选？”
   - 没有任务且没有筛选条件时：不显示“任务包”筛选框、“全部 0”、“本页 0 个任务”，只留“尚无任务”和一句空状态说明。
   - 有任务时：标题“任务”，旁边只写“本页 N 个任务”（筛选时加“，筛选后 M 个”），“按开始时间排列”改为悬停提示。正在筛选时保留筛选框，便于清除条件。
5. **请求列表改成一个列表，用语规范**。所有者：“知识喂入待办 这话非常不专业”“已到期未回答的请求 这个也不专业”“未回答的请求：你这里的设计是想说明什么，是状态，还是列表，还是都想覆盖”。
   - 任务页的“已到期未回答的请求”“未回答的请求”合并为一个列表“等待回应中的请求”：列为 状态、种类、所属任务、接收人（显示成员名字）、期限、待补充内容、后续处理；状态写“等待回应中”或“已逾期”，已逾期的排前面；不显示记录摘要。数据：`listRequests` 的未回答请求与 `listing.overdue_requests` 按 `record` 合并；期限已过或在逾期列表里即为已逾期。
   - 没有等待回应中的请求时整段不显示；原来那行“请求的处理在接收人的 Circle 中完成……”改为标题的悬停提示。
   - 任务详情页的“未回答的请求”同样改为“等待回应中的请求”（不需要“所属任务”列）。
   - 写成一个共用函数，两处共用。
6. **“知识喂入待办”移到知识库页并改名**：改为“知识入库待处理”，列名改为 来源、待补充内容、后续处理、检查脚本出错详情；没有事项时整段不显示。数据来自 `ctx.deps.knowledge.feeding?.todos(...)`。
7. **知识库页没有产品线时的空状态**。所有者：“团队知识库怎么是按照产品线预览？没有包哪里来的产品线？”“版本差异：你是打算从什么版本呢？通用 hub 平台会有这些吗”。
   - 没有可读的产品线时：不显示“按产品线浏览”的空卡片和“版本差异”，改为一张卡片说明“还没有团队知识；团队知识按产品线组织，发布产品包后可在此浏览和导入”（成员：“没有可读的团队知识；成员可读分配给自己的任务包所绑定的产品线”）。
   - 有产品线时，“版本差异”不要让人手填内容哈希：改为从该产品线的版本列表中选“从”和“到”（默认上一版本与当前版本）。
   - “导入知识”按钮加悬停提示：从产品包声明的来源导入到团队知识库（所有人可见），仅管理员可用。所有者问：“这个导入知识是本地的还是团队的，怎么区分？为什么设计在这里”。按钮是否改名为“导入共享知识”，先问所有者。
8. **“知识入库流程”卡片的划分**。所有者：“从目前的团队知识库和个人知识库来看应该就只分这两种，现在这个划分是什么意思”。改画成两栏：“个人（仅本人可见）”与“团队（所有人可见，Hub）”，中间一个“提交共享 → Hub 出处校验”；每格上方只标属于哪一栏，不再混用“本机 Circle”“Hub”等运行位置（运行位置写进小字说明）。“原文归档”仍标“规划中”。
9. **定时任务与机器人不放在任务包页**（da2eb2b 已去掉任务包页的占位）。所有者：“定时任务和机器人怎么能放到任务包里面呢？很奇怪的设计，应该自己有自己的界面才行”。本次不实现功能，也不加导航入口；在本页“没有做的”写明：实现时单独一个页面和导航入口。
10. **新增“团队”导航入口**。所有者：“第一次添加的永远是管理员，增加一个团队的侧边栏，专门用于权限和团队管理”。
    - 导航加“团队”（放在“设置”之前），页面 `/console/team`：成员列表（名字、角色、状态、可用的任务包）、添加成员（原“设置 · 成员”的内容与“添加成员”按钮移过来）、成员详情（权限、任务包分配、已连接的 Circle、停用与恢复，仍按决定 75 由控制台生成命令或走现有写接口）。
    - “设置”只留 Hub 状态、凭据等系统设置；成员视图下“我的 Circle”仍在设置。
    - 第一个账户是管理员的规则保持不变，并在团队页写明（悬停提示）。
    - 同步改设计里的导航说明（导航从 7 项变为 8 项），在决定 83 里写明这是所有者的新决定。
11. **“已连接的 Circle”不显示令牌**。所有者在设置页的令牌列上说：“这个令牌的方式太恶心了”。已连接的 Circle 按设备列出：设备名（OAuth 客户端名称，如“MacBook 上的 Circle”；以访问令牌连接的用令牌标签）、成员、最近使用时间、操作（断开）；令牌编号不显示在表里。
12. **控制台登录改为用户名加口令**。所有者：“我建议改成安装的时候必须填写用户名，密码可以选填（如果用户写了就用用户的，如果没有随机生成并告知用户，随机生成密码登录第一次必须修改密码）”。所有者在 2026-11-02 经 Claude 补充授权：本项直接实现，不再等待方案确认；成员同样用口令登录，仅管理员可添加账户，成员的 Circle 令牌绑定到成员账户；添加时生成初始口令、仅显示一次、首次登录须修改，之后在团队页管理。实现涵盖：
    - 安装：`install.sh` 交互询问管理员用户名（必填）与口令（可选）；不填则随机生成并只显示一次；口令写入方式不经命令行参数（标准输入或交互）。
    - 存储：新迁移给用户加口令摘要（用 `node:crypto` 的 scrypt，带盐，不加依赖）与“首次登录须修改”标记；不保存明文。
    - 登录页：用户名 + 口令；随机口令首次登录后必须先改口令才能进入；失败次数限制；访问令牌登录是否保留为管理员备用。
    - 成员：管理员添加成员时如何拿到初始口令（同样随机生成、只显示一次、首次登录须修改），以及重置口令。
    - 与决定 78 的关系：Circle 仍用 MCP 标准授权连接；一次性登录链接是否保留。
    - 不碰本机正在运行的部署；测试用临时数据根与临时钥匙串。

## 不在本次范围（写进“没有做的”，等所有者另定）

- 知识库通用化：团队知识库不强制依附产品包；个人与团队用同一套条目与索引（陈述 + 出处 + 树路径 + 内容哈希，仅可见范围不同），使个人知识也有搜索、被引用次数、出处核验与版本；产品线与版本作为可选的组织方式。所有者问：“知识库团队和个人的索引是否后续设计成一致，是否能做到现在团队知识库的效果？”——本次只在本页写一段方案草稿，不改模型。
- 定时任务与机器人的独立页面（规划中）。

## 收尾

- 完成后报告分支、提交和测试结果（含跳过）；第 12 项按追加授权实现，知识库只交调研及整合方案。
- 所有者 2026-11-02 补充：暂不改“导入知识”的名称，本次仅加悬停说明；命名纳入知识库调研方案。定时任务与机器人以后各用独立页面，本次不实现。
- 设计画布（claude.ai 上的《circle-hub 控制台设计稿》）与接口文档由 Claude 事后同步。

## 没有做的

- 第 9 项：任务包页不显示定时任务或机器人的占位，本次不加功能或导航入口。以后定时任务与机器人分别使用自己的页面和导航入口，不放在任务包页。
- 知识库通用化本次只做需求调研和个人、团队整合方案，不改知识模型、存储或读取权限。

显示轴追加授权（所有者在本任务中的答复）：允许新增 B07 的 `request_status` 并同步版本测试。可改路径补入 `contracts/model.json`、`contracts/generated/**`、`contracts/README.md`、`contracts/src/model-w04-w10-v07.test.ts`、`contracts/src/vocab-axes.test.ts`。

## 做了的

- 第 12 项：安装交互要求管理员用户名，可选口令经标准输入交给初始化命令，随机口令只显示一次且须首次修改。迁移 8 保存带盐 scrypt 摘要与首次修改标记，追加口令变更历史；控制台会话独立于 Circle 令牌并有期限。成员也用口令，添加成员时显示初始口令；团队页提供本人修改、管理员重置。强制修改覆盖页面、接口、流式更新和管理操作；失败限制同时覆盖未知账号。保留管理员备用令牌和管理员一次性链接，成员链接转到口令登录；旧成员未设口令的由管理员在团队页重置。MCP 标准授权、邀请码和令牌的账户绑定保留。

- 知识库调研及整合方案已写入 [`personal-team-knowledge.md`](../design/personal-team-knowledge.md)：核对当前模型与知识库实现，覆盖采集、出处、搜索、计数、版本、共享、权限及维护，参考 Outline 与 Joplin 官方资料，提出个人本地与团队 Hub 共用格式、分开授权的方案。本次没有实现知识库通用化。

- 第 11 项：团队、连接及成员设置按设备名显示 Circle，优先取标准授权客户端名称，其次取访问令牌标签；表格不显示令牌编号，断开命令仍保留精确目标。

- 第 10 项：新增团队导航、成员列表和详情；管理员可查看权限、任务包分配、连接并生成现有管理命令，成员仅查看本人。成员管理移出设置，成员设置保留“我的 Circle”；导航设计与决定 83 同步。

- 第 8 项：流程图改为个人与团队两栏，中间显示提交共享与出处校验；运行位置和读取权限放入悬停说明，原文归档仍标规划中。没有扩大现有读取权限。

- 第 7 项：无可读产品线时显示对应角色的团队知识说明；有产品线时按其已产出版本选择比较对象，默认上一版本到当前版本。“导入知识”保留名称，增加范围与管理员权限的悬停说明。

- 第 6 项：知识入库待处理移到知识库页，保留当前成员的读取范围；没有事项时隐藏。

- 第 4 项：无任务、无筛选时只显示空状态；筛选期间保留清除条件的入口。任务数量按本页与筛选后分别显示，排序说明悬停显示。
- 第 5 项：两个请求入口共用一个列表；按记录身份合并、逾期优先、显示成员名字，无请求时隐藏整段。状态取自新生成的 B07 显示轴；原请求记录不变。

## 验证

- 第 12 项：`npm run typecheck` 通过；以下口令、迁移、会话、授权、管理及安装相关文件定向检查 153 项通过、0 跳过：

  ```sh
  node --test --test-concurrency=2 hub/records/password.test.ts hub/records/principals.test.ts hub/records/migrations.snapshot.test.ts hub/server/console-password.test.ts hub/server/console.test.ts hub/server/standard-authorization.test.ts hub/server/console-api-write.test.ts hub/server/console-manage.test.ts hub/server/setup-code.test.ts hub/platform/install-script.test.ts hub/server/console-places.test.ts hub/server/console-live.test.ts hub/server/console-api.test.ts hub/server/console-results.test.ts hub/server/console-search.test.ts hub/server/console-systems.test.ts hub/server/console-environments.test.ts hub/server/proxy-cookie.test.ts hub/server/units.test.ts
  ```

  `node --test --test-concurrency=1 --test-name-pattern='init-admin|initial passwords' hub/server/assemble/cli-admin.test.ts` 选中的 16 项通过、0 跳过，其余用例未选中；补充安装参数后 `node --test hub/platform/install-script.test.ts` 8 项通过、0 跳过。`npm run test:docs` 283 项通过、0 跳过。只复用现有迁移保护并追加迁移，没有新增数据 SHA 扫描。未跑全量单元、验收、来源、备份恢复或 Linux 隔离套件；未验证实际安装、发布或现有部署。

- 合成页面预览：用全新临时浏览器配置查看登录、团队、知识库与空任务页，并检查团队和知识库 390 像素窄屏；未使用个人浏览器配置。浏览器配置和临时 Hub 均已停止并清理；截图与日志不入 Git。发布工作流仍期待设置码，最小同步补丁已准备，依 `AGENTS.md` 等待所有者授权后才能修改。

- 知识库方案：`npm run typecheck`、`npm run test:docs` 通过（文档 283 项、0 跳过）；没有实现通用化代码，未运行知识库回归或对同类项目做部署验证。第 11 项结果页导航补正后，另跑 `node --test --test-concurrency=2 hub/server/console-places.test.ts hub/server/console-manage.test.ts` 19 项通过、0 跳过。

- 第 11 项：`npm run typecheck` 通过；`node --test --test-concurrency=2 hub/server/console-places.test.ts hub/server/console.test.ts hub/server/console-environments.test.ts` 29 项通过、0 跳过；`npm run test:docs` 283 项通过、0 跳过。未运行全量回归。

- 第 10 项：`npm run typecheck` 通过；`node --test --test-concurrency=2 hub/server/console-places.test.ts hub/server/console-search.test.ts hub/server/console.test.ts` 31 项通过、0 跳过；`npm run test:docs` 282 项通过、0 跳过。新增成员状态显示轴另有确认待答，当前保留原设置页状态用语；未运行全量回归。

- 第 9 项：本项仅补范围说明。`npm run typecheck` 通过；`node --test hub/server/console-places.test.ts` 7 项通过、0 跳过；`npm run test:docs` 281 项通过、0 跳过。没有实现或测试定时任务、机器人功能，未运行全量回归。

- 第 8 项：`npm run typecheck` 通过；`node --test --test-concurrency=2 hub/server/console-knowledge.test.ts hub/server/console-places.test.ts` 11 项通过、0 跳过；`npm run test:docs` 281 项通过、0 跳过。未运行全量回归。

- 第 7 项：`npm run typecheck` 通过；`node --test --test-concurrency=2 hub/server/console-knowledge.test.ts hub/server/console-pagination.test.ts hub/server/console-places.test.ts` 15 项通过、0 跳过；`npm run test:docs` 281 项通过、0 跳过。未运行全量回归。

- 第 6 项：`npm run typecheck` 通过；`node --test --test-concurrency=2 hub/server/console-knowledge.test.ts hub/server/console-pagination.test.ts` 6 项通过、0 跳过；`npm run test:docs` 281 项通过、0 跳过。未运行全量回归。

- 第 5 项：`npm run typecheck`、`npm run verify:contracts` 通过；`node --test --test-concurrency=2 hub/server/console-pagination.test.ts hub/server/console-places.test.ts contracts/src/model-w04-w10-v07.test.ts contracts/src/vocab-axes.test.ts` 24 项通过、0 跳过；`node --test --test-concurrency=1 --test-name-pattern='uses generated axes' packs/workflow/case-review/packs.test.ts` 选中的词表扫描 1 项通过、0 跳过，其他测试未选中；`npm run test:docs` 281 项通过、0 跳过。未运行全量回归。

- 第 4 项：`npm run typecheck` 通过；`node --test --test-concurrency=2 hub/server/console-pagination.test.ts hub/server/console-places.test.ts` 12 项通过、0 跳过；`npm run test:docs` 通过（281 项、0 跳过，附带静态文档检查通过）。没有运行全量回归和来源校验。
