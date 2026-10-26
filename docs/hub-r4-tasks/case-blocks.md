# R5 B1：case-compile 块模型

依据：docs/hub-r5-brief.md B1、所有者本次要求，以及只读核对的编译分解报告。开始时主线 77e9de85 含 A1 的 2999f8de、c59bd83c。允许修改仅 packs/workflow/case-compile/** 与本任务页；需要平台新机制时只记录，不将产品或工作语义写进核心。

先在包 README 声明块、断言、寄存器、跨步与运行器能力边界，再实现。保持旧 flat steps/expects 输入有效；新块与 flat 输入互斥。所有判断来自完整结构、声明闭集、绑定来源或带引文的模型判断。合成数据为 ORBIT/COMET、lumen-api、文档地址段。InfoTest 仅只读参考，不执行、导入或复制其实现/资产。

检查：typecheck、case-compile 及受影响测试，并发 2；显式路径暂存，包升版重签，签署提交并带指定合作者，经 merge-locked.sh 合主线。
