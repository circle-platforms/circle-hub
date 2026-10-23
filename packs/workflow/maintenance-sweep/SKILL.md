# 维护巡检

Hub 按两个构建的影响视图直接算出较早构建里需要维护的用例。不需要你提交结果。

1. 开始运行时必须在 inputs.facets 绑定 `{"external":"knowledge:facets:<产品>:<起始构建>?kind=case&by=commands"}`，与 impact 的起始根相同。分面截断会拒绝启动：先重新读取完整分面，补齐未归位计数，再自动重试开始运行。开始运行：pack 写 maintenance-sweep；inputs.impact 绑定一个影响视图，例如 `{"external":"knowledge:impact:<产品>:<起始构建>..<目标构建>?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1"}`（catalog=commands@1 把变更限定到命令目录的成员按语法比，手册说明的改动不算；视图没写目录时结论里会有一句提示：只按种类比，可能混进其他生产器的条目）。这个任务包不绑定产品线，不要写 product、version、build。
2. 结果在开始运行时就算好了。每个条目是一条需要维护的用例。完整结论在 result.reference 指向的校验结果里，用 get_nodes 按这个 rec: 引用读取。条目多时照回答末尾的说明翻页。
3. 原样转述每条结论，不补全、不猜测。两条不通过要分开读：
   - `maintenance-sweep.case.command_removed` 是阻断：用例所在的命令已删除。处理是“按替代命令改写这条用例，或者停用它”。
   - `maintenance-sweep.case.command_changed` 是提示：命令还在，定义有差异。结论文字写前 3 处字段差异和"另有 M 处"（至多 200 字符），全部差异只在运行级详情里各写一份。
4. 只改了行为说明、或路径是新增的，不是维护项。索引没有收录的用例这里不作结论；较早构建有跳过的文档时，照结论里的句数转述，没有维护项并不能证明没有过期的用例。
5. 可选参数 ignore_fields 列出比较定义时跳过的顶层字段名。同名的嵌套字段仍比较。
6. submit_result 不是必需的。要补充看法时可以提交，看法记为模型转述的判断，不改变 Hub 算出的结论。

6. 原样转述“有 N 个用例没有解析出命令（未归位），没算进巡检范围”这句确定披露；它不改变已归位用例的结论。N 大于 0 时不能在披露后结束：客户端接着用 get_nodes 读取同一产品起始构建的 `knowledge:index:<产品>:<起始构建>?kind=case&key=document&fields=commands,document,node,title`，按 only= 分份读取全部文档，选出 commands 为空的用例，列出编号和标题供用户查看。截断分片继续按更小的 only= 补取，不能把未读完说成没有。缺少的事实是这些用例的命令归属；请用户查看用例确定归属。Hub 只分发和核验，不生成命令归属、不调用模型。K2 回注通道尚未接入，这一版不提交归位提议。
