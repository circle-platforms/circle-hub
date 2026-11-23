# 场景保真审计

每份自动化用例交给 Hub 之前，都要有一次独立的场景保真判断：它有没有改掉原始用例的场景。编写模型不判自己写的计划，也不手写 `data.fidelity`。

## 流水线怎么做

`pipeline.ts` 在每条用例的命令核验之后做这一步，主代理不手动跑：

1. `fidelity-plumb.ts` 为计划算出简报（`.brief.json`），交 Plumb（`sequence` `@2400`；使用者选了 Jev 时见下面「判断方式是 Jev 时」）判断，结果写成同名 `.verdict.json`；计划未变时沿用已有判断。工具展开定长文字，按 `added_precondition` 与配对 `cleanup:true` 折叠豁免步骤，按 2400 token 上限裁切前序步骤且不在命令块中间截断，超过网关单次请求上限（32 题、展开后 256 个打分对、1 MiB）时分批提交；遇 503/413 不放行。
2. Plumb 判不了的简报（超出题面上限，或每个未判保住的步骤都落在它自己的 `review` 区）交独立盲审：流水线用 `node '<技能目录>/tools/task-brief.ts' --role '保真核对' --case '<计划文件名>' --brief '<简报>' --out '<判断>' --task-file '<任务文件>'` 生成任务，派 `case-compile:compile-fidelity` 子代理只读这一份简报写判断。盲审不附编写理由、设备输出、手册或期望结论。
3. `fidelity-apply.ts` 把判断并入计划（`data.fidelity`，含未确认的 `model_disclosure` 与 `model_judgment`，摘要由工具填写）。`ready=false` 时 `attention` 指出要处理的内容，流水线把它带给下一次编写。

判定场景改了（`changed`）或没实现（`unrealized`）的，回到编写按理由改，再重新核对。

## 题面超过 2400 token 时

Plumb 一次最多读 2400 个估算 token 的核心内容（当前作者步骤加全部候选命令块和豁免依据），工具不在命令块中间截断。题面超了，工具依次做：

1. 先裁掉更早的步骤。
2. 还超，就把在题面里逐字相同、出现至少两次的长字面量（32 个字符以上，按空白分词，引号不算）写成同一个名字（`«L1»`、`«L2»`），原文连同字符数（带点的还有各段字符数）只在题面的「长字面量对照」表里写一次。只看长度和重复，不认关键词；差一个字符的字面量不算同一个，原样保留。自动化用例和简报里的原文不改，换了什么写在判断的 `disclosure`（“长字面量换名”）和汇总的 `literal_substitutions` 里。原样就不超的题面一个字也不动。
3. 换名后仍超（候选命令块和豁免依据本身就超限），这条用例不交给 Plumb，改走上一节第 2 步的独立盲审；汇总的 `over_budget` 列出这些用例和每步的估算 token。已有同名 `.verdict.json`（盲审写的）的视为已审，不会被覆盖。

## 判断方式是 Jev 时

使用者在开运行时选了 `--judge jev`，流水线带 `--judge jev` 运行 `fidelity-plumb.ts`：

- 每个作者步骤一道题，题面就是给 Plumb 的那一份；问的是“这些块有没有照作者写的实现这一步的场景”，在保住、改变、没实现里选一个（题目版本 `jev-choice@fidelity-v1`）。发给 TypeSafe 的是简报里的作者步骤、候选命令块和豁免依据。
- Jev 的回答没有校准过的阈值，一律是未确认的模型判断，只作参考：每一步都落在 `review` 区，没有一步靠 Jev 一句话放行。判“保住”的步骤也记成需人工复核（按 `--strict-review` 的办法记为 `changed`），整份判断另存为 `<前缀>.jev-review.json`，交独立盲审，由盲审的判断并入计划。判断里的 `model_version` 是 Jev 答出来的确切版本，`rationale` 写 Jev 的选项和那个选项的概率。
- Jev 的服务拒收某一步的题时，那一步没有 Jev 的判断：这条用例不由工具写判断文件，简报留在原处，交独立盲审；汇总里的 `jev_no_opinion` 和这条用例的复核说明写明是哪几步、为什么（计划不会因此退回重写）。已经得到的回答留在同目录的 `jev-audit.answers.jsonl`（每行只有题目摘要、确切模型版本和核对过的回答），下一遍只问还没有回答的题。
- 题面上限仍是 2400 token（这是给 Plumb 定的，Jev 自己的真实上限还没有实测），超限的用例照旧走独立盲审。别的判断方式写的判断不复用，要重新核对就换新的 `--briefs` 目录。

## 判断规则

- `.brief.json` 的 `mechanical.exemptions` 列出 `added_precondition`（来自重组 `sources.states`，或 Hub 原文校验过的锁定手册引文 `plan.precondition_source` / `block_context.preconditions`）时，有来源的前置步骤及配对 `cleanup:true` 逆清理按简报内置 `rules` 豁免；反向“前置不存在/未配置”测试不折叠前置步骤。
- Plumb 的题目附完整 `mechanical.exemptions` 与 `added_precondition` 规则（来源登记及原文相关性仍待模型核对），不由关键词识别负向场景或折叠步骤；只有模型确认未改变被测条件及反向场景时才采用豁免。
- 对应步骤用 `author_step_refs` 或完整 `adapted_commands`，缺依据须补写，不推定“未实现”。

Hub 按同样规则重算并核对每条原始步骤都有对应内容、判断取值合法、说没改的确实列出了对应步骤；对场景含义的判断仍来自模型，状态未确认。内部引用和字段只用于工具，不放进使用者答复。
