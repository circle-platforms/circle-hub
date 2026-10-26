# 维护巡检

Hub 按两个构建的影响视图直接算出较早构建里需要维护的用例。不需要你提交结果。

1. 开始运行时必须在 inputs.facets 绑定 `{"external":"knowledge:facets:<产品>:<起始构建>?kind=case&by=commands"}`，与 impact 的起始根相同。分面截断会拒绝启动：自动读取该视图 notes 和根引用，将原因报告当前用户供集成者定位预算或来源排除问题；同一根重复读取不会完整，不自动重试。待修复或不会截断的汇总接口可用、取得完整输入后继续启动。开始运行：pack 写 maintenance-sweep；inputs.impact 绑定一个影响视图，例如 `{"external":"knowledge:impact:<产品>:<起始构建>..<目标构建>?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1"}`（catalog=commands@1 把变更限定到命令目录的成员按语法比，手册说明的改动不算；视图没写目录时结论里会有一句提示：只按种类比，可能混进其他生产器的条目）。这个任务包不绑定产品线：不要写 product、version、build（顶层和 parameters 都不要）。
2. 结果在开始运行时就算好了。每个条目是一条需要维护的用例。完整结论在 result.reference 指向的校验结果里，用 get_nodes 按这个 rec: 引用读取。条目多时照回答末尾的说明翻页。
3. 原样转述每条结论，不补全、不猜测。两条不通过要分开读：
   - `maintenance-sweep.case.command_removed` 是阻断：用例所在的命令已删除。处理是“按替代命令改写这条用例，或者停用它”。
   - `maintenance-sweep.case.command_changed` 是提示：命令还在，定义有差异。结论文字写前 3 处字段差异和"另有 M 处"（至多 200 字符），全部差异只在运行级详情里各写一份。
4. 只改了行为说明、或路径是新增的，不是维护项。已读来源里没有需要维护的用例时，范围是空的记确定的支持；较早构建有跳过的文档时记未知并照结论里的句数转述（写明缺哪几份、下一步由谁补齐），没有维护项并不能证明没有过期的用例；视图没带出点名的定义条目时该条目记未知，不当作一致。
5. 可选参数 ignore_fields 列出比较定义时跳过的顶层字段名。同名的嵌套字段仍比较。
6. submit_result 不是必需的。要补充看法时可以提交，看法记为模型转述的判断，不改变 Hub 算出的结论。

6. 客户端必须用 get_nodes 读取本次 inputs.facets 绑定的源（源文件列表中 facets 槽的 src: 引用），检查其 kind=case、by=[commands] 和构建根，同时读取 truncated、skipped 和 notes。只有 truncated=false 且 skipped=0 才是完整视图；truncated=true 按第 1 步处理，不能披露为完整计数。从 values.commands 为 null 的行取 count 为 N；truncated=false 时没有这行则 N=0，但它只表示已读来源中的数量。skipped=0 时原样转述“有 N 个用例没有解析出命令（未归位），没算进巡检范围”。skipped>0 时必须转述“至少 N 个用例没有解析出命令（未归位），没算进巡检范围；另有 K 份来源未读，其中的用例不知道”，K 取 skipped；N=0 也不能说没有未归位用例。缺的事实是 K 份未读来源里的用例及命令归属；客户端立即读取 notes 和来源诊断，报告当前用户，请集成者修复或补读这些来源并重新生产根；新根取得后自动重读分面并继续披露。数值仅作线索写进回答，不生成支持或反驳主张，不改变已归位用例的结论。note.message 也按这两个分支披露，但校验结果没有计数主张，不能等校验结果替你列此数。N 大于 0 时，客户端自动从分面 build.root 读取根节点，但本轮最多展示一页 kind=case 且 commands 为空的用例样例，附上该页的下一页引用或游标，供用户选择继续。明确样例不是全量，不能把样例个数与 N 比到相等，也不能自动读完整棵根直到凑齐；需要批量核对时交给集成者在仓库外导出索引分批人工查看。缺少的事实是这些用例的命令归属；请用户查看用例确定归属。Hub 只分发和核验，不生成命令归属、不调用模型。K2 回注通道尚未接入，这一版不提交归位提议。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
