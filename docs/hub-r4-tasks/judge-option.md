# case-compile 的判断方式选项

分支 `wp/claude/judge-option`，从 `wp/claude/compile-flow-publish` @ `e4b82c293c` 开出。所有者 2026-11-22 的决定见进度文档决定 187。

## 要做的

`case-compile` 的命令核验和场景保真审计现在只能由 Plumb 判断，Plumb 后端起不来时任何账号都开不了编译。加一个由使用者选定的判断方式，默认仍是 Plumb：

- `tools/open-compile.ts --judge plumb|model`，写进 `open-compile.json`。
- `tools/pipeline.ts` 照 `open-compile.json` 办：`model` 时命令核验跑 `cmd-verify-plumb.ts --tree-only`，场景保真出简报后交 `compile-fidelity` 盲审，每条用例的复核说明写明判断方式。
- `tools/cmd-verify-plumb.ts --tree-only`：只做命令树的程序核对，没有结论的步骤状态未知并披露。

不做：不改 Hub 核心、合约和核对规则；不新增子代理角色；命令候选预筛（`cmd-select-plumb.ts`）不在流水线里，不动。

## 可以改的路径

- `packs/workflow/case-compile/`（工具、函数、测试、`SKILL.md`、`README.md`、`pack-files.ts`、`pack.json`、样例和表里的版本号）
- `docs/hub-r4-progress.md`、`docs/compatibility.md`、`docs/compatibility.en.md`、`CHANGELOG.md`、本页

## 限制

- `model` 方式没有 Plumb 对命令语义的判断；命令树核对不了的步骤没有任何判断。
- 盲审和编写用同一类通用模型，独立性比 Plumb 弱。
- 守卫按命令行声明核对标准输入的行数，所以两种方式下标准输入的写法相同，`model` 时第二行不读。

## 验证

见决定 187 的验证一行。真实环境上的检验是 7421 上以 `model` 方式做一次脑图编译，结果记在验收目录，不在这里。
