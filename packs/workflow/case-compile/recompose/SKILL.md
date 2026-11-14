---
name: recompose
description: 把原始用例整理成重组后的用例，保留原意、原句、改写后的步骤、具体取值和缺的资料。脚本编写前处理整份原始用例，需要敏捷平台上的文档号。
---

# 用例重组

原始用例经过用例重组，得到重组后的用例，再交给脚本编写。这里搬运原文，不创作内容。Hub 已按脑图位置读出原始用例的意图、动作和期望，不调用模型。

本地工具在客户端给出的 `<技能目录>`。命令与文件仅写工作目录相对路径（禁 `/tmp` 等外部目录）；`execute` 只运行单行 `node "<技能目录>/tools/<脚本>.ts" --选项 值`（空格隔开）。`%HUB_URL%` 与 `%HUB_TOKEN%` 由客户端执行时展开；需令牌的工具不在命令行或文件写令牌，只在命令末尾接三行标准输入 `<<'EOF'` / `%HUB_TOKEN%` / `EOF`。

每条原始用例只写一句结论，带 ID 加标题、结论、状态和判断。状态只用未确认、已确认、未知，模型的判断是未确认；判断只用正确或错误，未知不替它写判断。错误或未知才写原因和下一步。原因用缺资料、原始用例的问题、编写模型的问题、临时故障、设备的问题或还没查清。证据和决定者放最后；决定者用程序、模型、使用者。工具参数与内部引用留在机器可读部分。

## 读原始用例

一次处理整份原始用例，与后面的脚本编写使用同一构建的手册和命令树。先整份下载，再读每条原始用例及手册和命令树，在本地读和搜，不逐条、逐页取 Hub。

```text
start_run: pack=recompose；inputs.subject=<同一份脑图>
product/build/version: start_run 顶层，与后续 case-compile 相同
选择: 带 autoid、未声明不自动化的原始用例
本地原始用例: items/<序号>.json 中 fields.atoms
本地来源: sources.json、sources/<摘要>；手册和命令树: knowledge/
引用照抄下载文件中的“引用”行，不自行拼接
```

```sh
node <技能目录>/tools/download-run.ts --hub %HUB_URL% --run <用例重组编号> --out <新目录>
```

## 写重组后的用例

意图和期望保持原始用例原句，工具会逐字取出，不用重打。写错位置的验证方法或结果可以搬到对应位置，不重新表述。否定、条件、差异和命令都留下；命令可以改参数，不能删除，也不能加原始用例没写的对象或动作。

重组后的用例不带具体设备或测试环境地址，脚本编写时再按测试环境选；若命令语法必须含目标 IP 字段（例如 `sdns service ip <名字> <IP>`）且未定出合规保留占位时，先在 `adapted` 保持 `command_tree` 可解析的原值或在 `unknowns` 写明待脚本编写按测试环境替换，不用 `<中文>` 尖括号自造语法。说不清就写缺什么以及谁接下来做什么，不编造答案。只有“设置成功”这种说法、没有能判断的观察目标时，仍然缺资料。

读手册，把原始用例成立所缺的前置写全。例如功能默认关闭、依赖对象没建、查询前要有服务监听。不要假设测试环境已经具备，执行器在每条自动化用例结束后都会清理配置。

每条原始用例写一个文件，机器形状如下。除前两项外可省略；没有提出问题的原句保持原样。具体字段的取值以 tables/recompose-format.json 为准。

```json
{
  "item": "<下载文件中的 id>",
  "method": {"kind":"declared","text":"怎么验证","sources":["<原句或手册引用>"],"basis":"为什么这样验证"},
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
node <技能目录>/tools/submit-records.ts --hub %HUB_URL% --run <用例重组编号> --model <模型> --records <重组后的用例目录>
```

令牌从标准输入给工具。工具补齐能按规则确定的内容，把整份重组后的用例一次交给 Hub。每条原始用例都要有文件；按答复指出的错误改后重交，全部核对正确才完成。

```text
脚本编写与脚本合并: inputs.recomposition_run={"reference":"<run_reference>"}（取下载目录 references.json 或导出顶层的 run_reference）
inputs.recomposition_result={"run":"<用例重组编号>"}（已有 accepted_result_reference 也可 {"reference":"<该值>"}）
```

后续脚本合并、上机验证和失败分析按 case-compile 技能做。
