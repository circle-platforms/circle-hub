# 能力清单与来源回执

观察与分类日期：2026-10-10。

- [capability-catalog.csv](capability-catalog.csv)：逐条筛选主归属、协作对象、拆职责建议与源代码链接。
- [capability-catalog.json](capability-catalog.json)：固定仓库基线、统计、覆盖声明及全部记录。
- [validation-receipt.json](validation-receipt.json)：清单 SHA-256 与 211 个来源文件的 Git blob SHA 校验。

主归属 A–E 是五类运行职责；F/G 是横切工程；X 为范围外参考。完整定义见[运行对象 V1](../../object-boundaries-v1.md)。

403 个记录包含声明、skill 定义位置和模块/脚本单元；不能直接解释成 403 个可调用工具。splitRequired 表示拆职责或明确跨对象契约的建议，不等于已发现运行 bug。

源代码链接固定到 sourceCommit 与 line。sourceBlob 是源文件在该提交中的 Git blob SHA；回执通过实际字节重新计算。分类本身是本轮源码审阅形成的架构建议，哈希一致不证明语义分类或程序运行必然正确。

exposure、evidenceLevel 和 validation 记录没有启动运行态 registry、模型、设备或旧测试。动态配置、外部服务以及未提交候选不属于主线接口计数。

这些数据不包含密码、访问令牌、内部连接地址、原始业务语料或源码全文；调查缓存不进入 Git。
