# R5 B2：重组与编译结构

基线 ba3743c4，含 B1。修改范围：packs/workflow/case-compile/**、tests/fixtures/recompose/**、tests/fixtures/README.md 与本任务页。另已向所有者报告通用只读 RunContext.run/predecessor 缺口，最小改动 contracts/src/pack.ts、其生成物、hub/runs/engine/{start,evaluate}.ts 及机制测试；核心不放编译政策。其他包只读；通用记录、引用、引文核对、发布与分配机制复用现有接口。

重组为独立工作阶段；产品权威凭证与逐原子裁定都使用真实 Hub 记录，不能相信上传 JSON 的自述。模型解释语义，代码核结构、引用、闭集、全集、命令次数与出口。旧 flat 计划兼容，新重组输入显式绑定。新增输入清单属于已向所有者说明的契约扩展；旧 operational 断言不得迁就行为修改。

孪生示意中的占位选择器、释义原文账和本机路径在入库时迁成可核结构，并保留来源说明及四种预期终态；不会信任自报裁定。入库资产及新 README 扫描真实名称、构建和非文档地址。所有验证为合成环境，并发不超过 2；完整 docs/contracts/hub/packs/acceptance（含 oracle）后才经 merge-locked 合入。

必要的平台机制已在实现前报告：RunContext 增 actual run/predecessor/product_pack_digest，RunRecord 只追加新运行的私有产品锁；summaryOf 排除私有字段。以及 workflow@1 可选 incremental_submissions，只有重组阶段开启：按数据库追加序号取前一提交，保留旧材料且首次填空槽的 unknown-only 要求不计修复，真实违反和改旧数据不豁免。范围相应含 contracts/src/run.ts、hub/runs/engine/{submit,incremental}.ts 及新增机制测试；不向核心加入编译语义。

B1 完整交付回归：新端到端复现客户端公共摘要不含私有判据复核组导致 workbook recipe 指纹不一致；已改为绑定两份不变复核记录的身份，服务端内容/账号/有效范围仍完整核验。先有真实后继回读失败，再修实现；未修改旧测试断言。

孪生入库保存 B6 原模板（移除索引中的机器路径），生成可解析引用、逐字原文账及真实运行凭证绑定接口；不把自述裁定当受理。新 README 与每份资产的真实名称/构建前缀及非文档地址审计均零命中。

最终验证与合入准备：已同步 fb0c9df0 的通用解析器迁移，再同步 9c189f2a 的原合约身份修复。版本冲突按较大者加一，最终 case-compile@3.8.2；authority/recompose/adjudicate 为首次发布的 1.0.0。三处 verdict 子集改为 Extract<Verdict,...>，无扫描例外；旧 operational 断言未修改。

检查：gen:contracts 0 写入、0 删除、140 文件不变；typecheck 通过；docs 全量 242/242；contracts 全量 336/336；Hub 全量 3179 通过、0 失败、1 既有环境跳过（本机有 sandbox-exec，不运行仅适用于其缺席环境的反向分支）；packs 全量 3020/3020，附加孪生夹具 4/4；完整 acceptance 含 oracle 154/154，0 取消、0 跳过。Hub/contracts 文件在最后的纯类型子集修复与运行器身份主线同步中未改变。工作包和验收均在最后 3.8.2 树上重新全量完成。较早失败/中止的检查不计通过。

六项验收对应：真实引擎串通产品发布及清单 SHA、实际来源权威运行、非作者裁定、实际 predecessor 的新重组版本、编写显式消费、B1 独立判据、客户端摘要导出、工作簿生成及后继回读；另外验证两个分片保留全集、空槽未判定、不耗修复轮次，Hub 存了两份原始提交。三个反例、七码、闭集、原子/命令次数、物理来源、取值越权和两床字节/判定不变由专门测试覆盖。孪生完整目录逐文件扫描零命中，生成逐字节一致。

所有检查均合成；未访问真实系统、环境配置、所有者凭据或端口。新产品要由产品包作者发布 recompose-product@1 规范来源/适用范围/用途声明；管理员单独发布和分配三个阶段并分享实际来源凭证。缺声明时保留具名未知出口，不以内置排序替代。源文档没有充分资格或定位时逐节点报作者出口，不静默略过。旧单阶段只标 legacy，不代表重组完成。

日志在验收目录 wf/b2-case-recompose-{docs,contracts,hub,packs,acceptance}.tap，以及对应 gen/types 日志；源形状、私有上下文、增量预算、反向用例及孪生检查均保留在仓库测试中。
