# P1-2 冻结记录：契约包 FZ-01–09

日期：2026-10-10。对应 [P1 计划](p1-contract-sample-plan.md)第 7 节的 P1-2 步骤。

状态：**P1-2 已完成（契约层）。** 本记录是本地执行证据的如实汇总：范围是 schema 与词表层，对应验证矩阵的 L1 前置部分；它不构成 L1 通过（P1 的门禁在 P1-6 整体评审），更不涉及任何业务链。

> 修订注记（2026-10-10）：契约版本已由 [ADR 0009](decisions/0009-cancelled-status.md) 升为 1.1.0（`ResponseStatus` 增补 `cancelled`，退出码 5），冻结标识更新为 `FZ-2026-10-10-v1.1`。本记录正文中的 1.0.0 与原冻结标识为 P1-2 执行当时的状态，保留不改。

## 1. 落地产物

`packages/contracts/`（包名 `@infosec/contracts`，契约版本 1.0.0，冻结标识 `FZ-2026-10-10-P1-2`）：

| 冻结对象 | 文件 | 内容要点 |
| --- | --- | --- |
| FZ-01 | `src/vocab.ts` | `ResponseStatus` 八值；CLI 退出码表冻结：succeeded=0、failed=1、partial=2、unknown=3、not-run=4、accepted=10、running=11、cancel-requested=12（0 只给最终 succeeded，COM-06） |
| FZ-02 | `src/vocab.ts` | 任务阶段 11 值与操作状态 11 值两张允许迁移表（含取消四段子状态；`unknown` 只能向对账出口迁移；`delivered` 只能从 `under-review` 进入） |
| FZ-03 | `src/vocab.ts` | 错误注册表首批 25 个 code，八类齐全；类别与 code 强绑，`retryable` 实例不得比注册表放宽；`RECEIPT_LOST` 注册为不可直接重试（先入 `unknown` 对账）；注册表要求人工动作的 code 强制带 `userAction` |
| FZ-04 | `src/envelope.ts` | 请求/响应信封：身份、幂等键、绑定、效果声明、双轨记录区（verification / assessments 分列）、证据/产物引用、待输入与 `nextActions` |
| FZ-05 | `src/bindings.ts` | `BindingSet` 与程序侧闭合检查 `validateBindingClosure`（引用知识必固定快照与来源修订；有副作用必绑目标；用能力包必绑包与版本；涉产品必绑产品） |
| FZ-06 | `src/effects.ts` | `EffectDescriptor` 四维（读/写/占用/外传 + 可逆性与清理）；准入层级推导：不可逆恒为单独批准；“只读”一致性检查 |
| FZ-07 | `src/ids.ts` | 20 种前缀 ID 空间互不通用（如 `conv_*` 不能冒充 `task_*`）；SHA-256、fencing token、semver 校验 |
| FZ-08 | `src/records.ts` | `VerificationRecord`（强制声明检查范围）与 `AssessmentRecord`（supports/refutes 无证据引用会被标记）分开建模；完成清单骨架与 `evaluateCompletion`（必备项未满不得交付） |
| FZ-09 | `src/pending.ts` | `PendingInput` 与响应裁决：过期、修订已变一律拒绝；credential/MFA 强制敏感通道标记 |

## 2. 工具链定案（P1 启动议题的结论）

- **Schema 单一事实源 = Zod**：同一份 schema 产生 TS 类型、运行时校验与 JSON Schema（经 `zod-to-json-schema` 导出 `contractJsonSchemas()`），满足 P1 计划“schema 单一事实源、其余生成或校验”的约束，且运行时校验为真校验、不是仅类型。
- 实测解析版本（已写入 `package-lock.json` 并随包提交）：Node 24.20.0、TypeScript 5.9.3、zod 3.25.76、zod-to-json-schema 3.25.2、vitest 3.2.7。
- 仓库根 `.gitignore` 已含 `node_modules/`、`dist/`、`coverage/`，无需修改。

## 3. 本地验证证据（2026-10-10，本机执行）

| 命令 | 结果 |
| --- | --- |
| `npm install` | 成功（54 个包） |
| `npm run typecheck`（含测试文件） | 通过，无错误 |
| `npm run build` | 通过，产出 `dist/`（不入库） |
| `npm test`（vitest） | **26 项测试全部通过**，覆盖 FZ-01–09：状态/退出码、合法与非法迁移、错误类别强绑与不可放宽、信封解析与拒绝自造身份格式、绑闭合、效果层级、ID 空间隔离、双轨记录与完成门禁、待输入过期/过期修订拒绝、JSON Schema 导出 |

未覆盖与未执行（如实）：无 MCP/CLI/HTTP 三路真实传输对拍（P1-3）；无任何 harness 实连；信封 `payload` 仍为按操作待定的 `unknown`，各操作 schema 随 P2 各链实现进入，不在本次冻结内。

## 4. MCP 版本核对记录（ADR 0007 的后续动作）

本次只做了公开资料级核对，结论分三档如实记录：

- **已核对（官方规范面）**：MCP 规范版本史为 2024-11-05、2025-03-26、2025-06-18（稳定）、2025-11-25（最新稳定，Tasks 仍为 experimental）。来源：[MCP 规范页](https://modelcontextprotocol.info/specification/)。
- **暂定目标（未实测）**：P1-3 的最小服务端桩以 `2025-06-18` 的 tools 语义为协商基线目标；2025-11-25 的 Tasks 只按 ADR 0007 作增强路径看待。选 06-18 的理由是其为被广泛实现的稳定版；此目标在 L3 用真实客户端实测前不算定案，若实测不符按纠正记录修订。
- **未核对（如实）**：Circle 的确切 MCP 协商版本未在本次核对中取得可靠来源，不臆测。公开社区资料显示 OpenCode 支持 MCP、Pi 核心不内置 MCP 而经扩展/CLI 路径接入——这与 ADR 0007 的“最低基线含 CLI 路”一致，但社区资料不等于官方承诺，留待 P3 以三家实际安装版本实测确认。

## 5. 下一步

P1-3：最小服务端桩 + 三路对拍与故障注入向量可运行（L1 的协议部分）。在 P1-3 通过前，本包只声称为“schema 冻结版已落地并通过本地契约测试”，不声称协议互通已验证。
