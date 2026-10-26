# R5 B1：case-compile 块模型

依据：docs/hub-r5-brief.md B1、所有者本次要求，以及只读核对的编译分解报告。开始时主线 77e9de85 含 A1 的 2999f8de、c59bd83c。允许修改仅 packs/workflow/case-compile/** 与本任务页；需要平台新机制时只记录，不将产品或工作语义写进核心。

先在包 README 声明块、断言、寄存器、跨步与运行器能力边界，再实现。保持旧 flat steps/expects 输入有效；新块与 flat 输入互斥。所有判断来自完整结构、声明闭集、绑定来源或带引文的模型判断。合成数据为 ORBIT/COMET、lumen-api、文档地址段。InfoTest 仅只读参考，不执行、导入或复制其实现/资产。

检查：typecheck、case-compile 及受影响测试，并发 2；显式路径暂存，包升版重签，签署提交并带指定合作者，经 merge-locked.sh 合主线。

实现：块种类、断言族和运行器能力声明在 tables/blocks-format.json；schema 由 testing/gen-block-schema.ts 生成并有一致性测试。CAPTURE/EXPECT_FROM 的原文寄存器不经过回显解析，same 用双向字面包含证明整段相等，differs 必须有执行器声明的精确文字不等方法。恢复到捕获值必须有发送前语法/角色/效果守卫；冻结合约无此能力时明确未知，不开放普通 CLI 原文插值。

OBSERVE_DIST、OBSERVE_MEMBER、OBSERVE_EXIT 在同一闭集里声明但第一版不开放：缺区间/成员来源推导声明或原生退出状态通道。缺事实和维护者补合约出口写入报告。没有新增核心机制。

类型化判据的独立复核是同目录 review 工作包，按现有只读前驱、账号独立性、完整 Hub 记录及逐字引文机制运行。端到端测试从原提交开始，经管理员账号复核、记录分享、作者重新绑定复核证据，核到计划必需要求项满足，再通过实际 satisfiedRecipe 导出、生成及独立回读工作簿。

按所有者新增合入门槛：typecheck、packs/** 全量与 tests/acceptance/** 全量，并发 2。旧 operational 断言保留；仅 B1 明确改契约所涉及的非空 blocks 禁止、槽位输入清单、版本号及新增样例计数随声明更新。结果计数在合入回报列出。

本轮门槛结果：typecheck 通过；packs/** 全量 2926 通过、0 失败、0 跳过；tests/acceptance/** 全量 150 通过、4 失败、0 跳过。四处为 01-normal-review:148、05-cross-item-claims:58、22-fact-model-independence:168 与 oracle/differential:544。前三处运行级 level 中出现额外事实主张；最后一处 engine 的 independence_unknown 与 oracle 的 satisfied 不同。

在不含 B1 的 hub-redesign@78b3c5b5 干净副本复跑上述四文件：13 通过、同样 4 失败、0 跳过，差异一致。未改旧断言、未改核心或 acceptance；未合入 B1。下一步：主线修复这四处既有回归后再合最新主线并重跑要求的全量门槛。完整合成测试记录在 acceptance 工作目录 wf 的 b1-case-blocks-{full-packs,full-acceptance,main-baseline}.tap。

额外 test:docs：239 通过、1 失败、0 跳过。pack-version 检查发现主线 case-review-report@2.0.8、case-review-verify@1.1.10、case-review@1.1.25、knowledge-contribution@1.2.3 的已列文件/清单变化但版本未升；四目录与主线逐字相同，且对主线只读调用同一 versionReuseProblems 得到同一四条。没有为 B1 改这四包或豁免扫描。记录为 wf/b1-case-blocks-docs.tap 和 wf/b1-case-blocks-main-version-baseline.json。

最新复核：先同步所有者确认的 9a977c9c，再同步先合入的 B3（5c2a19c8）。B1 与 B3 合在一起的最终树通过 typecheck；Hub 全量 3209 通过、0 失败、1 既有环境跳过（本机有 sandbox-exec，故不运行“无 sandbox-exec 时默认拒绝”的反向环境分支）；contracts 全量 336 通过；packs 全量 2926 通过；完整 acceptance 含 oracle 154 通过，0 失败、0 取消、0 跳过。后三组均无跳过。

最终树 test:docs 241 通过；随后按新规执行 gen:contracts，0 写入、0 删除、138 文件不变，再跑 test:docs 241 通过。日志为 wf/b1-case-blocks-final-{hub,contracts,packs,acceptance,docs-after-generation}.tap 及 final-types.log、final-generation.log。

较早在 9a977c9c 上的并发 2 全量曾因主机共享内存配额耗尽，使 T1 的临时 PostgreSQL initdb 失败并取消 1 项；未改系统参数、未改断言，改为并发 1 完整重跑后 154 项全部通过。同步 B3 后又按并发 2 完成上述最终树的全部检查，没有取消。先前四项 A4 验收失败与漏升版本阻塞均已由主线修复。B1 自身除任务授权的块契约、版本号与样例计数对应断言外，没有迁就新行为修改旧 operational 断言；核心与其他包变化均来自同步主线。

代码已通过带回滚静态门的 merge-locked 流程合入，提交 e129c068；本次补齐验证记录，代码与上述受检树相同。
