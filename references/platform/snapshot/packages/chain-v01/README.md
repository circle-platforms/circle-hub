# @infosec/chain-v01

V01 链纵切（P2-3）：在固定快照上回答产品知识问题。程序核验与语义判断严格分轨（VER）：可否引用由程序决定（快照成员、实时撤回状态、产品/版本绑定、scope 分区），引用是否支持结论由 assessor 判断（ADR 0013，默认 scripted）。冲突（多来源异值）与明确无答都是一等结果，绝不拼凑单一答案。指标抽取使用声明式词表（`src/metrics.ts`），词表外的问题如实无答。

`runCalibration` 在冻结 SMP-V01-01..04 上运行全部问题并输出与期望结论的一致率与程序检查通过情况（ADR 0013 门槛：程序可判项 100%、结论一致率 ≥90%）。

本地验证：`npm install && npm run typecheck && npm test`（测试从仓库 `samples/v01/` 读冻结样本，可用 `V01_SAMPLES_DIR` 覆盖）。
