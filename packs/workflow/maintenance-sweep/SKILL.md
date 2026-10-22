# 维护巡检

Hub 按两个构建的影响视图直接算出较早构建里需要维护的用例。不需要你提交结果。

1. 开始运行：pack 写 maintenance-sweep；inputs.impact 绑定一个影响视图，例如 `{"external":"knowledge:impact:<产品>:<起始构建>..<目标构建>"}`。这个任务包不绑定产品线，不要写 product、version、build。
2. 结果在开始运行时就算好了。每个条目是一条需要维护的用例。完整结论在 result.reference 指向的校验结果里，用 get_nodes 按这个 rec: 引用读取。条目多时照回答末尾的说明翻页。
3. 原样转述每条结论，不补全、不猜测。两条不通过要分开读：
   - `maintenance-sweep.case.command_removed` 是阻断：用例所在的命令已删除。处理是“按替代命令改写这条用例，或者停用它”。
   - `maintenance-sweep.case.command_changed` 是提示：命令还在，定义有差异。结论文字写前 3 处字段差异，全部差异在数据里。
4. 只改了行为说明、或路径是新增的，不是维护项。索引没有收录的用例这里不作结论；较早构建有跳过的文档时，照结论里的句数转述，没有维护项并不能证明没有过期的用例。
5. 可选参数 ignore_fields 列出比较定义时跳过的顶层字段名。同名的嵌套字段仍比较。
6. submit_result 不是必需的。要补充看法时可以提交，看法记为模型转述的判断，不改变 Hub 算出的结论。
