# case-compile 的判断方式选项

分支 `wp/claude/judge-option`，从 `wp/claude/compile-flow-publish` @ `e4b82c293c` 开出。所有者 2026-11-22 的决定见进度文档决定 187。

## 要做的

`case-compile` 的命令核验和场景保真审计现在只能由 Plumb 判断，Plumb 后端起不来时任何账号都开不了编译。加一个由使用者选定的判断方式，默认仍是 Plumb：

- `tools/open-compile.ts --judge plumb|model`，写进 `open-compile.json`。
- `tools/pipeline.ts` 照 `open-compile.json` 办：`model` 时命令核验跑 `cmd-verify-plumb.ts --tree-only`，场景保真出简报后交 `compile-fidelity` 盲审，每条用例的复核说明写明判断方式。
- `tools/cmd-verify-plumb.ts --tree-only`：只做命令树的程序核对，没有结论的步骤状态未知并披露。

不做：不改 Hub 核心、合约和核对规则；不新增子代理角色；命令候选预筛（`cmd-select-plumb.ts`）不在流水线里，不动。

## 第三种：Jev（决定 191）

所有者 2026-11-23 定：做一个 Jev 技能，和 Plumb 技能并列，编译时由使用者手动选一个，不自动切换。

- 新通用技能包 `packs/skill/jev-judge`：TypeSafe 线上判断服务的客户端模块 `jev-client` 和命令行 `tools/jev-judge.ts ask`。
- `tools/open-compile.ts --judge plumb|jev|model`；选 `jev` 时只要标准输入第三行有 Jev 密钥，不要求安装 `jev-judge` 技能（流水线用内嵌的客户端，守卫拒绝直接运行技能的命令行）。
- `functions/jev-judge.ts` 把命令核验和场景保真的题改写成 Jev 的是非题和单选题；答案一律记为复核、未标定、未确认，不放行也不拦截。
- 标准输入三行；`assemble-delivery.ts --open` 必填，交付报告写明判断方式；Jev 暂时不可用时一条用例最多连续问 5 次，两次之间至少隔 60 秒。

## 可以改的路径

- `packs/workflow/case-compile/`（工具、函数、测试、`SKILL.md`、`README.md`、`pack-files.ts`、`pack.json`、样例和表里的版本号）
- `packs/skill/jev-judge/`、`packs/skill/frontmatter.test.ts`（决定 191）
- `scripts/real/`（守卫登记、探针、已评审调用的登记和它们的测试）、`docs/member-guide.md`、`docs/admin-guide.md`（决定 191）
- `docs/hub-r4-progress.md`、`docs/compatibility.md`、`docs/compatibility.en.md`、`CHANGELOG.md`、本页

## 限制

- `model` 方式没有 Plumb 对命令语义的判断；命令树核对不了的步骤没有任何判断。
- 盲审和编写用同一类通用模型，独立性比 Plumb 弱。
- 守卫按命令行声明核对标准输入的行数，所以三种方式下标准输入的写法相同（三行），用不到的那一行不读。
- 选 `jev` 不等于 Plumb：Jev 没有在我们数据上标定过的门槛，答案只进复核说明，场景保真全部交盲审；命令核验那道带上下文的题在 Jev 上只回放过一条真实用例；给 Jev 的题面预算是 32768 个估算 token（取自参考引擎，不是实测的服务上限，实测收下的最大请求是 19 KB）。

## 验证

见决定 187、191 的验证一行。真实环境上的检验是 7421 上以 `model` 方式做一次脑图编译，结果记在验收目录，不在这里。
