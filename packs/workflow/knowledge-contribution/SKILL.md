# 知识回注

只在 Circle 整合技能已决定把本地解读作为事实回注时使用。候选留在 Circle，本包不接候选，也不调用模型。

喂入是自动的：凡在运行里经 Hub 读到的用例、缺陷、构建、规格都由程序按来源 schema 填进喂入层，不是 Circle 的动作；Circle 只经回注补程序填不了的语义（分类、关系、适用条件、更正、版本声明），每条带逐字引文。运行中不问人：缺事实按具名请求补证或把该条标为 skipped，不向人提问。结构契约随包下发（tables/knowledge-structure.json），get_nodes 根路径也返回它；喂入层不改树、不进根摘要。

1. 用 JSON 清单标识本次工作，items 各带 id、title。上传清单，按 examples/start-run.json 开独立运行。这个任务包不绑定产品线：不要给 start_run 的 product、version、build，也不要写进 parameters。非管理员产品读者从 get_nodes 复制 tree:<root><path>[@entry] 引用，不绑定 originals；根原件只允许管理员读取。examples/start-run.json 默认就是这个路径。管理员确有可读 src: 原文时才另行绑定 originals，所有引用仍受锁定根约束。
2. 每项只交一条 contribution，code 使用分类、归位提议、声明、关系、版本声明对应的生成词表值；text 写整合后的陈述，data 按 examples/submit-result.json 带 root、path、source。版本声明（version_declaration）是人对某对象版本线的声明：object 引用、line、以及支撑它的来源结构逐字引文；Hub 记声明人和运行，来源结构绑定仍优先展示。
3. source 的 reference 必须读得到，quote 逐字引原文。非管理员继续使用 get_nodes 返回的 tree:<root><path>[@entry]，不绑定 originals；不要尝试用根的 src: 原件绕过权限。只收锁定根里已有的、可追溯 Hub 原件；不要把清单或会话当作知识根据。只有会话说法须负责人署名，本版没有署名通道。
4. 关系另外带 relation.kind 和 relation.other（同样是 reference、quote）。same_subject 仅表示同一议题，不表示内容等价；contradicts 记录矛盾关系；covers 记录覆盖关系（如构建覆盖缺陷）。三者都不修改任一方。矛盾和覆盖在视图里单列，不进版本差。
5. 不提交来源类型、依据等级、适用条件或置信分数。Hub 从实际来源核对并保留，不接受模型提升等级或扩展适用范围。
6. 检查回执的回注条数、记录引用和未入层原因。结构、引用、引文边界错误按说明修正并回读来源后重交。待署名、未入根、个人来源、血缘缺失等只影响该条：补齐事实；当前不能补齐就把本条标为 skipped 并写明原因，提交其余条目。不得以未知结束这项工作，也不得把未入层算成已经回注。
7. 陈述和两端引文不带明文凭据；扫描未通过时清理文字，凭据留在 Circle 本地。关系双方须是两个不同的原文片段。记录转述不能替代原文；改用锁定根中的 src: 或 tree:。同摘要重交只取原回执，修正内容或更新 notes 后才会重新核验。

## 操作记录

整合技能提交 Circle 做过的事时仍用本包，不要新开通道。

1. 工具后钩子先把原始输出上传为原件，出处必须是 `client_captured`。不要把会话里人的说法、模型转述或连接器读到的原文改标成这个出处。
2. 回注条目的 `code` 用 `assertion`。`text` 写这件事。`data.feeding` 选一种：`fed-observation@1` 写 `action` 和 `result` 引文；`fed-procedure@1` 写 `goal` 和带引文的 `steps`；`fed-pitfall@1` 写 `phenomenon`、`suggestion` 和引文。`source` 指向同一份上传原件。
3. 引文逐字复制上传原件，选择器用 `src:<摘要>/text@1/l/1` 这种带解析器的引用。改一个字会被拒绝。
4. 不要填写版本、构建、对象摘要、上传者、运行号、时间或租约。Hub 只从本次运行锁定的构建或台架结构里的在装构建取值；没有就记未声明。提交里自己写版本会被拒绝。可选 `device` 取自台架清单，`bed` 与采集清单 `targets.bed` / `bed_id` 对齐，二者只是声明。运行或它接续的预订冻结了台架清单时，Hub 按清单核对二者：只有一个台架含该设备时补上台架，同名设备在几个台架里就要写明 `bed`。记录只写设备和台架，不写租约；台架的预订、租约和释放归 test-bed 包。device/bed 只收字符串，不能含当前 Hub 令牌或其他凭据形状。
5. 和已有条目矛盾时用 `contradicts` 记下双方，不要判哪边为真。需要撤回时由管理员追加撤回，不要改旧记录。
6. 这三类对产品读者可见，但读不到原件的人看不到条目。它们的等级按决定 73 是声明，不拿去当核验、评分或放行的证据。

客户端实现位于 `tools/operation-capture`，安装说明见其 SKILL.md 和本包 README。必须先由用户为本会话开启共享；未加载技能或未开启时不采集。独立令牌文件权限为 0600，不能使用模型自报的出处或版本代替。客户端目前只支持 macOS 和 Linux。

回注入层不改树、不改根摘要。原文和关系只提供可追溯根据，Hub 的确定性核验不证明整合陈述的语义为真。

归位提议可以用 Circle 的 jev 技能做；Hub 只核路径和引文，不看概率。技能在 tools/jev，密钥只在 Circle 一侧。

适用条件只交 applicability_claim 的生成结构。value 严格取冻结闭集/数值声明，逐字引用原条件和章节路径；期望身份的 span 是原始字节位置。author 声明与模型判断分别展示，不改写生产器值，不把 null 当无条件。回注受理仅说明引用、路径、闭集及身份成立，语义仍为判断；冲突留给独立复核。缺原件/原包/闭集时按具名请求补证，不能用现值替换冻结版本。
