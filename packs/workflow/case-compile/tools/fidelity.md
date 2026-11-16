# 脚本合并前核对原始用例的场景

每次脚本编写或改写后，先对自动化用例做独立场景保真判定，确认没有改掉原始用例的场景，再交给 Hub。默认且优先使用客户端侧 `fidelity-plumb.ts` 调用 Plumb（`sequence` `@2400`）生成 `.verdict.json`，再由 `fidelity-apply.ts` 并入计划；编写模型不自判自己。

## 默认方式：客户端侧 Plumb 保真核对

1. 运行 `fidelity-plumb.ts` 生成或复用 `.brief.json` 与 `.verdict.json`（工具会自动展开定长文字、按 `added_precondition` 与配对 `cleanup:true` 折叠豁免步骤、按 2400 token 上限裁切前序步骤且不截断命令块，超过网关单次请求上限（32 题、展开后 256 个打分对、1 MiB）自动分批提交；遇 503/413 不静默放行，`review` 区加标 `[需人工复核：Plumb sequence 落入 review 区]`）：

```sh
node '<技能目录>/tools/fidelity-plumb.ts' --run '<脚本编写目录>/run.json' --plans '<自动化用例目录>' --briefs '<核对目录>' --base-url %PLUMB_URL% --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

2. 让工具把判断写回自动化用例，确认 `ready=true` 后再做脚本合并：

```sh
node '<技能目录>/tools/fidelity-apply.ts' --run '<脚本编写目录>/run.json' --plans '<自动化用例目录>' --briefs '<核对目录>'
```

## 仅当 Plumb 未部署时的手动盲审流程

若当前环境明确未配备 Plumb 网关，才改用 `fidelity-brief.ts` + `task-brief.ts --role '保真核对'` + `fidelity-apply.ts`：

```sh
node '<技能目录>/tools/fidelity-brief.ts' --run '<脚本编写目录>/run.json' --plans '<自动化用例目录>' --out '<核对目录>'
node '<技能目录>/tools/task-brief.ts' --role '保真核对' --batch '<核对目录>' --task-dir '<核对任务目录>'
node '<技能目录>/tools/fidelity-apply.ts' --run '<脚本编写目录>/run.json' --plans '<自动化用例目录>' --briefs '<核对目录>'
```

（单条重审可用 `node '<技能目录>/tools/task-brief.ts' --role '保真核对' --case '<autoid>' --brief '<核对目录>/<前缀>.<8位摘要>.brief.json' --out '<核对目录>/<前缀>.<8位摘要>.verdict.json' --task-file '<任务文件路径>'`，交前台并行 `task`（`subagent_type="case-compile:compile-fidelity"`，严禁用 `background`，每批最多 6 个）；不得附带编写理由、设备输出、手册或期望结论。）

缺判断、文件已过期时重新运行第 1 步；格式不对就重新核对。判定认为场景改了（`changed`）、没实现（`unrealized`），或落入 `review` 且启用 `--strict-review` 时，按理由改自动化用例，再重新核对。

Hub 按同样规则重算并核对每条原始步骤都有对应内容、判断取值合法、说没改的确实列出了对应步骤；对场景含义的判断仍来自模型，状态未确认。

```text
fidelity-plumb.ts 写出并复用同名 .brief.json / .verdict.json；原自动化用例未变时沿用已有判断
fidelity-apply.ts: ready=true 才能继续；attention 指出要处理的内容
结果写回 data.fidelity（含未确认 model_disclosure 与 model_judgment），摘要由工具填写，不手写
若 `.brief.json` 的 `mechanical.exemptions` 列出 `added_precondition`（来自重组 `sources.states` 或 Hub 原文校验的锁定手册引文 `plan.precondition_source` / `block_context.preconditions`），核对有来源前置步骤及配对 `cleanup:true` 逆清理时按简报内置 `rules` 予以豁免；反向“前置不存在/未配置”测试不折叠前置步骤，仍严禁读 `plans/`、`knowledge/` 或附带编写说明/设备输出。
内部引用和字段只用于工具，不放进使用者答复
```

给使用者每条只报一句，带原始用例 ID 加标题、结论、状态和判断。模型的判断是未确认，判断只用正确或错误，未知不填判断；错误或未知才写原因和下一步，证据和决定者放最后。原因只用缺资料、原始用例的问题、编写模型的问题、临时故障、设备的问题、还没查清，决定者只用程序、模型、使用者。


Plumb 保真题目附完整 mechanical.exemptions 与 added_precondition 规则（来源登记及原文相关性仍待模型核对），不由关键词识别负向场景或折叠步骤。保持全部候选及配对清理；只有模型确认未改变被测条件及反向场景时才可采用豁免。对应步骤使用 author_step_refs 或完整 adapted_commands，缺依据须补写，不推定“未实现”。判断缓存绑定完整题目摘要及提示版本；旧目录不兼容时保留旧文件并换新 --briefs 目录。
