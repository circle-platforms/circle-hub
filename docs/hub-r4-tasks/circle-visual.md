# 任务：Circle 工作台视觉统一（石墨主题）——决定 142

依据：
- 所有者 2026-11-02：“同样的方案也要让circle保持相同设计感”。控制台已选定主题版本 A“石墨”，Circle 工作台改用同一套设计。
- 设计规范《Circle 设计规范》：[`docs/design/circle-design-system/`](../design/circle-design-system/README.md)，效果图在 [Circle 仓库的文档](https://github.com/circle-platforms/circle/blob/main/docs/design/circle-design-system-screens.md)，文件摘要见 `docs/design/circle-design-system.sha256`。Circle 仓库的 `docs/design/circle-design-system/` 是同一份。与工作台直接相关的是：
  - README 的“品牌”“颜色”“字体与排版”“页面结构”“在两个产品中实现 › Circle 工作台”；
  - 组件 WorkbenchShell 与 Composer；
  - 交互、文字两节，两个产品通用。

本任务在 Circle 仓库完成。本页放在 circle-hub 仓库，只用来交接与记录。

当前状态（2026-11-03）：视觉统一已获 Claude 批准，Claude 变基为 `ee7466ed` 并打开 Circle PR #405；本轮 CI 回修已在 Circle 本地签署提交 `d2e31542`，完整 67 组件、核心/应用检查与开发版/打包版各 26 阶段原生流程通过，待 Claude 审查并推送。CV-19 的一次旧包 Git 行差异仍未定因，原失败与新增诊断保留，不宣称已修复。决定 139 保持已提交且干净的第一阶段（Circle `9e7d7659`、记录 `7409057f`），回到该阶段的审查点，不向视觉分支混入知识库代码。下文原方案与四阶段记录保留；CI 回修见末节。

## 做法

- Circle 仓库：工作树 `../circle-visual`，从 `origin/main` 开分支 `workbench-graphite-local`。node_modules 按 Circle 仓库的做法准备，不在共享检出里切分支。
- 遵守 Circle 仓库的 `AGENTS.md`：
  - 提交信息为一句英文祈使句，`git commit -s`；
  - 用户可见的变化在 `CHANGELOG.md` 的 `## Unreleased` 下加一行；
  - 桌面界面文字写成 `t('…')`，中文写进 `apps/workbench/src/i18n/zh-CN`；终端保持英文；
  - 原生检查只用 `CIRCLE_WORKBENCH_DATA_DIR` 与合成数据，不打开真实的 Circle 数据；
  - 改到应用时，除 CLI 检查外还要跑应用包检查。
- 只在本机提交，不推送；推送和开 PR 需要所有者同意。
- 先在本页“实施方案”一节写出做法，经 Claude 审查后再动手。

## 要做到的（验收标准）

1. **一张调色板**：颜色仍然只来自 `src/ink/theme.ts`，不另建第二张颜色表。
   - 把桌面深色、浅色两套的底色与文字色换成规范的值；工作台的 `apps/workbench/src/theme.ts` 按 README 的对应表导出设定。
   - 色环（`GRADIENT_STOPS`）不变；它就是规范里的品牌色。
   - 终端的默认配色（`DEFAULT_DARK` / `DEFAULT_LIGHT`）是否随之调整，在实施方案里说明影响后再定；终端界面不在本任务改版范围内。
   - 用测试钉住导出的每个设定与 `tokens.json` 一致，两套主题都要覆盖。
2. **结构**：导航 232px（`surface-0`）、会话（`surface-1`，内容最宽 760px 居中）、抽屉 380px（`surface-2`），层次靠底色，不靠边框。
3. **会话与输入区**：用户消息、回复、思考、工具调用、计划、请求提示、状态行和后台任务按 WorkbenchShell 组件实现。输入区的四种状态按 Composer 组件实现：默认、计划模式（紫色外框）、工作中（色环外框转动）、等待回应（橙色外框）。
4. **标志与字标**：左上角为色环、小写字标“circle”与“工作台”；界面里的色环画法与 `docs/images/logo.svg` 一致。
5. **字体、圆角、动效**：
   - 字体沿用现有的系统字体与 `Circle CJK`；
   - `--radius` 由 7px 改为 8px，用户消息、计划和输入区用 10px；
   - 动效时长 120、180、240ms，系统开启“减少动态效果”时全部关闭，色环静止。
6. **用词**：按规范“文字”一节逐条检查并改写 `zh-CN` 词典：
   - 不用“你、他”作主语，进行中写成“等待××中”，路径用“ › ”连接；
   - 例子：“{n} 个请求等待你处理”改为“{n} 个请求等待处理”，“Circle 已把它交给你”改为“等待回应中”；
   - 英文键与英文界面不变。
7. **设计规范在 Circle 仓库**：同一份设计规范已经放进 Circle 仓库的 `docs/design/circle-design-system/`，并列在 `docs/design/README.md` 的索引里，由单独的文档 PR 完成。规范有改动时，两个仓库同时更新，摘要保持一致。
8. **核对**：
   - 截图：原生窗口在深浅两套主题、宽窗口与 1024px 窄窗口下截图，与 WorkbenchShell、Composer 组件预览对照，只用合成数据。按 `docs/workbench/validation.md` 的做法更新截图与收据。
   - 对比度：用设定值检查。
   - 测试：跑 `npm run check`、`npm run check:apps` 与工作台、桌面包的测试，跳过项逐项列出。

## 不在本任务

- Circle 的本机知识库、本机记忆与同步客户端：决定 139，另立任务。
- 终端界面（TUI）的改版。

## 实施方案

状态：方案已经 Claude 审查通过，按四块依次实施。以下为批准的实施清单，实际完成范围与验收结果另见“做了的”和“验证”。

基线：Circle `workbench-graphite-local` 当前为 `f672b668`（设计规范文档），其父提交及本机 `origin/main` 均为 `8b9c1736`；代码只在该工作树修改和本机提交。本页只在 Hub 的 `circle-visual-notes` 分支修改和本机提交。依次执行根目录 `npm ci`、`npm --prefix apps/workbench ci`、`npm --prefix apps/desktop ci`，使用现有锁文件，不加依赖、不改锁文件。

### 1. 调色板与设定

- 颜色的唯一实现位置仍为 Circle 的 `src/ink/theme.ts`。在该文件提供桌面深浅两套语义色槽，覆盖实际使用的 surface、line、text、brand、area、status、focus、inverse 与浮层颜色；由桌面调色板构造函数供工作台取用。设计文档的 `tokens.json` 是测试对照，不在组件或另一个运行时文件复制颜色表。
- **建议保留终端 `DEFAULT_DARK` 与 `DEFAULT_LIGHT` 的现值**：分别为前景/背景 `#d6dee6` / `#10151a`、`#3c4148` / `#f7f8fa`。新增同文件内的桌面深色入口，与桌面浅色入口一起采用 `text-primary` / `surface-1`。因此 CLI 的自动探测、无法探测时的回退、显式 dark/light、终端主题监听和终端派生色算法均维持现状；桌面不再借用 `DEFAULT_DARK`。此选择随本方案交 Claude 审查。
- 工作台 `apps/workbench/src/theme.ts` 仅做语义映射：`--sidebar` → `surface-0`；`--bg` → `surface-1`；`--drawer` / `--surface` → `surface-2`；浮层与输入区分别取 `surface-3` / `surface-sunken`；`--hover` / `--active` → hover/pressed；`--fg` / `--secondary` / `--muted` → 三级文字；accent/violet/attention → 三个区域色。`--border` 保留装饰线含义，新增明确的控件线设定，并逐处迁移输入框、按钮、筛选控件；同时提供焦点环、主按钮反色、状态点/文字/底色等映射。RGBA 叠加层保留透明度，不先转换为不透明 RGB。
- `--positive` / `--negative` 按规范取 `status-pass` / `status-fail`；正文和标签改用对应 `*-text` 色，不能把状态点的颜色直接当正文。`--violet` / `--attention` 用于可读的模式文字，输入区外框分别用 `brand-violet` / `brand-orange`。保留 `GRADIENT_STOPS` 的值和停点；工作中外框按深浅品牌设定绘制，标志采用 `docs/images/logo.svg` 的四段圆弧几何与原始品牌停色。
- xterm 标签页继续由当前调色板的 `terminalTheme()` 推导，不另建 ANSI 表。桌面前景、背景、光标和选区会随桌面新主题改变；CLI 的配色不因此改变，xterm 中应用输出自身的 ANSI 颜色语义保留。
- 扩展 `apps/workbench/test/theme.test.ts`：读取 `tokens.json`，递归解析 `{token}` 别名，按颜色语义归一化 RGB/RGBA，对**每个导出的规范映射**逐项断言 dark/light；新增映射必须有测试对照，不能只断言几个代表值。同时覆盖 auto 跟随系统、即时切换与四档字号。扩展 `terminal-theme.test.ts` 和核心颜色/界面测试，证明桌面 xterm 跟随且 CLI 默认值未变。
- 对比度检查按实际用途与合成后的底色计算：正文及说明文字 ≥ 4.5:1，控件线与焦点标识 ≥ 3:1；品牌标志、状态点与文字分开列结果。发现规范值本身不足时记录色对和实测值，交审查决定，不悄悄改 token 或放宽测试。

### 2. 三栏、会话元素与输入区四态

- 先清点现有样式覆盖关系，在原有 React 组件内调整，不把规范的静态 HTML 另做一套应用。主要修改边界为 `apps/workbench/src/app/App.tsx`、`app/workspace-layout.ts`、`components/Sidebar.tsx`、`components/MessageView.tsx`、`components/ToolMessage.tsx`、`features/Conversation.tsx`、`features/Composer.tsx`、`features/PlanView.tsx`、`features/InlineRequest.tsx` 及其直接关联样式和测试。主页输入区、设置、菜单与抽屉一并检查新 token 的使用；确需超出此范围时先在本页说明原因。
- 导航默认 232px、`surface-0`；主区 `surface-1`，会话内容与输入区统一最宽 760px 居中；抽屉默认 380px、最小 300px、`surface-2`，保留拖动与现有面板功能。窗口宽度小于 1180px 时抽屉默认收起为按钮，小于 760px 时导航收起为按钮；用当前布局计算而非仅 CSS 隐藏来维护焦点和打开/关闭状态。保留文件、网页和任务等现有全屏/独立窗口行为，回归已有面板尺寸测试。
- 导航左上显示色环、小写 `circle` 和经 `t()` 翻译的“工作台”；会话选中项使用中性悬停底与 600 字重。底部仅显示实际运行时状态。规范预览中的平台导航、知识库开关与“已连接到 Hub”是视觉示例，不据此新增决定 139 的功能或 Hub 专属入口/标签。
- 用户消息靠右，`surface-2`、10px、无框；Circle 回复直接排在主区底色上，标题为小色环与 `circle`；思考用次要文字并标“思考”，去掉竖线与套框。工具调用用 `surface-2` 单行，动作、等宽对象、用时可读且可展开。计划同底色、10px，完成点取通过色、当前步骤取紫色并加粗。请求提示是细线框单行，注意点、数量与“查看”；保留实际请求详情和审批、提问、密钥输入的可达性。
- 将底栏纳入输入区外框，模型/强度选择、模式、附件和发送/停止操作仍接现有运行时。输入框随内容增高，最多 12 行后滚动；空内容不可发送，附件等现有约束保留。输入区下方依次为等宽用量/上下文状态行、后台任务列表；后台任务逐行显示状态、编号、说明/命令和用时。
- 四态由当前会话与实际待处理请求推导，不另造运行时状态：默认用 `surface-sunken`、1px 控件线；计划为 2px 品牌紫框；工作中为 2px 色环、3.6 秒一圈、停止操作及用时；等待回应为 2px 品牌橙框和请求提示。优先级为当前待回应请求 > 当前回合运行 > 空闲计划模式 > 默认；请求答复后按实际运行状态恢复，模式文字独立反映当前模式。测试覆盖 plan 中开跑、运行中到达请求、答复、结束、中止及跨会话切换，防止只按 `data-state="waiting"` 判定。
- 保留 Enter 插话、追加队列、草稿、审批与取消等既有真实语义；Composer 预览的示例占位文案不用于改写这些行为。若工作中统一停止按钮需要收拢现有暂停/继续入口，只调整入口呈现并保留对应操作与测试。
- 沿用系统字体和 `Circle CJK`、四档界面字号；字号阶梯、字重 400/500/600、等宽计量与 4px 间距体系按规范检查。统一常规圆角 8px，用户消息/计划/输入区 10px，对话框 14px；层次靠底色，阴影限浮层。
- 引入 120/180/240ms 时长和规范缓动；减少动态效果时关闭 transition、animation 与相关 JS 装饰动画，色环静止。保留 Tab、焦点环、图标按钮的翻译名称及提示；实测窄窗菜单、请求和停止操作无裁切。

### 3. zh-CN 用词检查

- 按规范“文字”一节逐项检查 `apps/workbench/src/i18n/zh-CN/` 全部区域词典，记录命中位置和改写，不做无上下文的全局替换。英文键及既有英文界面保持不变；确需新增界面标签时用字面量 `t('…')` / `tn()` 并补中文。
- 请求数量统一为“{n} 个请求等待处理”；交还提示统一为“等待回应中”；删除以“你、他”为主语的写法；进行中用“等待××中”；按钮用动作、打开对话框的动作加省略号；按对照表检查“与我共享、我的、来源、分享、已验证/待验证、版本记录、文件夹、类型”等。
- 仅界面层级路径改为“ › ”。真实文件路径、命令、模型名、工具名、键、代码、模型/用户内容和诊断原文保持原值；不能把文件系统路径中的 `/` 替换为导航符，也不能删去决定安全后果所需的信息。项目/工作区/文件夹沿用 `desktop-i18n.md` 的语义区分。
- 扩展已有 `i18n.test.ts` 的用词回归，继续检查翻译覆盖、重复键一致性、占位符与全角标点；对请求单复数、交还、模式和待处理状态用合成数据核对中文原生截图。英文原生检查继续跑，终端仍保持英文。

### 4. 原生验证、截图与交接

- 所有运行和测试使用临时 `CIRCLE_HOME`、隔离 `CIRCLE_WORKBENCH_DATA_DIR`、合成工作目录及明确的测试 profile；模型只用 ScriptedModel 或 loopback HTTP fixture。先跑针对性主题、布局、输入区、请求、i18n 与终端测试，再完整执行 `npm run check`、`npm run check:apps`，并执行根目录、workbench、desktop 的 `format:check` 和 `git diff --check`。`check:apps` 已包括两应用的类型检查与单元测试、desktop `test:runtime` 和构建；逐项记实际命令、退出码、数量与跳过项，不把构建当原生验收。
- 开发版执行 desktop 的 `test:desktop`、`test:interface`，以 `CIRCLE_DESKTOP_CHECK_NARROW=1` 另跑 1024px 窄窗；运行相关 `test:live` 路径验证真实预加载桥、审批、输入与运行时行为。增加聚焦本任务的原生场景，使用现有 Playwright/Electron 与 evidence/viewport/readiness helpers，不能拿浏览器布局服务器的截图替代原生窗口。
- 截图矩阵：dark/light × 宽窗（实际宽度至少 1280px）/1024px × 默认/计划/工作中/等待回应，中文为主；另核对英文与 auto、减少动态效果。四态均截图，状态切换均有断言；宽窗/窄窗覆盖导航、760px 内容约束、抽屉展开/收起、长路径/长模型名、请求、计划、工具详情与后台任务。先保留改前截图与现有基线，再检查改后实际图，对照 WorkbenchShell/Composer 预览；不能自动接受差异或只凭截图文件存在判通过。
- 执行 `npm --prefix apps/desktop run package` 生成本地开发包，用 `CIRCLE_DESKTOP_EXECUTABLE` / `CIRCLE_DESKTOP_APP_PATH` 指向该包重复原生桌面/界面及本任务截图矩阵，确认回执中的 packaged 标志；开发版、打包版证据分目录保存，防止既有固定输出路径互相覆盖。
- 按 `docs/workbench/validation.md` 的方式记录运行时间、平台/架构、Node/Electron、实际 viewport、主题/语言/四态、逐项 checks/errors、源文件与构建 SHA-256、截图摘要、打包 ASAR 摘要及应用/磁盘镜像摘要。实际原生证据放在现有被忽略的 `apps/desktop/artifacts/` / `out/` 下；在 Circle 的 validation 文档新增本轮记录并保存所需合成截图/脱敏收据，保留旧记录的时间和适用范围。入 Git 的收据只留相对路径，不带本地绝对路径、环境值或真实数据。
- 测试通过、运行时行为通过、截图人工核对与 Claude 视觉审查分别记录。macOS 本地结果不外推其他平台，不声明签名/公证或公开发布。每次失败保留原因与证据；所有跳过逐项列出，不删测试、不增加重试来换绿。
- 审查通过后按四块逐步实现并记录发现/结果；用户可见改动在 Circle `CHANGELOG.md` 的 Unreleased 加一行，代码与验证提交在 `workbench-graphite-local`，任务记录提交在 `circle-visual-notes`，均为一句英文祈使句并 `-s`。不 push、不建 PR、不改发布流程、不安装到 Applications。

### Claude 审查结论（2026-11-03）

方案通过，按四块依次实施，每块完成后报告。对方案和“发现”中几处的决定如下：

1. **终端配色**：同意。`DEFAULT_DARK`、`DEFAULT_LIGHT` 保持现值，终端不在本任务范围内。桌面在同一文件里新增深色入口，与桌面浅色入口一起取规范值。
2. **浅色输入区的品牌外框**：保留规范的值，不改设定。
   - 外框的对比按外侧的主区底色（`surface-1`，白色）验收：蓝 3.14:1，橙 3.12:1。
   - 输入区的状态同时有文字说明：模式文字、“等待 Circle 完成中”、请求提示条。颜色不是唯一的提示。
   - 在验证记录里写明这两个实测值和上面的理由；不要为凑数改设定或放宽测试。
3. **状态点与状态文字**：同意分开。点用 `status-*`，正文与标签用 `status-*-text`。
4. **预览与说明不一致的地方**：以组件 README 为准，工作中显示停止按钮。设计规范的 WorkbenchShell 预览由 Claude 修正，两个仓库同步。预览里的平台入口、知识库开关和“已连接到 Hub”只是示意，不据此新增功能；决定 139 另有任务。
5. **验证记录**：同意新增本轮记录，保留旧记录的时间和适用范围。入库的收据去掉本机路径和环境值。

## 发现

- 当前桌面深色直接使用 `DEFAULT_DARK`，浅色使用 `DESKTOP_LIGHT`，多数界面色由混合比例派生；因此只改两组前景/背景不能精确得到规范的分层、控件线与三级文字。已有 `theme.test.ts` 仅检查信任文字绿色在四种底色上的 4.5:1，对全部 token 的固定映射尚无覆盖。
- 按版本内 `tokens.json` 与核心 `contrastRatio()` 重算：浅色 `status-pass` 在 `surface-1` 上为 3.592:1，`status-pass-text` 为 5.651:1。现有 `--positive` 同时承担文字角色，需要在迁移时区分点与文字，保留文字 4.5:1 的实际用途检查。
- 同一计算中，浅色 `brand-blue` / `brand-orange` 在 `surface-sunken` 上分别为 2.749:1 / 2.731:1，而规范明确输入区采用该底色与品牌外框。外框紧邻主区与输入区两面；审查需确认品牌状态外框的对比验收面，或由规范维护者决定修订。当前不改规范与值，也不声称该色对已达 3:1。
- 规范 README/Composer 与静态预览有差异：WorkbenchShell 预览在 working 状态仍显示禁用的发送按钮；Composer README 要求停止按钮。计划采用组件 README 的真实状态规则。WorkbenchShell 的平台入口、知识库开关与 Hub 连接文字也不能作为能力交付依据。
- `docs/workbench/validation.md` 明确是历史前端回执，当前运行时证据路径见其指向的 `native-runtime.md`；本轮记录需保留这一区别。现有原生 receipt helper 提供源文件/构建摘要，但不包含本轮设计文档摘要，新增场景需补入；现有部分回执含本地 appPath，入 Git 前必须脱敏。

## 做了的

- Step 0：核对两个工作树的分支与干净状态；读取 Circle `AGENTS.md`、`CONTRIBUTING.md`、TUI 契约、桌面 i18n、validation 与 native-runtime 文档，以及设计规范 README、tokens、WorkbenchShell/Composer 的说明、预览与对应样式。
- 核对主题、xterm 派生、会话输入区、布局与现有 i18n/主题测试、原生截图及摘要回执脚本，写出上述四块实施方案。
- 按指定顺序重装三个锁文件的依赖；没有新增依赖，没有修改代码、清单、锁文件或视觉基线。代码实施等待 Claude 审查。

### 第一块：调色板与设定

实现完成，Claude 已批准。Circle 本机提交：`839059f2`（`Unify desktop palette tokens with the graphite design system`，已签署）；没有推送。整体 `npm run check` 当次仍为失败，Claude 已将其单项失败判为负载相关超时，见下述审查记录。第二块结果见下。

#### 第一块审查补充（来源：Claude 本轮交接）

- `tests/browser-pipe-close.test.ts` 的单项失败不是本次改动导致。Claude 在本工作树以临时 `CIRCLE_HOME` 单独运行两次，两次均通过；其覆盖的代码自 `f672b668` 起未变。当次三个代理同时测试，load average 约为 11，`Browser.getVersion` 只有 2 秒启动限时，因此记为负载相关超时。保留当次失败记录；第四块结束时再单独运行该文件，不增加超时或重试来代替检验。
- 同意已实现的状态提升：悬停/选中行的辅助文字使用 `text-secondary`，按下控件边框使用 `focus-ring`。Claude 将把这两条补入设计规范；本代理不改规范文件。

- 在 Circle `src/ink/theme.ts` 集中定义桌面语义色与阴影，新增 `DESKTOP_DARK` 和 `buildDesktopPalette()`；桌面深浅前景/主区底色取规范值。`DEFAULT_DARK`、`DEFAULT_LIGHT` 和 `GRADIENT_STOPS` 保持原样，CLI 的读取路径未改。
- `apps/workbench/src/theme.ts` 导出规范命名和旧工作台名称的语义映射；完整保留 RGBA 透明度。状态点与状态文字、装饰线与控件线、模式文字与品牌框分别取色。迁移已有状态/信任/错误文字、状态点、输入控件、主按钮反色和焦点色；三栏尺寸、输入区四态结构与中文字典尚未实施。
- 新增的叠加态对比检查发现：辅助文字在深色浮层按下底色上为 4.138:1；浅色导航/凹底按下底色上分别为 4.474:1 / 4.302:1。控件线在深色浮层/浅色凹底按下态为 2.809:1 / 2.920:1。保留规范 token，交互元素悬停/选中时将辅助文字提升为 `text-secondary`，按下/选中时将控件边线提升为 `focus-ring`；针对这些组合维持原来的 4.5:1 与 3:1 门槛。
- Monaco 原先把 CSS 颜色的 alpha 丢掉，会把新的悬停/选区/差异底色变成实色。新增同一调色板文件内的 `cssColorHex()` 转换器，保留 8 位颜色透明度；编辑器跟随新焦点、输入、状态文字与差异底色。此项是 token 消费者适配，不新增编辑器功能。
- 主题测试逐项核对全部规范颜色、阴影及每个工作台别名；另覆盖自动/显式切换、四档字号、文字与控件对比度、状态文字/点的使用、编辑器透明度。新增核心回归钉住终端默认值/回退与品牌停点，扩展 xterm 的桌面深浅切换及原有核心对比测试。普通文字/信任文字在五层底色上检查；带淡底的状态标签在实际非输入层上检查，不把不存在的“凹底输入框内带淡底通过标签”当作覆盖。
- 浅色品牌框按 Claude 决定，在外侧 `surface-1` 上验收：蓝 **3.14:1**、橙 **3.12:1**，测试保留 ≥ 3:1。四态文字提示将在第二块接入，颜色不是唯一提示；不改规范值。
- 已添加 Circle `CHANGELOG.md` Unreleased 行。没有改依赖、锁文件或设计规范；Claude 负责的预览修正未触碰。

### 第二块实施发现

- 原有概况与抽屉可同时形成第四栏；按三栏规范改为共用右侧栏，保留两个入口和文件/代理文档的展开宽度及全屏功能。普通模式默认 380px，文档打开后仍可展开到 760px，拖动最小 300px。
- 原生主窗口 `apps/desktop/src/main.ts` 原有最小宽度 760px，会阻止实际窗口进入规范要求的“小于 760px 导航收起”状态；将该窗口最小宽度改为 640px，并在原生检查中验证 700px 下通过按钮打开导航。本次只改该尺寸，不改宿主权限或运行时行为。
- 增加长草稿原生检查后发现：1024×650 窗口中，计划和长输入会把发送按钮挤到窗口外。把输入区改为可收缩的纵向 flex，底栏保持不收缩、计划清单和文本框各自滚动；保留最多 12 行的输入上限，最终原生检查确认发送操作仍在 viewport 内。

### 第二块：三栏、会话与输入区

实现完成，Claude 已批准。Circle 本机提交：`0fd38629`（`Unify workbench panes and composer states`，已签署）；未推送。第三块结果见下；第四块的完整原生/打包验收及浏览器超时单项复核待执行。

- 三栏采用导航 232px、主区 `surface-1`、右侧 `surface-2` 的布局。概况和功能抽屉互斥；普通抽屉默认 380px，拖动最小 300px。文件/代理文档仍可按原有行为展开到 760px，并保留全屏/独立窗口。1180px 以下抽屉收起；760px 以下导航经按钮打开，不把仍可显示导航的 1024px 窗口当成手机导航。
- 会话内容宽度与输入区统一不超过 760px，用户消息采用靠右的 `surface-2`、10px 无框块；回复直接排在主区底色上，增加小色环与 `circle` 标题；思考去掉竖线，工具调用采用同层灰底单行和可展开详情。原始内容、工具结果、文件与命令不翻译。
- 新增会话内活计划、用量/上下文状态行和后台任务列表，全部投影已有会话数据；只列当前会话仍活动的后台工作，未知值仍为 `N/A`。完成的计划不重复留在活计划区，历史记录照旧保留。
- 新增纯展示状态推导：当前待回应请求优先，其次工作中、空闲计划、默认。待回应包括当前会话审批/提问、回合中的浏览器对话框/证书/交还请求，以及任务审查；暂停的旧回合不继续显示工作中。底栏纳入输入框，工作中用 3.6 秒色环、明确文字和停止按钮；计划/等待回应分别用品牌紫/橙框，模式文字仍独立反映实际模式。保留草稿、Enter 插话、追加消息、审批、停止/继续和跨会话状态边界。
- 新的色环组件使用 `docs/images/logo.svg` 的四段圆弧和调色板原始停色；导航显示小写 `circle` 与 `t('workbench')`。将原有回合等待行的装饰性色环改为普通活动指示，色环只用于标志和工作中的输入框。
- 保留系统字体与 `Circle CJK`，统一常规圆角 8px、消息/计划/输入区 10px、对话框 14px；采用 120/180/240ms 的状态过渡，减少动态效果时全部关闭并静止色环。新界面文字补入中文词典，整套 zh-CN 改写仍属于第三块。
- 新增状态与会话投影测试，并将旧布局测试的“概况与抽屉并排”断言替换为三栏互斥契约；保留文档展开、拖动、最小尺寸、折叠和草稿保留的检查。停止按钮改用准确名称，已有 live/parallel-sessions/compaction 原生脚本的定位名称同步更新，不改其行为断言。
- 新增 `apps/desktop/test/graphite-native.mjs`，以隔离 profile 和合成会话启动实际 Electron，输出带相对路径、源文件/构建/设计摘要的收据和截图。现已检查代表性的深色工作中、浅色窄窗等待回应、浅色用户消息截图；后续打包版与最终整体验收仍在第四块。
- 核对减少动态效果时发现，会话菜单原先用 160ms CSS 动画阻止打开菜单的那次 pointerup 误选菜单项；全局关闭动画会同时撤掉这项防护。将其改为匹配实际 pointerId 的事件防护，新的菜单项 pointerdown 或键盘操作会正常解除防护。原生检查在 reduced-motion 下验证了“打开时松开不误选、随后新点击可以重命名”，不通过保留动画或延长等待规避。

#### 第二块审查补充（来源：Claude 本轮交接）

- Claude 已检查原生截图：深色 working 的色环外框、停止按钮和“等待 Circle 完成中”，浅色 plan 的紫框与模式文字，以及两套主题的导航、会话、计划底色均符合设计。
- 批准主窗口最小宽度从 760px 降至 640px，以及输入区纵向收缩修正。
- 第三块须修正深色 working 图中的 `waiting for runtime connection` 与 `connection settings`。定位为 `Conversation.tsx` 预览等待行直接写出的 JSX 文字，缺少 `t()`，并非核心透传；改为翻译调用，补“等待连接运行时中”和“连接设置…”。桌面 i18n 文档虽允许预览专属文字保留英文，本轮依 Claude 明确要求翻译这两项；合成工具输出中同样的英文仍按内容原样保留。

### 第三块：zh-CN 用词

实现与验证完成，等待 Claude 审查。Circle 本机提交：`e3b16e51`（`Align Chinese workbench wording with the shared design rules`，已签署）；没有推送。第四块尚未开始。

- 对 20 个区域词典逐项检查，改写 16 个文件中的 201 条既有中文，补入两条连接提示。按每个词典文件的语法树与第二块 HEAD 比较，原有 2,102 个英文键全部保留且未改名，新增仅上述两项；最终共 2,104 个词典属性。没有改既有英文键、CLI 终端界面或核心返回文本。
- 请求单复数均为“{n} 个请求等待处理”；交还和人工回应均使用“等待回应中”。删除中文界面中的“你、他”称谓（“其他”保留），问题、确认与权限说明保持原有动作、范围和人工批准条件。
- 压缩、重试、连接、文件加载/保存、扩展加载等操作进度改为“等待××中”。工具组仍区分排队与执行，例如“等待读取中 · {file}”与“等待读取完成中 · {file}”；完成、失败、取消及未知结果不因此变化。长期服务“运行中”、工作状态类别、工具说明里的“正在运行的任务”等事实或限定语保留，未把它们误写成等待任务完成的操作进度。
- 按对照表把实际文件目录改为“文件夹”，示例模型 catalog 改为“示例模型列表”，核对依据改为“核对来源”，消息/命令/事件历史改为对应“记录”。没有版本引文或内容分享范围的旧标签；GitHub OAuth 授权与单文件访问授权继续表示技术权限，不改成“分享”；修订号不是“修订引文”，保留其意义。
- 附加文件、打开文件夹、连接模型、导出格式等会打开对话框的动作补中文省略号；连接设置按钮同样有省略号。重命名会话在导航中直接进入行内编辑，不统一改成弹窗标签；设置等共用标题的名词不添加尾部省略号。
- 检查组件层级路径与词典：没有以斜杠拼接的界面层级路径需要改写，现有文件树用节点/箭头表达层级。实际文件路径、命令前缀 `/`、`$EDITOR / $VISUAL`、价格比例、进度 `done/total` 均保持原值，不替换成 ` › `。
- 新增用词、连接提示、请求单复数、交还与排队/执行区别回归；保留占位符、跨区域译法一致性、动态切换语言和原始工具/第三方状态内容测试。同步已有测试中的确切中文断言，不删行为断言；本机菜单 `nativeText` 的既有文字不在 renderer 词典范围，未误改其测试。
- 原生 graphite 脚本新增实际连接提示、请求数量的中英文断言，并操作连接设置按钮验证仍能打开原对话框；两套主题、两种宽度、四态样本及源文件/构建/设计摘要继续保留。第二块截图归档保持原样，第三块另存证据。

## 验证

Step 0 实际执行（Node 24.22.1、npm 11.19.1）：

| 命令/检查 | 结果 |
| --- | --- |
| 根目录 `npm ci` | 退出 0；安装 148 包。npm 报告 2 个 moderate 审计项，并提示 cpu-features/koffi/ssh2 的安装脚本未获 allowScripts 覆盖；未追加批准、未运行 audit fix |
| `npm --prefix apps/workbench ci` | 退出 0；安装 217 包，审计 0；现有 prepare-monaco postinstall 完成 |
| `npm --prefix apps/desktop ci` | 退出 0；安装 61 包，npm 报告 5 个 moderate 审计项；现有 native-permissions postinstall 完成，未运行 audit fix |
| 读取版本内 tokens 并调用 `contrastRatio()` 的 Node stdin 脚本 | 退出 0；重算 10 个色对，相关值列在“发现”；这是数值观察，不是完整对比度验收 |
| Circle `git status --short` 与六个 package 清单/锁文件的 `git diff --exit-code` | 退出 0、无输出；Circle 跟踪文件无改动 |
| Hub `git diff --check` | 退出 0；仅本任务页有改动 |

`npm run check`、`npm run check:apps`、应用测试、原生启动、截图与打包均未执行；属于审查通过后的实施验收，不计作通过。

### 第一块验证

所有测试调用均设置临时 `CIRCLE_HOME` 与 `CIRCLE_WORKBENCH_DATA_DIR`；只使用仓库的合成资源、脚本模型和本地网关。以下各组测试有重叠，不相加成总数。

| 命令/检查 | 实际结果 |
| --- | --- |
| `node node_modules/tsx/dist/cli.mjs --test apps/workbench/test/theme.test.ts apps/workbench/test/terminal-theme.test.ts tests/desktop-palette.test.ts tests/render-colors.test.ts tests/interface.test.ts` | 退出 0；25 项通过，失败/跳过 0；规范 45 个颜色、2 个阴影、所有别名、渐变、字号均有断言 |
| `npm --prefix apps/workbench test`（最终样式修改后） | 退出 0；330 项通过，失败/跳过 0 |
| `npm run check:apps` | 退出 0；workbench 类型检查与 330 项测试通过；desktop 类型检查与 163 项单元测试通过；完整 runtime 测试 821 项中通过 804、失败 0、跳过 17；工作台构建、原生 main/preload 与本地 renderer 打包构建完成。构建仍报告大于 500 kB 的 chunk 和现有 `src/update.ts` 的 CJS `import.meta` 警告，未改相关代码 |
| `npm run check` | 首次在类型检查因新核心测试使用 `.ts` 导入退出 1，已按 Circle 的编译约定修为 `.js`；修正后整组类型检查通过，测试 1,584 项中通过 1,573、失败 1、跳过 10，退出 1，未进入 build。失败是未修改的 `tests/browser-pipe-close.test.ts`：合成浏览器启动阶段 `Browser.getVersion` 超过该测试设定的 2 秒，尚未到待验证的关闭阶段。`src/browser/chrome.ts` 与该测试相对基线 diff 为空；未判为已修复、未增加超时、未重跑求绿，需协调者另行判定 |
| `npm run build`（因整组 check 未进入 build 而单独执行） | 退出 0；核心类型编译与资源构建完成 |
| `npm run format:check`；`npm --prefix apps/workbench run format:check`；`npm --prefix apps/desktop run format:check` | 最终均退出 0；首次 workbench 格式检查指出本次改过的 `panes.css`，格式化后修正 |
| `git diff --check`；三个包的清单/锁文件与设计目录的 `git diff --exit-code` | 均退出 0；未改依赖或规范 |

核心整组的 10 项跳过（均为当前 macOS 不具备的 Windows 路径，原样保留）：

1. `a Windows browser exit queued behind its deadline is observed before reporting failure`
2. `a Windows browser still alive after deadline delivery is not reported as exited`
3. `Windows 8.3 temporary paths preserve root identity, workspace hashes and future file writes`
4. `on Windows a text file on another drive is not added to the message`
5. `on Windows the real PowerShell command runs as far as listing the windows`
6. `on Windows a window that is not DPI aware is taken whole: its picture is its own size with no empty part`
7. `the Windows helper removes the launcher and the running version once their processes end, and keeps a folder that is not empty`
8. `on Windows a program left running by an ended shell is found and ended`
9. `on Windows stopping a finished job ends a program whose parent cmd had already ended`
10. `on Windows cancelling a running command ends a program whose parent cmd had already ended`

应用完整 runtime 组的 17 项跳过（均需真实 Windows API、ConPTY、Job、PowerShell 或短路径支持；未添加 Windows 代码）：

1. `on Windows a refused outside write names the process that has the file open`
2. `Windows real ConPTY naturally exits repeated owned sessions without keeping the parent Node process alive`
3. `Windows terminal close waits for the native-exit output-flush window and preserves the complete final log`
4. `Windows TUI dark shutdown restores the main screen and cooked input before a natural exit`
5. `Windows TUI light shutdown restores the main screen and cooked input before a natural exit`
6. `the Windows installer preserves the relaunched argv through real PowerShell`
7. `real Windows Job controls an assigned quiescent Node and inherited detached child through retained handles`
8. `Windows native adapter fails before allocating a PTY without claiming shell exit proves owned tree exit`
9. `Windows original ConPTY input and resistant inherited service stop use real root exit and Job-empty facts`
10. `Windows natural completion waits for actual root ACK, wrapper exit, Job empty and original log closure`
11. `Windows supervisor cannot preload command Node options before Job assignment`
12. `Windows invalid supervisor authentication never starts a command and the quiescent original PTY closes`
13. `real Windows short-path aliases preserve CAS coordination and native folder boundaries`
14. `a save on Windows waits while another program has the file open without letting it be replaced`
15. `Windows session release observes PID birth and real exit without weakening the strict disappearance oracle`
16. `Windows signal cleanup observes the real job descendant and preserves any scratch-folder EBUSY failure`
17. `a Windows owned worker transport fault remains a durable failure and stops the real program`

四态文字、原生截图矩阵、打包原生回执与视觉审查尚未完成；本块 token/颜色数值检查不代替这些后续验收。

### 第二块验证

本轮重型检查按顺序运行。仍使用临时 `CIRCLE_HOME` / `CIRCLE_WORKBENCH_DATA_DIR`、合成工作区、脚本模型或本地网关；没有连接真实 Circle 数据、模型端点或业务系统。各组有重叠，不相加。

| 命令/检查 | 实际结果 |
| --- | --- |
| 从 workbench 包执行 `node ../../node_modules/tsx/dist/cli.mjs --import ./test/helpers/ignore-css.mjs --test test/composer-state.test.ts test/conversation-chrome.test.ts test/workspace-layout.test.ts test/i18n.test.ts` | 退出 0；16 项通过，失败/跳过 0。最初从仓库根运行时误用了 CLI 的 JSX 配置，改为应用包的工作目录后正常；没有给组件增加全局 React 依赖 |
| `npm run check` | 退出 0；1,584 项中通过 1,574、失败 0、跳过 10，类型检查与构建通过。包含 browser-pipe-close 在本轮整组中的通过；这不替代 Claude 要求的第四块结束时单独复核，也不把第一块当次失败改记为通过 |
| `npm run check:apps` | 退出 0；workbench 333 项、desktop 单元 163 项通过；runtime 821 项中通过 804、失败 0、跳过 17；类型检查和两个应用构建完成。保留现有大 chunk 与 CJS import.meta 构建警告 |
| `npm --prefix apps/workbench test`（最后的菜单事件与样式调整后） | 退出 0；333 项通过，失败/跳过 0 |
| `npm --prefix apps/desktop run build`（最终原生检查前） | 退出 0；主进程、preload 与 renderer 构建完成。初次因新测试中已完成状态字面量被推宽为 string 而被类型检查拦住，已用字面量类型修正 |
| `node apps/desktop/test/graphite-native.mjs`（最终） | 退出 0；实际开发版 Electron，16 组主题/宽度/四态样本、7 组检查、17 张截图，`packaged:false`、`errors:[]`。导航实测 232px，抽屉稳定实测 380px，内容/输入区均不超过 760px；1180px 保持分栏、1179px 收起抽屉，700px 下可通过按钮打开导航；1024×650 长草稿仍可见发送按钮；请求答复、停止/继续、草稿与 Enter 插话均有断言；减少动态效果与菜单误选防护均有断言 |
| 根目录、workbench、desktop 的 `format:check`；`git diff --check` | 最终均退出 0。首次 workbench 格式检查指出新测试的字面量类型修正尚未格式化，已修正；随后刷新原生收据，源码摘要逐项重算不一致 0 |

最终原生证据已在本机保留副本：Circle 仓库 `apps/desktop/artifacts/graphite/chunk-2-development/`。包含 `receipt.json`、16 张状态截图、额外的 `light-1440-messages.png` 和先前失败诊断；该目录被忽略，不入 Git。实际宽窗 viewport 为 1440×967（申请高度 980，由屏幕可用区约束），窄窗同样记录实际大小。收据含截图、源码、构建和设计文件摘要，不含本机路径和环境值。

原生开发过程中保留了三类失败证据并分别处理：首次抽屉宽度在布局落定前读取了临时最小尺寸，改为等候实际 panel 几何稳定后断言 380px；小于原生最小宽度的请求被宿主拦住，修正主窗口最小宽度；长草稿发送按钮越界，修正纵向收缩。均未延长超时或增加重试求绿。

本轮核心的 10 项跳过、runtime 的 17 项跳过已经与第一块日志逐个比较，名称和原因全部相同；逐项清单仍为上面的两份，无新增跳过。完整 `test:desktop`、`test:interface`、live/parallel-sessions/compaction 原生端到端脚本、打包版矩阵和最终视觉批准仍属于第四块，尚未执行；本块原生测试的真实按钮操作使用 preview 合成会话，不声称实际模型/工具执行已通过。

### 第三块验证

本轮重型检查逐组执行，全部使用临时 `CIRCLE_HOME` / `CIRCLE_WORKBENCH_DATA_DIR` 与合成数据。

| 命令/检查 | 实际结果 |
| --- | --- |
| 从 workbench 包执行 `node ../../node_modules/tsx/dist/cli.mjs --import ./test/helpers/ignore-css.mjs --test test/i18n.test.ts test/compaction-render.test.ts test/agent-activity.test.ts test/format.test.ts` | 退出 0；30 项通过，失败/跳过 0 |
| 对 20 个词典文件使用包内 TypeScript 语法树，比较第二块 HEAD 与当前值、键集合 | 退出 0；原有 2,102 个属性键保留，新增 2、删除/改名 0，201 条既有中文改写；跨区域一致性与占位符完整性另由单元测试检查 |
| `npm run check` | 退出 0；1,584 项中通过 1,574、失败 0、跳过 10；类型检查与构建完成 |
| `npm run check:apps`（首次） | 退出 1；workbench 336 项中通过 333、失败 3、跳过 0，后续 desktop/runtime/build 未开始。失败均为旧中文断言：live-runtime 和 runtime-notice 仍期待“正在重启…”，terminal-redirect 仍期待“Circle 正在使用”。已更新确切显示文字，退出码、状态对象与控制对象断言保留；修正后整组重新执行 |
| `npm run check:apps`（修正旧中文断言后） | 退出 0；workbench 336 项与 desktop 单元 163 项全部通过；runtime 821 项中通过 804、失败 0、跳过 17，类型检查与两个应用构建完成。保留既有大于 500 kB 的 chunk 与 CJS import.meta 警告 |
| 根目录、workbench、desktop 的 `format:check` | 均退出 0，无格式问题 |

核心 10 项、runtime 17 项跳过已与第二块日志逐一比较，名称与原因全部相同；逐项清单仍为第一块列出的两份，没有新增或弱化跳过。组件的 7 组受影响用例已经顺序运行、全部退出 0：`editor-ui.mjs`、`github-authorization-phase-ui.mjs`、`github-connection-ui.mjs`、`github-plugin-ui.mjs`、`github-sidebar-status-ui.mjs`、`original-browser-shell-ui.mjs`、`overview-cards-ui.mjs`。调用包内 `runComponentSuites({ suites: [...] })`，通过原有 runner 保留逐组状态、退出码、截图与诊断，不是完整组件组；没有超时或跳过。证据位于 Circle `apps/desktop/artifacts/graphite/chunk-3-components/attempt-eqmtar/`（忽略目录，不入 Git）。这些是 Chromium 组件检查，与下述实际 Electron 原生检查分开记录。

| 原生命令/检查 | 实际结果 |
| --- | --- |
| `CIRCLE_GRAPHITE_EVIDENCE_DIR=apps/desktop/artifacts/graphite/chunk-3-development CIRCLE_WORKBENCH_LANGUAGE=zh-CN node apps/desktop/test/graphite-native.mjs` | 退出 0；开发版实际 Electron，16 个样本、9 组检查、17 张截图，`packaged:false`、`errors:[]`；两套主题、1440/1024 宽度下的等待行和连接设置按钮全部为中文，等待请求行为“1 个请求等待处理” |
| 同一原生命令，语言设 `en`，证据目录设 `chunk-3-english` | 退出 0；16 个样本、9 组检查、17 张截图，`packaged:false`、`errors:[]`；两条连接文字与请求数量仍显示原英文 |
| 两份收据内的源码、构建、设计文件和截图摘要逐项重算 | 每份核对 3,697 项，不一致均为 0；原生检查前已完成格式化和最终应用构建，之后没有改动收据涵盖的源码/测试 |
| `git diff --check`；核心 `src/`、三份包清单/锁文件和设计目录的 `git diff --exit-code` | 均退出 0；没有改终端、依赖、锁文件或规范 |

已打开检查中文 `dark-1440-working.png`、`light-1024-attention.png`、`light-1440-plan.png` 与英文 `dark-1024-working.png`；两条中文连接提示、请求数量和较长状态行可见，输入区与操作保持在窗口内。截图中的英文对话、计划项、命令、模型名，以及预览合成的非 ISO 时间 `today` 是数据原值；`model/time.ts` 对非时间戳按原值展示，不把它作为缺失翻译或伪造为实际时间。

证据各自独立写入 Circle 的 `apps/desktop/artifacts/graphite/chunk-3-development/` 与 `chunk-3-english/`，包含收据和全部截图；不覆盖第二块归档，不入 Git。连接设置按钮实际打开原对话框；已有四态、停止/继续、Enter 插话、草稿、窄窗和减少动态效果断言继续通过。这些预览合成检查不证明真实模型/工具执行；打包版、完整原生运行时验收与 `browser-pipe-close.test.ts` 最终单独复核仍留在第四块，等待第三块审查后开始。


### 第三块审查修正（来源：Claude 本轮交接）

- Claude 指出设计 README 的中西文间距条文有误，由 Claude 修改规范：中文与拉丁字母、数字、占位符之间保留一个空格。本轮以该明确决定为准，不改规范。两条终端提示恢复“Circle 正在使用终端 {n}”“Circle 正在使用“{name}””，不把 using 改成控制。
- “等待××中”只表达排队、审批、回应、重启、重试等等待状态。Circle 正在做的工具执行、读取/编辑/搜索、合并、压缩、恢复、加载/保存等恢复“正在××”；Composer 已批准的“等待 Circle 完成中”是操作者等待 Circle 的提示，保留。
- 重新逐条核对第三块的 201 条改词和两条新增提示；恢复间距及主动/等待区别，并补齐词典扫描发现的 4 条既有占位符间距。请求数量、“等待回应中”、两处 `t()`、其他已批准的用词继续保留。
- i18n 回归新增全词典的中西文/数字/占位符边界检查，同时覆盖主动工具组与排队工具组、压缩/恢复、授权、重启/重试及 using 的准确含义。相关中文断言同步恢复，原有实际效果检查保留。
- workbench 全组退出 0：337 项通过，失败/跳过 0；最后补充精确单空格断言后，i18n/压缩呈现/终端重定向 14 项再次通过。desktop 的 `node --import tsx --test test/github-notice.test.ts` 退出 0，3 项通过。词典键集合未变，本次共修正 14 个词典文件中的 103 条译文。
- 原有 7 组受影响组件用例均已通过：第一组运行的前 5 项（editor、GitHub 授权阶段/连接/插件/侧栏）通过；修正下述断言和面板名称定位后，original-browser-shell 与 overview-cards 通过。保留各次收据：`apps/desktop/artifacts/graphite/chunk-3-correction-components/`、`chunk-3-correction-components-final/`、`chunk-3-correction-components-complete/`。
- CV-1（测试检查方法）：original-browser-shell 以浮点 DOMRect 严格等于 26px 判断按钮，实际为 26.000015px。改为计算样式精确等于 26px/26px/6px，同时实际宽高必须在 0.001px 内；没有延长等待或重试。修正后的首次运行到中文面板时因新增占位符空格发现定位仍为“浏览器面板”，已同步为“浏览器 面板”，后续完整通过；未更改行为断言。
- 扩展到另外 3 组面板组件时，terminal-mode 在关闭菜单后找不到加号：现有 Escape 事件冒泡还会关闭抽屉（CV-2，产品问题），不属于改词；browser-chrome 与 overview-actions 在 runner 中因此尚未开始。第四块处理该事件边界并继续执行，不把本次失败或未运行写成通过。


第三块修正的 Circle 本机跟进提交：`89ae2b98`（`Correct Chinese spacing and distinguish active work from waiting`，已签署），未推送。原 `e3b16e51` 保留为审查前记录；其关于主动进度和无空格的描述由本轮 Claude 决定及此跟进覆盖。

### 第四块进行记录

- 按 Claude 本轮明确要求继续原生开发版和本地打包应用验收；仍使用隔离目录与合成资源，顺序运行重型检查。额外扩展 graphite 原生检查，覆盖 auto 动态跟随、长项目路径/模型标识、工具展开详情和 Node/Electron/Chromium 版本记录。
- CV-2 已定位到原有 workspace-content 与 inspector-resource-host 的 Escape 处理器：React 门户菜单的键盘事件会经 React 树冒泡到面板。处理器现仅接受自己 DOM 内且未被消费的 Escape，门户菜单保留自己的关闭语义；终端模式组件增加“关菜单后抽屉仍开启”的断言。
- 该断言通过后，terminal-mode 的下一检查用立即 `count()` 判断连接表单卸载，在新关闭动效尚未结束时读到 1。改为等待实际 detached 状态后仍断言 0；未增加超时或固定睡眠。保留失败证据 `chunk-4-panel-regressions/`，组件检查继续。

- CV-2 的终端菜单断言与完整 terminal-mode 组件流程现已通过。连接表单的退出动效检查改为等实际卸载，保持原动作和调用参数断言。
- browser-chrome 的旧“完整视图”样本使用 1060px。新规则下它属于窄窗覆盖层，本来就不显示完整视图按钮；单等布局落定不能改变这个契约。将完整视图样本改为 1280px（分栏样本仍为 1500px），保留按钮和退出全屏、工具栏边界等断言；窄窗覆盖层仍由 original-browser-shell 和本轮原生矩阵覆盖。所有失败诊断保留在对应忽略目录中。

- 原有 7 组之外新增的 terminal-mode、browser-chrome、overview-actions 组件检查均已通过；workspace-shell 也完成深浅主题 × 290/500/1280px 六组几何观察及两语言下全部模式截图。`overview-actions` 的动态面板名称定位同样补入占位符空格。
- workspace-shell 的原断言仍期待概况与会话同底色、浅色导航为白色，现改为从调色板解析导航/会话/抽屉的实际 CSS 色并逐层核对；两层必须有区别。原几何稳定检查只比较宽度，改为在原 40 次帧检查内同时比较 x/y/宽/高，未延长等待，未稳定时明确失败。
- CV-3（样式遗漏）：旧 `panes.css` 中针对 files/terminal/browser 的 `.inspector:is(...)` 优先级高于 graphite 的通用 `.inspector`，使这些模式外层仍用会话底色。新增同等优先级的 `.inspector.work-drawer` 规则，最终这些模式外层统一 `surface-2`，组件实际颜色断言通过；新增原生抽屉实际底色与 `--drawer` 解析色相同的检查。
- 本轮 `npm run check` 退出 0：1,584 项中通过 1,574、失败 0、跳过 10，类型检查与核心构建通过。原生构建和后续应用/打包检查继续。

- 扩展原生矩阵首次到长模型 ID 菜单时明确失败：1024px viewport 内菜单实测约 2792.43px 宽，发送操作仍在视口内；失败截图和诊断保存在 `apps/desktop/artifacts/graphite/chunk-4-preliminary/`。CV-4（产品问题）：模型菜单缺少最大宽度。已将该菜单限制为不超过 480px 和窗口可用宽度，单行长 ID 用省略显示，当前模型及选项的 title 保留完整 ID；原生检查也实际选择另一模型。没有截断传给运行时的模型标识，未新增依赖。
- 含 CV-2/CV-3 修正的工作区组件六组尺寸观察最终全部通过，证据保存在 `chunk-4-shell-surfaces/`。两次原生构建均退出 0，保留既有大 chunk/CJS import.meta 警告；CV-4 的原生复核继续。

- 开发版完整 `npm --prefix apps/desktop run test:desktop` 退出 0（约 105 秒），包含宿主、浏览器各专项、终端、GPU 开/关弹窗与 Anthropic/OpenAI 两种协议的模式工具配对；配对各记录 5 次实际请求及原始检查点不变等检查。原生矩阵含 CV-4 修正后的首次复核退出 0：16 样本、12 检查、`errors:[]`，已查看长 ID 窄窗截图。
- `test:interface` 的旧请求按钮定位未包含新增的 view 文本，现同步完整无障碍名称，不移除审批记录与任务仍运行的断言。后续取消工作区删除检查在内层对话框退出、外层设置仍暂时 aria-hidden 时过早取 count；改为等项目行实际可见后仍断言存在。
- CV-5（产品问题）：界面流程在首页连续切换菜单时，项目菜单 End 键焦点被抢。隔离原生观察区分两种输入：单独开项目菜单正常；选择思考深度后立即开项目菜单，End 先聚焦 no project，随后旧菜单退出回调把焦点移回 message，使新菜单关闭。修正 Composer 与 Home 共用的关闭焦点处理：若另一个菜单/对话框已经打开，不移动焦点。相同隔离操作修正后保留 no project 焦点，原生 graphite 新增跨菜单退出的回归。前后观察保存在 `apps/desktop/artifacts/graphite/chunk-4-focus-probes/`；没有用重试或延长超时替代修正。
- 开发版完整界面及剩余原生流程从新目录继续；首次各类失败、未开始项仍保留，不覆盖早先通过的完整桌面证据。

- CV-5 相同隔离原生步骤的修正后记录确认：End 后 no project 焦点保持，没有再出现旧退出回调把焦点改为 message 的事件。原生完整界面复核已经越过此处，随后“选择无项目”用例的立即 textbox count 在项目菜单退出动效结束前读到 1；改为等 `.project-menu` 实际 detached，保留输入字节与焦点、搜索框不存在的断言。

- 开发版界面最终完整通过：`test:interface` 47 个命令、87 项检查、`errors:[]`；1024px 的 desktop 主流程 23 项检查、界面同为 47/87，全部退出 0。证据在 `chunk-4-native-development/attempt-resume-4/`；完整 desktop 组早先的通过保存在该 variant 根目录。
- live 组的原品牌断言只有 circle，现按已批准设计分别断言 `.brand strong` 为 circle、`.brand small` 为 workbench；应用名称和窗口标题仍严格为 Circle。随后核心 live 25 检查、8 组设置语言/主题/宽度切换、浏览器 29、坐标 5、UI 回归 6 均通过。托盘明确跳过：macOS 保持 Dock，此平台托盘不隐藏窗口，原脚本条件未改。
- 会话管理在关闭菜单后立即数节点，观察到唯一节点 `data-state=closed`、opacity 正在退出；改为等实际卸载，保留 B 会话切换与菜单不存在断言。修正后该专项、并行会话、网络、搜索、连接和重启专项均退出 0。继续完成状态、思考和压缩；整组后续将作完整确认，历史失败不改写为通过。

- live 剩余专项分段复核完成：会话管理、并行会话、网络、websearch、连接、重启、completion（8 检查）、thinking（6 次请求、4 项效果检查）均退出 0。完整 live 组的最终确认待下一步执行，先前整组失败仍保留。
- 压缩专项最初因“所有 turn-clock 都应为 0”的旧断言失败；已批准的工作中输入区新增的是 elapsedOnly 计时器，不是第二条压缩状态。将检查改为全页时钟只能等于底栏内至多一个时钟，且底栏不得重复压缩/合并/恢复文字或 token/用量；原压缩状态唯一性、对齐和宽度检查保留。修正后 `test:compaction` 退出 0，6 项检查、`packaged:false`，保留实际取消、恢复/重启与中文状态验证。

- 本轮 graphite 扩展检查最新预验收退出 0：中文开发版 16 个四态样本、13 组检查（含 CV-5 连续菜单焦点回归），另保留展开抽屉、长路径/模型与工具详情截图。已人工查看深色抽屉和浅色工具详情，外层底色与布局符合本轮目标；最终源文件冻结后的正式矩阵及打包版仍待执行。
- 查看工具详情新场景又发现预览专属的 sample record 直接写在 JSX；现接 `t('sample record')`，中文“示例记录”，工具 ID 和原始输出不改。预览对话框的 frontend preview 标题也接已有词典项；英文原文不变。原生工具详情检查增加中文/英文对应断言，最终词典只比第三块修正再新增这 1 项。

- 开发版完整 `npm --prefix apps/desktop run test:live` 最终确认退出 0，约 215 秒；15 个脚本路径全部完成，其中 tray 按 macOS 原条件跳过。完整成功证据在 `apps/desktop/artifacts/graphite/chunk-4-native-development/attempt-live-final/`；分段排查的成功与失败目录全部保留。最终 check:apps 与格式检查进行中，随后冻结代码并生成本地包。

- 最终 `npm run check:apps` 退出 0：workbench 337 项、desktop 单元 163 项全部通过；runtime 821 项中通过 804、失败 0、跳过 17，两应用类型检查与构建通过。根目录、workbench、desktop 的 format:check 均退出 0；依赖/锁文件、核心 src 与设计目录 diff 为空。后续只生成本地包和正式矩阵，再更新验证文档及交接。

- 第四块修正与原生回归的 Circle 本机提交为 `fa905204`（`Preserve graphite panel surfaces and menu interactions`，已签署）；代码工作树已冻结且干净。包括 CV-2/CV-3/CV-4/CV-5、两处补充预览翻译、实际状态/几何等待与按批准视觉契约更新的断言；未推送。
- `CIRCLE_DESKTOP_OUTPUT_DIR=apps/desktop/out/graphite npm --prefix apps/desktop run package`（运行时使用同一目录的展开路径）退出 0，生成本地 Circle.app 和约 251MB 的 DMG；ad hoc 本地签名、严格校验完成，没有公证、发布或安装到 Applications。已有 .icon 格式缺失提示和 hdiutil 命令弃用警告保留，无 hdiutil 重试。
- 逐个复算打包收据中的产物哈希，并从实际 ASAR 提取 dist 文件与本次构建清单逐个比较，均无不一致。打包版原生完整流程已启动，待记录最终检查数、正式矩阵和文档。

- 打包收据 2,571 个产物哈希重算一致；实际 ASAR 内 2,612 个 dist 文件与当前构建逐个比较相同，不一致 0。DMG SHA-256 为 `3ae48fc4aeb0e8831a3df62fbb53de4c00357d33aea9597d96781d2d1ce1503f`，ASAR 为 `2b93a6dbd780b9b1d100063a2159a5dc8b4e8a854e79d953d2d2f8bc3250a845`。
- 打包版 `test:desktop`、`test:interface` 以及 1024px desktop 主流程均退出 0；界面仍为 47 个命令、87 项检查，宿主为 23 项。正在完成窄窗界面、完整 live 与压缩。
- 打包 desktop 组原有 5 项跳过逐项保留（未修改 guard）：`browser-page.mjs`（打包由 browser-live 检查）、`browser-lifecycle.mjs`（同上）、`browser-key-race-native.mjs`（原说明指向 popout，但不把替代说明当作该用例通过）、`terminal-panel.mjs`、`popout.mjs`。后两项虽输出“needs a desktop-capable session”，本次实际由 `CIRCLE_DESKTOP_EXECUTABLE` 的既有分支触发，不是无桌面。完整开发版这 5 项已实际运行通过；打包版 popout-press-native 另有实际流程，但不等同于整套 popout GPU 双模式用例。Mac tray 跳过另单独记录。

- 打包版完整原生批次全部退出 0：desktop 约 56 秒、interface 约 37 秒、1024px desktop 约 14 秒、1024px interface 约 36 秒、完整 live 约 215 秒、compaction 约 49 秒。宽窄界面各 47 命令/87 检查，主宿主各 23 检查；live 核心 25、压缩 6，回执均为 packaged:true。5 个 desktop 与 1 个 tray 的既有跳过按上述范围保留。证据在 `apps/desktop/artifacts/graphite/chunk-4-native-packaged/`。
- 源码 fa905204 冻结后的正式四轮矩阵正在执行：开发/打包 × 中文/英文，每轮 dark/light × 1440/1024 × 四态；另外保存消息、展开抽屉、长标识、工具详情。正式收据增加真实 Node/Electron/Chromium 版本及打包 ASAR 摘要，不含个人本地路径或环境值。

### 第四块最终结果与交接

四轮正式矩阵均已完成、退出 0：开发/打包 × zh-CN/en，每轮 16 个四态样本、13 组检查、20 张截图，`errors:[]`；共 64 样本、80 张本机原图。全部使用冻结源码 `fa905204` 和同一构建。实际 Electron 44.9.1、Chromium 152.0.7977.167、应用 Node 24.22.0、runner Node 24.22.1，macOS arm64。申请高度 980px，由屏幕可用区限制，实际各样本 965/967px，收据逐项记录实际 viewport；宽度为 1440/1024px。

四轮收据共享 1,064 个源码、2,612 个构建和 4 个设计文件的摘要清单。重新计算这 3,680 项、80 张截图和 11 张入 Git 的原样副本，摘要不一致均为 0；两份打包矩阵的 ASAR 摘要与打包原始收据一致。原生执行结束后再次核对 2,571 个产物、ASAR 中 2,612 个 dist 文件以及严格 codesign，全部通过。代码、依赖、锁文件和设计文件在冻结后未变，后续只提交文档及证据。

人工打开检查了开发及打包代表截图：中文深色工作中、浅色计划/待回应、英文窄窗工作中、抽屉、长标识及工具详情；最终打包版工具详情显示“示例记录”。这属于人工查看结果，Claude 最终视觉批准仍待审查。浅色品牌框仍按已批准的外层 surface-1 测量，蓝色 3.14:1、橙色 3.12:1，状态有文字；没有改 token。

| 最终检查 | 实际结果 |
| --- | --- |
| `npm run check` | 退出 0；1,584 项中通过 1,574、失败 0、跳过 10，类型与构建通过 |
| `npm run check:apps` | 退出 0；workbench 337、desktop 单元 163 全部通过；runtime 821 项中通过 804、失败 0、跳过 17，类型与构建通过 |
| 三个包的 `format:check`、`git diff --check` | 均退出 0；核心 10 项和 runtime 17 项跳过与前块的名称/原因逐项一致，未新增或弱化跳过 |
| 受影响组件 | 共 11 个不同专项通过，包含 workspace-shell 的深浅主题 × 290/500/1280px 六组几何及中英文模式；不是完整组件组 |
| 开发和打包的原生流程 | 各自完整 desktop、interface、1024px desktop/interface、完整 live、compaction 均退出 0；宽窄界面各 47 命令/87 检查、宿主各 23、live 核心 25、压缩 6；保留前文逐项列出的 5 项打包 desktop 与 macOS tray 跳过，不把它们记为通过 |
| 最后单独执行 `node node_modules/tsx/dist/cli.mjs --test tests/browser-pipe-close.test.ts` | 在独立临时 home/data 下退出 0；1 项通过、失败/跳过 0，约 1 秒。运行前 load 为 4.74/6.36/5.90，本任务其他测试已结束；原 2 秒超时未变。第一块的负载相关超时仍保留原记录，不改写为通过 |

Circle 新增 `docs/workbench/graphite-validation.md`，由旧 validation/native-runtime 文档链接；旧计数、历史收据保留。`docs/workbench/validation/graphite/` 保存四份矩阵收据、共享源码/构建摘要、11 张代表原图、最终检查及逐项跳过、包含历史失败的 native 命令摘要、打包原始收据和最终完整性结果。JSON 逐份解析并检查无本机绝对路径，文档链接全部核对存在。全部 80 张原图与诊断仍在前述本机忽略目录，没有覆盖第三块或失败记录。

本轮本机提交（均已签署、未推送）：

- 第三块修正：Circle `89ae2b98`，`Correct Chinese spacing and distinguish active work from waiting`。
- 第四块代码与原生回归：Circle `fa905204`，`Preserve graphite panel surfaces and menu interactions`。
- 第四块文档、截图与收据：Circle `6d8c2779`，`Record graphite desktop validation and packaged evidence`；该提交只有文档/证据，收据绑定的源码仍为 `fa905204`。
- 本页只在 Hub `circle-visual-notes` 交接分支提交；未修改 Hub 代码、设计规范或任何其他任务文件。

已完成本轮授权的实现与本机验证，等待 Claude 审查第三块修正及第四块结果。不推送、不建 PR、不安装到 Applications、不公证或发布；其他操作系统、真实模型服务和生产设备兼容性不由本轮合成检查推断。

### PR #405 的 CI 回修（2026-11-03，修复与验证结果）

来源：Claude 本轮交接，Circle workflow run `41486669382`；通过 `gh run view --json headSha,status,conclusion,jobs` 核对失败提交确为 `ee7466ed13584e1df6ca75b7f5cfeeeeea5947fc`。代码只在 `circle-visual` / `workbench-graphite-local`，记录只在本页；决定 139 两个工作树已检查为干净提交点，没有 stash 或未完成改动。

- 已获取实际 CI 失败日志和上传证据，保存在 Circle 忽略目录 `apps/desktop/artifacts/graphite/ci-41486669382/`。第一次整组 artifact 下载在 shard 2 的 ZIP 传输中遇到 unexpected EOF；仅重新下载该 artifact 后成功，不把网络下载失败算作测试重跑。未重新运行 GitHub workflow、未推送或评论 PR。
- 既有本机证据确实只跑过受影响的 11 个组件专项，不能当作完整组件组通过。此次先运行未修复源码的完整组件 runner，前 7 项通过，第 8 项 settings-dialog 在原有“the dialog is inside the window”失败，保留 `ci-405-baseline-components/`，后续未运行项不记通过。
- 未修复源码重新构建并运行完整 native developer journey，开启与 CI 相同的 WEB_DEBUG / DIAGNOSTIC / PUSH（这里 PUSH 是浏览器调试投送，不是 Git push）。macOS arm64 开发入口 26 个阶段全通过、errors 为空；证据 `ci-405-native-baseline/`。这不覆盖 Ubuntu 的失败，必须结合 CI 真实回放和可控事件次序复现。

本轮逐项分类与处理：

1. **CV-6，旧布局断言**：large-file-tree 在 800px 窗口要求 overlay 宽至少 790px；CI 原图实际为 760px，文件、右侧索引和侧栏折叠均正常。已批准的 graphite CSS 将文档覆盖层限制为 `min(100%, 760px)`。将宽度改为精确核对该公式（1px 几何容差），保留侧栏折叠、索引显示、600px 隐藏索引、文件和会话归属等所有检查；不延长原 10 秒等待。原断言在本机同样超时，证据 `ci-405-repros-before/large-file-tree-ui.mjs/`。
2. **CV-7，产品动效错误**：通用 graphite-enter/exit 改写 `transform`，覆盖 `.dialog-content` 原来的 `translate(-50%, -50%)` 居中。CI 最终截图已恢复居中，掩盖了动效阶段；新增实际 CSS 动效固定进度采样，修复前 1280×800 的起点实测 x=648.10、right=1711.90、bottom=1080.90，明确越窗。最终用 `--graphite-position` 在 keyframes 中组合原有居中与 6px/1.5% 动效；原窗口内断言不放宽，新增进入/退出各进度的四边界检查。首修的独立 translate 方案因 CV-17 的生产构建回归已撤换，详情和失败证据见后文。
3. **CV-8，产品快捷键错误**：agent-source-return 的 quick-open 已完成选择，但仍保留关闭动效；全局 Ctrl/Cmd+K 见到任意 `[role=dialog]` 就拒绝，因此快捷键被已关闭的对话框吃掉。CI trace/最终 DOM 无新的搜索对话框；本机暂停真实退出动效后可确定复现。快捷键只由 `data-state=open` 的对话框阻挡，关闭中的对话框可以重新打开搜索；四个主题/宽度用例显式覆盖该次序，仍检查本人/子代理来源、阅读位置、草稿和跨会话隔离。
4. **CV-9，产品终端焦点错误**：CI 两个 PTY 失败的实际回放只有命令前缀。新 shell 已取得 xterm 焦点，但 + 菜单退出完成后 Radix 默认把焦点还给按钮，后半段输入和 Enter 丢给了按钮/菜单；随后菜单还能使健康探针无法点击，导致独立阶段被阻塞。快速 macOS 基线输入能抢在退出前完成，所以需要改变可控事件次序而非增加等待。新增测试 helper 暂停真实 CSS exit，先发送前半段，再完成 exit 并观察 FocusScope 事件后的真实焦点；修复前焦点确定离开 `terminal-terminal-5`。终端两个菜单在 xterm 已持有焦点时阻止默认回焦，创建失败或尚未接过焦点时保留原默认行为；Find/连接的显式焦点处理保留。组件同时核对完整写入字节，native journey 将同一事件次序应用于原实际 PTY 检查，继续要求原 echo 与 600 行真实输出。

受控复现最初用 getByRole 查询被关闭中 modal menu 暂时 aria-hide 的背景 tab，因此先在创建后等待 tab 处停住；已将“刻意暂停退出期间”的定位改为 includeHidden，并在真正退出后保留原可访问 tab 的检查。修正后的复现才用于证明 CV-9 焦点错误，不把该定位问题说成产品故障。所有原失败与此诊断均保留在独立目录，不覆盖历史截图或变基前回执。


补充发现与验证：

- CV-7 同时影响 `.toast`：原有 `translateX(-50%)` 也被 graphite-enter 覆盖。让 notice fixture 加载与产品一致的 graphite 样式后，800px 窗口起点实测 left=402.59、right=743.30，中心偏到约 573px；最终也在共享 keyframes 中组合水平居中，实际动效进度采样与原有计时/跨会话通知检查均通过。第一次采样因 fixture 只加载 app.css 而没有动画，先补齐产品样式再复现，不将无动画的测试错误算作产品故障。
- **CV-10，需要的检查测量不可靠**：第一轮修复后完整组件运行在 editor 首项失败。trace 的 save HTTP payload 确认字节就是期望的 held-save 草稿，并非提交了旧草稿。保存 helper 每 3 秒复核一次按钮；它只认 `save`，而正在保存的同一个按钮已改名为 `saving file`，查询会阻塞后续磁盘观察，和主流程等待 observedWritten 互相卡住。现在持续定位该按钮的两个真实状态，保留原截止时间、完整磁盘字节及“回复结束才完成”的断言；同时捕获并等待后台 helper 的拒绝，清理时释放挂起的合成回复，避免浏览器关闭错误遮住原始失败。独立 editor 流程已完整通过。首次完整运行失败的 `ci-405-complete-components/` 保留，不改写为通过。
- 受控回归 `ci-405-repros-after/` 已完整通过 terminal-mode、large-file-tree、agent-source-return（深浅 × 1280/375）与 settings-dialog。notice 的计时和实际动效补充检查在 `ci-405-notice-after/` 通过。开始第二轮完整组件组；所有重型检查顺序运行。


第二轮完整组前 20 项通过，第 21 项 native-editable-shortcuts 在 macOS 的复制事件处失败（`ci-405-complete-components-final/attempt-9GtZzR/`），其后尚未运行：

- **CV-11，需要的检查测量不可靠（平台按键）**：会话 DOM 选区的最后一步声称使用平台复制键，实际固定发送 Control+C。macOS 上该键没有被 Circle preventDefault，草稿也保持不变，但系统复制应是 Command+C，故不会产生期待的 trusted copy 事件；Ubuntu 同项已通过。保留 Control+C 不清空草稿且不被拦截的检查，再在 macOS 发送 Meta+C，核对真实 trusted copy 事件与完整选区字节；clipboard 仍在 copy 事件中 preventDefault，绝不写宿主剪贴板。没有延长原 30 秒等待或减少断言。
- CV-8 的最终选择器仅排除明确 `data-state=closed` 的 dialog：证书/更新用的手写 dialog 没有该属性，仍保留原快捷键阻挡行为。agent-source-return 增加无 data-state dialog 的回归，避免修复关闭动效时扩大快捷键范围。


第三轮完整 runner 前 28 项通过，第 29 项 runtime-wait 的中文预期仍是“Circle 仍在处理 custom-command”，实际词典已按 Claude 的主动执行规则使用“Circle 正在处理 custom-command”。**CV-12（旧文案断言）**：仅同步这条预期，保留 9 秒事实、原始失败细节、无 retry、复制/关闭及首页卡片等八组行为检查；不改产品或超时。用基线词典差异扫描所有组件/原生测试的旧中文片段，剩余命中均为已同步的面板空格、授权状态或未变的文字片段，没有再发现完整旧文案。先从第 29 项继续检查尚未执行的 39 项，发现问题后逐项修正，再做最终整组确认；失败收据 `ci-405-complete-components-reviewed/` 保留。


续跑在原第 32 项 workspace-layout 停止：

- **CV-13（旧布局断言）**：该测试要求宽窗并列显示概况与终端，形成四栏；approved WorkbenchShell 和现有 `workspace-layout.ts` 明确是概况/模式共用第三栏。现在精确检查模式打开时替换概况、初始第三栏 380px、拖动到 300px 下限及会话 420px 下限、关闭模式恢复概况、主动关闭/显示概况、键盘调整及再次打开保留宽度。保留终端 DOM、输入 DOM/完整草稿/选区、阅读位置、文件来源/手动侧栏选择及窄窗覆盖层等检查。900px 文件覆盖层也从旧“至少 890px”同步为设计的右对齐 760px 上限，仍核对边界和侧栏恢复，不改产品布局。
- **CV-14（需要的检查测量不可靠）**：同步布局后，窄窗刚打开 overlay 的首帧仍在 6px 滑入动效，原测试便立即要求最终边界。改为等待该节点的实际 Animation.finished 再读取几何，保留原最终边界及原 6 秒状态截止；移除一个只返回 Function 对象、实际未判断任何状态的无效预等待。没有新增固定睡眠、超时或重试。
- 修正后 workspace-layout 深浅两主题完整流程通过，证据 `ci-405-layout-settled/`；首次同步布局后在动效边界失败的证据仍保留 `ci-405-layout-after/`。继续运行原第 33–67 项，最终再确认标准全列表。


续跑至原第 40 项 native-terminal-tabs 时，在窄窗 A→B→A 切换失败。**CV-15（需要的检查测量不可靠）**：chooseSession(B) 点击后会关闭导航 dialog，测试只凭 sidebar 可见便马上 chooseSession(A)，点击落在仍 visible、正在退出的旧导航中，随后节点 detached。失败最终 DOM 已是 B 且 dialog 为 0，trace 显示 A 节点从移动到卸载；不是 A 的终端列表重载出错。现在每次切换都等实际目标路由与含 sidebar 的 dialog detached，使用原默认时限；仍实际点击导航、切回原会话并验证 terminal.list 次数增加、选中 ID/名称/稳定顺序/完整写入及进程状态。保留失败 `ci-405-remaining-components-tail/`，专项复核进行中。


CV-15 的专项复核完整通过：主流程 6 组、服务/不可连接等 12 组，共 32 张截图，证据 `ci-405-terminal-tabs-after/`。后续原第 41–59 项均通过；第 60 项 files-git-marks 的颜色断言失败。

- **CV-16（旧 token 断言）**：已批准的第一块将 Git 修改文件名及 M 字母映射到 status-warn-text，新增文件名及 A 字母映射到 status-pass-text；旧用例仍比较 attention（area-task）和 accent（area-knowledge）。现比较实际解析的警告/通过文字 token，并新增两个字母标记的颜色检查；未改调色板、生产 CSS 或删除 Git 请求归属/隐藏不请求/删除文件不显示等行为检查。普通文件还必须既非警告文字也非通过文字色。保留原失败 `ci-405-remaining-components-last/`，从该项继续最后 8 项。


最后八项（files-git-marks、drawer-auto-open、overview-cards、notice-timers、tool-summary-line、git-changes-refresh、plan-review、terminal-tab-menu）均通过。连同前述收据，目前分段已实际覆盖全部 67 个不同专项，未把未运行项记为通过。已冻结最终代码并启动标准全列表的最后确认，之后顺序执行 npm run check、npm run check:apps、开发版 native journey、本地隔离目录打包及打包版 native journey、三个格式检查与 git diff --check；任何一步失败即停，没有自动重跑。Circle 的 AGENTS.md 要求开发版和打包版都验证，因此本轮也重跑新包，不借用变基前旧包的通过结论。


最终标准 `npm --prefix apps/workbench run test:components` 已退出 0，67/67 专项通过（不是仅分段汇总）。完整收据 `apps/desktop/artifacts/graphite/ci-405-verified-components/attempt-FgrPyD/receipt.json`；页面、trace、每项日志和截图位于同一 attempt 内。冻结清单含 1,431 个源码/测试/依赖文件，`ci-405-source-manifest-final.json` 的 SHA-256 为 `223070b3ee940967d2e5cd64b3a73d3058760b356be212a5cd6a0f5543d56ef0`；最终整组过程中重新核算为 0 项字节不一致。后续检查继续使用同一冻结清单，每步前都复核，不混用旧包或旧源码。


第一轮冻结验证：npm run check 退出 0（1,592/通过 1,582/失败 0/跳过 10），check:apps 退出 0（workbench 337、desktop 单元 163 全过；runtime 821/通过 804/失败 0/跳过 17，类型和构建通过）。两组跳过逐项名称/原因与旧 checks.json 完全一致。

但开发版 native journey 最终是 **21 通过、5 失败、0 blocked**，不能记为全通过；验证链退出 1，打包和格式步骤尚未开始。原始 stdin 和 600 行部分断言已经完成，随后 start service 按钮越窗，整个终端生命周期阶段失败；该阶段未完成清理又造成后续手动 PTY 数量 3≠1，另有 GitHub 设置按钮和两项主题切换失败。`ci-405-native-final/` 的失败收据、阶段截图与进度保留；先前口头把部分断言通过说成整个阶段通过已纠正。

- **CV-17（CV-7 首修方案引入的生产构建回归）**：Vite 开发服务保留新增独立 translate，但生产 CSS 输出中 translate 被移除，transform:none 仍存在，导致弹窗稳定位置反而失去居中。已直接核对构建 CSS 与原生失败截图，不归咎于原生输入或增加点击等待。改用 --graphite-position 保存每类弹层的定位变换，在进入/退出 keyframes 中始终组合该定位；静止时保留原有 app.css 的 transform。普通 menu/popover 显式重置该属性，避免从父 dialog 继承居中。此方案使用既有 transform，不改依赖、构建配置或设计动效的时长/位移。先重建并检查生产 CSS，再运行完整 native journey 验证；之后重跑受 CSS 影响的整组组件与应用检查。核心 src/tests/脚本未再修改，先前 root check 仍单独保留为已执行的真实结果。


CV-17 修正后重新构建退出 0，直接检查 production CSS 确认 --graphite-position 及 enter/exit 中的组合 transform 均保留。完整开发版 `npm --prefix apps/desktop run test:journey` 在 `ci-405-native-centered/` 退出 0：26/26 阶段通过、0 failed/blocked、errors:[]；之前五项失败均消失，原 PTY stdin、600 行和真实服务就绪/停止/重启检查完整保留。开始第二份冻结清单（v2）上的标准 67 组件、check、check:apps、隔离打包、打包版完整 journey 与格式检查。新旧收据分目录保留；应用再次构建后还会将 main/preload/runtime-worker/renderer index 四项产物摘要与这次开发版 receipt 对照，避免在开发检查后悄悄换包。


CV-17 修正后的第二份冻结清单包含同样 1,431 个文件，`ci-405-source-manifest-v2.json` 的 SHA-256 为 `2fe38202019e720aaf835ca440595ad9c106e1434291df6b3b9e6d21a7e95498`。该版本标准完整 67 组件再次退出 0（完整收据 `ci-405-verified-components-v2/attempt-m0IAvr/receipt.json`），不是使用先前 translate 方案的通过结论。随后 check/check:apps 继续顺序执行；与前次冻结相比只改 graphite.css 的定位实现，所有失败、开发版原生通过与旧清单仍保留。

第二轮冻结的 check/check:apps 均退出 0，数量仍为 1,592（1,582 过/10 跳过）及 337+163+821（804 过/17 跳过），两组跳过名称/原因逐项一致。四项主产物与开发版原生通过收据摘要相同。隔离输出 ci-405 的打包退出 0，ad hoc 签名与严格校验通过，DMG 已生成；但打包版完整 journey 为 24 通过、2 失败，未记作通过，格式步骤尚未执行。

- **CV-18（产品焦点/选区竞态）**：服务创建实际 label 变为填入的 Node 路径，而 command.file 仍为默认 npm，因此进程 exit 1 未就绪。Modal 的双层延迟聚焦会无条件把已选择的可执行字段改回首字段；真实 fallback 在第二字段已填写后执行的确定性组件回归，修正前失败。仅保留字段焦点还不够：菜单退出默认回到触发按钮，Modal 再抓回输入时会全选，下一段字符覆盖整条路径；新增完整字节断言又确定失败（只剩追加的文字）。最终保留已交互字段/选区，并在终端菜单退出时尊重已经持有焦点的打开中 dialog。初始名称字段无人交互时仍保留原有全选行为，回归也检查这一点。受控失败/修正分别保留 `ci-405-dialog-focus-before/`、`ci-405-dialog-focus-after/`、`ci-405-dialog-focus-complete/`，包含初始全选检查的最终专项在 `ci-405-dialog-focus-preserved/` 完整通过；未增加时限、睡眠或重复填写。原生服务提交前新增名称、可执行路径、目录的精确输入值检查，后续仍验证实际进程/端口/日志和 argv。
- **CV-19（打包 Git 列表差异，诊断中）**：UI 多出 isolation-b.md，而 Git 当前结果和原会话 snapshot 都没有该项。没有改比较 oracle、排除该文件或增加等待；补充只读 renderer context/cache 诊断，用来区分 UI 快照与 Git 缓存，下一次新代码验证用于实际重现/定位，不将一次重跑变绿视为修复。

第一次打包的完整证据保留 `ci-405-native-packaged-final/`，新焦点修复另建 ci-405-focus 包和新原生收据，再执行最终广泛回归。

#### CI 回修最终结果

最终产品改动是弹层进入/退出始终保留定位变换、搜索快捷键只忽略明确关闭中的 dialog、终端菜单尊重已取得键盘的 xterm/服务表单，以及 Modal 延迟聚焦保留已交互字段与选区。默认首字段的初始全选行为保留。另同步旧三栏/760px 覆盖层、文字和语义 token 预期，并修正保存观察、平台复制键、退出动效/导航卸载的测量；没有延长超时或新增自动重试，行为检查保留，旧值按设计替换，未更新截图基线，没有新增依赖或改锁文件。Unreleased 已增加一行用户可见修复。

| 最终执行 | 实际结果 |
| --- | --- |
| `npm --prefix apps/workbench run test:components` | 退出 0，标准全列表 67/67；`ci-405-verified-components-v3/attempt-l1unEq/receipt.json` |
| `npm run check` | 退出 0，1,592 项中通过 1,582、失败 0、跳过 10；类型与核心构建通过 |
| `npm run check:apps` | 退出 0，workbench 337、desktop 单元 163 全过；runtime 821 项中通过 804、失败 0、跳过 17；类型与应用构建通过 |
| 开发版完整 `test:journey` | 退出 0，26/26、0 failed/blocked、errors:[]；`ci-405-native-focus/receipt.json` |
| 隔离输出 `package:only` 与打包版完整 `test:journey` | 均退出 0；包在 `apps/desktop/out/ci-405-focus/`，收据 `ci-405-native-packaged-focus/receipt.json` 为 packaged:true、26/26、0 failed/blocked、errors:[]；没有安装、公证、发布 |
| 根包/workbench/desktop 三个 `format:check` 与 `git diff --check` | 均退出 0 |

最终核心 10 项和 runtime 17 项跳过的名称、原因逐项与旧 `docs/workbench/validation/graphite/checks.json` 相同，均为既有 Windows 条件，未新增跳过。重型步骤顺序执行。实际 stdin、原 600 行完整复制、独立缓冲区、真实端口/日志就绪、停止/重启、原 PID/argv、只读恢复等断言均保留；两个原生收据还记录 applicationClosed/serverClosed/temporaryProfileRemoved:true、clipboardRecoveryPending:false。已查看代表截图：宽窗三栏、中文深色 760px 服务表单（页脚完整在窗内）及打包版真实服务 ready；这不是新的跨平台视觉批准。

最终冻结及完整性：

- `ci-405-source-manifest-v3.json` 包含 1,431 个源码/测试/依赖文件，SHA-256 `8b4e079ba83607f8e2172980784e328efdf7e87ba19a281c4d999a91a702a2ad`；与两份原生通过流程所用的 focus 清单完全一致。最后重算源码不一致 0，提交后逐一比较本提交内的源码 blob 与清单，仍为 0。
- 最后 check:apps 重建的 main/preload/runtime-worker/renderer index 四份产物与开发版原生通过收据一致；打包 ASAR 与实际运行收据一致，SHA-256 `aad55622e079ae132889d30c77187fe38e41af8a658968112d939db3822e2cef`。
- 打包原始收据中的 2,574 个文件重新计算，摘要不一致 0；原生执行结束后 `codesign --verify --deep --strict` 再次通过。保留既有大 chunk、CJS import.meta、缺少 .icon 格式及 hdiutil 弃用提示；无 hdiutil 重试。
- 汇总收据 `apps/desktop/artifacts/graphite/ci-405-final-validation-v3.json` 与 `ci-405-final-integrity.json` 均为 passed。原始失败、各次 build、trace、截图、源码清单和包仍在对应忽略目录中；未覆盖变基前的证据。

CV-19 继续作为**单次未定因观察**保留：增加只读诊断后，新产品焦点修正版本的开发版与打包版完整流程均通过，Git 比较没有放宽，Git 生产逻辑没有改动；两份 renderer-at-open 诊断都是正确原会话、无会话 changes、初始 Git cache 为空。它们不能解释第一次包内多出 isolation-b.md 的形成过程，因此不将本次通过写成“CV-19 已修复”。如再现，新的 failure JSON 会同时保留实际 renderer context/cache、主进程 snapshot 与 Git 结果。

Circle 本机提交：`d2e3154262d42314016623410678a78fce2856e5`，`Preserve desktop overlay placement and keyboard input through animations`，22 个显式文件，已签署。代码只在 `workbench-graphite-local`；本页只在 `circle-visual-notes` 提交。未推送、未重跑远端 workflow、未评论 PR；本机平台为 macOS arm64，Ubuntu 的最终结果仍待 Claude 推送后的 CI。决定 139 两个工作树复核仍干净，保持 Circle `9e7d7659` / notes `7409057f` 的第一阶段完成审查点，没有 stash、移植半成品或混入知识库改动。

### PR #405 Ubuntu 地址栏回修（2026-11-03，进行中）

来源：Claude 转交 run `41515273724`、job `125517121067`（components 1），唯一失败 `26-original-browser-shell-ui`。决定 139 第二阶段已安全提交在 Circle `a6c11845`、notes `69dc9a65`，两树干净；本轮不把知识库字节移到视觉分支，也不开始第三阶段。

- 已按要求下载该 run 全部 artifacts，另提取 shard 1 作集中调查。Ubuntu 原始失败在 `original-browser-shell-ui.mjs:548`，截图请求已到合成宿主，地址 input 仍存在且值为 fixture URL；原 5 秒 `fill()` 连续报告不可见。失败 DOM、PNG、trace 在 `apps/desktop/artifacts/graphite/ci-405-linux-browser-shell-focused/attempt-iTUU59/26-original-browser-shell-ui/`，原件未覆盖。
- **CV-20（产品排版缺陷）**：工具栏按内容收缩，地址外壳与内层编辑字段均允许收缩到 0；安全文字、接管按钮、前进/后退/刷新及模式按钮占满约 380px 的抽屉。Linux 字体度量暴露了该退化，原 macOS 规格仍通过。用规范已有的“更大”字号在同一真实 App/合成宿主流程中重现：浏览器 375px、地址外壳 94.5px、字段及 input 宽度 0，input 高 18px；原 5 秒 fill 仍因不可见失败。失败几何、图片及 trace 保留 `ci-405-browser-zero-before/`，不是强制填充或取消可见性检查。
- 修复按实际浏览器容器宽度响应：不大于 480px 时为地址保留单独一行，工具按钮都保留；宽视图仍是一行。紧凑工具行的 26px 图标按钮加上下各 1px 的空间，使其始终与 28px 接管按钮同高，避免控制状态改变时网页坐标移动。第一版候选被原有“控制环不改变网页位置”断言发现 2px 位移，已在产品 CSS 中修正，原断言不改。
- 回归保留全部旧尺寸、主题、语言、截图代次、过期回调及页面坐标检查；加入更大字号下的真实地址 fill/Enter，并检查最窄视口的中英、深浅色实际导航请求。时限仍为 5 秒，没有 force、重复填充或新增重试。新窄窗用例显式关闭可能恢复为打开状态的抽屉后再打开，不错误地把每次窄窗重载当作一次宽→窄变化。

正在完成最终专项、广泛回归与开发/打包原生验证；尚不把本机结果写成 Ubuntu 已通过。

最终候选的标准组件集已退出 0，67/67 全过：`ci-405-browser-verified/components/attempt-qKkgNA/receipt.json`。第 26 项包含全部原有检查及新增 290px 更大字号的中英深浅色真实导航，36 组检查、page errors 为 0；最终截图在输入提交后的实际显示状态稳定后拍摄。最窄用例的 input 宽度为英文约 162.42px、中文约 192.77px，375px pane 的更大字号用例约 247.42px，均保留真实 fill/Enter 与宿主请求断言。已查看代表深浅截图，文字清晰，没有输入值与展示值重叠。

冻结清单 `ci-405-browser-verified/source-manifest.json` 含 1,471 个源码/测试/配置文件，SHA-256 `43f2a28c49dba467ab5e162ab02198b71c678fcd194a982d97c85d97588c3f7c`；每个验证步骤前后复核，当前不一致 0。后续原生与打包使用同一版源码，不复用旧 d2e31542 的包。

广泛检查与第一轮原生：核心 check 为 1,592 项（1,582 过、0 失败、10 跳过），check:apps 为 337＋163 全过、runtime 821 中 804 过/17 跳过，类型与生产构建通过。生产 CSS 保留 `container:circle-browser/inline-size`，480px 查询被构建器等价改写为 `(width<=480px)`；临时收据脚本起初只认 max-width 拼法，因此先停在静态检查。直接核对产物后让该临时检查识别同一条件的标准等价表示，保留初次错误记录，没有改产品 CSS 或测试断言。

开发版 native journey 25/25 通过、errors:[]；该次未打开可选的 WEB_DEBUG，因此不是旧配置的 26 项。新包成功生成，但打包版在原生面板检查失败：输入框几何、命中、焦点、Tab 检查均通过，值却由 `http://127.0.0.1:…` 变为带 `/` 的规范 URL，未把这次流程记作通过。

- **CV-21（需要的检查取样不可靠）**：面板检查的 openPanel 适配器见空地址便 fill(origin)/Enter，随后只等输入框 visible 就开始“值保持不变”取样；这时它自己发起的原生导航还未提交，尾部 `/` 的正常规范化通知可能落在取样与 Tab 之间。不是输入草稿被覆盖：这一步没有再修改输入，产品 editingAddress 仅在实际 onChange 后保护草稿，读取中的页面地址应继续跟随导航。适配器现在只在自己发起初始化导航时，使用原有 until 截止等待 native browserState 的规范 URL、loading=false 及 renderer 的同一值，再进入原封不动的值/几何/命中/Tab oracle。没有比较时去掉 `/`、改成 startsWith、增加截止或在失败后重复填写。
- 原失败保留 `ci-405-browser-verified/native-packaged/`。后续用单独收据先验证同一 25 项配置的该初始化分支，再以 WEB_DEBUG=1 做完整 26 项开发/打包检查。产品源码与已验证包不变；新冻结清单与原清单的唯一差异将是这个外部原生测试驱动文件，不复用失败为通过。

该候选等待尚未得到完整原生分支验证：复核流程先在旧 CV-19 的 Git 列表差异处停止，新增诊断这次已实际记录 parent 的 Git cache 多出 isolation-b.md，而主进程当前 Git 与 session.changes 都没有它。记录在 `ci-405-browser-native-v2/packaged-initial-navigation/changes-list-mismatch.json`，因此 CV-19 由“单次观察”更新为“再次出现、仍未定因”；不改 Git oracle、不排除此文件，也不写成已修复。

为避免把未充分验证且不属于 Linux 输入框修复的原生驱动候选混入 PR，该等待补丁只保存为忽略目录中的 `ci-405-browser-native-v2/native-initial-navigation-wait.diff`，从本轮代码差异撤回。原始 native 驱动恢复逐字节一致，1,471 项冻结清单再次复核不一致 0。本轮代码仍仅 CSS、原组件回归和 changelog 三个路径。CI 的既定原生配置同时设置 WEB_DEBUG=1、DIAGNOSTIC=1、PUSH=1；接下来使用这个完整配置，而非遗漏可选项的 25 项配置，独立记录开发版和同一包的 26 项结果。失败/blocked 仍令配置失败，diagnostic 不等于跳过或通过。

#### Ubuntu 地址栏回修的最终交接

代码提交 `169bd3cc37f62cb7d5001561fecf46c0247e6d33`，`Keep browser addresses editable in compact drawers`，已签署；只有 `panes.css`、`original-browser-shell-ui.mjs`、CHANGELOG 三个显式文件。原生测试驱动与 d2e31542 逐字节相同，未并入 CV-21 的候选等待，也未改 Git 生产逻辑。

| 最终检查 | 结果 / 收据 |
| --- | --- |
| 标准完整 `test:components` | 67/67，退出 0；`ci-405-browser-verified/components/attempt-qKkgNA/receipt.json` |
| `npm run check` | 退出 0，1,592（1,582 过、0 失败、10 跳过），类型与核心构建通过 |
| `npm run check:apps` | 退出 0，337＋163 全过，runtime 821（804 过、0 失败、17 跳过），类型与生产构建通过 |
| CI 配置的开发版完整 native journey | 26/26，0 failed/blocked、errors:[]；`ci-405-browser-native-full/native-development/receipt.json` |
| 同一新包、CI 配置的打包版完整 native journey | 26/26，0 failed/blocked、errors:[]、packaged:true；`ci-405-browser-native-full/native-packaged/receipt.json` |
| 三包 `format:check`、`git diff --check`、运行后严格 codesign 验证 | 均退出 0；汇总 `ci-405-browser-native-full/validation.json` |

CI 配置指 WEB_DEBUG=1、DIAGNOSTIC=1、PUSH=1，与 workflow 的既定开关一致；PUSH 是 browser Console/CDP/IPC 测量，不是远端 Git push。两次本机流程另用显式测试 profile 的后台窗口，平台为 macOS arm64；没有把它说成 Ubuntu 已通过。两份原生收据均记录 applicationClosed/serverClosed/temporaryProfileRemoved:true、clipboardRecoveryPending:false。核心 10、runtime 17 项跳过的名称/原因逐项与旧 checks.json 相同，新增跳过 0。

完整性复核：

- 1,471 项冻结源码的字节不一致 0；提交后按 Git blob 逐项比较，仍为 0，最终代码与通过检查的产品/测试字节一致。
- 本地包仅位于 `apps/desktop/out/ci-405-browser/`，未安装到 Applications、未公证或发布；ASAR SHA-256 `e871e2c5d24d9f48118562f8fd8fa2c6806087422c534e4bf024dc3111227886`，原生执行后未变，严格签名校验通过。
- main/preload/runtime-worker/renderer index 四项当前构建摘要与开发原生 receipt 一致；从实际 ASAR 解出的同四项也逐字节一致。汇总 `ci-405-browser-native-full/final-integrity.json`。
- 已查看最终 290px 更大字号的英文深色、中文浅色截图以及实际 Electron 浏览器面板；地址行可读，导航/接管/模式控件保留，页面坐标的原严格断言通过。没有更新截图基线、延长超时、强制隐藏元素输入或增加自动重试。

失败尝试全部保留。最终配置通过不等于 CV-19 已修复：该旧 Git 缓存差异本轮再次出现，有更完整诊断，仍未定因；CV-21 是省略可选 debug 的 25 项配置中发现的初始化取样竞态，候选修正尚未验证并未提交。它们作为后续调查边界交接，不被替换为绿色结论；本提交只修复 CV-20 地址栏产品缺陷。

本轮未推送、未重跑远端 workflow、未评论 PR。决定 139 的第二阶段仍保持 Circle `a6c11845` / notes `69dc9a65` 的完成审查点，未 stash 或混入本轮提交；结束本轮回修后返回该任务，等待第二阶段审查，不擅自开始第三阶段。
