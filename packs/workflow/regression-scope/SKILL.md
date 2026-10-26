# 回归范围

Hub 按两个构建的影响视图直接算出回归范围：后一构建里，放在新增或修改路径上的用例。不需要你提交结果。范围不是缺陷，没有不通过。

## 知识视图标识

写法是 `knowledge:<视图>:<产品>:<构建>[?参数]`，四段用冒号，参数在问号后。产品按登记的大小写照抄。下面用合成产品 ORBIT、构建 Rel_ORBIT_7_1_0_30，不要写成 orbit，也不要换成别的分隔符。

- facets：`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`。必填 kind、by。
- index：`knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=commands`。必填 kind、key。
- impact：`knowledge:impact:ORBIT:Rel_ORBIT_7_1_0_29..Rel_ORBIT_7_1_0_30?changed=definition&attached=case`。构建段写成 `<起始>..<目标>`；changed、attached、catalog 可以不写。
- links：`knowledge:links:ORBIT:Rel_ORBIT_7_1_0_30`。没有必填参数，prefix 默认 /。

三种写错：
（1）分隔符用了 @。错 `knowledge:facets@ORBIT@Rel_ORBIT_7_1_0_30?kind=case&by=commands`。对 `knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`。
（2）缺构建。错 `knowledge:facets:ORBIT?kind=case&by=commands`。对 `knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`。
（3）参数不全。错 `knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?key=commands`。对 `knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=commands`。

本包照抄（目标构建 Rel_ORBIT_7_1_0_30，起始构建 Rel_ORBIT_7_1_0_29）：
`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`
`knowledge:impact:ORBIT:Rel_ORBIT_7_1_0_29..Rel_ORBIT_7_1_0_30?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1`
`knowledge:impact:ORBIT:Rel_ORBIT_7_1_0_29..Rel_ORBIT_7_1_0_30?changed=behaviour`

1. 开始运行时必须在 inputs.facets 绑定 `{"external":"knowledge:facets:<产品>:<目标构建>?kind=case&by=commands"}`，与 impact 的目标根相同。分面截断会拒绝启动：自动读取该视图 notes 和根引用，将原因报告当前用户供集成者定位预算或来源排除问题；同一根重复读取不会完整，不自动重试。待修复或不会截断的汇总接口可用、取得完整输入后继续启动。开始运行：pack 写 regression-scope；inputs.impact 绑定一个影响视图，例如 `{"external":"knowledge:impact:<产品>:<起始构建>..<目标构建>?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1"}`（必须带 changed=definition：范围只按命令定义的变化算；catalog=commands@1 把变更限定到命令目录的成员按语法比，手册说明的改动不算；附着的用例条目只带这五个字段，大版本差也放得下）。视图没写目录时结论里会有一句提示：只按种类比，可能混进其他生产器的条目。要看手册说明的变化，另在 inputs.behaviour 绑同一对构建的 `changed=behaviour` 视图：它只作线索写在结论里，不进范围。这个任务包不绑定产品线：不要写 product、version、build（顶层和 parameters 都不要）。
2. 结果在开始运行时就算好了。每个条目是一条范围内的用例，摘要给出优先级、文档、变更的命令数和第一条原因的结论（新增命令、删除命令、命令定义有变更或仅说明文字有变更——手册里已有说明的新命令不会再被写成“修改”）。完整结论在 result.reference 指向的校验结果里，用 get_nodes 按这个 rec: 引用读取。条目多时照回答末尾的说明翻页。
3. 原样转述每条结论，不补全、不猜测。范围内的用例是支持（事实）。变更路径上没有用例的，记为未知（缺输入），写在跨条目结论里，不是失败：用例索引本来就不完整。后一构建的索引缺少列出的文档时，照结论里的句数转述，未覆盖的路径可能是用例没有被读到。
4. 可选参数：priorities 只保留列出的优先级；include_added 默认 true，写成 false 时新增路径不进入范围，也不记为未覆盖。一次运行最多纳入 4,000 条用例（超出会被拒绝并说明怎么收窄：先用 priorities）；空范围是合法的空结果。
5. submit_result 不是必需的。要补充看法时可以提交，看法记为模型转述的判断，不改变 Hub 算出的结论。

6. 客户端必须用 get_nodes 读取本次 inputs.facets 绑定的源（源文件列表中 facets 槽的 src: 引用），检查其 kind=case、by=[commands] 和构建根，同时读取 truncated、skipped 和 notes。只有 truncated=false 且 skipped=0 才是完整视图；truncated=true 按第 1 步处理，不能披露为完整计数。从 values.commands 为 null 的行取 count 为 N；truncated=false 时没有这行则 N=0，但它只表示已读来源中的数量。skipped=0 时原样转述“有 N 个用例没有解析出命令（未归位），没算进回归范围”。skipped>0 时必须转述“至少 N 个用例没有解析出命令（未归位），没算进回归范围；另有 K 份来源未读，其中的用例不知道”，K 取 skipped；N=0 也不能说没有未归位用例。缺的事实是 K 份未读来源里的用例及命令归属；客户端立即读取 notes 和来源诊断，报告当前用户，请集成者修复或补读这些来源并重新生产根；新根取得后自动重读分面并继续披露。数值仅作线索写进回答，不生成支持或反驳主张，不改变已归位用例的结论。note.message 也按这两个分支披露，但校验结果没有计数主张，不能等校验结果替你列此数。N 大于 0 时，客户端自动从分面 build.root 读取根节点，但本轮最多展示一页 kind=case 且 commands 为空的用例样例，附上该页的下一页引用或游标，供用户选择继续。明确样例不是全量，不能把样例个数与 N 比到相等，也不能自动读完整棵根直到凑齐；需要批量核对时交给集成者在仓库外导出索引分批人工查看。缺少的事实是这些用例的命令归属；请用户查看用例确定归属。Hub 只分发和核验，不生成命令归属、不调用模型。K2 回注通道尚未接入，这一版不提交归位提议。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
