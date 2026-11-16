---
name: recompose
description: 把原始用例整理成重组后的用例，保留原意、原句、改写后的步骤、具体取值和缺的资料。脚本编写前按全量或给定范围处理原始用例，需要敏捷平台上的文档号。
---

# 用例重组

原始用例经过用例重组，得到重组后的用例，再交给脚本编写。这里搬运原文，不创作内容，不能加原始用例没写的对象或动作；有来源的前置欠缺写入 `sources.states`，交脚本编写补齐并配对逆清理。Hub 已按脑图位置读出原始用例的意图、动作和期望，不调用模型。

本地工具在客户端给出的 `<技能目录>`。命令与文件仅写工作目录相对路径（禁 `/tmp` 等外部目录）；`execute` 只运行单行 `node '<技能目录>/tools/<脚本>.ts' --选项 '值'`（空格隔开）。`%HUB_URL%` 与 `%HUB_TOKEN%` 由客户端执行时展开；需令牌的工具不在命令行或文件写令牌，只在命令末尾接三行标准输入 `<<'EOF'` / `%HUB_TOKEN%` / `EOF`。

每条原始用例只写一句结论，带 ID 加标题、结论、状态和判断。状态只用未确认、已确认、未知，模型的判断是未确认；判断只用正确或错误，未知不替它写判断。错误或未知才写原因和下一步。原因用缺资料、原始用例的问题、编写模型的问题、临时故障、设备的问题或还没查清。证据和决定者放最后；决定者用程序、模型、使用者。工具参数与内部引用留在机器可读部分。

## 读原始用例

按范围或全量一次处理并封批原始用例：若使用者一开始就只点做部分用例，从第一次运行（`recompose`）起即传与后续 `case-compile` 相同的 `parameters.scope`（`scope.md` 与 `parameters.scope.words` 用同一原话，完整脑图仍作为上下文整份下载，Hub 仅对 `scope.cases` 内用例投影条目并按冻结全集在 `full_set` 封批；后续 `case-compile` 范围须为其冻结条目的子集，范围在首次 `start_run` 时定死，中途换范围或扩大须重新 `start_run` 重开 `recompose`）；未传 `scope` 时，处理整份全部带 `autoid`、未声明不自动化的原始用例（分片不能独立封整批，仅后续脚本编写用 `parameters.exclude` 排除时不免除整批结案，缺任何一条都会阻塞封批）。与后面的脚本编写使用同一构建的手册和命令树；先整份下载，再读每条原始用例及手册和命令树，在本地读和搜，不逐条、逐页取 Hub。

```text
start_run: pack=recompose；inputs.subject=<同一份脑图>
product/build/version: start_run 顶层，与后续 case-compile 相同
parameters.scope: {"words":"<范围原话>","cases":["<autoid>",...]}（可选；与 scope.md/case-compile 同原话，完整脑图仍下载作上下文；不传则选整份带 autoid、未声明不自动化的原始用例）
本地原始用例: items/<序号>.json 中 fields.atoms
本地来源: sources.json、sources/<摘要>（含完整脑图）；手册和命令树: knowledge/
引用照抄下载文件中的“引用”行，不自行拼接
```

```sh
node '<技能目录>/tools/download-run.ts' --hub %HUB_URL% --run '<用例重组编号>' --out '<新目录>' <<'EOF'
%HUB_TOKEN%
EOF
```

## 写重组后的用例

意图和期望保持原始用例原句，工具会逐字取出，不用重打。写错位置的验证方法或结果可以搬到对应位置，不重新表述。否定、条件、差异和命令都留下；命令可以改参数，不删改、不替换作者的被测对象、被测动作或边界条件，也不凭空增设无来源的新测试目标；使作者命令在设备上成立所缺的功能前置必须在第 2 步从手册查全写入 `states`（`missing_prerequisite`）。

重组后的用例不带具体设备或测试环境真实地址，脚本编写时再按测试环境选；写入 `adapted.commands` 或 `slots` 的每条命令都必须是**具体可执行的完整命令行**（按 `knowledge/` 锁定命令树 `words` 逐词抄写，所有必填 `<argN:...>` 与选用的可选 `[...]` 参数一律替换为合法具体字面值：字符串用双引号如 `"web1"`、整数写十进制数、未选用的 `[...]` 直接省略，严禁保留 `<argN:...>`、`[...]`、`...` 或 `<中文>`）。若命令语法必须含目标 IP 字段且未给出固定值，填 RFC 5737/3849 文档保留地址（如 `192.0.2.10` 或 `2001:db8::1`）并在 `unknowns` 写明待脚本编写按测试环境替换。正例：`sdns service ip "web1" 192.0.2.10`；反例：`sdns listener <arg1:ipv4/ipv6> [<arg2:int ...>]` 或带 `<源IP>` 尖括号写法。说不清就写缺什么以及谁接下来做什么，不编造答案。只有“设置成功”这种说法、没有能判断的观察目标时，仍然缺资料。

读手册（含同构建手册正文、跨章说明与配置示例），把原始用例成立所缺的前置写全并记入 `states`（`missing_prerequisite` + `prerequisites` + `reason`，含功能默认关闭、依赖对象没建、监听前提、多端本端与对端对称配置）；若对原始动作作了等价改写或步骤补全，在 `adapted` 写明 `equivalence_reason` 与 `equivalence_refs`。注意原始用例若明确要测“前置不存在/未配置”的反向场景，只记清该前提是测试条件，不写成必补前置。不要假设测试环境已经具备；运行器仅对已声明清配对象经 \`cmd_config\` 发出且命中清理前缀表（如 \`clear.py\` 前缀规则；运行器清配置并在收尾末尾执行 \`write memory\` 存盘）的配置，在第 2 条及之后用例开始前与整本结束关闭连接时自动清理；第 1 条用例前、其余设备、未命中规则的命令及跨步前置条件均须显式准备与恢复（运行器收尾覆盖的存盘等命令只写主步骤，不写 \`cleanup:true\`）。

每条原始用例写一个文件，**只接受下面这一种精简机器形状**（`submit-records` 会自动封装为 `recompose-record@1`；严禁写完整 `schema`/`case`/`contract`/`atoms`/`coverage`/`ledgers` 或 `handling`，否则将被拒收）。除前两项外可省略；没有提出问题的原句保持原样。具体字段取值（如 `method.kind` 允许 `declared`、`recomposed`、`missing`）以 `tables/recompose-format.json` 为准。

```json
{
  "item": "<下载文件中的 id>",
  "method": {"kind":"declared","text":"怎么验证","sources":["<引用>"],"basis":"为什么这样验证"},
  "slots": [{"atom":"a4","knowledge_location":"has_verification_knowledge","evidence":[],"proposal":null}],
  "states": [{"atom":"a2","state":"missing_prerequisite","reason":"缺什么","prerequisites":["要先做什么"]}],
  "adapted": [{"atom":"a2","action":"structural_completion","text":"改写后的步骤","commands":["完整命令行"],"equivalence_reason":"为什么保持原意","equivalence_refs":["<手册或命令树引用>"]}],
  "concretizations": [{"slot":"e1","value":"具体取值","value_ref":"<来源引用>","source_kind":"catalog"}],
  "unknowns": [{"missing":"缺什么","next_action":"接下来谁做什么","audience":"编写模型","due":"脚本编写之前"}]
}
```

```text
method.kind: declared=原始用例写了方法；recomposed=方法在别处搬来；missing=确实没有，须写 unknowns
knowledge_location: has_verification_knowledge=能判断期望；recomposable_from_elsewhere=别处有依据，写 evidence；genuinely_missing=缺依据，写 proposal
states.state: underdetermined=写法不清；missing_prerequisite=缺前置，写 prerequisites；settled=已有决定
adapted.action: parameter_change=改参数；equivalent_form=等价写法；structural_completion=补全结构
adapted.commands: 完整命令行，由对应构建的命令树解析
引用: method.sources、slots.evidence、adapted.equivalence_refs 每项都是引用，不是原句文字；本用例原句取 items/<序号>.json 里 fields.atoms[].reference，手册和命令树取 knowledge/ 里“引用”行的 tree:…
```

## 原始用例与手册不一致

原始用例要求的取值或写法被手册和命令树排除，期望却是成功时，先让使用者决定，不自行改写，也不照写上机。原始用例要测的正是非法输入、期望就是被拒绝时，不算这种问题。先读同一构建的手册原话，保存其引用。

只有主代理问使用者。子代理不问，把原始用例 ID 加标题、原句、构建号、手册原话及引用交给主代理。整份原始用例的这类问题攒齐了问一次：以手册为准改写；或保留原始用例，这条暂不做脚本编写，等作者决定。使用者另有明确决定就照做，已经决定的不再问。

只用已有字段保存决定，不另造结构。尚未决定的写明原因和下一步，脚本编写先排除，交付时写原始用例的问题，不为凑轮数上机。

```text
已决定: states.reason 以“使用者决定：”开头，逐字写使用者的话；state=settled
按手册改写: adapted.action=parameter_change；equivalence_reason 引用决定
确定取值: concretizations.decided_by="使用者"；value_ref=<手册引用>
暂不编写或尚未问到: state=underdetermined；reason 写原句、手册原话及使用者的决定（没有就如实写）
unknowns: missing 写原始用例与手册不一致；next_action 写作者或使用者决定
脚本编写: parameters.exclude=[autoid,...]；交付说明写 author_conflict，见 tools/delivery.md
不用 conflict: 它要求两个有签发权的来源，原始用例和手册都不是
```

## 交给脚本编写

```sh
# 提交前先离线自检：UTF-8/JSON 语法、单一精简格式、item 唯一/完整性，并用冻结的运行和命令树跑 Hub 对重组记录的检查（支持单文件或目录，不接触 Hub）
node '<技能目录>/tools/check-record.ts' --file '<重组后的用例目录>' --run '<下载运行目录>'
# 注意：命令行与 <<'EOF' 必须在同一行（空格隔开，切勿在 <<'EOF' 前换行）
node '<技能目录>/tools/submit-records.ts' --hub %HUB_URL% --run '<用例重组编号>' --model '<模型>' --records '<重组后的用例目录>' <<'EOF'
%HUB_TOKEN%
EOF
```

提交前先跑 `check-record.ts`，必带 `--run`，`ok=true` 才提交：它离线检出编码/语法错误、完整 schema 字段误用、缺 `item`/`method` 或同 `item` 重复，并用同一份冻结的运行和命令树把 Hub 对重组记录的检查（`record`、`full_set`）跑一遍，Hub 会拒绝的问题（引用写成原句文字、取值不在声明范围内、改写后的命令不合命令树等）这里同样报出，按报出的位置和值改完再提交；不带 `--run` 时结果里 `hub_checks.ran` 为 `false`，只核对了形状，不能当作 Hub 会接受；再由 `submit-records.ts` 从标准输入取令牌，补齐能按规则确定的内容，把本次范围内的重组后的用例一次交给 Hub（未设 `scope` 时即为整份）。每条已投影的原始用例都要有文件；按答复指出的错误改后重交，全部核对正确才完成。

```text
脚本编写与脚本合并: inputs.recomposition_run={"reference":"<run_reference>"}（取下载目录 references.json 或导出顶层的 run_reference）
inputs.recomposition_result={"run":"<用例重组编号>"}（已有 accepted_result_reference 也可 {"reference":"<该值>"}）
```

后续脚本合并、上机验证和失败分析按 case-compile 技能做。

提交前的使用者决定逐字写入 sources.states 的 settled 条目与 reason。重组封批后不改已保存记录；在后续编写工作目录 scope.md 用明确的“## 全局”或“## 用例 <完整ID>”标题与“使用者决定：<原话>”逐行记录，由编写简报保留来源。未知标题不自动当全局，代码引用不作为决定。
