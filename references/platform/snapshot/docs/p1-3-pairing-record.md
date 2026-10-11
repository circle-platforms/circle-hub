# P1-3 记录：三路对拍与故障注入向量

日期：2026-10-10。对应 [P1 计划](p1-contract-sample-plan.md)第 7 节的 P1-3 步骤。

状态：**P1-3 已完成（桩级对拍）。** 本地实测：11 个场景 × 3 种传输全部通过，断言是**完整响应信封逐字段相等**，不只是状态码相等。范围声明：对拍对象是 scripted 桩，不是真实 harness、不是真实设备/Web——那是 L3/L5 的事。本记录构成验证矩阵 L1「协议部分」的证据，L1 整体通过仍待 P1-6 门禁评审。

## 1. 落地产物

`packages/server-stub/`（`@infosec/server-stub`）：

- `src/service.ts`：确定性 scripted 长任务服务（逻辑时钟、确定性 ID 计数）。实现六调用 submit / status / result / input / cancel / reconcile 与共同契约的关键语义：幂等去重、回执丢失→`unknown`→对账恢复、取消四段状态、待输入绑定修订、终局后取消冲突、越权 scope 与版本拒绝。每个响应都先过 `ResponseEnvelopeSchema` 自检再出门。
- 三种传输，同一服务核心：MCP（`src/mcp-server.ts`，官方 TypeScript SDK 1.32.1，stdio，六个 `task_*` tools）、CLI（`src/cli.ts`，状态存于进程外的状态文件，退出码走 FZ-01 冻结映射，测试逐项断言）、HTTP（`src/http-server.ts`，`POST /v1/task/<call>`，业务状态只在信封里）。
- `fixtures/vectors.json`：11 个场景与期望（状态、错误码、操作状态、执行次数、duplicate / reconciled / pending 标记）。
- `test/pairing.test.ts`：把向量在三路上各跑一遍（每路全新实例），断言期望成立且三路信封深相等；每个响应都过契约 schema 解析。

场景清单：instant-success、slow-poll-success、needs-input、target-failure、cancel-before-run、drop-receipt-reconcile、duplicate-submit-idempotent、stale-input-rejected、forbidden-scope、unsupported-version、cancel-after-final。

## 2. 本地验证证据（2026-10-10，本机执行）

| 命令 | 结果 |
| --- | --- |
| `npm install`（server-stub） | 成功；解析版本：@modelcontextprotocol/sdk 1.32.1、TypeScript 5.9.3、vitest 3.2.7、@types/node 24 |
| `npm run typecheck` | 通过（过程中补齐了 FZ-02 的 `still-running` 映射，见第 3 节） |
| `npm test` | **11 个场景全部通过**（每景含三路信封深相等 + CLI 退出码断言）；总时长约 20 秒 |

一次真实的自检命中：首跑时 duplicate 场景失败，原因是向量里用的幂等键 `dup-1` 只有 5 个字符，被 FZ-04 的 schema（最短 8）以 `INVALID_PAYLOAD` 拒掉——是测试数据违规、契约在起作用，向量已改为 `dup-0001`。如实记录，不算契约缺陷。

## 3. 发现的问题与处置

1. **OPEN-09（新登记，需定案）**：**运行中被取消的操作，其最终 `ResponseStatus` 在 FZ-01 八值里没有诚实的位置。** 任务阶段有 `cancelled`，但响应状态没有：`failed` 不是失败、`partial` 不是部分完成、`not-run` 只适用于尚未执行。本桩只取消未执行的操作并把 `stopped-observed → not-run` 写死为该情形的映射，**运行中取消的结果映射明确留空**。候选处置：契约 v1.1 给 `ResponseStatus` 增补 `cancelled`（破坏性变更，须走 COM-05 升版与三路回归），或在 v1.1 中明确定义 stopped-observed 的结果映射规则。已登记到共同契约第 16 节，P2 启动前需用户定案。
2. **FZ-02 落码补齐**：实现时发现操作状态 `still-running` 在响应状态映射中漏列，已补为 `cancel-requested`（取消在途的中间态，细节看 `result.operationStatus`），并被类型检查抓住后修复——属于冻结词表内的映射补齐，不是词表变更。
3. **MCP 协商版本的断言边界（如实）**：本次 MCP 路走官方 SDK，版本协商由 SDK 处理，测试**没有**断言具体协商出的 protocolVersion。因此 P1-2 记录里“以 2025-06-18 为暂定目标”仍是未实测目标；对拍证明的是信封语义与传输无关，不证明某个 MCP 修订版的互通细节。修订版实测留待 P3 接真实客户端时做。

## 4. 下一步

P1-4：样本制备（SMP 清单）与 R01–R08 场景卡；P1-5 冻结 Excel/脑图契约（依赖样本）；P1-6 收口评审。在 P1-6 通过前，L1 只记“协议部分有桩级证据”，不记通过。

## 修订注记（2026-10-10，ADR 0009）

OPEN-09 已于同日定案：契约升 v1.1，`ResponseStatus` 增补 `cancelled`，`stopped-observed` 的最终状态一律映射为 `cancelled`（本记录第 3 节所述“未执行即取消 → not-run”的临时映射废止，`not-run` 收窄为从未受理执行）。服务桩与向量已同步更新并重跑回归：契约测试 26 项、三路对拍 11 个场景全部通过（CLI 侧 `cancelled` 退出码 5 一并被断言覆盖）。本记录其余部分保留 P1-3 执行当时的原文。
