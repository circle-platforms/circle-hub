# R5 B1：case-compile 块模型

依据：docs/hub-r5-brief.md B1、所有者本次要求，以及只读核对的编译分解报告。开始时主线 77e9de85 含 A1 的 2999f8de、c59bd83c。允许修改仅 packs/workflow/case-compile/** 与本任务页；需要平台新机制时只记录，不将产品或工作语义写进核心。

先在包 README 声明块、断言、寄存器、跨步与运行器能力边界，再实现。保持旧 flat steps/expects 输入有效；新块与 flat 输入互斥。所有判断来自完整结构、声明闭集、绑定来源或带引文的模型判断。合成数据为 ORBIT/COMET、lumen-api、文档地址段。InfoTest 仅只读参考，不执行、导入或复制其实现/资产。

检查：typecheck、case-compile 及受影响测试，并发 2；显式路径暂存，包升版重签，签署提交并带指定合作者，经 merge-locked.sh 合主线。

实现：块种类、断言族和运行器能力声明在 tables/blocks-format.json；schema 由 testing/gen-block-schema.ts 生成并有一致性测试。CAPTURE/EXPECT_FROM 的原文寄存器不经过回显解析，same 用双向字面包含证明整段相等，differs 必须有执行器声明的精确文字不等方法。恢复到捕获值必须有发送前语法/角色/效果守卫；冻结合约无此能力时明确未知，不开放普通 CLI 原文插值。

OBSERVE_DIST、OBSERVE_MEMBER、OBSERVE_EXIT 在同一闭集里声明但第一版不开放：缺区间/成员来源推导声明或原生退出状态通道。缺事实和维护者补合约出口写入报告。没有新增核心机制。

类型化判据的独立复核是同目录 review 工作包，按现有只读前驱、账号独立性、完整 Hub 记录及逐字引文机制运行。端到端测试从原提交开始，经管理员账号复核、记录分享、作者重新绑定复核证据，核到计划必需要求项满足，再通过实际 satisfiedRecipe 导出、生成及独立回读工作簿。

按所有者新增合入门槛：typecheck、packs/** 全量与 tests/acceptance/** 全量，并发 2。旧 operational 断言保留；仅 B1 明确改契约所涉及的非空 blocks 禁止、槽位输入清单、版本号及新增样例计数随声明更新。结果计数在合入回报列出。
