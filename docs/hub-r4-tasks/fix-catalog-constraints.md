# 目录约束集成测试接线修复

所有者授权：fix-catalog-constraints，从 hub-redesign 的 a7792766 建立独立工作树。范围为 hub/knowledge/catalog-constraints.test.ts、hub/knowledge/README.md、本页；不改 Cursor 在 adoc-book-dirs 上处理的 adoc 绑定实现，冲突以主线为准。

## 根因与依据

基线两条失败都发生在知识生产 result.ok：生产器输出不符合 producer-output@1，未声明顶层键 declarations。FAMX 的 c1ab7a62 已把命令签名来源映射移到包内部返回值，不允许它成为通用生产合约字段。测试却仍把 produceCommandEntries 的内部结果直接 JSON 固化为生产器应答。

这是测试接线落后，并非目录丢失未知约束或未知类型的实现回归。改用包公开 API commandTreeProducer，传入结构解析模型及同一原件的 SHA-256，走正式生产边界，由包完成来源绑定和内部字段剥离。增加 ProducerOutput 严格解析及不外泄 declarations 的结构断言；不从测试里任意摘字段，也不放宽 Hub 验证。

原有断言全部保留：未核 limit 的原始缺失事实、目录解释器 unknown、未知类型不补猜 type、目录 complete=false、语法证据以及目录摘要对原件变化的敏感性。合成构建名使用 10.8 线，未涉及真实数据或系统。

## 验证

定向基线 1 过 / 2 失败；修复后 3/3。完整 hub/knowledge 与 FAMX 测试使用同一 Node 命令，test-concurrency=2：1032/1032，零失败、零跳过；npm run typecheck 通过。不改发布包文件，无需包升版或重签。
