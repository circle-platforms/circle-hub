# 用例定位

Hub 按目录树直接算出每份测试脑图（或每个用例）在哪里：产品线、版本、版本线、发布火车、模块、目录和标题里写出的构建名，以及关联的需求和缺陷。不需要你提交结果。

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

本包开始运行绑的是敏捷脑图，不绑知识视图。要写知识视图时照上面四条抄。

1. 开始运行：pack 写 case-location；inputs.documents 写要定位的脑图，例如 `[{"external": "agile:mindmap:<文档编号>"}]`。产品线已由任务包绑定，start_run 不用写 product。要对照某个构建时，build 和 version 写在 start_run 顶层，与 pack、inputs 并列，不写进 parameters。一次最多约 40 份（按用例定位时一份）；回答放不下全部条目时，末尾的说明写明略去了哪些条目、用 get_nodes 怎么读（调用和翻页方式），照它读完再转述。
2. 结果在开始运行时就算好了：每个条目的摘要就是它的定位结论，完整结论在 result.reference 指向的校验结果里，用 get_nodes 读取。运行的“版本依据”是锁定的知识根，不是文档所在的版本。
3. 原样转述每个条目的结论和置信度，不补全、不猜测：目录版本层按声明的完整层级与语法解析；标题只有整段符合版本语法时才作低置信度参考，不从散文捞版本，也不提取构建日期或 patch。“目录版本层自相矛盾”是确定的冲突（提示档），保留每个版本和目录原文，转述整理目录或用 line 声明的下一步；优先报告版本层冲突，说明声明与哪些值一致。“不确定”的条目照说明转述缺的事实和下一步；“与声明矛盾”的条目以目录树给出的结论为准，并说明哪个声明与目录树矛盾。目录是敏捷平台读取时列出的，不是引用的片段。
4. 构建候选（要求项 build_candidates）：定位到的版本线在知识库里两个名称族的已知构建，按制作时间从新到旧（包括只有名字、还没有知识根的构建；制作时间相同的按名字，页上没有制作时间的排最后并写“制作时间未知”）；结论的文字逐个写出候选（构建名（名称族）、制作于 年-月-日 时:分，别名写“基于 <基础构建>”，发布状态另写“已发布 <日期>”或“未发布”），最多写前 12 个，更多的写“另有 N 个”。目录和标题里“写出的构建名”只从标签开头按包的构建语法读取，不从正文中间捞取：是候选（或是候选别名的基础）记支持；属于另一条线记不通过（提示档，写明属于哪条线）；构建站没有列出的构建名记不通过（提示档 build_not_listed，写明“不认识不等于写错”，是确定的结论不是未知）——知识库只收录构建站列出的构建。定位没给出版本线、或这条线没有已知构建时，候选记未知（缺输入），不是出错，更不是没有构建的结论。目录版本层冲突时先说冲突，再分别列出每条线的候选。候选是运行开始那一刻知识库的状态。
5. 编号只认声明的整字段语法：`bug:33001` 是缺陷，`story:33001` 是需求，多个非零十进制编号用逗号分隔；编号最多 12 位，不能有前导零、空格或全角变体。不要从散文、错拼或相似词提取编号。包在声明的位置也能读取整段纯数字列表，类型仍未声明；`id_ranges` 只按调用方声明的范围分组，并标“声明的范围”。范围不能分出类型时，包分别尝试读取需求和缺陷来源作为候选；不能凭哪一个存在或可读判断作者所指类型。保留未知与缺的事实，下一步请作者补类型，或在支持该主张的工作中提供逐字引文。结果按类别列出编号，超过 20 个时照回执写“另有 N 个”。
6. 可选参数：line 和 product 是替调用方声明的版本线和产品，只补目录树没给的部分，结论标为声明；granularity 写 case 时每个用例一个条目（用例节点带标签或带用例优先级 2 的标记，决定 18）。
7. submit_result 不是必需的；要补充看法时可以提交，看法记为模型转述的判断，不改变 Hub 算出的结论。

第一步仅绑定 PLM 期望来源，不声称 PLM 里有或没有该编号；核验等待 hub-read-absence 后的第二步。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
