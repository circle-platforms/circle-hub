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
`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=line,module,has_expected,negative,test_type_status`
`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`
`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=line,module,tags,resource_empty,tag_valid`

1. 开始运行：pack 写 quality-board；inputs.facets 写 `{"external": "knowledge:facets:<产品>:<构建>?kind=case&by=line,module,has_expected,negative,test_type_status"}`（可以在 by 里加 priority 等字段，不影响分组）。同时必须绑定 inputs.placement：`{"external":"knowledge:facets:<产品>:<构建>?kind=case&by=commands"}`，角色为提示，只披露未归位数，不作阈值判据。需要测试类型覆盖时，inputs.facets 改成两个对象的数组，再加 `{"external":"knowledge:facets:<产品>:<构建>?kind=case&by=line,module,tags,resource_empty,tag_valid"}`，计数视图和标签视图不得合成一个，三个视图必须同产品同根。这个任务包不绑定产品线：不要写 product、version、build（顶层和 parameters 都不要）——输入里的外部标识已经写明产品和构建，运行不会去锁定别的构建。
2. 结果在开始运行时就算好了：每个条目是一个分组（条目编号是 `<版本线>/<模块>`，没有归组的版本线或模块是 unplaced），摘要是“用例数、三项个数和占比”，完整结论在 result.reference 指向的校验结果里。逐条结论用 get_nodes 读取；条目多时照回答末尾的说明接着读。
3. 原样转述每个分组的指标和阈值结论，不补全、不猜测：
   - 占比是精确分数（结论数据里是 num/den），转述用展示值（四位小数或一位百分数）；“超过上限”“低于下限”是提示档的不通过，等于阈值不算越界。
   - 三个阈值可以用参数调整：max_missing_ratio、max_vague_ratio（默认 0.05）、min_negative_ratio（默认 0.02）。
4. 合计（要求项 totals）在结果的 cross_item 里：整个视图的用例数和三项总数，并写明看板覆盖已索引文档的每一个用例（未归位表示没有命令归属的用例，与有没有树上位置不同，也计入合计）——没读到的来源不在其中，所以它描述的是已索引的用例，不是整套测试。视图有列出的来源没读或被截断时，合计的说明里照写，转述时不要略去。
5. 阈值结论是管理信号，不是缺陷：不要写成“不通过的测试”或“质量不合格”，照“超过/低于阈值”转述。
6. submit_result 不是必需的；要补充看法时可以提交，看法记为模型转述的判断，不改变 Hub 算出的看板。

7. 标签视图只给六种测试类型的出现、未见和未打标签用例数，不给每种的精确用例数。同一用例可能有同类型的多个标签。其余 18 类需要步骤和期望等原文，这个视图看不到，请另开 template-gap；不能把未见标签写成没有这类测试。
8. 标签视图截断或有未读来源时，原样转述“部分”和“在已读的来源里没看到”；绑定时 Hub 会续读分页，仍不完整就补来源或请维护者补完整视图。
9. 未归位数按合计原样转述。placement 截断且没有空组时不能猜零：重新绑定同根完整 by=commands 视图；续页仍受预算或来源限制时，补来源或请维护者提供完整汇总。

含糊比例只引用同根、同原件且已受理有效的 case-review 判断：inputs.cases 绑定 `knowledge:index:<产品>:<构建>?kind=case&key=case_location`，inputs.reviews 绑定其结果 rec:。写明已判断分母、未判断数和冲突数；零分母为未判断，不转述旧 vague_expected。负向比例分母只含测试类型已声明的用例。引文存在不证明语义判断正确。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
