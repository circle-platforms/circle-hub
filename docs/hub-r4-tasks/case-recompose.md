# R5 B2：重组与编译结构

基线 ba3743c4，含 B1。修改范围：packs/workflow/case-compile/**、tests/fixtures/recompose/**、tests/fixtures/README.md 与本任务页。另已向所有者报告通用只读 RunContext.run/predecessor 缺口，最小改动 contracts/src/pack.ts、其生成物、hub/runs/engine/{start,evaluate}.ts 及机制测试；核心不放编译政策。其他包只读；通用记录、引用、引文核对、发布与分配机制复用现有接口。

重组为独立工作阶段；产品权威凭证与逐原子裁定都使用真实 Hub 记录，不能相信上传 JSON 的自述。模型解释语义，代码核结构、引用、闭集、全集、命令次数与出口。旧 flat 计划兼容，新重组输入显式绑定。新增输入清单属于已向所有者说明的契约扩展；旧 operational 断言不得迁就行为修改。

孪生示意中的占位选择器、释义原文账和本机路径在入库时迁成可核结构，并保留来源说明及四种预期终态；不会信任自报裁定。入库资产及新 README 扫描真实名称、构建和非文档地址。所有验证为合成环境，并发不超过 2；完整 docs/contracts/hub/packs/acceptance（含 oracle）后才经 merge-locked 合入。

必要的平台机制已在实现前报告：RunContext 增 actual run/predecessor/product_pack_digest，RunRecord 只追加新运行的私有产品锁；summaryOf 排除私有字段。以及 workflow@1 可选 incremental_submissions，只有重组阶段开启：按数据库追加序号取前一提交，保留旧材料且首次填空槽的 unknown-only 要求不计修复，真实违反和改旧数据不豁免。范围相应含 contracts/src/run.ts、hub/runs/engine/{submit,incremental}.ts 及新增机制测试；不向核心加入编译语义。

B1 完整交付回归：新端到端复现客户端公共摘要不含私有判据复核组导致 workbook recipe 指纹不一致；已改为绑定两份不变复核记录的身份，服务端内容/账号/有效范围仍完整核验。先有真实后继回读失败，再修实现；未修改旧测试断言。

孪生入库保存 B6 原模板（移除索引中的机器路径），生成可解析引用、逐字原文账及真实运行凭证绑定接口；不把自述裁定当受理。新 README 与每份资产的真实名称/构建前缀及非文档地址审计均零命中。
