# 编码代理说明只用 AGENTS.md（决定 185，主线上编号 162）

所有者 2026-11-19 在对话里选“合并为只使用 AGENTS.md”。Claude Code 2.1.277 起，工作目录及其上级都没有 CLAUDE.md 时才读 AGENTS.md；本仓库原来有 CLAUDE.md，有约束力的 AGENTS.md 因此不会自动加载。circle 和 circle-packs 只有 AGENTS.md，已经按这种方式加载。

## 可以改的路径

- `AGENTS.md`
- `CLAUDE.md`（删去）
- `docs/hub-r4-progress.md`（决定 185）
- `docs/hub-r4-tasks/agents-md-only.md`（本页）

## 并进 AGENTS.md 的内容

- Current scope：六个工具名；streamable HTTP 和 Bearer 令牌；控制台的管理动作各自执行对应的 `circle-hub` 命令；HTTPS 和一键安装；已退役的 `CIRCLE_SERVER_*` 名字。
- 新的 Commands 一节：命令清单原样保留作速查；测试用的临时 PostgreSQL，需要 macOS 或 libpq 的测试，跳过不算通过；任务 worktree 里不运行 `npm install`。
- 新的 Architecture 一节：`hub/` 各包的依赖方向和职责；`packs/`；真实系统的结构只出现在 `tests/fixtures` 和 `scripts/real/`。
- Source and reference ownership：foundation/circle 不得修改、运行（它的测试、客户端安装、更新和发布脚本都算）或导入；可擦除语法的具体禁项（不用 `enum`、参数属性和 namespace）；`npm run verify:references` 核对的 287 个文件；类型化错误码；包函数是纯模块。
- Evidence and changes：读取失败按 D05 R[3]（模型第 37 版）的三种返回，新代码按这一条写。

“Git and commits”一节与 circle-packs 相同，没有改。

## 不进仓库的

Claude Code 自己的 hook、按路径加载的规则和插件开关，放在开发者本机的 Claude Code 设置里（所有者同日决定）。

## 核对

只改文档，没有部署。本地跑了 `npm run test:docs`；在新会话里用 `claude -p` 确认加载的是 AGENTS.md，不再是 CLAUDE.md。内置 /code-review 提出的六处遗漏和措辞问题已改正：foundation/circle 不得运行和导入、可擦除语法的禁项、传输方式和退役名字、重复的说法、本任务页、D05 R[3] 对新代码的要求。
