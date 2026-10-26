# 质量看板

Hub 直接算出一个构建的用例质量看板：每个（版本线、模块）分组的用例数、无期望结果占比、只有含糊期望结果占比、负面用例占比，以及整个构建的合计。不需要你提交结果。

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

本包照抄这三条（同一产品、同一构建）：
`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=line,module,has_expected,vague_expected,negative`
`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`
`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=line,module,tags`

1. 开始运行：pack 写 quality-board；inputs.facets 写 `{"external": "knowledge:facets:<产品>:<构建>?kind=case&by=line,module,has_expected,vague_expected,negative"}`（可以在 by 里加 priority 等字段，不影响分组）。同时必须绑定 inputs.placement：`{"external":"knowledge:facets:<产品>:<构建>?kind=case&by=commands"}`，角色为提示，只披露未归位数，不作阈值判据。需要测试类型覆盖时，inputs.facets 改成两个对象的数组，再加 `{"external":"knowledge:facets:<产品>:<构建>?kind=case&by=line,module,tags"}`，计数视图和标签视图不得合成一个，三个视图必须同产品同根。这个任务包不绑定产品线：不要写 product、version、build（顶层和 parameters 都不要）——输入里的外部标识已经写明产品和构建，运行不会去锁定别的构建。
2. 结果在开始运行时就算好了：每个条目是一个分组（条目编号是 `<版本线>/<模块>`，没有归组的版本线或模块是 unplaced），摘要是“用例数、三项个数和占比”，完整结论在 result.reference 指向的校验结果里。逐条结论用 get_nodes 读取；条目多时照回答末尾的说明接着读。
3. 原样转述每个分组的指标和阈值结论，不补全、不猜测：
   - 占比是精确分数（结论数据里是 num/den），转述用展示值（四位小数或一位百分数）；“超过上限”“低于下限”是提示档的不通过，等于阈值不算越界。
   - 三个阈值可以用参数调整：max_missing_ratio、max_vague_ratio（默认 0.05）、min_negative_ratio（默认 0.02）。
4. 合计（要求项 totals）在结果的 cross_item 里：整个视图的用例数和三项总数，并写明看板覆盖已索引文档的每一个用例（未归位表示没有命令归属的用例，与有没有树上位置不同，也计入合计）——没读到的来源不在其中，所以它描述的是已索引的用例，不是整套测试。视图有列出的来源没读或被截断时，合计的说明里照写，转述时不要略去。
5. 阈值结论是管理信号，不是缺陷：不要写成“不通过的测试”或“质量不合格”，照“超过/低于阈值”转述。
6. submit_result 不是必需的；要补充看法时可以提交，看法记为模型转述的判断，不改变 Hub 算出的看板。

7. 标签视图只给六种测试类型的出现、未见和未打标签用例数，不给每种的精确用例数。同一用例可能有同类型的多个标签。其余 18 类需要步骤和期望等原文，这个视图看不到，请另开 template-gap；不能把未见标签写成没有这类测试。
8. 标签视图截断或有未读来源时，原样转述“部分”和“在已读的来源里没看到”，自动同步未读来源并重新获取同根标签视图重跑。若仍截断，明确报告分面补读能力缺口并交集成者补取，不把它当最终完整覆盖。
9. 未归位数按合计里的“未归位（没有命令归属的用例） N 个”原样转述。placement 截断且没有空组时会拒绝启动：缺的是未归位数。自动重新获取同根未截断的 by=commands 视图并重试；当前接口不能分页，也不支持 only=，不要发出虚构查询。仍取不全时报告知识包汇总能力缺口，请集成者补取不可截断的未归位汇总字段后再运行，不能以未知结束。有来源未读时自动同步这些来源并重新运行，说明这个数只覆盖已索引的来源。

含糊比例只引用已受理评审判断，写明已判断分母、未判断数和冲突数；没有判断时先补 case-review 和同根 cases 索引，不转述旧 vague_expected。引文存在不证明语义判断正确。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
