# 密钥传输最终合成

依据：所有者要求 Linux 优先，以 c0b88a6a 为起点合当前 hub-redesign，择优合 d0146bc6，最终只留一套实现。

可改路径：hub/platform/key-transfer.ts、hub/platform/key-transfer.test.ts、hub/platform/cli.ts、hub/platform/README.md、hub/records/api.ts、hub/records/vault.ts、hub/records/vault.test.ts、hub/server/cli-admin.ts、hub/server/key-transfer.test.ts、本页。基线自带的 api.ts 和 server/cli.ts 管道接线保留。

仅合成数据，不运行测试（集成者全量验收正在占用 macOS），不访问实际密钥、钥匙串、环境文件或业务系统。不合入、不推送。

合成选择：保留 KeyPipe 和确认参数；采用有界二进制输入、等待输出回调、输入/输出 30 秒超时和固定错误。输出超时先销毁流后结束传输；仅 records verify --vault 逐条只读 AEAD 核验，空库未知，不创建 key-check，不输出名称。

未完成：类型检查、全部测试、Linux 服务用户 fileKeyStore 端到端接线、独立复核、真实迁移密文解密证明。所有这些未运行项均不是通过。

Independent review: Antigravity reviewed fixed implementation `a85514a6` without executing tests and found no remaining
static blocker in bounded transfer, destination-state uncertainty, non-overwrite and explicit read-only vault verification.
This source review does not establish real key migration or target-machine behavior; synthetic and real rehearsal results
must be recorded separately after execution.


最终收尾：已签署合最新 hub-redesign。typecheck 退出0；最小定向（32+1分块、真实二进制子进程管道、回调/超时/EPIPE及目标未知）6通过、0失败、0跳过。未重复全量、vault全套或acceptance。源码确认 Linux 导入 fileKeyStore 与运行时 hubKeyProvider 的 fileKeyProvider 使用同一部署根及密钥名称；真实服务用户执行未验证。所有者取消备份/演练；实际平台密钥管道由集成者执行，本代理不读真实密钥或目标系统。准备由集成者合主线。
