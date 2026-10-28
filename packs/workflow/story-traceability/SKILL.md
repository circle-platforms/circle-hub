# 需求到用例的追溯

Hub 只分发和核验，所有交互动作由客户端执行。本包没有模型调用，不生成用例。

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

本包的索引用这条：`knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=stories`。

1. 先问用户产品、构建和要核对的需求编号；没有编号就询问，不猜。可选已有 PLM 构建列表与明确的构建记录编号：管理员核实真实字段后配置资源 `settings.build_story_field`。只有指定字段是编号数组才可从构建取范围；范围依据代码为 observed（用户提供编号时为 declared），显示文字来自词表标签。配置或字段缺失、数组为空、应答未包含构建编号三者分别说明；向用户索取需求编号，不能把空数组说成字段缺失。不要让用户填写字段名。用户给出编号的路径优先。
2. 编号按数字去前导零，数值排序去重，每批最多 50 个，绑定多个 `stories: [{external: "plm:stories:<编号>+…"}]`。在 `cases` 绑定 `knowledge:index:<产品>:<构建>?kind=case&key=stories`。已经绑定的需求编号由 Hub 写入 cases 的 only=；fields 缺省时补上 document、node、stories、title。不要为了收窄用例索引再向用户要一遍编号。需求编号本身仍须询问，不猜测范围。可选构建路径只绑定 `build: {external: "plm:builds:<产品编号>"}` 并给 `parameters.build_id`，Hub 从构建范围自动分批读取需求详情。不要从发布说明的缺陷范围猜需求范围。
3. `start_run` 指定 `pack: "story-traceability"`。这个任务包不绑定产品线：不要给 start_run 顶层的 product、version、build，也不要写进 parameters。构建范围只用 inputs.build 和 parameters.build_id。这是事实生产运行，不提交模型生成的结果。分页读取完整条目及跨条目统计。每个条目列出原样状态和阶段、用例、来源；PLM 没返回不算任何状态。没有状态到“已交付”的映射，不推断已交付。字段未提供只是原件里的观察事实，不要求补写或修补原件；应答里没有某编号时，立即请用户确认该编号，不宣称该需求不存在。
4. 按请求编号看结论：已列出的连接即使被裁剪也有确定事实，明细不完整时原样转述“至少 N 个索引条目”。只有没有连接且覆盖不足的编号才拒绝；按错误点名的编号核对原始键后用 only= 取命中，未命中不证明不存在；缺少规范化 only 匹配时交核心维护人补齐能力，不能靠同步消除固定上限。
5. 完整视图中无连接是确定的、有覆盖范围的事实：在锁定知识根的需求号索引中未见用例携带该编号；不推出未索引的用例不存在。汇报需求数、已追溯、无连接、PLM 应答及状态计数，引用完整视图和原件。不得把已经限定范围的事实再改成未知。

构建路径的 build_id 必须唯一，PLM 原始 name 必须和 cases 视图构建名在 NFKC、去首尾空白后逐字相同。异名回执会列出两个名字，下一步重绑与 PLM 原始 name 同名的 cases 视图后重开；不要另给 start_run 的 product、version、build，也不能猜别名。跨名称族需等待核心的只读别名查询接口。构建身份与引用从 groups[0].selected_build 读取一次；逐条转述紧凑 selected_build 的编号和 name，完整引用保留在 grounds，不能把另一个 PLM 构建的需求说成本构建的范围。

PLM 返回的状态或阶段不是单个值，是确定的观察事实：先转述汇总中的 status_nonscalar、stage_nonscalar 计数，说明没有按状态计数；不当作 null 状态分组，不改成未知，原始 JSON 在 PLM 原件中。长条目被截断时汇总计数照样保留并转述。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
