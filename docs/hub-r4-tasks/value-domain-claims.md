# 任务：手册对参数取值的说明，由程序在交计划时拒绝说明之外的取值

依据：

- 所有者的决定（2026-11-11，第 6 项）：计划里命令的字面参数，手册对这个参数的说明排除的取值（太长、含手册不允许的字符、是保留字），在交计划时由程序拒绝。这一条超出参考实现（参考引擎）的做法：它只按类型、个数、整数范围和封闭枚举拒绝，长度和字符留给写计划的人判断。
- 运行 23（`packs/workflow/case-compile/README.md` 的 3.15.0 一节）：一个用例三次派发都配了一个含手册该参数一行不允许的字符的主机名，设备每次回格式错误，用例改了两次没改名，眼看要成缺陷候选。那一行当时不在锁定根里，现在产品包已经保留它，并记着它说明哪条命令的哪个参数（`data.parameter = {commands, name}`，产品包 1.7.49），简报也把这些行列在命令下面。
- 规矩（所有者 2026-10-24）：不用关键词、词典或自由文本正则读手册的句子做检查和抽取；语义交模型主张，逐字引用，由 Hub 核对引文存在。所以这里不是程序去读手册那一行找长度或字符，而是模型读、交一条类型化的主张，程序只核对引文和主张里写出的数字、字符、词是否出自这一行，再按类型化的字段拒绝。

- 分支：`it-value-domain`（从 f5849a42f3 开出），供集成分支审阅合并。
- 可改路径：`packs/skill/command-tools/{README.md,SKILL.md,skill.json,pack.json,functions/modules/command-check/value-domain.ts,functions/modules/command-check/value-domain.test.ts}`、`packs/workflow/case-compile/{functions/plan-commands.ts,functions/subject.ts,functions/value-domain.test.ts,functions/generated/skills/command-tools/command-check/value-domain.ts,pack.json,recompose/functions/generated/skills/command-tools/command-check/value-domain.ts,recompose/pack.json}` 和本页。
- 这一页做了什么：第 4 到第 6 节所说的程序和测试做完了（不需要改模型）；第 7 节是调查结果；第 8 节是需要模型、契约和 Hub 核心改动的部分，只写了建议文字，没有动 `contracts/model.json`、`contracts/codes.json` 和 `hub/`；第 9 节是要所有者定的事。
- 先读：`AGENTS.md`、`packs/workflow/knowledge-contribution/SKILL.md`、`packs/workflow/case-compile/README.md`（3.15.0）、`hub/knowledge/applicability-claims.ts`（同类先例）。

## 1. 要解决的事

计划里的命令是模型写的，值也是。命令树管得住类型、个数、整数范围和封闭枚举，管不住手册里用文字说的限制：长度、能用哪些字符、哪些词不能用。这些限制在手册那一行里（"该参数指定主机名……特殊字符仅支持……"）。运行 23 的那一行没有人对着计划看，设备拒了才发现。

要的是：手册这一行排除的取值，不用等设备拒，交计划时就拒，并告诉写计划的人是哪一行、哪一句。

## 2. 参考实现怎么做，这里哪里一样、哪里不一样

| 参考实现 | 这里 |
|---|---|
| 每个参数位置带一组取值说明，种类 enum、union、range、length、default，每条说明记来源和位置（种类和来源都是闭集） | 每条主张带手册那一行的引用和原文，每条规则带它依据的原句 |
| 手册这一行的取值说明，由维护脚本用正则从句子里读出长度、区间、默认值 | 不读句子。模型读，交类型化的字段；程序只核对字段里的数字、字符、词出自引文 |
| 手册里的参数按名字落到命令树的参数上，同名参数不止一个就跳过（名字比较不分大小写）；长度说明只落在文本参数上 | 一样：按参数名落，同名参数恰好一个才用（名字要精确相等，Hub 准入时已核过命令树里有这个名字）；只用在文本类参数上，数字、地址、枚举、关键字按它们自己的类型判 |
| 拒绝只看类型、个数、整数范围和来源是命令树限制、手册表或足迹的封闭枚举；长度和默认值在它的命令查询工具里写作“只供参考，不是拒绝规则” | 长度、字符、保留字也拒（所有者的决定） |
| 判定不一致不是硬失败，而是一条要用户裁决的冲突，给出选项 | 这里是 `refute`，和现在整数范围、类型不符的拒绝一样；作者要测非法输入的情形见第 9 节 |
| 读命令语法时，手册表的枚举通过几道否决后才当封闭集，区间只在这一行只说明一个参数时才取；构建命令时只拒枚举和整数区间。它的历史记录里有一条教训：把参数表的列表当封闭集，造出过反向的假拒绝 | 同一个教训：规则里“仅”的含义是模型的判断，写错会错拒；所以要有撤回、分歧时不用、拒绝文字里指明依据 |

两件事不和参考实现一样，是故意的：它的取值说明由脚本读句子得来，这里不许；它让长度只供参考，这里拒。

## 3. 设计：谁做什么

1. 模型读手册那一行（简报里列在命令下面，每行带引用），按第 4 节的形状交一条回注，种类是新的“取值范围主张”，经现有的知识回注工作流（`knowledge-contribution`）交，和适用条件主张（`applicability_claim`）走同一条路。
2. Hub 在回注边界上机械核对（第 5 节）：引文逐字出自这一行；这一行确实是说明这个命令的这个参数的手册行；主张里写出的每个数字、字符、词都出现在它那条规则的引文里；这条命令和这个参数在锁定命令树里找得到。核对过的主张作为锁定根这个构建的一条回注保存，等级是判断，不升级。
3. 一次运行检查计划时，Hub 把所选命令的、仍有效的主张和命令目录条目一起交给检查（第 7、8 节）。
4. 检查（`case-compile` 的 `plan-commands.ts`）把规则用在计划命令的文本参数上，不合的拒绝，文字里写明依据。没有主张时什么都不变。

模型的判断留在第 2 步之前：哪些话是限制、“仅支持”是不是唯一的、是否不分大小写。程序不替它读，也不替它纠。

## 4. 主张的形状（闭集字段）

一条主张是：

```json
{
  "entry": "<手册那一行的条目摘要，64 位十六进制>",
  "commands": ["demo host name"],
  "parameter": "host_name",
  "rules": [ { "kind": "...", "...": "...", "quote": "这条规则依据的原句" } ]
}
```

回注的 `data.source` 是这一行：`reference` 写 `tree:<根><路径>@<条目>`，`quote` 逐字写这一行里承载这条主张的那段原文。`commands` 写这一行说明的命令写法（取自条目的 `data.parameter.commands`，可以只写其中几条），`parameter` 写参数名（必须等于条目的 `data.parameter.name`）。

`rules` 是 1 到 10 条规则，同一种只写一条。每条规则是下面十种之一，`quote` 必须是 `data.source.quote` 里的一句原话：

| kind | 字段 | 意思 |
|---|---|---|
| `max_bytes` | `limit` | 取值最多 limit 个字节（UTF-8） |
| `max_characters` | `limit` | 取值最多 limit 个字符 |
| `part_max_characters` | `limit`、`separator` | 按 separator 分开的每一段最多 limit 个字符 |
| `allowed_specials` | `characters` | 取值只含 ASCII 字母、ASCII 数字和这里列的字符，别的都不行 |
| `forbidden_characters` | `characters` | 取值不含这里列的任何字符 |
| `not_at_start` | `characters` | 取值不以这里列的字符开头 |
| `not_at_end` | `characters` | 取值不以这里列的字符结尾 |
| `wildcard` | `character` | 这个字符只能是取值的第一个字符；在那里它不受 `allowed_specials` 限制 |
| `reserved_words` | `words`、`case_insensitive` | 整个取值不能是这些词；`case_insensitive` 说明比较时是否不分大小写 |
| `no_whitespace` | 无 | 取值不含空白字符 |

这十种来自手册里实际有的几类限制，没有编新的概念：长度（字节和字符、整个值和每一段）、能用的字符（列出的特殊字符、禁用的字符、不能放在头尾的字符、通配符的位置）、保留字（带大小写的比较方式）、空格。不在这十种里的（最小长度、必须以字母开头、要加引号、格式、依赖别的参数的取值）不写，模型不确定时少写：少写只会少拒，不会错拒。

一个合成的例子（手册行和命令都是编的）：

> 该参数指定主机名。取值必须为长度不大于253个字节的字符串，由“.”分隔的各部分长度不能超过63个字符。特殊字符仅支持“._-”，通配符“*”只能位于起始位置。不允许为保留字“default”或“all”，这些保留字不区分大小写。取值不能包含空格。

```json
{ "entry": "<64 位十六进制>", "commands": ["demo host name"], "parameter": "host_name",
  "rules": [
    { "kind": "max_bytes", "limit": 253, "quote": "长度不大于253个字节" },
    { "kind": "part_max_characters", "limit": 63, "separator": ".", "quote": "由“.”分隔的各部分长度不能超过63个字符" },
    { "kind": "allowed_specials", "characters": [".", "_", "-"], "quote": "特殊字符仅支持“._-”" },
    { "kind": "wildcard", "character": "*", "quote": "通配符“*”只能位于起始位置" },
    { "kind": "reserved_words", "words": ["default", "all"], "case_insensitive": true, "quote": "不允许为保留字“default”或“all”，这些保留字不区分大小写" },
    { "kind": "no_whitespace", "quote": "取值不能包含空格" } ] }
```

按这条主张，`demo host name a:b` 被拒：含手册没有允许的字符“:”。`demo host name *.example` 过。

真实手册里这一类参数的说明（在参考引擎的手册目录里看过，不写进仓库）用这十种都说得下。

## 5. Hub 核对什么，哪些还是模型的判断

程序核对的（纯函数 `claimProblems`，在命令工具技能的模块 `value-domain.ts` 里；Hub 做回注准入时要调它，见第 8 节）：

- 每条规则的引文是 `data.source.quote` 里的原句（逐字，不改空白、全半角和大小写）；`data.source.quote` 又逐字出自 `reference` 指的那一行（现有的回注引文核对）。
- 规则里写出的每个数字，是它那条规则的引文里的一整串数字（`25` 不能靠 `253` 里的两位，`63` 不能靠 `163`）；每个字符、分隔字符、通配符，每个保留字，都出现在它那条规则的引文里。写成带千位逗号或汉字数字的数字，写不出来，就不写这条规则。
- 形状是闭的（`readValueRules`）：规则种类、字段、个数、每个字符是单个字符、没有重复；允许的特殊字符里不能有字母和数字，不能和禁用的字符矛盾，通配符不能同时是禁用字符。
- 同一模块里还有两个纯函数，Hub 准入时调（见第 8 节），条目数据和命令目录由 Hub 读出来交给它们：`rowProblems` 核这一行的 `data.parameter` 说明的正是这个参数、这些命令（精确相等）；`bindingProblems` 核锁定命令树里有这些命令，且某个签名里名字相同的文本参数恰好一个，否则这条主张永远用不上，不收。

程序不核对、仍是模型的判断的：

- 这些话是不是限制；“仅支持”是不是真的唯一；`case_insensitive` 写 true 还是 false；规则适用的范围（这一行的限制是不是依赖别的参数的取值）。
- 引文存在不证明含义正确。主张的依据等级是判断，不升级，不当事实用，拒绝的文字里这样写明。

用在计划上时再核一遍（`readValueDomainClaims`）：形状不合的、引文不在这一行里的、字符不在引文里的主张，检查当它不存在。这是使用端在使用前重读有效条件（模型 B01 R[3]）。

## 6. 程序怎么用它

命令工具技能的模块 `packs/skill/command-tools/functions/modules/command-check/value-domain.ts`，纯函数，不引入别的文件：

- `readValueRules`、`readValueDomainClaim`、`readValueDomainClaims`：读闭集形状。
- `claimProblems(rules, row)`、`rowProblems(entryData, commands, parameter)`、`bindingProblems(tree, commands, parameter)`：第 5 节程序核对的部分。
- `checkValue(rules, value)`：一个取值违反了哪几条规则，每条一句话。
- `effectiveRules(claims)`：同一个参数有几条主张时，哪些规则在用。
- `valueDomainRefusals(command, parameters, claims)`：一条已解析命令的拒绝。

`case-compile` 的 `plan-commands.ts` 在命令被锁定语法完整解析、得到身份之后，对它的每个参数调 `valueDomainMessages`：

- 命令写法取自身份的路径（`/commands/demo/host/name` 就是 `demo host name`），和主张的 `commands` 精确相等才用；参数按名字精确相等，同名参数恰好一个才用（参考实现也这样做：同名不止一个就跳过）。
- 只用在文本取值上：参数类型是 `string`、`hostname`、`ip_or_hostname`，且语法把值读成文本。数字、被读成地址的值（`ip_or_hostname` 里的 IPv4、IPv6）、枚举成员、关键字按它们自己的类型判。取值是去掉引号的值，带空格的值要加引号写，空格就算进去。
- 同一个参数的几条主张，同一种规则说法一致就用一条；说法不一致（两条主张的字节数上限不同，或一个说不分大小写一个说分）这一种就都不用，别的种类照用。程序不挑对自己合适的那一边。
- 拒绝是 `refute`，指针是那条命令行的参数位置。文字写命令、参数、取值（过长截短）、状态未确认、判断错误、原因和下一步，最后放手册原句和决定者模型；内部引用保留在传入的主张里。
- 没有主张、主张不合形状、主张是别的命令的、别的参数的：什么都不变。主张从检查的输入进来，不随检查结果往下传。

主张怎么进检查的输入：`planSubject` 把输入里的 `value_domains`（数组）放进它封存的 `command_catalog`，`planCommands` 从那里读。Hub 现在不提供这个字段，所以线上行为不变；Hub 供给的部分见第 8 节。

## 7. 调查：喂入的事实今天怎样到达一次运行，主张放哪

- **喂入层**（`hub/knowledge/feeding.ts` 的 `FeedingLayer`）：程序把运行里读到的用例、缺陷、规格、构建、上传说明写成喂入对象；Circle 的操作记录（观察、步骤、教训）也走回注槽写进来；运行开始时冻结一个喂入偏移（`feeding_offset`，在 `RunContext` 里），之后重放看到同一个范围，撤回仍然生效。读它有两条路：客户端用 `get_nodes` 读节点页；工作流声明一个 `knowledge:index`、`facets` 或 `impact` 视图输入（`hub/knowledge/views.ts`，例如 `case-compile` 的可选输入 `case_index`），`start_run` 时绑定，包函数从输入里读到视图。喂入层只收程序从来源读出的事实，模型对语义的主张不进这一层。
- **回注层**（`hub/knowledge/contributions.ts` 的 `ContributionLayer`）：Circle 把本地解读成事实的东西经 `knowledge-contribution` 工作流交回来，Hub 按锁定根核引文和路径后存成 `knowledge-contribution@1` 记录，挂在节点路径上、不计根摘要，产品读者可读，带有效状态（有效、被引片段已变、根据已撤回），管理员可追加撤回。适用条件主张（`applicability_claim`，`hub/knowledge/applicability-claims.ts`）是现成的先例：类型化的字段、`QuoteEvidence` 引文、准入时核对、读侧单独显示判断状态。
- **检查收到什么**（`hub/runs/engine/evaluate.ts` 的 `runContextOf` 和 `builderInput`）：运行上下文（运行号、产品、根、`command_policy`、`feeding_offset`……）和包自己的 `catalog_select` 选出命令后 Hub 读出的目录条目。`command_policy` 是从锁定根的头部读来、在 `start_run` 冻结的（`hub/runs/engine/command-policy.ts`）。到今天，回注层的东西不会进到检查的输入里；喂入层的内容只有通过绑定的视图输入才到包函数。

放哪，比较过四处：

| 放处 | 结论 |
|---|---|
| 喂入层 | 只收程序从来源读出的事实，不收模型对语义的主张。不选 |
| 产品包里的数据表（作者手写） | 是产品内容，要人写，不是这里决定的“模型读、Hub 核”的路。不选 |
| 随计划一起交 | 写计划的同一个模型替自己的计划写限制，不独立；每份计划都要重写，也积累不起来。不选 |
| 回注层，新种类 | 正是“客户端把语义用逐字引文回注”的位置；有现成的准入、有效状态、撤回、跨根延续（同一路径的被引片段没变，在别的根上仍然有效）。选这一处 |

读取：和 `command_policy` 一样在检查输入里带，范围按这条检查已选出的命令目录条目来选（`catalog_select` 选出的命令，不超过 512 条），每条命令只带它的、仍有效的主张。

## 8. 需要模型、契约和 Hub 核心改动的部分（只写建议文字，没有实现）

这些要模型负责人和契约负责人先定，不是这一项能改的：新的产出种类是词表值（`contracts/model.json` 的 `document_output_kind`），AGENTS.md 要求枚举只出自生成物。

**8.1 模型（`contracts/model.json`）**

1. 词表轴 `document_output_kind`（K03）加一个值：`value_domain_claim`，标签“取值范围主张”。
2. 新增词表轴 `value_rule_kind`（K03），标签“取值规则种类”，值和标签：`max_bytes` 字节数上限、`max_characters` 字符数上限、`part_max_characters` 分段字符数上限、`allowed_specials` 允许的特殊字符、`forbidden_characters` 禁用的字符、`not_at_start` 不能开头的字符、`not_at_end` 不能结尾的字符、`wildcard` 通配符位置、`reserved_words` 保留字、`no_whitespace` 不含空白。规则种类现在写在模块里（`VALUE_RULE_KINDS`），轴进模型后模块改读生成的快照。
3. K03 加 R[8]：“取值范围主张是回注层的一类：对象是锁定根里一行手册对一个命令参数的说明（条目的 data.parameter 记着命令和参数名），内容是封闭种类的规则（长度、字符、保留字等），每条规则带它依据的原句。Hub 只做确定性核对：引文逐字出自该行；该行说明的正是这条命令的这个参数；规则里写出的每个数字、字符、词出现在它那条规则的引文里；这条命令和参数在锁定命令树里对得上，且是文本类参数。规则的含义（是否‘仅’、是否不分大小写、适用范围）仍是模型的判断，等级为判断，不升级。同一参数的主张对同一种规则说法不一致时，这一种规则不用。管理员撤回即失效。”
4. 回注准入拒绝的原因都能落到现有的码：形状不合、规则里的字面值不在引文里、这一行不说明该参数，用 `SUBMISSION_SCHEMA_VIOLATION`；条目或命令在锁定根里找不到，用 `REFERENCE_UNRESOLVED`；引文不是逐字，用 `QUOTE_MISMATCH`。**不需要新增错误码。**

**8.2 契约（`contracts/src`，生成物随之重新生成）**

- `contributions.ts`：`ValueDomainClaimInput`（`entry`、`commands`、`parameter`、`rules`，规则是 `kind` 区分的联合，字段如第 4 节，严格对象）；`ContributionInput` 的 `superRefine` 加一条：只有 `value_domain_claim` 种类带 `value_domain_claim` 字段（和现有的 `applicability_claim` 一条一样）；`AdmittedValueDomainClaim`（输入加 `admission: {composition, row, command_entries}`：组成的摘要、这一行的摘要、各命令在锁定树里的条目摘要）；`KnowledgeContributionBody` 加可选的 `value_domain_claim`；`WithheldContributionBody` 去掉它。
- `pack.ts`：`ItemSubjectInput` 加可选的 `value_domains: z.array(z.unknown())`；检查声明（`checks.json` 的检查条目）加一个标志说明这条检查要这些主张，`hub/runs/packs/validate.ts` 核对它必须同时声明 `catalog`。
- 规则的纯函数现在放在命令工具技能的模块里（技能模块是自成一体的文件夹，不能引用外面）。Hub 核心不能引用包里的文件。照 `command-grammar.ts` 的先例：源文件放 `contracts/src/value-domain.ts`，`tools/gen-contracts.ts` 同时生成 `contracts/generated/value-domain.ts` 和模块里的副本，Hub 引用生成的那份。文件不引入任何东西，搬过去是机械的。

**8.3 Hub 核心**

- `hub/knowledge/value-domain-claims.ts`（新）：`admitValueDomain`，写法照 `admitApplicability`，在 `ContributionLayer.prepare` 里、对 `value_domain_claim` 种类调用：
  1. `data.source.reference` 必须是 `tree:<input.root><路径>@<条目>`，条目等于主张的 `entry`，且在这次锁定的组成里。
  2. 读该条目，调 `rowProblems(content.data, commands, parameter)`：`data.parameter.name === parameter`，主张的每条 `commands` 都在 `data.parameter.commands` 里。条目没有 `data.parameter` 就拒：这不是说明某个参数的手册行。
  3. 调 `claimProblems(rules, source.quote)`：每条规则的引文是 `source.quote` 的子串，规则里的数字、字符、词在它那条规则的引文里；结果为空才收。
  4. 读这些命令在锁定树里的定义条目（`reading.nodeAt(root, ['commands', ...词])`，条目数据的 `words` 和 `signatures`），调 `bindingProblems(entries, commands, parameter)`：某个签名里名字等于 `parameter` 的参数恰好一个，且类型是文本类（`string`、`hostname`、`ip_or_hostname`）；否则拒，说明“这条规则用不上”，不让一条永远用不上的主张存进去。
  5. 凭据扫描 `JSON.stringify(claim)`（`scanPublicText`）。
  存的内容：主张加准入证明；身份摘要（`identityOf`）把它算进去。
- 索引：存主张时对每条命令写一个索引值 `knowledge.contribution.value_domain`，值为 `digestOf({product, command})`，供按命令查。
- `ContributionLayer.valueDomains(root, commands, reader, horizon)`：按索引取这些命令的主张，只留有效状态为“有效”的（被引片段没变、没被撤回、读者能读），返回第 4 节形状加 `reference`、`row`（即 `source.quote`）、`record`。
- `hub/ports.ts` 的 `KnowledgePort` 加 `valueDomains`；`hub/runs/engine/evaluate.ts` 的 `builderInput` 在已选出目录之后，对这些目录条目的命令调它，把结果放进检查输入的 `value_domains`，条数和字节数设上限（照 `selectCatalog`：512 条、1 MiB，超出时按“拆分计划后重核”提示）。
- 范围的冻结：新增的主张在运行开始之后不进这次运行（照 `feeding_offset`），撤回立即生效。建议在 `start_run` 冻结一个回注偏移，和 `feeding_offset` 并排；检查重放时看到的主张不随后来的新主张变。
- 谁的主张用：所有能读这个产品的人交的、状态有效的主张。这个范围见第 9 节。

**8.4 回注包（`packs/workflow/knowledge-contribution`，模型改后才能写）**

- `SKILL.md` 加一条（建议文字）：

  > 8. 手册对命令参数取值的说明（长度、允许的字符、保留字）：读那一行手册（条目的 data.parameter 写着它说明哪条命令的哪个参数），交一条 code=value_domain_claim 的回注。data.source 引这一行（tree:<根><路径>@<条目>）并逐字引文；data.value_domain_claim 写 {entry, commands, parameter, rules}，每条规则是十种 kind 之一，带类型化字段和 quote（它依据的原句，逐字出自这一行）。规则里的每个数字（整串数字）、字符、词都要出现在它自己的 quote 里，否则 Hub 拒收。只写手册这一行明确说了的：“支持字母、数字、特殊字符”没有列出是哪些特殊字符，就不写 allowed_specials；“特殊字符包括……”如果列的是需要加引号的那一类字符，不是允许清单，也不写；一行对不同取值或不同条件有不同规定时，不写。allowed_specials 的意思是除字母数字和这些字符外都不行，只在手册说“仅支持”这类唯一性时写；reserved_words 的 case_insensitive 只在手册写明不区分大小写时写 true。Hub 只核对引文、命令和参数名、数字字符和词是否出自这一行；规则的含义仍是你的判断，写错会让别人的计划被拒，管理员可以撤回。

- `slots.schema.json` 由 `pack-files.ts` 从生成的契约重新生成，不手改；`tables/quotes.json` 不用改（规则的引文由准入核对）。

**8.5 `case-compile`**

- 检查声明（`checks.json`）那个标志；`SKILL.md` 的“参数取值”一条加一句：计划里的取值被 Hub 已核的手册说明拒绝时，照拒绝文字改值，认为解读有误请管理员撤回，不自己绕开。
- 简报（`authoring-brief.ts`）在手册行下面列出该行已有的有效主张，写计划的人先看到程序会拒什么。这要运行下载里带回注，是后续的事。

## 9. 要所有者定的事

1. **作者要测非法输入的用例。** `case-compile` 的 `SKILL.md`（“参数取值”一条）现在写“作者要测的正是非法输入时照写”。程序一拒，这样的用例（超长域名、带非法字符的名字）就编不出来；作者自己在步骤里写的值含手册不允许的字符也一样，写计划的人没法改。整数范围和类型不符今天已经是这样拒的，这里把同样的做法扩到长度和字符。要不要开一个口子：建议是计划里对某条命令行声明“这是测非法输入”，附作者那句话的逐字引文，程序核对这句话在作者原文里，然后放过这一条（披露）；这要改计划的槽位结构，没有做。
2. **谁的主张对所有人生效。** 一条主张进回注层后，会拒所有人的计划。建议先按“能读这个产品的人交的、状态有效的都用”，靠第 5 节的核对、分歧时不用、拒绝文字指明回注记录、管理员撤回来兜；也可以要求管理员确认过才用。
3. **全角字符。** 手册里有的特殊字符写成全角（例如全角的叹号、冒号）。程序按码位精确比较，不折叠；写成全角的列表就是全角字符的列表，半角的同一个符号不在里面。模型要么照手册的字写，要么在拿不准手册意思时不写 `allowed_specials`。折叠全半角是改规则，要所有者定。
4. **主张分歧时不用**：按种类逐种处理（一种说法不一致就不用这一种，别的种类照用）。要不要改成整条主张都不用，或者给用户一个明确的未知并写明下一步。
5. **第一条真实主张**要在所有者的环境里，由 Circle 对着生产手册的真实一行交。仓库里没有、也不会有真实手册行和真实主张；这里的例子都是合成的。

## 10. 没做的

- 第 8 节全部（模型、契约、Hub 核心、回注包、`case-compile` 的声明和说明、简报）。
- 最小长度、必须以字母开头、必须加引号、格式（“格式为……”）、依赖别的参数的取值、命令之间的关系，这些规则种类没有；将来加种类要走模型。
- 检查通过时不披露“多少个文本取值有主张、多少个没有”：没有主张的取值只是没被核，通过的文字没有提这一点。
- 没有升版本：`command-tools`、`case-compile`（含 `recompose`）的内嵌副本和清单已重新生成，版本不变；发布时 Hub 核对内嵌文件等于已发布的技能版本，要先升技能版本、改工作流的 `embeds`、重签。CHANGELOG、`docs/hub-r4-progress.md` 和包 README 的版本记录没改。

## 11. 测试

都是合成数据，没有真实手册行、命令和地址。本次只执行 `node --test packs/workflow/case-compile/functions/value-domain.test.ts`，8 通过、0 失败、0 跳过；模块的单独测试文件未执行。

- `packs/skill/command-tools/functions/modules/command-check/value-domain.test.ts`：形状（每种拒绝各一例）、引文和字面值核对（`25` 不能靠 `253`、字符不在引文里、词的大小写）、这一行是否说明这个参数、命令树里是否有这个文本参数、每种规则的边界（正好到上限、多一个、汉字三字节、代理对算一个字符、每段、列表外的字母、通配符、保留字的大小写、空白）、分歧和互相矛盾的处理、按名字和类型落到参数。
- `packs/workflow/case-compile/functions/value-domain.test.ts`：含不允许字符的主机名在 `planCommands` 里被拒并写明依据；合规的值、上限、通配符放过；没有主张或主张对不上时结果和以前逐项相等；数字参数、被读成地址的值不被文本规则判；分歧；不合形状或引文对不上的主张当不存在；经 `checkCommandsKnown` 成为命令检查的拒绝；`value_domains` 经 `planSubject` 进到封存的命令目录；长取值和长列表的文字不超长。
