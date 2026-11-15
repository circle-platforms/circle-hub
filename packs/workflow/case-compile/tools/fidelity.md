# 脚本合并前核对原始用例的场景

每次脚本编写或改写后，先由新会话逐条核对自动化用例有没有改掉原始用例的场景，再交给 Hub。编写会话不兼做这次判断；核对规则由工具给出，不由编写者转述。

1. 把原始用例和自动化用例交给工具，写出给独立模型读取的文件。同一个目录一直沿用。工具先展开定长文字并写回自动化用例；只有新写或改过的自动化用例需要重新判断。

```sh
node '<技能目录>/tools/fidelity-brief.ts' --run '<脚本编写目录>/run.json' --plans '<自动化用例目录>' --out '<核对目录>'
```

2. 用 `task-brief.ts` 为 `to_audit` 中每份 `.brief.json` 生成独立盲审任务文件（或一次批量生成整目录；工具会自动隔离编写简报、历史轮次与设备日志），再将生成的短派发提示交给前台并行 `task`（`subagent_type="general-purpose"`，严禁用 `background`，每批最多 6 个）：

```sh
node '<技能目录>/tools/task-brief.ts' --role '保真核对' --batch '<核对目录>' --task-dir '<核对任务目录>'
```

（单条重审可用 `node '<技能目录>/tools/task-brief.ts' --role '保真核对' --case '<autoid>' --brief '<核对目录>/<前缀>.<8位摘要>.brief.json' --out '<核对目录>/<前缀>.<8位摘要>.verdict.json' --task-file '<任务文件路径>'`；不得附带编写理由、设备输出、手册或期望结论。）

3. 让工具把判断写回自动化用例。工具会确认判断的仍是当前自动化用例，写好后才做脚本合并。

```sh
node '<技能目录>/tools/fidelity-apply.ts' --run '<脚本编写目录>/run.json' --plans '<自动化用例目录>' --briefs '<核对目录>'
```

缺判断、文件已过期时回到第 1 步；格式不对就让独立模型按文件里的规则重写。模型认为场景改了、没实现，或说没改却没列出对应步骤时，按理由改自动化用例，再重新核对。不改独立模型的结果，也不靠修改任务说明换结论。

Hub 按同样规则重算并核对每条原始步骤都有对应内容、判断取值合法、说没改的确实列出了对应步骤；对场景含义的判断仍来自模型，状态未确认。

```text
模型读取 to_audit 中的 .brief.json 文件；原自动化用例未变时沿用已有判断
结果写同名 .verdict.json，完整格式以每份 rules 为准
fidelity-apply: ready=true 才能继续；attention 指出要处理的内容
结果写回 data.fidelity，摘要由工具填写，不手写
若 `.brief.json` 的 `mechanical.exemptions` 列出 `added_precondition`（来自重组 `sources.states` 或 Hub 原文校验的锁定手册引文 `plan.precondition_source` / `block_context.preconditions`），核对有来源前置步骤及配对 `cleanup:true` 逆清理时按简报内置 `rules` 予以豁免，仍严禁读 `plans/`、`knowledge/` 或附带编写说明/设备输出。
内部引用和字段只用于工具，不放进使用者答复
```

给使用者每条只报一句，带原始用例 ID 加标题、结论、状态和判断。模型的判断是未确认，判断只用正确或错误，未知不填判断；错误或未知才写原因和下一步，证据和决定者放最后。原因只用缺资料、原始用例的问题、编写模型的问题、临时故障、设备的问题、还没查清，决定者只用程序、模型、使用者。
