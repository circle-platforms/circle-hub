# 模板类别核验（模板 v3，R1）

Hub 不调用模型。类别语义来自作者 `category_ids` 或模型逐用例判断；Hub 核结构、身份、逐字引文、用例归属和集合。引文存在不证明语义正确，仍需独立复核查漏。禁止关键词、词典、同义词、前缀、自由文本正则判断类别；不将 Functional 等测试类型标签映射为 functional。

## 知识视图标识

写法 `knowledge:<视图>:<产品>:<构建>[?参数]`；产品按登记大小写照抄。以下均为合成示例。

- facets：`knowledge:facets:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&by=commands`。必填 kind、by。
- index：`knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=commands`。必填 kind、key。
- impact：`knowledge:impact:ORBIT:Rel_ORBIT_7_1_0_29..Rel_ORBIT_7_1_0_30?changed=definition&attached=case`。构建段写成 `<起始>..<目标>`；changed、attached、catalog 可以不写。
- links：`knowledge:links:ORBIT:Rel_ORBIT_7_1_0_30`。没有必填参数，prefix 默认 /。

注意：四段之间用冒号，不用 @；构建和视图必填参数不能省略。

收窄到一份文档时照抄：`knowledge:index:ORBIT:Rel_ORBIT_7_1_0_30?kind=case&key=document&only=1001&fields=document,node,commands,command_identities,title,path_labels,object,command_tree_root`。喂入索引的条目引用是 `rec:`，条目摘要是来源记录摘要；`data.object` 才是共享的用例内容身份。旧树条目仍用 `tree:`。

1. 用 list_task_packs 读此版本的输入和要求项；start_run 后从运行回执及其运行记录读取槽位模式。本规程末尾按 `tables/template-v3.json` 列出描述性闭集。类别的 id、label、group、description 供阅读，不能编译成文字匹配规则。24 个类别的必选范围与用户跳过政策在 `template-v3-coverage.json`。
2. start_run：pack=template-gap；documents 绑定敏捷平台脑图或 upload_file 回执。要对照某个构建时，product 和 build、version 写在 start_run 顶层，与 pack、inputs 并列，用来锁定目录，不写进 parameters。每份脑图一个条目。默认 case_rule=marked；tagged 会与按命令的默认用例范围不一致，按回执改用 marked 重跑。批量过大时拆批。
3. 可选 case_index 绑定 `knowledge:index:<产品>:<同构建>?kind=case&key=document&only=<本次敏捷平台文档编号>&fields=document,node,commands,command_identities,title,path_labels,object,command_tree_root`。only 不多不少，不含上传文件。commands 是 command_identities 派生的路径集合；完整身份包含根、路径、签名及带类型的参数，command_tree_root 标明签名来自哪棵命令树，不能按路径相同合并不同参数调用。
4. 读运行条目；unclassified 是还缺类别判断的用例，不是缺类别。模型读用例、步骤和结果，逐用例提出 CategoryJudgment：item、category_id、quote、producer。producer 显式声明 model_id、model_family_id；quote.identity 写原件 source_sha256、kityminder@1、精确 selector 和字节 span（unit=byte、offset、length），quote.text 逐字对应原件。span.offset 从原件第 0 字节算；src 的 :from-to 是片段内 UTF-8 字节区间，不可互换。转义或双重编码时写原件字节，显示文字只供判断。无法取得跨度则未知，请维护者核对原件；不得猜、借祖先/兄弟/嵌套用例引文或正规化宽窄、大小写、空白。

   定位跨度：安装 mindmap-format 1.0.2 或之后的本地工具；旧运行仍由锁定版本核验。对完整原件运行 `node <mindmap格式目录>/tools/parse-model.ts --source <原件> --out <模型文件>`；候选写成 `[{"item":"<用例编号>","selector":"<节点>","text":"<显示原文>"}]`；运行 `node <mindmap格式目录>/tools/locate-quotes.ts --source <原件> --model <模型文件> --candidates <候选> --out <结果>`。一处直接选，多处选位置，零处核对来源。按 README 将显式类别、引文选择及一次声明的模型身份交给 `node <本包>/tools/prepare-claims.ts --located <结果> --choices <选择> --identity <身份> --out <主张>`，批量生成 coverage；Hub 核验引文及用例归属。原件和结果仅放私有目录。
5. submit_result：每份文档条目的 slots.coverage 为 SlotClaim 列表，每条的 data 是一份 CategoryJudgment，text 是你的分类陈述。已有作者精确声明且不另补判断的文档也显式交 coverage:[]。空列表只代表没交模型判断，不能把未分类用例变成已分类。提交回执不受理时，按逐条结构/引文错误修正后重交；原件字段非法时请作者改正原件再重读、开始新运行，不暗中修剪或映射标签。
6. 未分类时继续第 4–5 步，不索要已绑定的原件。来源读失败按回执重读；缺命令身份就用新生产器重产、重读索引并开新运行；命令未连接则按文档键和精确修订补同步。仍失败时记录缺失事实和已做动作，交维护者处理，不声称完成。
7. skipped 只按用户明确声明填写：category 是精确 id，reason 照用户原话，可选 document 限定文档；可选 command 是完整 CommandIdentity 对象，不能写命令路径字符串。它与未分类分栏披露，不制造覆盖证据；默认文档跳过也应用于该文档每个命令身份。
8. 完整范围内全部用例分类完成后，才把未覆盖、未显式跳过的必选类别称为缺类别。按命令的结果比较完整身份；缺 command_identities 或 command_tree_root 的旧根不能判覆盖完整，按回执补齐缺的事实后重读。已找到的覆盖和计数可据证转述，未见部分、未读完整范围、未分类和显式跳过分别说明。计数含全量，证据列表只为显示截断。
9. 最终只转述受理回执及其限定：类别语义仍是作者声明或模型判断，Hub 核对的是引用和集合；不要把“引用核验通过”说成“语义正确”。引用新结果；旧记录不改写，维护者另行追加旧规则注记与新模型、包、根、运行的血缘。

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

喂入层：读取来源触发喂入，投影可能在后台继续；缺事实时为未知；按回执查状态，不把暂时的空清单当作没有用例。视图按锁定树苗和冻结序号读取已完成的可见记录；版本未声明和矛盾的对象单列计数，不进版本差。Circle 经 knowledge-contribution 回注语义（带逐字引文），结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
