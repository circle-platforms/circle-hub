# 密钥传输最终合成

依据：所有者要求 Linux 优先，以 c0b88a6a 为起点合当前 hub-redesign，择优合 d0146bc6，最终只留一套实现。

可改路径：hub/platform/key-transfer.ts、hub/platform/key-transfer.test.ts、hub/platform/cli.ts、hub/platform/README.md、hub/records/api.ts、hub/records/vault.ts、hub/records/vault.test.ts、hub/server/cli-admin.ts、hub/server/key-transfer.test.ts、本页。基线自带的 api.ts 和 server/cli.ts 管道接线保留。

仅合成数据，不运行测试（集成者全量验收正在占用 macOS），不访问实际密钥、钥匙串、环境文件或业务系统。不合入、不推送。

合成选择：保留 KeyPipe 和确认参数；采用有界二进制输入、等待输出回调、输入/输出 30 秒超时和固定错误。输出超时先销毁流后结束传输；仅 records verify --vault 逐条只读 AEAD 核验，空库未知，不创建 key-check，不输出名称。

未完成：类型检查、全部测试、Linux 服务用户 fileKeyStore 端到端接线、独立复核、真实迁移密文解密证明。所有这些未运行项均不是通过。
