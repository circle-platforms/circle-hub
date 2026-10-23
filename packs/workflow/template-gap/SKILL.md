# 模板缺口检查（团队测试用例模板 v3）

这个任务包只有事实要求项：start_run 时 Hub 按模板表直接算出每份脑图的结果，你不需要填写槽位，也不需要调用 submit_result。

1. 开始运行：pack 写 template-gap；inputs.documents 写要检查的脑图，可以给多份，一次最多约 30 份（文档很大时更少；Hub 说输入太大时分几批运行）。敏捷平台的脑图写 {"external": "agile:mindmap:<文档编号>"}；本地文件先用 upload_file 上传，再写 {"reference": "src:<sha256>"}。用例规则参数 case_rule 默认 marked（认标签和团队模板标记），如需限制为只认标签可设为 tagged。开始运行时写 product 和 build，Hub 按 commands@1 目录绑定产品线并锁定根。可选输入 case_index 写 {"external":"knowledge:index:<产品>:<同一个构建>?kind=case&key=document&only=<本次敏捷平台文档编号，逗号分隔>&fields=document,node,commands,title,path_labels"}；only 不多不少，只含本次敏捷平台文档，不写上传文件。根或 only 不符合时整次不受理，按回执给出的锁定构建和 only 修正。
2. 每份脑图是一个条目，条目编号是文档编号（上传的文件是 upload-<sha256 前 12 位>）。条目摘要就是结果：用例数（含用例规则与靠标记识别的用例数）、缺的模板类别、参数声明跳过的类别、出现了几个模板类别，以及限制为 tagged 时未计入的未打标签节点数。模板的 24 个类别都要覆盖；摘要里的类别写成“名称（编号）”，写不下时只列编号，名称见文末的类别表。
3. 证据用例：start_run 的回答里给出了运行记录的引用（rec:<摘要>，是运行记录本身，不是“完整结果”那个校验结果的引用）时，用 get_nodes 读条目的字段：reference 写运行记录的引用加上 #/items/<条目序号>/fields（序号从 0 起，按条目列出的顺序）。字段 categories 列出每个类别是否出现、用例数和证据用例编号（按编号排序，最多 20 个），missing 是缺的类别，skipped 是声明跳过的类别。回答里没有运行记录的引用时，证据用例只在控制台的运行页里：告诉用户去那里看，不要拿校验结果的引用去读条目字段，那里没有。
4. 跳过由用户决定：只有用户明确说某个类别对某份脑图不适用并给出理由时，才重新开始运行，在参数 skipped 里写类别编号，reason 照用户的原话写，例如 [{"category": "stress", "reason": "<用户的原话>"}]；只对其中一份文档跳过时加 "document": "<文档编号>"。不要按你自己的判断跳过：你认为某个类别可能不适用时，写进第 6 步的评论，由用户决定。跳过的类别单独列出，不算缺失；转述时说明这是用户声明的。skipped 写得不对时 start_run 不受理，按回答里的修正改。
5. 把 Hub 的结果原样转述给用户：每份脑图缺哪些类别、跳过了哪些、读到的证据用例，不增不减，不改写结论。测试类型主要按用例的标签判定，靠标记识别的用例因没有标签，相关测试类型会如实报缺，其余类别按关键词判定，可能误报；摘要里提到用例规则、只靠标记识别的用例数或未打标签的节点时一并转述。
6. 你自己的看法（例如建议补哪些用例、哪些缺口可能只是没打标签、哪些类别可能不适用）另起一段，开头标明“模型转述，未经校验”，不要混进 Hub 的结果。也可以用 submit_result 把看法交成跨条目判断（cross_item 里 nature 写 judgment，不带 code）；它只作为模型的判断记下，不改变 Hub 算出的事实。

模板类别（编号 名称，24 个都要覆盖）：functional 功能测试、configuration 配置测试、integration 集成测试、compatibility 兼容性测试、negative 反向测试、stress 压力测试；command_add 命令的添加、command_delete 命令的删除、command_modify 命令的修改、command_query 命令的查询、show_at_maximum 最大配置下的 show、no_command no 命令、clear_command clear 命令、operation_log 操作日志、audit_log 审计日志、configuration_sync 配置同步、configuration_save 配置保存、configuration_restore 配置恢复、configuration_clear 配置清除、upgrade_new_to_new 升级兼容：新版本之间、upgrade_old_to_new 升级兼容：老版本到新版本、upgrade_new_to_old 升级兼容：新版本到老版本、security 安全、database 数据库。
