# 任务：Circle 工作台视觉统一（石墨主题）——决定 93

依据：
- 所有者 2026-11-02：“同样的方案也要让circle保持相同设计感”。控制台已选定主题版本 A“石墨”，Circle 工作台改用同一套设计。
- 设计规范《Circle 设计规范》：[`docs/design/circle-design-system/`](../design/circle-design-system/README.md)，效果图在 [Circle 仓库的文档](https://github.com/circle-platforms/circle/blob/main/docs/design/circle-design-system-screens.md)，文件摘要见 `docs/design/circle-design-system.sha256`。Circle 仓库的 `docs/design/circle-design-system/` 是同一份。与工作台直接相关的是：
  - README 的“品牌”“颜色”“字体与排版”“页面结构”“在两个产品中实现 › Circle 工作台”；
  - 组件 WorkbenchShell 与 Composer；
  - 交互、文字两节，两个产品通用。

本任务在 Circle 仓库完成。本页放在 circle-hub 仓库，只用来交接与记录。

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

- Circle 的本机知识库、本机记忆与同步客户端：决定 90，另立任务。
- 终端界面（TUI）的改版。

## 实施方案

（由 Codex 动手前填写，经 Claude 审查。）

## 发现

（无。）

## 做了的

（未开始。）

## 验证

（未开始。）
