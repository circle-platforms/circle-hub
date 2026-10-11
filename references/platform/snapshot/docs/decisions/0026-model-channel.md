# ADR 0026：模型与 gateway 选型（DEC-P3-04）

- 状态：已定案（2026-10-10，用户提供通道并确认）
- 议题：DEC-P3-04（P3 规划 §2）——P3-5 真实模型 L4 评测用哪条模型通道
- 背景：本议题在其余 DEC-P3 议题定案时被单独留置（「待用户给出模型通道」），P3-5 在此之前处于 blocked。本 ADR 记录通道事实与使用约束；评测本身的参数与预算冻结在 `docs/p3-5-evaluation-plan.md`，运行前经用户确认。

## 决定

1. **通道**：阿里云百炼 Token Plan（MaaS）的 Anthropic 兼容端点 `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`（Messages API 形态）。
2. **模型**：`qwen3.8-flash`（确切 id；评测记录中的 modelId 以此为准，端点回显已核对一致）。
3. **凭证**：API Key 只存于保险库连接器（`custom.aliyun-token-plan`，`x-api-key` 头，egress 仅限上述主机），运行时经代理注入；绝不入仓、不进日志、不出现在评测记录与回执中。通道为 Token Plan 专属密钥与专属域名（与按量付费体系隔离，不混用）。
4. **连通性验证（2026-10-10）**：经连接器的一笔最小调用返回 200，端点回显 model 为 `qwen3.8-flash`，usage 正常计量。如实记录：第一次验证尝试在 60 秒超时（当时无凭证的对照请求 1–2 秒即返回 401，代理标记获取 0.05 秒），重试即通，判定为冷路径瞬时阻塞、非通道不可用；后续运行器须使用宽松超时并记录每次调用的耗时与状态。
5. **模型行为口径**：该模型会先消耗输出 token 于推理再产出正文——评测的 max_tokens 与预算须按此计量（验证调用在 max_tokens=16 时正文为空、stop_reason 为 max_tokens）。
6. **使用范围**：本通道在 P3 内只用于 P3-5 评测（V01/V04 语义评测为主、V03 视觉试点为辅）。用于其他步骤或生产用途不在本决定内；更换模型或端点须修订本 ADR 并重跑受影响的评测。

## 与既有决定的关系

- ADR 0013（语义评测）：真实 assessor 经同一可替换接口接入，methodId/methodVersion 与确切 modelId 逐条记录；阈值不因换模型而改动，变更须附校准数据另立 ADR。
- P3 规划：DEC-P3-04 至此定案，P3-5 解除 blocked；其余登记（OPEN-06/07 等）不受影响。
