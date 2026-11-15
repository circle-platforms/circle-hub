---
name: case-compile
description: 把原始用例写成自动化用例，交给 Hub 核对，生成自动化用例 Excel 后上机验证并分析错误。需要这份原始用例在敏捷平台上的文档号。
---

# 自动化用例

原始用例先做用例重组，再做脚本编写、脚本合并、上机验证和失败分析。模型写自动化用例，Hub 核对并重算，不生成内容、不调用模型。

接到使用者范围说明时，主代理须先在工作目录写入 `scope.md`（首行标明 `# 使用者原话，由主会话记录`，正文逐字抄录范围原话，后续变更也逐字追加，不改写或缩减；若一开始只点做部分用例，从首次 `recompose` 起即传同一 `parameters.scope`，`scope.md` 与 `parameters.scope.words` 用同一原话且首次开运行时定死）；若单条用例范围不同，可用 `## <autoid>` 或 `## <item_id>` 分节，`task-brief.ts` 只向子代理传入全局原文与本案分节；未写 `scope.md` 不得派发任何子代理。各阶段派发子代理前，**统一且只用** `task-brief.ts` 把完整任务说明写入 `--task-file <任务文件路径>`，再把标准输出那段极短派发提示原样传给 `task`（`subagent_type` 使用输出的角色名）的 `description` 参数，不把完整任务说明重打进对话、不删改或手写简报：

```sh
node '<技能目录>/tools/task-brief.ts' --role '<用例重组|脚本编写|保真核对|失败分析>' --case <用例或范围> --brief <简报或输入路径> --out <目标路径> --task-file <任务文件路径> [--scope scope.md] [--note '<补充>'] [--round <轮次> --run <运行目录> --item <条目JSON> --prior-plans <路径...> --prior-returns <目录...> --prior-answers <路径...> --prior-notes <路径...>|--brief-json <结构简报JSON>]
```

本地工具在 `<技能目录>`（优先用安装工具，否则按 Hub 命令**装进当前主目录的 `skills` 目录**；装在别处时验收主目录的守卫会拒绝执行）。文件工具限工作目录相对路径（`.`）及只读 `<技能目录>`，写入禁出工作目录（禁 `/tmp`）。触发本地脚本与 Hub 工具时，`execute` 只写单行 `node '<技能目录>/tools/<脚本>.ts' --选项 '值'`（禁 `=`）；列目录用 `ls`，找文件用 `glob`，搜文本用 `grep`。`%HUB_URL%` 与 `%HUB_TOKEN%` 由客户端展开；需令牌的命令把 `node` 命令行与 `<<'EOF'` 写在同一行（空格隔开，切勿在 `<<'EOF'` 前换行），下一行只写 `%HUB_TOKEN%`，再一行只写 `EOF`，令牌不落盘。

每条结论只写一句，带原始用例 ID 加标题、结论、状态和判断。状态只用未确认、已确认、未知；模型的判断是未确认。判断只用正确或错误，未知不替它写正确或错误。错误或未知才写原因和下一步。原因只用缺资料、原始用例的问题、编写模型的问题、临时故障、设备的问题、还没查清。证据和决定者放最后；决定者只用程序、模型、使用者。内部引用和工具参数留在机器可读部分，不转述给使用者。

## 1. 用例重组

先用 test-bed 取得整个测试环境的使用权，设备清单要写全；刚安装构建后仍持有的可以沿用。按 recompose 技能处理原始用例（使用者一开始只点做部分用例时，从第一次 `recompose` 起传相同 `parameters.scope`，完整脑图仍下载作上下文；单条或分批经 `tools/task-brief.ts --role '用例重组' --task-file <文件>` 写入任务文件后按同法派发；提交 Hub 前先跑 `recompose` 技能的 `tools/check-record.ts` 离线自检），写出要点、改写后的步骤、具体取值和缺的资料，脚本编写与脚本合并都使用这份重组后的用例和同一构建的手册和命令树。同脑图同构建已有核对正确的重组（含新会话）直接沿用，不再重跑；确实跳过时在最终报告说明原因。

原始用例要求的取值或写法被手册排除、期望却是成功时，先让使用者决定，不照写上机，也不自行改掉；原始用例本来要测非法输入时照写。主代理把整份原始用例的这类问题攒齐问一次，带 ID、标题、原句和构建号及手册原话。重组时使用者已决定的照做，不再问。尚未决定的先排除，并按 `tools/delivery.md` 写原因和下一步。

## 2. 脚本编写

先把资料整份下载到工作目录，再读每条原始用例及对应文件。手册和命令树在本地读和搜，引用照抄，不逐条、逐页读 Hub。每条原始用例对应的 `items/<序号>.json` 与 `briefs/<序号>.md` 列有命令、参数约束、配置恢复方法、同级命令写法与待填自动化用例。派发子代理前先 `ls` 核对真实文件名（总数 `<10` 条时为 `0.md`、`0.json` 而非 `00.md`），确认 `download-run` / `fidelity-brief` / 计划或返回文件均已落盘且输出目录就绪后再调 `task-brief.ts` 与 `task`；严禁未写完 `plans/*.json` 就跑 `fidelity-brief.ts` 或派发下游子代理。

一条原始用例一个子代理，同时派出：装了 `case-writers` 扩展用 `write_case_plans`；否则每条跑 `tools/task-brief.ts --role '脚本编写' --task-file <文件>` 把任务说明写盘并将标准输出的短提示原样传参，**在同一条消息里以前台方式并列多个 `task` 调用（`subagent_type="compile-writer"`，严禁用 `background`；后台最多同时 4 个且第 5 个直接报错）**，不合并用例，**每批最多 6 个**，失败或超时的条目单独重派、不整批重来。单条编写、环境改写、前置清理与字段语法守则均由已安装的 `compile-writer` 定义提供，且已声明自动化用例的受限结构在根目录 `<技能目录>/slots.schema.json`（不在 `tables/`）、完整例子在 `<技能目录>/examples/submit-result.json`、分块格式在 `<技能目录>/tables/blocks-format.json`；只在答案会改变做法、资料里又查不到时问使用者，设备的问题还是原始用例的问题，需要使用者决定，能查清的自己查并在报告说明。子代理不问使用者：定不了的写进给主代理的报告。

每条原始用例都照原意写，按同构建手册、命令树与已声明执行器规则完成，不用确认标记绕过，也不从 help 散文推断或复制内部内容。执行器规则缺类型、用途、效果或允许范围时，按 Hub 点名的资料找维护者补齐并向使用者说明谁在补什么，缺资料的原始用例先排除、其余继续。只读自检单个计划或目录跑 `tools/check-plan.ts`。

### 主会话参数与本地工具命令

以下参数供主会话调用 Hub 与工具填写，不放进使用者答复：

```text
start_run: pack=case-compile; predecessor=<test-bed acquire run>
product/build/version: start_run 顶层，不放 parameters
inputs: subject/contract/inventory/profile；后三项用发布的 doc:doc
profile: device_count 只读预检及可选 fold_newlines
整份原始用例: 不填 parameters.autoid；单条: 原样复制 autoid 字符串
排除: parameters.exclude=[autoid,...]，脚本编写和脚本合并用同一列表
按范围: parameters.scope={"words":"<范围原话>","cases":["<autoid>",...]}（不与 exclude/autoid 同用；words 与 scope.md 同原话）；recompose 与 case-compile（编写/合并/返工）首次开运行时定死同一范围，case-compile 须为绑定重组条目的子集，中途换或扩范围须重新 start_run
跳过用例重组: parameters.pipeline=legacy
沿用已核对正确的重组（同脑图同构建）:
  inputs.recomposition_run={"reference":"<run_reference>"}（取下载重组目录 references.json 或导出顶层 run_reference）
  inputs.recomposition_result={"run":"<重组运行编号>"}（Hub 解析成已接收的结果）
本地导出: tools/normalize-mindmap.ts --in <导出文件> --out <规整文件>
上传中性文件名，说明写两边摘要和“客户端规整”，不改内容或编号
下载: node '<技能目录>/tools/download-run.ts' --hub %HUB_URL% --run <脚本编写编号> --out <新目录> <<'EOF'（接两行 %HUB_TOKEN% 与 EOF，切勿在 <<'EOF' 前换行）
本地读取: items/<序号>.json、sources.json、sources/<摘要>、knowledge/、briefs/<序号>.md
```

各计划无手写 `data.fidelity`、已展开定长占位且 `check-plan.ts` 自检为 `ok: true` 后再合并。**同运行重交与重开边界**：同一 `plan_run` 尚未进入 `merge_run`（无在途上机验证任务）、`scope`/`exclude`/`inputs` 未变且 `rounds_left>0` 时，可直接把改好的计划重交当前 `plan_run`（复用未改文件与未改 `data.fidelity`）；仅 `rounds_left=0`、已进 `merge_run` 或 `scope`/`exclude`/`inputs` 变化时才 `start_run` 新开 `plan_run`（上机返工 `predecessor` 填原 `test-bed` 预订号并用 `carry-plans.ts` 结转未改自动化用例，详见 `tools/delivery.md`），并重生成上传与新开合并；始终禁止把改过的计划直接交进 `merge_run`。单行 `start_run` 模板（无排除删 `parameters.exclude`）：
```text
start_run {"pack":"case-compile","product":"<产品>","build":"<构建>","predecessor":"<test-bed预订号>","inputs":{"subject":<原subject输入>,"contract":<原contract输入>,"inventory":<原inventory输入>,"profile":<原profile输入>,"recomposition_run":{"reference":"<run_reference>"},"recomposition_result":{"run":"<重组运行编号>"}},"parameters":{"exclude":["<排除autoid>"]}}
```
第 2 轮及以上返工派发 `脚本编写` 或 `失败分析` 前，统一经 `task-brief.ts --round <n> --task-file <文件>` 传入同案 `--prior-plans`/`--prior-returns`/`--prior-answers`/`--prior-notes`（多轮按 `1..n-1` 英文逗号分隔、缺轮写 `-`，单轮直接传路径）；`task-brief.ts` 会写入任务文件（超 1800 字符逐字长行不折行并提示行号），并在传入运行目录或 `--run`/`--brief briefs/<序号>.md` 时在内存中自动拼入同案 `compile-brief@1`（含执行器失败标志、测试环境与前置）与精简机械规则拒收 `{code, path, message, fix}`、区分“末尾 12,000 字符截断 / 输出无法唯一定位 / 未找到命令”的报错步设备逐字摘录、未确认的失败分析结论（`confidence: "hypothesis"`；`notes.json` 缺 `round` 时标为轮次未记录且不冒充第 1 轮），并对总篇幅按固定顺序截断披露；禁止手写摘要、传整批 `submission.json` 或跨用例拼接；`保真核对` 继续严格盲审，只传 `.brief.json`。

## 3. 脚本合并

先把全部自动化用例写好，再按下面顺序走完场景保真审计并一次提交给 Hub（缺审、摘要过期或格式错会在本地退出，不占修复次数）。按说明改错并自动重交，最多重交 2 次；重改计划后从第 1 步重算核对资料并重新审计；不要把 Hub 已接收内容当成全部正确。只有缺少自动化用例 Excel 时可以继续生成，其他检查都要正确。检查写成步骤符合执行器规则、期望能在原始用例里找到原句、命令在手册和命令树里、地址在测试环境里、没改掉原始用例的场景、自动化用例 Excel 和自动化用例一致、自动化用例本身写对了。

```sh
node '<技能目录>/tools/check-plan.ts' --file <计划或判断JSON> [--brief <核对文件>]
node '<技能目录>/tools/fidelity-brief.ts' --run <脚本编写目录>/run.json --plans <自动化用例目录> --out <核对目录>
# 对每份 to_audit/*.brief.json 运行 task-brief.ts --role '保真核对' --task-file <文件>（或用 --batch 核对目录），将短输出按同法前台并行 task（每批最多 6 个）写同名 .verdict.json
node '<技能目录>/tools/fidelity-apply.ts' --run <脚本编写目录>/run.json --plans <自动化用例目录> --briefs <核对目录>
# 确认工具输出为正确（ready=true）后再提交；命令行与 <<'EOF' 在同一行，切勿前换行
node '<技能目录>/tools/submit-plans.ts' --hub %HUB_URL% --run <脚本编写编号> --model <模型> --plans <自动化用例目录> <<'EOF'
%HUB_TOKEN%
EOF
node '<技能目录>/tools/fetch-run.ts' --hub %HUB_URL% --run <脚本编写编号> --out <新目录> <<'EOF'
%HUB_TOKEN%
EOF
node '<技能目录>/tools/generate-workbook.ts' --run <新目录>/run.json --result <新目录>/result.json --submission <新目录>/submission.json --out <新目录>/case.xlsx
```

submit-plans 与 fetch-run 从标准输入取令牌，fidelity-brief、fidelity-apply 与生成工具只读本地文件。文件不覆盖；按工具指出的步骤和执行器规则修正，重取正确的自动化用例，不猜另一种解析写法。原始文件上传后，Hub 再核自动化用例 Excel 与自动化用例一致。上机返工改用例后，用 `carry-plans.ts` 结转未改自动化用例并回第 2 节 `start_run`（`predecessor` 填原 `test-bed` 预订号）新开 `plan_run` 核对，重生成上传并新开 `merge_run`；禁交已进 `merge_run` 的旧运行或当前 `merge_run`。

```text
首次只有 workbook_verified 缺文件可继续；其他必需项的结论须为正确（`satisfied`）
upload_file: 普通上传 case.xlsx 原文件（不标捕获原件）；核对 SHA 与生成工具一致
第二次 start_run（同 subject/contract/inventory/profile/product/build/version 及 exclude/scope）:
  predecessor: "<脚本编写编号>"（脚本编写的运行编号）
  parameters.plan_run: "<脚本编写编号>"（与 predecessor 同一脚本编写运行号，必填）
  inputs.plan_result: {"run": "<脚本编写编号>"}（同一脚本编写运行号；多用例必填，单用例也可填）
  inputs.workbook: {"reference": "src:<upload_file 返回的 sha256>"}（`src:` 后填上传返回的 64 位摘要）
用 submit-plans.ts（参数同上，--run 填第二次 start_run 编号）加三行 %HUB_TOKEN% here-doc 重交。`reuse` 只认本次 `start_run` 返回的 `rec:` 前驱引用；自动化用例 Excel 的核对结论不提供该项，禁拿 fetch-run/submission.json 填 `reuse`。
Hub 上机前核对 Excel、构建、设备数、测试环境使用权及前后对应关系
```

## 4. 上机验证

脚本合并核对正确且仍持有整个测试环境时，Hub 开始上机验证。只说明已按合成执行器规则或发布的执行器规则核对，不证明在真实设备上跑得通。状态未知就写明缺什么，并继续补资料或重新核对，不拿未知结束。

```sh
node '<技能目录>/tools/download-returns.ts' --hub %HUB_URL% --run <合并或上机编号> --out <新目录> --wait 3600 <<'EOF'
%HUB_TOKEN%
EOF
```

tools/delivery.md 下载命令带 `--wait 3600` 时**必须用 `background` 启动**（Circle 前台 `execute` 上限 600 秒会直接拒收），等后台退出通知、不 `sleep` 轮询；若到时限仍未完成，工具不写文件并退出 1，直接按同一命令重试继续等待。设备只能经 Hub 上机验证或 `test-bed` 动作到达，严禁用终端工具（`terminal_connect`/`telnet`/`ssh`）或脚本直连设备。完成后只停在报告，不释放 test-bed 预订；要继续修正重跑，可复用同一个预订。仅在使用者要求释放或收尾释放时照抄 `test-bed` 请求（`predecessor` 与 `parameters.booking` 同写原预订号）：`{"pack":"test-bed","inputs":{"inventory":{"external":"doc:doc:bed-topology"}},"predecessor":"<预订号>","parameters":{"action":"release","booking":"<同一预订号>"}}`。

## 5. 失败分析

每条原始用例最多编写并上机 3 轮；第 3 轮仍未写对即停止上机验证、直接收尾写结论并组交付目录，严禁第 4 轮。完整读 `index.json`（含 `execution_refused`、`syntax_rejected`）、逐条设备会话文本与 `log.txt`（框架日志只记下发命令和超时，设备 CLI 报错同时记入会话文本与 `index.json`；必要时用 `tools/task-brief.ts --role '失败分析' --case <autoid> --brief returns/index.json --out <失败分析输出> --task-file <任务文件> --round <n> --item items/<序号>.json --prior-plans ... --prior-returns ... [--prior-answers ...]` 写盘并派发 `compile-attributor` 子代理只读失败分析，并在 `notes.json` 按 `tools/delivery.md` 记录 `"round"` 字段，不改计划），再给错误的原始用例写原因和下一步。先看设备构建与手册和命令树是不是同一版，再查配置是否真正生效、手册要求的前置是否都写了；多个原始用例同一症状时找共同前置，也解释为什么其他原始用例正确。确认改动并开始返工时：未进 `merge_run` 且 `rounds_left>0`、`scope`/`exclude`/`inputs` 未变直接重交当前 `plan_run`；`rounds_left=0`、已进 `merge_run` 或 `scope`/`exclude`/`inputs` 变化时先用 `carry-plans.ts` 结转未改自动化用例并按第 2 节 `start_run` 重走第 2～3 节。

排除这些后才判断设备的问题。原始用例的期望已忠实实现、手册前置全有、观察方法和对象正确，才能提出设备的问题；说不清就写状态未知、原因还没查清，在被测命令前加只读观察，下一次上机验证区分。设备输出只帮助理解错误，不抄进期望；其中点名的命令或配置，先在相同构建的手册和命令树中读到再改。时序、等待的推测是未确认的模型判断，预测不符就换解释。

运行前由运行者执行本包的 `tools/install-agents.ts` 安装四个角色定义，再启动新 Circle 会话；不要依赖旧会话隐式发现新定义。任务工具输出的角色名为本次派发唯一类型。
