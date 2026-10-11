# 内存中的任务和操作

`platform` 是最早的公共参考实现。它把任务、实际操作、资源占用和证据登记放在一个包里，用来跑通流程。职责仍然分别由对应模块承担。

任务部分能创建任务、读取进度、等待用户回答、更新输入和检查完成清单。操作部分能登记一次操作、记录开始和结果、处理取消或结果不明。资源占用部分让操作取得、续期和释放使用权，并拒绝已经过时的写入。证据登记部分保存记录的身份、范围和内容摘要，方便其他步骤引用。

它还提供可控制的测试时钟、标识生成器和统一的成功/失败结果。这些帮助测试稳定复现。

这里的数据保存在内存中。它不能独自保证程序重启后仍能恢复，也不能仅凭内部状态证明远端进程已经停止。当前代码中的完成、停止和核对入口，还需要按正式使用要求补齐检查。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-platform-clock-clock-now-interface-method"></a>
## Clock.now

ID `fn-platform-clock-clock-now-interface-method`；interface-method / public；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/clock.ts#L3)；SHA-256 `23c6b4ad2b9c52ab0265b87ff045afa701c93bf047a2296a50987e360c68d424`。

```ts
now(): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-clock-systemclock-now-callable-value"></a>
## systemClock.now

ID `fn-platform-clock-systemclock-now-callable-value`；callable-value / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/clock.ts#L6)；SHA-256 `23c6b4ad2b9c52ab0265b87ff045afa701c93bf047a2296a50987e360c68d424`。

```ts
() =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-clock-fakeclock-constructor-constructor"></a>
## FakeClock.constructor

ID `fn-platform-clock-fakeclock-constructor-constructor`；constructor / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/clock.ts#L10)；SHA-256 `23c6b4ad2b9c52ab0265b87ff045afa701c93bf047a2296a50987e360c68d424`。

```ts
constructor(startMs = 0)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-clock-fakeclock-now-method"></a>
## FakeClock.now

ID `fn-platform-clock-fakeclock-now-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/clock.ts#L13)；SHA-256 `23c6b4ad2b9c52ab0265b87ff045afa701c93bf047a2296a50987e360c68d424`。

```ts
now(): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-clock-fakeclock-advance-method"></a>
## FakeClock.advance

ID `fn-platform-clock-fakeclock-advance-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/clock.ts#L16)；SHA-256 `23c6b4ad2b9c52ab0265b87ff045afa701c93bf047a2296a50987e360c68d424`。

```ts
advance(ms: number): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-clock-iso-function"></a>
## iso

ID `fn-platform-clock-iso-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/clock.ts#L21)；SHA-256 `23c6b4ad2b9c52ab0265b87ff045afa701c93bf047a2296a50987e360c68d424`。

```ts
export function iso(ms: number): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-idgen-idgen-next-method"></a>
## IdGen.next

ID `fn-platform-idgen-idgen-next-method`；method / public；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/idgen.ts#L5)；SHA-256 `bf7b9879205222e87f014a4ee800d249d92a8221049aec371837c7d9e81364c4`。

```ts
next(prefix: string): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-leases-leasemanager-constructor-constructor"></a>
## LeaseManager.constructor

ID `fn-platform-leases-leasemanager-constructor-constructor`；constructor / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/leases.ts#L31)；SHA-256 `03545ae17335d35830871b55b4b0bdc6af62c288c20f30cabe577a658f0b887e`。

```ts
constructor(clock: Clock, ids: IdGen)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-leases-leasemanager-islive-method"></a>
## LeaseManager.#isLive

ID `fn-platform-leases-leasemanager-islive-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/leases.ts#L36)；SHA-256 `03545ae17335d35830871b55b4b0bdc6af62c288c20f30cabe577a658f0b887e`。

```ts
#isLive(lease: Lease): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-leases-leasemanager-activelease-method"></a>
## LeaseManager.#activeLease

ID `fn-platform-leases-leasemanager-activelease-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/leases.ts#L40)；SHA-256 `03545ae17335d35830871b55b4b0bdc6af62c288c20f30cabe577a658f0b887e`。

```ts
#activeLease(resourceId: string): Lease | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-leases-leasemanager-acquire-method"></a>
## LeaseManager.acquire

ID `fn-platform-leases-leasemanager-acquire-method`；method / public；主归属建议 D；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/leases.ts#L48)；SHA-256 `03545ae17335d35830871b55b4b0bdc6af62c288c20f30cabe577a658f0b887e`。

```ts
acquire(
    resourceId: string,
    holderRunId: string,
    ttlMs: number = DEFAULT_LEASE_TTL_MS,
  ): Result<Lease>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-leases-leasemanager-renew-method"></a>
## LeaseManager.renew

ID `fn-platform-leases-leasemanager-renew-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/leases.ts#L74)；SHA-256 `03545ae17335d35830871b55b4b0bdc6af62c288c20f30cabe577a658f0b887e`。

```ts
renew(leaseId: string, fencingToken: number): Result<Lease>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-leases-leasemanager-release-method"></a>
## LeaseManager.release

ID `fn-platform-leases-leasemanager-release-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/leases.ts#L89)；SHA-256 `03545ae17335d35830871b55b4b0bdc6af62c288c20f30cabe577a658f0b887e`。

```ts
release(leaseId: string, fencingToken: number): Result<{ released: true }>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-leases-leasemanager-iscurrent-method"></a>
## LeaseManager.isCurrent

ID `fn-platform-leases-leasemanager-iscurrent-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/leases.ts#L104)；SHA-256 `03545ae17335d35830871b55b4b0bdc6af62c288c20f30cabe577a658f0b887e`。

```ts
isCurrent(resourceId: string, fencingToken: number): boolean
```

源码说明（原注释，仅作来源）

```text
/** True only for the live lease carrying exactly this token. */
```

<a id="fn-platform-leases-leasemanager-sweepexpired-method"></a>
## LeaseManager.sweepExpired

ID `fn-platform-leases-leasemanager-sweepexpired-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/leases.ts#L110)；SHA-256 `03545ae17335d35830871b55b4b0bdc6af62c288c20f30cabe577a658f0b887e`。

```ts
sweepExpired(): Lease[]
```

源码说明（原注释，仅作来源）

```text
/** Each expired, unreleased lease is reported exactly once. */
```

<a id="fn-platform-operations-canonicalrequesthash-function"></a>
## canonicalRequestHash

ID `fn-platform-operations-canonicalrequesthash-function`；function / exported；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L58)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
export function canonicalRequestHash(request: unknown): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-constructor-constructor"></a>
## OperationService.constructor

ID `fn-platform-operations-operationservice-constructor-constructor`；constructor / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L82)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
constructor(
    clock: Clock,
    ids: IdGen,
    leases: LeaseManager,
    opts: { dedupeWindowMs?: number; resultRetentionMs?: number } = {},
  )
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-get-method"></a>
## OperationService.get

ID `fn-platform-operations-operationservice-get-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L95)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
get(operationId: string): OperationRecord | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-submit-method"></a>
## OperationService.submit

ID `fn-platform-operations-operationservice-submit-method`；method / public；主归属建议 D；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L99)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
submit(
    input: SubmitInput,
  ): Result<{ operation: OperationRecord; duplicate: boolean }>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-move-method"></a>
## OperationService.#move

ID `fn-platform-operations-operationservice-move-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L150)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
#move(op: OperationRecord, to: OperationStatus): Result<OperationRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-leaselive-method"></a>
## OperationService.#leaseLive

ID `fn-platform-operations-operationservice-leaselive-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L162)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
#leaseLive(op: OperationRecord): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-start-method"></a>
## OperationService.start

ID `fn-platform-operations-operationservice-start-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L170)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
start(operationId: string): Result<OperationRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-complete-method"></a>
## OperationService.complete

ID `fn-platform-operations-operationservice-complete-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L191)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
complete(
    operationId: string,
    outcome: "succeeded" | "failed" | "partial",
    result?: unknown,
  ): Result<OperationRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-writeguard-method"></a>
## OperationService.writeGuard

ID `fn-platform-operations-operationservice-writeguard-method`；method / public；主归属建议 D；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L221)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
writeGuard(operationId: string): Result<{ allowed: true }>
```

源码说明（原注释，仅作来源）

```text
/** Fencing-checked write: the only way a holder may mutate a resource. */
```

<a id="fn-platform-operations-operationservice-requestcancel-method"></a>
## OperationService.requestCancel

ID `fn-platform-operations-operationservice-requestcancel-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L236)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
requestCancel(operationId: string): Result<OperationRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-confirmstopped-method"></a>
## OperationService.confirmStopped

ID `fn-platform-operations-operationservice-confirmstopped-method`；method / public；主归属建议 D；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L242)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
confirmStopped(operationId: string): Result<OperationRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-operations-operationservice-markunknown-method"></a>
## OperationService.markUnknown

ID `fn-platform-operations-operationservice-markunknown-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L263)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
markUnknown(operationId: string): Result<OperationRecord>
```

源码说明（原注释，仅作来源）

```text
/**
   * Record that an operation's outcome became unknowable to the caller
   * (receipt lost, connection dropped mid-commit — RC-03's entry point).
   * The operation may only leave `unknown` through reconcile.
   */
```

<a id="fn-platform-operations-operationservice-sweep-method"></a>
## OperationService.sweep

ID `fn-platform-operations-operationservice-sweep-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L276)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
sweep(): { resumedReads: string[]; unknowned: string[] }
```

源码说明（原注释，仅作来源）

```text
/**
   * Observe lease expiries and apply the ADR 0011 split. Returns what
   * happened so callers and tests can assert on it.
   */
```

<a id="fn-platform-operations-operationservice-reconcile-method"></a>
## OperationService.reconcile

ID `fn-platform-operations-operationservice-reconcile-method`；method / public；主归属建议 D；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L321)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
reconcile(
    operationId: string,
    decision:
      | { action: "resume" }
      | {
          action: "final";
          outcome: "succeeded" | "failed" | "partial";
          result?: unknown;
          evidenceNote: string;
        },
  ): Result<OperationRecord>
```

源码说明（原注释，仅作来源）

```text
/**
   * The only way out of `unknown` (RC-03). "resume" is permitted for read
   * operations, or for effect operations carrying reconcile evidence.
   */
```

<a id="fn-platform-operations-operationservice-responsestatus-method"></a>
## OperationService.responseStatus

ID `fn-platform-operations-operationservice-responsestatus-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L368)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
responseStatus(op: OperationRecord): ResponseStatus
```

源码说明（原注释，仅作来源）

```text
/** Envelope-level status for a finished operation (FZ-01 mapping). */
```

<a id="fn-platform-operations-operationservice-getresult-method"></a>
## OperationService.getResult

ID `fn-platform-operations-operationservice-getresult-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/operations.ts#L392)；SHA-256 `3a30912e5780c34b5f039b786f9e944a6bacfe595e90759d8bdd24e1a51c46d4`。

```ts
getResult(
    operationId: string,
  ): Result<{ status: ResponseStatus; result?: unknown; resultExpired: boolean }>
```

源码说明（原注释，仅作来源）

```text
/** Terminal results stay retrievable for the retention window (ADR 0011). */
```

<a id="fn-platform-registry-registry-constructor-constructor"></a>
## Registry.constructor

ID `fn-platform-registry-registry-constructor-constructor`；constructor / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/registry.ts#L28)；SHA-256 `d28d3c6082d7bdd450a5fdd3adb3ed3e27255358a17f4a4be1802a0ee0f2e9b1`。

```ts
constructor(clock: Clock, ids: IdGen)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-registry-registry-register-method"></a>
## Registry.register

ID `fn-platform-registry-registry-register-method`；method / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/registry.ts#L33)；SHA-256 `d28d3c6082d7bdd450a5fdd3adb3ed3e27255358a17f4a4be1802a0ee0f2e9b1`。

```ts
register(input: Omit<RegisteredItem, "id" | "registeredAt">): RegisteredItem
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-registry-registry-get-method"></a>
## Registry.get

ID `fn-platform-registry-registry-get-method`；method / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/registry.ts#L43)；SHA-256 `d28d3c6082d7bdd450a5fdd3adb3ed3e27255358a17f4a4be1802a0ee0f2e9b1`。

```ts
get(
    id: string,
    tenantId: string,
    scopeId: string,
  ): Result<RegisteredItem>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-registry-registry-list-method"></a>
## Registry.list

ID `fn-platform-registry-registry-list-method`；method / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/registry.ts#L59)；SHA-256 `d28d3c6082d7bdd450a5fdd3adb3ed3e27255358a17f4a4be1802a0ee0f2e9b1`。

```ts
list(tenantId: string, scopeId: string): RegisteredItem[]
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-result-ok-function"></a>
## ok

ID `fn-platform-result-ok-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/result.ts#L13)；SHA-256 `19ce132b5d92473f5499496620f74e1ac8dd7a46ea69b093384327d8177c4742`。

```ts
export function ok<T>(value: T): Result<T>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-result-fail-function"></a>
## fail

ID `fn-platform-result-fail-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/result.ts#L17)；SHA-256 `19ce132b5d92473f5499496620f74e1ac8dd7a46ea69b093384327d8177c4742`。

```ts
export function fail<T>(
  code: ErrorCode,
  message: string,
  userAction?: string,
): Result<T>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-tasks-taskservice-constructor-constructor"></a>
## TaskService.constructor

ID `fn-platform-tasks-taskservice-constructor-constructor`；constructor / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L43)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
constructor(clock: Clock, ids: IdGen)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-tasks-taskservice-createtask-method"></a>
## TaskService.createTask

ID `fn-platform-tasks-taskservice-createtask-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L48)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
createTask(input: {
    tenantId: string;
    scopeId: string;
    principalId: string;
    title: string;
  }): TaskRecord
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-tasks-taskservice-get-method"></a>
## TaskService.get

ID `fn-platform-tasks-taskservice-get-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L71)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
get(taskId: string): TaskRecord | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-tasks-taskservice-transition-method"></a>
## TaskService.transition

ID `fn-platform-tasks-taskservice-transition-method`；method / public；主归属建议 C；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L75)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
transition(taskId: string, to: TaskPhase): Result<TaskRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-tasks-taskservice-bumpinputrevision-method"></a>
## TaskService.bumpInputRevision

ID `fn-platform-tasks-taskservice-bumpinputrevision-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L91)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
bumpInputRevision(taskId: string): Result<TaskRecord>
```

源码说明（原注释，仅作来源）

```text
/** A new input revision voids any attached checklist (ST-04). */
```

<a id="fn-platform-tasks-taskservice-requestinput-method"></a>
## TaskService.requestInput

ID `fn-platform-tasks-taskservice-requestinput-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L100)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
requestInput(
    taskId: string,
    input: {
      decisionType: DecisionType;
      question: string;
      options?: string[];
      sensitiveChannel?: boolean;
      ttlMs?: number;
    },
  ): Result<PendingInput>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-tasks-taskservice-respond-method"></a>
## TaskService.respond

ID `fn-platform-tasks-taskservice-respond-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L140)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
respond(
    taskId: string,
    response: PendingInputResponse,
  ): Result<{ outcome: PendingResponseOutcome }>
```

源码说明（原注释，仅作来源）

```text
/**
   * The outcome is data, not an exception: stale and expired responses are
   * recorded rejections and never advance the task (HUM-02).
   */
```

<a id="fn-platform-tasks-taskservice-attachchecklist-method"></a>
## TaskService.attachChecklist

ID `fn-platform-tasks-taskservice-attachchecklist-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L164)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
attachChecklist(
    taskId: string,
    checklist: CompletionChecklist,
  ): Result<TaskRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-tasks-taskservice-satisfyitem-method"></a>
## TaskService.satisfyItem

ID `fn-platform-tasks-taskservice-satisfyitem-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L184)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
satisfyItem(taskId: string, itemId: string): Result<TaskRecord>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-tasks-taskservice-deliver-method"></a>
## TaskService.deliver

ID `fn-platform-tasks-taskservice-deliver-method`；method / public；主归属建议 C；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform/src/tasks.ts#L198)；SHA-256 `3b9a81cb40707497ebfec25f8db871d3fbd044030c05712dff128479f7549d65`。

```ts
deliver(taskId: string): Result<TaskRecord>
```

源码说明（原注释，仅作来源）

```text
/** VER-03 gate: only from under-review, only with all required items met. */
```

</details>
