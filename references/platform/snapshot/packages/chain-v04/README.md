# @infosec/chain-v04

V04 链纵切（P2-4）：用例评审。程序核验（输入哈希绑定、用例标识）与维度判断分轨：四个已声明维度（越权未校验 / 关键操作异常分支缺失 / 凭据明文记录 / 内部矛盾）由规则式评审方法（ADR 0013 的 scripted 方法，`rule-based-usecase-review`）产生发现，每条用例汇总为一份 AssessmentRecord；评审报告本身不交付，交付必须经平台任务的完成清单与评审人签字（v04-signoff）。

校准（`runV04Calibration`）：SMP-V04-01 基本正确集上高严重发现数必须为 0；SMP-V04-02 的预标缺陷 D-01..D-03 须按类型+严重级检出，修订版须检出 D-04 且不再报 D-01。注意修订版 UC-04R 的文本未随冻结样本提供，校准时按样本 description 在测试侧构造，属测试夹具。

本地验证：`npm install && npm run typecheck && npm test`（样本路径可用 `V04_SAMPLES_DIR` 覆盖）。
