# 模板类别核验（模板 v3，R1）

Hub 不调用模型。类别语义来自作者原件的 `category_ids`，或你逐用例提交的模型判断；Hub 只核验结构、身份、逐字引文、用例归属与集合运算。引文存在不证明分类语义正确，结果仍需独立复核查漏。不得用关键词、词典、同义词、前缀、自由文本正则判断类别，也不得把 Functional 等测试类型标签映射成 functional。

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

本包要收窄到一份文档时照抄：`knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=document&only=1001&fields=document,node,commands,command_identities,title,path_labels`。

1. 用 get_workflow 读此版本的要求项、槽位及本规程末尾按 `tables/template-v3.json` 列出的描述性闭集。类别的 id、label、group、description 供阅读，不能编译成文字匹配规则。24 个类别的必选范围与用户跳过政策在 `template-v3-coverage.json`。
2. start_run：pack=template-gap；documents 绑定敏捷平台脑图或 upload_file 回执。要对照某个构建时，product 和 build、version 写在 start_run 顶层，与 pack、inputs 并列，用来锁定目录，不写进 parameters。每份脑图一个条目。默认 case_rule=marked；tagged 会与按命令的默认用例范围不一致，按回执改用 marked 重跑。批量过大时拆批。
3. 可选 case_index 绑定 `knowledge:index:<产品>:<同构建>?kind=case&key=document&only=<本次敏捷平台文档编号>&fields=document,node,commands,command_identities,title,path_labels`。only 不多不少，不含上传文件。commands 是 command_identities 派生的路径集合；完整身份包含根、路径、签名及带类型的参数，不能按路径相同合并不同参数调用。
4. 读 start_run 的条目字段和运行记录。unclassified 是还缺类别判断的用例，不是缺类别。读取原件中这些用例的节点及下属步骤/结果；用模型逐用例判断可适用类别，按该包声明的 id 提出 CategoryJudgment。每条写 item（用例编号）、category_id、quote、producer；quote.identity 写原件 source_sha256、kityminder@1、精确 selector、原始字节 span（unit=byte、offset、length），quote.text 逐字对应这些原始字节；producer 显式写 model_id、model_family_id。不得拿祖先、兄弟或嵌套用例的同文当证据。JSON 转义和双重编码按原始字节身份写，不正规化宽窄、大小写或空白。
5. submit_result：每份文档条目的 slots.coverage 为 SlotClaim 列表，每条的 data 是一份 CategoryJudgment，statement 是你的分类陈述。已有作者精确声明且不另补判断的文档也显式交 coverage:[]。空列表只代表没交模型判断，不能把未分类用例变成已分类。提交回执不受理时，按逐条结构/引文错误修正后重交；原件字段非法时请作者改正原件再重读、开始新运行，不暗中修剪或映射标签。
6. 遇到未分类立即继续第 4–5 步补判断，不停下来向用户索要已绑定的原件。来源读失败则按回执重读；命令身份缺失则用新生产器重产知识、重读索引并开新运行；命令未连接则按文档键和精确修订事实补同步。补证仍失败时记清缺的事实及做过的动作，交具名集成者 Claude 作为设计缺口，本轮不得声称核验完成。
7. skipped 只按用户明确声明填写：category 是精确 id，reason 照用户原话，可选 document 限定文档；可选 command 是完整 CommandIdentity 对象，不能写命令路径字符串。它与未分类分栏披露，不制造覆盖证据；默认文档跳过也应用于该文档每个命令身份。
8. 完整范围内全部用例分类完成后，才把未覆盖、未显式跳过的必选类别称为缺类别。按命令的结果比较完整身份；缺 command_identities 的旧根不能判覆盖完整。已找到的覆盖和计数可据证转述，未见部分、未读完整范围、未分类和显式跳过分别说明。计数含全量，证据列表只为显示截断。
9. 最终只转述受理回执及其限定：类别语义仍是作者声明或模型判断，Hub 核对的是引用和集合；不要把“引用核验通过”说成“语义正确”。引用新的结果记录。旧运行、旧结果、旧根的字节不改写；由集成者另行对旧规则结果追加 legacy_keyword_rules 注记及新模型/包/根/运行血缘，真实重产由集成者执行。

## 发布表的类别声明

| id | 名称 | 分组 | 模型可读说明 |
| --- | --- | --- | --- |
| functional | 功能测试 | test_type | 用例检验所声明功能的行为与结果。 |
| configuration | 配置测试 | test_type | 用例检验配置的设置和生效行为。 |
| integration | 集成测试 | test_type | 用例检验多个组件协作的行为。 |
| compatibility | 兼容性测试 | test_type | 用例检验不同环境或版本之间的兼容行为。 |
| negative | 反向测试 | test_type | 用例检验不合法输入或失败路径的预期行为。 |
| stress | 压力测试 | test_type | 用例检验负载或容量压力下的行为。 |
| command_add | 命令的添加 | command | 用例检验命令创建对象的行为。 |
| command_delete | 命令的删除 | command | 用例检验命令移除对象的行为。 |
| command_modify | 命令的修改 | command | 用例检验命令更改对象的行为。 |
| command_query | 命令的查询 | command | 用例检验命令读取对象信息的行为。 |
| show_at_maximum | 最大配置下的 show | command | 用例检验配置达到所声明上限时的信息展示。 |
| no_command | no 命令 | command | 用例检验模板规定的 no 命令行为。 |
| clear_command | clear 命令 | command | 用例检验模板规定的 clear 命令行为。 |
| operation_log | 操作日志 | command | 用例检验操作日志记录的内容和行为。 |
| audit_log | 审计日志 | command | 用例检验审计日志记录的内容和行为。 |
| configuration_sync | 配置同步 | configuration | 用例检验配置在节点之间同步的行为。 |
| configuration_save | 配置保存 | configuration | 用例检验配置持久保存的行为。 |
| configuration_restore | 配置恢复 | configuration | 用例检验从保存状态恢复配置的行为。 |
| configuration_clear | 配置清除 | configuration | 用例检验清除配置的行为。 |
| upgrade_new_to_new | 升级兼容：新版本之间 | upgrade | 用例检验两个新版本之间升级的兼容行为。 |
| upgrade_old_to_new | 升级兼容：老版本到新版本 | upgrade | 用例检验老版本升级到新版本的兼容行为。 |
| upgrade_new_to_old | 升级兼容：新版本到老版本 | upgrade | 用例检验新版本回退到老版本的兼容行为。 |
| security | 安全 | other | 用例检验所声明的安全需求。 |
| database | 数据库 | other | 用例检验数据库相关的行为和结果。 |

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
