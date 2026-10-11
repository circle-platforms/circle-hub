# 长期任务运行方式的比较

`runtime-eval` 是研究不同长期任务运行方式的实验包。它分别使用 PostgreSQL 任务记录与 Temporal，检查任务恢复、重复动作、运行中升级和操作结果等场景。两条路线使用各自的任务与 worker 脚本，便于观察实际重启和结果保存。

这部分用于选型比较，不是正式业务模块。已有记录描述本地场景结果；ADR 0022 已确认采用 PG 任务表路线；该实验包继续作为比较工装保留。本轮没有重跑这些场景，也没有把它们的历史通过数算成本轮沙盒结果。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-runtime-eval-pgflow-recordeffect-function"></a>
## recordEffect

ID `fn-runtime-eval-pgflow-recordeffect-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L35)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
export async function recordEffect(
  client: Pool | PoolClient,
  flowId: string,
  stage: string,
  opts: { countAttempt?: boolean } = {},
): Promise<boolean>
```

源码说明（原注释，仅作来源）

```text
/** Record an effect exactly once per (flow, stage); returns true if new. */
```

<a id="fn-runtime-eval-pgflow-noteattempt-function"></a>
## noteAttempt

ID `fn-runtime-eval-pgflow-noteattempt-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L62)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
export async function noteAttempt(
  pool: Pool,
  flowId: string,
  stage: string,
): Promise<void>
```

源码说明（原注释，仅作来源）

```text
/**
 * Count one execution attempt in autocommit. Used by routes whose
 * execution engine retries work outside any ledger transaction
 * (Temporal activities): a killed attempt still leaves its count,
 * while the effect insert itself stays exactly-once.
 */
```

<a id="fn-runtime-eval-pgflow-effectsof-function"></a>
## effectsOf

ID `fn-runtime-eval-pgflow-effectsof-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L74)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
export async function effectsOf(pool: Pool, flowId: string): Promise<string[]>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-runtime-eval-pgflow-attemptsof-function"></a>
## attemptsOf

ID `fn-runtime-eval-pgflow-attemptsof-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L82)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
export async function attemptsOf(
  pool: Pool,
  flowId: string,
  stage: string,
): Promise<number>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-runtime-eval-pgflow-pgflowrunner-constructor-constructor"></a>
## PgFlowRunner.constructor

ID `fn-runtime-eval-pgflow-pgflowrunner-constructor-constructor`；constructor / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L107)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
constructor(pool: Pool)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-runtime-eval-pgflow-pgflowrunner-migrate-method"></a>
## PgFlowRunner.migrate

ID `fn-runtime-eval-pgflow-pgflowrunner-migrate-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L111)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
async migrate(): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-runtime-eval-pgflow-pgflowrunner-startflow-method"></a>
## PgFlowRunner.startFlow

ID `fn-runtime-eval-pgflow-pgflowrunner-startflow-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L115)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
async startFlow(flowId: string, flowVersion: number): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-runtime-eval-pgflow-pgflowrunner-wakeup-method"></a>
## PgFlowRunner.wakeup

ID `fn-runtime-eval-pgflow-pgflowrunner-wakeup-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L124)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
async wakeup(flowId: string, kind: "tick" | "decision", payload?: unknown): Promise<void>
```

源码说明（原注释，仅作来源）

```text
/** Wakeups are durable and unconditional: duplicates are expected. */
```

<a id="fn-runtime-eval-pgflow-pgflowrunner-flowstate-method"></a>
## PgFlowRunner.flowState

ID `fn-runtime-eval-pgflow-pgflowrunner-flowstate-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L131)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
async flowState(flowId: string): Promise<{ stage: EvalStage; flowVersion: number } | undefined>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-runtime-eval-pgflow-pgflowrunner-runonce-method"></a>
## PgFlowRunner.runOnce

ID `fn-runtime-eval-pgflow-pgflowrunner-runonce-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L141)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
async runOnce(): Promise<void>
```

源码说明（原注释，仅作来源）

```text
/** Process pending wakeups and actionable stages once. */
```

<a id="fn-runtime-eval-pgflow-pgflowrunner-processflow-method"></a>
## PgFlowRunner.#processFlow

ID `fn-runtime-eval-pgflow-pgflowrunner-processflow-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/pgflow.ts#L152)；SHA-256 `9daf6179d8b0385da29d60281e70ea0e7d155d03159238808a50c194c38721c0`。

```ts
async #processFlow(flowId: string): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-runtime-eval-temporal-activities-getpool-function"></a>
## getPool

ID `fn-runtime-eval-temporal-activities-getpool-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/temporal/activities.ts#L6)；SHA-256 `4dcc6a69c2c98f1811ef5582c8f6ff3e2736dbb0377ec59f52315eded4362667`。

```ts
function getPool(): Pool
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-runtime-eval-temporal-activities-applyeffect-function"></a>
## applyEffect

ID `fn-runtime-eval-temporal-activities-applyeffect-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/temporal/activities.ts#L21)；SHA-256 `4dcc6a69c2c98f1811ef5582c8f6ff3e2736dbb0377ec59f52315eded4362667`。

```ts
export async function applyEffect(flowId: string, stage: string): Promise<boolean>
```

源码说明（原注释，仅作来源）

```text
/**
 * Activities for the Temporal route. The effect itself goes through
 * the same exactly-once ledger as the PG route: Temporal retries
 * activities at least once, so the ledger (not the workflow) is what
 * makes the effect exactly-once. The attempt is noted in autocommit
 * BEFORE the work, so a worker killed mid-activity still leaves its
 * attempt counted — retries become visible, effects do not double.
 */
```

<a id="fn-runtime-eval-temporal-workflows-v1-evalflow-function"></a>
## evalFlow

ID `fn-runtime-eval-temporal-workflows-v1-evalflow-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/temporal/workflows-v1.ts#L15)；SHA-256 `b0558ac05c04662bec5afad6fdbf2a323ae4145fba7996c1b92369c36f55021d`。

```ts
export async function evalFlow(flowId: string): Promise<string>
```

源码说明（原注释，仅作来源）

```text
/**
 * Canonical evaluation flow, v1 semantics:
 * effect A -> wait for a human decision signal -> effect B -> done.
 */
```

<a id="fn-runtime-eval-temporal-workflows-v2-evalflow-function"></a>
## evalFlow

ID `fn-runtime-eval-temporal-workflows-v2-evalflow-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/runtime-eval/src/temporal/workflows-v2.ts#L32)；SHA-256 `34f24371f106e6187d36a51804b679e0543b7c4f5721bf6d6bbe00370e75d39a`。

```ts
export async function evalFlow(flowId: string, semanticsVersion = 1): Promise<string>
```

源码说明（原注释，仅作来源）

```text
/**
 * Canonical evaluation flow, v2 semantics: adds a marker effect C
 * after B — but only for flows whose recorded input pins semantics
 * version >= 2. The version travels in the workflow input (recorded
 * in history at start, so replay-stable), mirroring the PG route's
 * per-flow version pin.
 *
 * Why the input pin is needed: patched() alone does NOT freeze an
 * in-flight flow. During this evaluation, a v2 workflow gated only
 * by patched("marker-stage-c") gave an in-flight v1 flow the new
 * stage C — patched() only protects determinism of steps already
 * recorded; steps not yet executed adopt the new code. Strict
 * pinning requires either this input discipline or Temporal worker
 * deployment versioning with old workers kept alive.
 */
```

</details>
