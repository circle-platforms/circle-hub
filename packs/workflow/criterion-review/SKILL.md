# 判据变更声明复核

本任务不绑定产品线：不要给 start_run 的 product、version、build，也不要写进 parameters。本任务复核判断请求所指的那份提交里的声明。它不是前驱的已受理结果，必须按 next_action 显式绑定 declaration 的 rec: 和 evidence 里的期望原件，predecessor 为声明运行。src 输入绑定整份原件（不带解析器或选择器），rec 输入可绑定片段；quotes 仍指向声明所引的精确片段。

逐条读旧判据、新判据、断言和依据，起草接受或不接受、理由与引文。接受与否必须由当前账号的主人确认；模型只起草，不能替人确认。作者账号不算独立，即便换会话或模型族也不算。

每个条目的 review 槽交一条陈述：code 为 accept 或 reject，text 写确认内容，location 为本条声明位置，data.reason 写理由，quotes 附声明所引期望来源的逐字原文。

缺原件或权限时补绑 evidence、请管理员补授权或由有权的非作者复核，不把缺输入当作拒绝新判据的理由。Hub 不判断新判据的内容是否正确，不修改源文件。

喂入层：这个包读到的用例、缺陷、构建、规格凡经 Hub 读的都由程序自动进喂入层（带锁定树苗和冻结序号），视图按"锁定树苗 + 冻结序号之前的喂入层"读；版本未声明和矛盾的对象单列计数，不进版本差。Circle 只经 knowledge-contribution 回注补程序填不了的语义（带逐字引文），运行中不问人；结构契约见该包 tables/knowledge-structure.json 或 get_nodes 根路径。
