# 知识回注

只在 Circle 整合技能已决定把本地解读作为事实回注时使用。候选留在 Circle，本包不接候选，也不调用模型。

1. 用 JSON 清单标识本次工作，items 各带 id、title。上传清单，按 examples/start-run.json 开独立运行，指定产品和构建以锁定根；src: 原文须绑定 originals，tree: 原文受锁定根约束。
2. 每项只交一条 contribution，code 使用分类、归位提议、声明、关系对应的生成词表值；text 写整合后的陈述，data 按 examples/submit-result.json 带 root、path、source。
3. source 的 reference 必须读得到，quote 逐字引原文。只收锁定根里已有的、可追溯 Hub 原件；不要把清单或会话当作知识根据。只有会话说法须负责人署名，本版没有署名通道。
4. 关系另外带 relation.kind 和 relation.other（同样是 reference、quote）。same_subject 仅表示同一议题，不表示内容等价；contradicts 记录矛盾关系。两者都不修改任一方。
5. 不提交来源类型、依据等级、适用条件或置信分数。Hub 从实际来源核对并保留，不接受模型提升等级或扩展适用范围。
6. 检查回执的回注条数、记录引用和未入层原因。遇到明确的边界错误先按修正说明修正或重读来源后重交；不得以未知结束这项工作。缺少负责人签名或来源未入根是本版不收的确定原因，回到具名负责人处理，不把它记成已经回注。

回注入层不改树、不改根摘要。原文和关系只提供可追溯根据，Hub 的确定性核验不证明整合陈述的语义为真。
