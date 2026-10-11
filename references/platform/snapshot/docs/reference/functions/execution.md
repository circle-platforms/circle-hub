# 实际进程与浏览器的执行管理

`execution` 开始把操作记录与真实子进程、浏览器连起来。控制部分登记操作、检查租约、处理取消和结果核对；进程监督部分启动 worker、记录运行信息并处理超时与停止。浏览器部分为任务创建独立上下文，操作本地登录站并读取页面的明确状态。

源码中已有本地测试和 P3-3 记录。这些是该模块的既有工作，本轮只检查源码并更新说明，没有运行它的测试。它尚不能由此证明真实设备兼容、复杂网络诊断、用户实时查看或所有远端停止方式已完成。独立沙盒里的网络与浏览器实验也没有替代本模块的验收。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-execution-process-worker-send-callable-value"></a>
## send

ID `fn-execution-process-worker-send-callable-value`；callable-value / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/scripts/process-worker.mjs#L20)；SHA-256 `33c2995550405283e83878a084bfe194a5c440e16ce7d6efe071bd3c9b83a233`。

```ts
(msg) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-worker-authorize-function"></a>
## authorize

ID `fn-execution-process-worker-authorize-function`；function / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/scripts/process-worker.mjs#L25)；SHA-256 `33c2995550405283e83878a084bfe194a5c440e16ce7d6efe071bd3c9b83a233`。

```ts
async function authorize(opId)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-worker-execute-function"></a>
## execute

ID `fn-execution-process-worker-execute-function`；function / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/scripts/process-worker.mjs#L31)；SHA-256 `33c2995550405283e83878a084bfe194a5c440e16ce7d6efe071bd3c9b83a233`。

```ts
async function execute(msg)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-browser-worker-browserworker-launch-method"></a>
## BrowserWorker.launch

ID `fn-execution-browser-worker-browserworker-launch-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/browser-worker.ts#L13)；SHA-256 `4d8d72662baa8b1a03ef53125a1443b036b308c1054a9e02359285d9a1581307`。

```ts
async launch(): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-browser-worker-browserworker-close-method"></a>
## BrowserWorker.close

ID `fn-execution-browser-worker-browserworker-close-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/browser-worker.ts#L17)；SHA-256 `4d8d72662baa8b1a03ef53125a1443b036b308c1054a9e02359285d9a1581307`。

```ts
async close(): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-browser-worker-browserworker-newtaskcontext-method"></a>
## BrowserWorker.newTaskContext

ID `fn-execution-browser-worker-browserworker-newtaskcontext-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/browser-worker.ts#L22)；SHA-256 `4d8d72662baa8b1a03ef53125a1443b036b308c1054a9e02359285d9a1581307`。

```ts
async newTaskContext(): Promise<BrowserContext>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-browser-worker-browserworker-pagestate-method"></a>
## BrowserWorker.pageState

ID `fn-execution-browser-worker-browserworker-pagestate-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/browser-worker.ts#L27)；SHA-256 `4d8d72662baa8b1a03ef53125a1443b036b308c1054a9e02359285d9a1581307`。

```ts
async pageState(page: Page): Promise<string | undefined>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-browser-worker-browserworker-waitstate-method"></a>
## BrowserWorker.waitState

ID `fn-execution-browser-worker-browserworker-waitstate-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/browser-worker.ts#L31)；SHA-256 `4d8d72662baa8b1a03ef53125a1443b036b308c1054a9e02359285d9a1581307`。

```ts
private async waitState(page: Page, states: string[]): Promise<string>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-browser-worker-browserworker-login-method"></a>
## BrowserWorker.login

ID `fn-execution-browser-worker-browserworker-login-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/browser-worker.ts#L41)；SHA-256 `4d8d72662baa8b1a03ef53125a1443b036b308c1054a9e02359285d9a1581307`。

```ts
async login(
    page: Page,
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<string>
```

源码说明（原注释，仅作来源）

```text
/** Fill and submit the real login form; returns the landing state. */
```

<a id="fn-execution-browser-worker-browserworker-submitmfa-method"></a>
## BrowserWorker.submitMfa

ID `fn-execution-browser-worker-browserworker-submitmfa-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/browser-worker.ts#L54)；SHA-256 `4d8d72662baa8b1a03ef53125a1443b036b308c1054a9e02359285d9a1581307`。

```ts
async submitMfa(page: Page, code: string): Promise<string>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-browser-worker-browserworker-sessioncookie-method"></a>
## BrowserWorker.sessionCookie

ID `fn-execution-browser-worker-browserworker-sessioncookie-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/browser-worker.ts#L60)；SHA-256 `4d8d72662baa8b1a03ef53125a1443b036b308c1054a9e02359285d9a1581307`。

```ts
async sessionCookie(context: BrowserContext, baseUrl: string): Promise<string | undefined>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-constructor-constructor"></a>
## ControlPlane.constructor

ID `fn-execution-control-plane-controlplane-constructor-constructor`；constructor / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L72)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
constructor(clock: Clock)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-partitionkey-method"></a>
## ControlPlane.#partitionKey

ID `fn-execution-control-plane-controlplane-partitionkey-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L76)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
#partitionKey(spec: SubmitSpec): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-submit-method"></a>
## ControlPlane.submit

ID `fn-execution-control-plane-controlplane-submit-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L80)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
submit(spec: SubmitSpec): Result<{ op: OperationRecord; deduplicated: boolean }>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-getoperationbyid-method"></a>
## ControlPlane.getOperationById

ID `fn-execution-control-plane-controlplane-getoperationbyid-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L113)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
getOperationById(operationId: string): OperationRecord | undefined
```

源码说明（原注释，仅作来源）

```text
/** Internal accessor for trusted in-process components (no partition check). */
```

<a id="fn-execution-control-plane-controlplane-getoperation-method"></a>
## ControlPlane.getOperation

ID `fn-execution-control-plane-controlplane-getoperation-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L117)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
getOperation(
    tenantId: string,
    scopeId: string,
    operationId: string,
  ): Result<OperationRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-acquirelease-method"></a>
## ControlPlane.acquireLease

ID `fn-execution-control-plane-controlplane-acquirelease-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L130)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
acquireLease(resourceId: string, workerId: string): Result<{ fencingToken: number }>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-heartbeat-method"></a>
## ControlPlane.heartbeat

ID `fn-execution-control-plane-controlplane-heartbeat-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L155)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
heartbeat(resourceId: string, workerId: string, fencingToken: number): Result<true>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-assign-method"></a>
## ControlPlane.assign

ID `fn-execution-control-plane-controlplane-assign-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L164)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
assign(operationId: string, workerId: string, fencingToken: number): Result<OperationRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-authorizeeffect-method"></a>
## ControlPlane.authorizeEffect

ID `fn-execution-control-plane-controlplane-authorizeeffect-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L189)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
authorizeEffect(
    operationId: string,
    workerId: string,
    fencingToken: number,
  ): Result<true>
```

源码说明（原注释，仅作来源）

```text
/**
   * The exit-point re-check (ADR 0020): a worker must call this
   * immediately before a real side effect. It re-validates the live
   * lease, the fencing token, and that no cancel has been requested.
   */
```

<a id="fn-execution-control-plane-controlplane-reporteffect-method"></a>
## ControlPlane.reportEffect

ID `fn-execution-control-plane-controlplane-reporteffect-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L216)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
reportEffect(
    operationId: string,
    workerId: string,
    fencingToken: number,
    outcome: "succeeded" | "failed",
    detail: string,
  ): Result<OperationRecord>
```

源码说明（原注释，仅作来源）

```text
/** A fencing-valid worker report is a trusted execution record. */
```

<a id="fn-execution-control-plane-controlplane-onworkerexit-method"></a>
## ControlPlane.onWorkerExit

ID `fn-execution-control-plane-controlplane-onworkerexit-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L233)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
onWorkerExit(workerId: string): void
```

源码说明（原注释，仅作来源）

```text
/** The worker process died (or vanished): its running operations go unknown. */
```

<a id="fn-execution-control-plane-controlplane-requestcancel-method"></a>
## ControlPlane.requestCancel

ID `fn-execution-control-plane-controlplane-requestcancel-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L246)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
requestCancel(operationId: string): Result<OperationRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-notestopsignalled-method"></a>
## ControlPlane.noteStopSignalled

ID `fn-execution-control-plane-controlplane-notestopsignalled-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L258)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
noteStopSignalled(operationId: string): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-notestopreported-method"></a>
## ControlPlane.noteStopReported

ID `fn-execution-control-plane-controlplane-notestopreported-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L263)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
noteStopReported(operationId: string, detail: string): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-control-plane-controlplane-observestop-method"></a>
## ControlPlane.observeStop

ID `fn-execution-control-plane-controlplane-observestop-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L277)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
async observeStop(
    operationId: string,
    observer: () => Promise<{ stopped: boolean; detail: string }>,
  ): Promise<Result<OperationRecord>>
```

源码说明（原注释，仅作来源）

```text
/**
   * Settle a cancel by OBSERVATION of the target (stage 4). Only an
   * observer's finding can produce stopped-observed; an observer that
   * finds the target still running, or cannot determine its state,
   * leaves the operation stop-unconfirmed.
   */
```

<a id="fn-execution-control-plane-controlplane-confirmstopped-method"></a>
## ControlPlane.confirmStopped

ID `fn-execution-control-plane-controlplane-confirmstopped-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L302)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
confirmStopped(
    operationId: string,
    claim: { outcome?: string; note?: string },
  ): Result<OperationRecord>
```

源码说明（原注释，仅作来源）

```text
/**
   * D-T01: confirmStopped finalizes NOTHING on its own. Without a
   * trusted execution record (fencing-valid worker report or a prior
   * observation) it is rejected and the operation keeps its state —
   * prose explanations and arbitrary outcome claims are not evidence.
   */
```

<a id="fn-execution-control-plane-controlplane-reconcile-method"></a>
## ControlPlane.reconcile

ID `fn-execution-control-plane-controlplane-reconcile-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L327)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
async reconcile(
    operationId: string,
    observer: () => Promise<
      | { determined: true; finalStatus: "succeeded" | "failed" | "stopped-observed"; observation: string }
      | { determined: false; observation: string }
    >,
  ): Promise<Result<OperationRecord>>
```

源码说明（原注释，仅作来源）

```text
/**
   * Reconcile an unknown operation FROM OBSERVATION of the target.
   * The observer's finding, not the lost receipt, decides the final
   * state; an observer that cannot determine the state changes
   * nothing.
   */
```

<a id="fn-execution-control-plane-controlplane-isresourcewritable-method"></a>
## ControlPlane.isResourceWritable

ID `fn-execution-control-plane-controlplane-isresourcewritable-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/control-plane.ts#L350)；SHA-256 `6e8ec23c7671ada6d221942584abee08595944282e8cfabf7fa0432c0bba4d45`。

```ts
isResourceWritable(resourceId: string): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-supervisor-processworkersupervisor-constructor-constructor"></a>
## ProcessWorkerSupervisor.constructor

ID `fn-execution-process-supervisor-processworkersupervisor-constructor-constructor`；constructor / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L28)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
constructor(cp: ControlPlane, workerId: string)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-supervisor-processworkersupervisor-start-method"></a>
## ProcessWorkerSupervisor.start

ID `fn-execution-process-supervisor-processworkersupervisor-start-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L33)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
async start(): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-supervisor-processworkersupervisor-send-method"></a>
## ProcessWorkerSupervisor.#send

ID `fn-execution-process-supervisor-processworkersupervisor-send-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L54)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
#send(msg: unknown): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-supervisor-processworkersupervisor-online-method"></a>
## ProcessWorkerSupervisor.#onLine

ID `fn-execution-process-supervisor-processworkersupervisor-online-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L58)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
#onLine(line: string): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-supervisor-processworkersupervisor-acquire-method"></a>
## ProcessWorkerSupervisor.acquire

ID `fn-execution-process-supervisor-processworkersupervisor-acquire-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L113)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
acquire(resourceId: string): number
```

源码说明（原注释，仅作来源）

```text
/** Acquire (or renew) the lease for a resource and remember the fencing token. */
```

<a id="fn-execution-process-supervisor-processworkersupervisor-fencingfor-method"></a>
## ProcessWorkerSupervisor.fencingFor

ID `fn-execution-process-supervisor-processworkersupervisor-fencingfor-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L120)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
fencingFor(resourceId: string): number | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-supervisor-processworkersupervisor-execute-method"></a>
## ProcessWorkerSupervisor.execute

ID `fn-execution-process-supervisor-processworkersupervisor-execute-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L129)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
async execute(
    operationId: string,
    action: { kind: "append-effect" | "sleep"; dir: string; sleepMs?: number; holdReceiptMs?: number },
  ): Promise<string>
```

源码说明（原注释，仅作来源）

```text
/**
   * Execute an already-assigned operation in the worker. Resolves
   * with the worker's detail once its report has been filed with the
   * control plane; rejects if the worker dies first.
   */
```

<a id="fn-execution-process-supervisor-processworkersupervisor-stop-method"></a>
## ProcessWorkerSupervisor.stop

ID `fn-execution-process-supervisor-processworkersupervisor-stop-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L162)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
async stop(operationId: string): Promise<{ childPid: number | null; exited: boolean }>
```

源码说明（原注释，仅作来源）

```text
/** Ask the worker to stop the operation's subprocess (cancel stages 2-3). */
```

<a id="fn-execution-process-supervisor-processworkersupervisor-kill-method"></a>
## ProcessWorkerSupervisor.kill

ID `fn-execution-process-supervisor-processworkersupervisor-kill-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L173)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
kill(signal: NodeJS.Signals = "SIGKILL"): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-supervisor-processworkersupervisor-onexit-method"></a>
## ProcessWorkerSupervisor.onExit

ID `fn-execution-process-supervisor-processworkersupervisor-onexit-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L177)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
onExit(handler: () => void): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-execution-process-supervisor-processworkersupervisor-shutdown-method"></a>
## ProcessWorkerSupervisor.shutdown

ID `fn-execution-process-supervisor-processworkersupervisor-shutdown-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/execution/src/process-supervisor.ts#L181)；SHA-256 `9378dc09ffeb77a3c47e50cd6af619f8189fa6d30f584062241b6d841aa330e0`。

```ts
async shutdown(): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
