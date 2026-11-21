---
name: case-compile
description: 把原始用例编成自动化用例，经 Hub 核对、生成 Excel 后上机并分析错误。需要敏捷平台文档号。
---

# 自动化用例

依次为用例重组、脚本编写、脚本合并、上机验证、失败分析。模型编写，Hub 只核对重算，不生成内容或调用模型。

主代理先在工作目录写 `scope.md`：首行 `# 使用者原话，由主会话记录`，正文逐字抄录范围，变更逐字追加，不改写或缩减。首次只做部分用例时，从首次 `recompose` 起传同一 `parameters.scope`，`scope.md` 与 `parameters.scope.words` 同原话，首次开运行时定死。单条范围可按 `## <autoid>` 或 `## <item_id>` 分节，`task-brief.ts` 只传全局原文与本案分节；未写范围不得派发。各阶段只用 `task-brief.ts` 经 `--task-file` 写任务，标准输出的短派发提示原样传给 `task.description`，`subagent_type` 用输出的 `case-compile:compile-*`。

任务参数：`--role` 取用例重组、脚本编写、保真核对或失败分析；`--case` 为用例或范围，`--brief` 为输入，`--out` 为目标，`--task-file` 为任务文件。可选 `--scope`、`--note`；返工加 `--round`、`--run`、`--item`、`--prior-plans`、`--prior-returns`、`--prior-answers`、`--prior-notes`，或 `--brief-json`。

本地工具在 `<技能目录>`（用安装工具或按 Hub 命令**装进当前主目录的 `skills` 目录**，别处守卫拒执行）。文件工具限工作目录相对路径（`.`）及只读 `<技能目录>`，写入禁出工作目录（禁 `/tmp`）。触发本地脚本与 Hub 工具时，`execute` 使用本文列出的实际工具命令，技能脚本路径和值分别用单引号引用，每条命令只占一行（禁 `=`）；路径型 `--run` 写运行目录，不写 run.json；列目录用 `ls`，找文件用 `glob`，搜文本用 `grep`。`%HUB_URL%` 与 `%HUB_TOKEN%` 由客户端展开；需令牌的命令把 `node` 命令行与 `<<'EOF'` 写在同一行（空格隔开，切勿在 `<<'EOF'` 前换行），下一行只写 `%HUB_TOKEN%`，再一行只写 `EOF`，令牌不落盘。

逐条一句，带原始用例 ID、标题和结论。结论只用通过、未通过、无结论；模型自己的判断写明是模型的判断、未经确认，无结论不写成通过或未通过。未通过或无结论才写原因和下一步。原因只用本包 `functions/generated/vocabulary.ts` 中 `attribution` 轴经 `labelOf` 生成的中文标签，机器字段用同源代码，禁另列词表或自造标签。证据放最后。内部引用、工具参数只进机读部分。

## 0. 开运行即核对与逐条流水线

取得或沿用 test-bed 预订后，第一步只跑开运行工具；技能版本、Plumb、命名文档、预订和脑图是否就绪由它和 Hub 用代码判定：

```sh
node '<技能目录>/tools/open-compile.ts' --hub %HUB_URL% --plumb %PLUMB_URL% --subject 'agile:mindmap:<文档号>' --product '<产品>' --build '<构建>' --booking '<test-bed 预订号>' --out 'open-compile.json' <<'EOF'
%HUB_TOKEN%
%PLUMB_API_KEY%
EOF
```

输出第一行是“就绪：…”就往下走；是“无法编译：…”时把这一行原样告诉使用者，然后停止，不分析、不提问、不换参数重试。部分用例加 `--scope '<范围文件>'`（`{"words":"<范围原话>","cases":[...]}`）；返工加 `--recompose-run` 与 `--recompose-record` 沿用重组。重组运行和脚本编写运行只经此工具开，`start_run` 只开 test-bed 和脚本合并运行。

就绪后下载两个运行，开流水线：

```sh
node '<recompose 技能目录>/tools/download-run.ts' --hub %HUB_URL% --run '<用例重组编号>' --out 'recompose-run' <<'EOF'
%HUB_TOKEN%
EOF
node '<技能目录>/tools/download-run.ts' --hub %HUB_URL% --run '<脚本编写编号>' --out 'plan-run' <<'EOF'
%HUB_TOKEN%
EOF
node '<技能目录>/tools/pipeline.ts' init --recompose-run 'recompose-run' --plan-run 'plan-run' --open 'open-compile.json' --model '<模型>' --state 'pipeline.json'
```

子代理由编写循环派发，主代理不逐个派 `task`。`init`、`retry`、`rework` 之后各启动一次；它在后台运行，结束通知里的 `Result` 是汇总，期间不查、不等：

```
workflow({"script_path":"<技能目录>/workflows/compile-loop.js","args":{"pipeline":"<技能目录>/tools/pipeline.ts","state":"pipeline.json"}})
```

每条用例独立走：重组 → 自检 → 单条提交并确认受理 → 编写 → 计划自检 → 命令核验 → 场景保真审计，重组一受理就开写，不等其他用例。关口都由 `pipeline.ts` 跑，结论看汇总，主代理不自己判断；同时在跑的子代理在 6 个以内，结束一个补一个。汇总 `all_done` 后进第 3 节；`stopped` 的每条都先 `pipeline.ts retry --state 'pipeline.json' --case <序号> --note '模型决定：<针对停下原因的改法>'` 一次再启动循环，再停下的才写进报告，不写停轮结论。汇总有 `waiting`、`interrupted` 或循环报错就再启动一次，它从状态接着做。看进度用 `pipeline.ts status`。

## 1. 用例重组

先用 test-bed 取得整个测试环境的使用权，设备清单要写全；刚安装构建后仍持有的可以沿用。按 recompose 技能处理原始用例（完整脑图仍下载作上下文；每条用例的重组任务、`check-record.ts` 离线自检和单条提交都由第 0 节的 `pipeline.ts` 派发和执行），写出要点、改写后的步骤、具体取值和缺的资料，脚本编写与脚本合并都使用这份重组后的用例和同一构建的手册和命令树。同脑图同构建已有核对正确的重组（含新会话）直接沿用，不再重跑；确实跳过时在最终报告说明原因。

全程不问使用者（不调用 `question`）。原始用例要求的取值或写法被手册排除、期望却是成功时，按手册做最小改写，保住被测对象、动作和边界；原始用例本就测非法输入时照写。有多种做法时依次取：合同构建手册和命令树、保住作者步骤与边界、执行器能判定、改动最小。每个决定记入记录（`states.reason` 以“模型决定：”开头）和最终报告（带原句和手册原话）；`scope.md` 里使用者已有决定的照做。

使用者的决定只认 `scope.md` 里标题 `## 全局` 或 `## 用例 <完整ID>` 下的 `使用者决定：<原话>`，重组提交前逐字记入 `sources.states`；非明确标题不按全局解释。

## 2. 脚本编写

先整份下载再读原始用例，本地读搜 `knowledge/`（“· 引用”行是标注，下面是原文），不逐页读 Hub；查命令写法跑 `tools/cmd-lookup.ts --run <运行目录> --param '<命令>'`，不逐段 grep。`items/<序号>.json`、`briefs/<序号>.md` 列有命令、参数、恢复法与待填计划。

一条原始用例一个子代理，由第 0 节的 `pipeline.ts` 生成任务并给出派发动作（`subagent_type="case-compile:compile-writer"`，`background: true`），不合并用例；没过关口的条目由它带着原因单独重派，主代理不整批重来。清理分工（存盘禁入 `cleanup:true`）、`adapted` 不是步骤白名单（补 `sources.states` 或手册/示例前置，附 `precondition_source` 与配对清理，不改“前置不存在”测试）与语法由包内定义与 `task-brief.ts` 注入；受限结构/示例/分块在 `<技能目录>/slots.schema.json`、`examples/submit-result.json`、`tables/blocks-format.json`。主代理和子代理都不问使用者：能查清的自己查，定不了的按第 1 节的次序自行决定并在报告说明。

每条原始用例都照原意写，按同构建手册、命令树与已声明执行器规则完成，不用确认标记绕过，也不从 help 散文推断或复制内部内容。作者没写字面的期望，模型写检查点：是模型的判断，未经确认，不做复核，上机验证裁定。执行器规则缺类型、用途、效果或允许范围时，按 Hub 点名的资料找维护者补齐并向使用者说明谁在补什么，先把这条现有计划交给 Hub 核对，取得对本条具名的缺失事实和请求后，下一个脚本编写运行才排除它、其余继续；没有这条 Hub 记录，不把模型笔记称为“Hub 点名”。作者步骤与手册冲突、按手册改写也落不了地时，按 tools/delivery.md 写结构化 author_conflict 并保留逐字引文。计划自检跑 `tools/check-plan.ts --file <计划> --run <运行目录>`。

### 主会话参数与本地工具命令

主会话参数，不进使用者答复：

```text
不要从记忆填写旧版本。
product/build/version: start_run 顶层，不放 parameters
profile: device_count 只读预检及可选 fold_newlines
整份原始用例: 不填 parameters.autoid；单条: 原样复制 autoid 字符串
排除: parameters.exclude=[autoid,...]，脚本编写和脚本合并用同一列表
按范围: parameters.scope={"words":"<范围原话>","cases":["<autoid>",...]}（不与 exclude/autoid 同用；words 与 scope.md 同原话）；recompose 与 case-compile（编写/合并/返工）首次开运行时定死同一范围，case-compile 须为绑定重组条目的子集，中途换或扩范围须重新 start_run
跳过用例重组: parameters.pipeline=legacy
本地规整: node '<技能目录>/tools/normalize-mindmap.ts' --in '<导出文件>' --out '<规整文件>'
上传中性文件名，说明写两边摘要和“客户端规整”，不改内容或编号
下载命令见下方
本地读取: items/<序号>.json、briefs/<序号>.md、knowledge/；来源文件按sources.json的file指针读取，不猜名字
```

```sh
node '<技能目录>/tools/download-run.ts' --hub %HUB_URL% --run '<脚本编写编号>' --out '<新目录>' <<'EOF'
%HUB_TOKEN%
EOF
```

各计划无手写 `data.fidelity`、已展开定长占位且 `check-plan.ts` 自检为 `ok: true` 后再合并。**同运行重交与重开边界**：同一 `plan_run` 尚未进入 `merge_run`、无在途上机、`scope`/`exclude`/`inputs` 未变且 `rounds_left>0` 时，可直接重交当前 `plan_run`（复用未改计划与 `data.fidelity`）；仅 `rounds_left=0`、已进 `merge_run` 或 `scope`/`exclude`/`inputs` 变化时才 `start_run` 新开（上机返工 `predecessor` 填原预订号并用 `carry-plans.ts` 结转，见 `tools/delivery.md`）并重生成上传与新开合并；禁止把改过的计划直接交进 `merge_run`。新开脚本编写运行一律用第 0 节的 `open-compile.ts`。
第 2 轮及以上返工派发 `脚本编写` 或 `失败分析` 前，统一经 `task-brief.ts --round <n> --task-file <文件>` 传入同案 `--prior-plans`/`--prior-returns`/`--prior-answers`/`--prior-notes`（多轮按 `1..n-1` 英文逗号分隔、缺轮写 `-`，单轮直接传路径）；`task-brief.ts` 会写入任务文件（超 1800 字符逐字长行不折行并提示行号），并在传入运行目录或 `--run`/`--brief briefs/<序号>.md` 时在内存中自动拼入同案 `compile-brief@1`（含执行器失败标志、测试环境与前置）与精简机械规则拒收 `{code, path, message, fix}`、区分“末尾 12,000 字符截断 / 输出无法唯一定位 / 未找到命令”的报错步设备逐字摘录、未确认的失败分析结论（`confidence: "hypothesis"`；`notes.json` 缺 `round` 时标为轮次未记录且不冒充第 1 轮），总篇幅按固定顺序截断披露；禁手写摘要、传整批 `submission.json` 或跨用例拼接；`保真核对` 继续严格盲审，只传 `.brief.json`。

## 3. 脚本合并

流水线已对每条用例跑过下面的命令核验和 Plumb 场景保真审计（缺审、过期或格式错在本地拦截，不占修复次数）；`all_done` 后先收拢就绪的计划，再提交给 Hub：`node '<技能目录>/tools/pipeline.ts' collect --state 'pipeline.json' --out 'plans'`，提交、生成工作簿和合并都用收拢后的 `plans` 目录。collect 输出的 `reviewed` 写进最终报告。收拢后不改 `plans`、不写跳过声明；对就绪条目有异议用 `retry` 送回。收拢后**后台**跑合并工具（约 10 分钟）：交计划、生成并上传 Excel、开脚本合并运行并提交都由它做，输出“合并通过：…”进第 4 节；“合并不了：…”按它点名的条目和原话 `pipeline.ts retry`，就绪后重新 collect 到新目录再跑。下面的分步命令只在它点名时用。命令核验以命令树为准：命令树核对不过的必改；Plumb 拒绝而命令树核对通过的只标需人工复核，不阻断。按说明改错并自动重交，最多重交 2 次；重改计划后重跑审计；不要把 Hub 已接收当全部正确。保真核对依 `mechanical.exemptions` 豁免有来源前置及配对 `cleanup:true` 清理（不改被测场景与“前置不存在”测试）。

```sh
node '<技能目录>/tools/open-merge.ts' --hub %HUB_URL% --open 'open-compile.json' --plans 'plans' --model '<模型>' --out '<新目录>' <<'EOF'
%HUB_TOKEN%
EOF
node '<技能目录>/tools/check-plan.ts' --file '<计划或判断JSON>' [--brief '<核对文件>']
node '<技能目录>/tools/cmd-select-plumb.ts' --run '<脚本编写目录>' --base-url %PLUMB_URL% --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
# ready=true 后再提交（命令行与 <<'EOF' 同行）
node '<技能目录>/tools/submit-plans.ts' --hub %HUB_URL% --run '<脚本编写编号>' --model '<模型>' --plans '<自动化用例目录>' <<'EOF'
%HUB_TOKEN%
EOF
node '<技能目录>/tools/fetch-run.ts' --hub %HUB_URL% --run '<脚本编写编号>' --out '<新目录>' <<'EOF'
%HUB_TOKEN%
EOF
node '<技能目录>/tools/generate-workbook.ts' --run '<新目录>' --result '<新目录>/result.json' --submission '<新目录>/submission.json' --out '<新目录>/case.xlsx'
```

submit-plans 与 fetch-run 从标准输入取 %HUB_TOKEN%，Plumb 脚本用 --key-stdin 传入 %PLUMB_API_KEY%，fidelity-brief、fidelity-apply 与生成工具只读本地文件。文件不覆盖；按工具提示修正，不猜另一种写法。上机返工见第 5 节，不手工结转；禁交已进 `merge_run` 的旧运行或当前 `merge_run`。

Hub 上机前核对 Excel、构建、设备数、测试环境使用权及前后对应关系；脚本合并运行只由合并工具开，不手写 `start_run`。

## 4. 上机验证

脚本合并核对正确且仍持有整个测试环境时，Hub 开始上机验证。只说明已按合成执行器规则或发布的执行器规则核对，不证明在真实设备上跑得通。无结论就写明缺什么，并继续补资料或重新核对，不拿未知结束。

```sh
node '<技能目录>/tools/download-returns.ts' --hub %HUB_URL% --run '<合并或上机编号>' --out '<新目录>' --wait 3600 <<'EOF'
%HUB_TOKEN%
EOF
```

tools/delivery.md 带 `--wait 3600` 的下载**必须 `background` 启动、不给 `timeout`**（前台上限 600 秒会拒收，后台的 `timeout` 到点即结束作业），等后台通知不 `sleep`；超时未完不写盘并退出 1，按同命令续等。全部通过即按 tools/delivery.md 第 5 节组交付目录。设备只经 Hub 或 `test-bed` 到达，严禁终端工具直连（`terminal_connect`/`telnet`/`ssh`）。有失败不停在报告、不问使用者，直接按下节返工；不释放 `test-bed` 预订（返工可复用）；仅使用者要求或收尾时发 `{"pack":"test-bed","inputs":{"inventory":{"external":"doc:doc:bed-topology"}},"predecessor":"<预订号>","parameters":{"action":"release","booking":"<同一预订号>"}}`。

## 5. 失败分析

每条原始用例最多编写并上机 3 轮，严禁第 4 轮；第 3 轮仍未写对即停止上机验证，仍跑一次下面的 rework。完整读 `index.json`（含 `execution_refused`、`syntax_rejected`）、逐条会话与 `log.txt` 互校（可用 `tools/task-brief.ts --role '失败分析' --round <n>` 写盘派只读子代理，在 `notes.json` 记 `"round"` 且不改计划）后再写原因与下一步。先核版本一致、配置生效与手册及示例前置（含对端配对）是否漏写，查多案同症共因。上轮改过再跑仍出同句设备报错即证伪上轮假设，必须换向；设备点出所缺且手册/示例支持未试假设时，尚有轮次就必须下一轮先试，不得以“缺资料”或“剩一次机会”为由不试；轮次用完不开第 4 轮，按收尾规矩写结论（没有结构化归因时原因写还没查清），把未试的假设和试法写进下一步，交使用者决定（无任何来源支持才归“缺资料”）。返工（只改失败案）：分析后跑下面的命令（`--returns` 写本轮回传目录；第 3 轮 `--open` 写上次给的文件）：它新开运行、结转通过的、重派没过的，3 轮用完则改开交付卷（只结转通过的）；照第 0 节启动循环，之后照它的 `message` 办。回传“没有发出”不算一轮，原因消除后重跑合并。

```sh
node '<技能目录>/tools/pipeline.ts' rework --state 'pipeline.json' --open 'open-compile.json' --returns '<新目录>' --notes 'notes' --hub %HUB_URL% --plumb %PLUMB_URL% <<'EOF'
%HUB_TOKEN%
%PLUMB_API_KEY%
EOF
```

排除这些且无未试手册/示例假设后才判设备的问题（期望忠实实现、前置全有、观察方法/对象正确且命令未被拒绝）；说不清写无结论、原因还没查清，加只读观察再验。设备输出只助排错，不抄进期望；点名的命令或配置先在同构建手册和命令树读到再改。时序、等待推测是未确认判断，不符即换解释。
