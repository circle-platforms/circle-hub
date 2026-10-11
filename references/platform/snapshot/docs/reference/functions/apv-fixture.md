# 模拟设备与设备操作流程

`apv-fixture` 提供一台内存中的模拟设备。它能打开和关闭会话，读取、暂存、提交和回滚配置，还能模拟回执丢失、身份变化、版本冲突和延迟。

驱动部分把这些动作接到平台的操作记录上。它检查设备身份，发现身份变化就停止后续写入。提交结果不清楚时，先读取设备状态来核对，不直接再提交一次。场景程序检查正常变更、丢回执、版本冲突和身份变化，并检查会话和暂存内容有没有清理。

它帮助我们检查设备流程，未连接真实 APV，也未证明 SSH 的实际通道行为。真实 SSH 和产品现场要另外验证。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-apv-fixture-driver-sha256json-function"></a>
## sha256Json

ID `fn-apv-fixture-driver-sha256json-function`；function / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L9)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
function sha256Json(value: unknown): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-registrylike-register-interface-method"></a>
## RegistryLike.register

ID `fn-apv-fixture-driver-registrylike-register-interface-method`；interface-method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L15)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
register(input: {
    tenantId: string;
    scopeId: string;
    kind: "evidence" | "artifact";
    sha256: string;
    label: string;
    bindings: Record<string, string>;
  }): { id: string }
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-idgenlike-next-interface-method"></a>
## IdGenLike.next

ID `fn-apv-fixture-driver-idgenlike-next-interface-method`；interface-method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L25)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
next(prefix: string): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-constructor-constructor"></a>
## ApvDriver.constructor

ID `fn-apv-fixture-driver-apvdriver-constructor-constructor`；constructor / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L58)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
constructor(deps: {
    fixture: ApvFixture;
    ops: OperationService;
    registry: RegistryLike;
    ids: IdGenLike;
    ctx: { tenantId: string; scopeId: string; principalId: string; runId: string };
    timeoutMs?: number;
  })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-halted-getter"></a>
## ApvDriver.halted

ID `fn-apv-fixture-driver-apvdriver-halted-getter`；getter / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L74)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
get halted(): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-lastknownversion-getter"></a>
## ApvDriver.lastKnownVersion

ID `fn-apv-fixture-driver-apvdriver-lastknownversion-getter`；getter / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L77)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
get lastKnownVersion(): number | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-sessionopen-getter"></a>
## ApvDriver.sessionOpen

ID `fn-apv-fixture-driver-apvdriver-sessionopen-getter`；getter / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L80)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
get sessionOpen(): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-submit-method"></a>
## ApvDriver.#submit

ID `fn-apv-fixture-driver-apvdriver-submit-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L84)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
#submit(name: string, kind: "read" | "effect", request: unknown)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-identitydrifted-method"></a>
## ApvDriver.#identityDrifted

ID `fn-apv-fixture-driver-apvdriver-identitydrifted-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L94)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
#identityDrifted(receipt: Receipt): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-driftfail-method"></a>
## ApvDriver.#driftFail

ID `fn-apv-fixture-driver-apvdriver-driftfail-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L120)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
#driftFail<T>(): Result<T>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-haltedguard-method"></a>
## ApvDriver.#haltedGuard

ID `fn-apv-fixture-driver-apvdriver-haltedguard-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L127)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
#haltedGuard<T>(): Result<T> | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-opensession-method"></a>
## ApvDriver.openSession

ID `fn-apv-fixture-driver-apvdriver-opensession-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L137)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
openSession(): Result<{ sessionId: string; serial: string }>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-readconfig-method"></a>
## ApvDriver.readConfig

ID `fn-apv-fixture-driver-apvdriver-readconfig-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L156)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
readConfig(object: string): Result<{ value?: string; configVersion: number }>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-stagechange-method"></a>
## ApvDriver.stageChange

ID `fn-apv-fixture-driver-apvdriver-stagechange-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L185)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
stageChange(object: string, value: string): Result<{ stageId: string }>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-commitchange-method"></a>
## ApvDriver.commitChange

ID `fn-apv-fixture-driver-apvdriver-commitchange-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L215)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
commitChange(): Result<CommitOutcome>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-reconcilecommit-method"></a>
## ApvDriver.reconcileCommit

ID `fn-apv-fixture-driver-apvdriver-reconcilecommit-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L260)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
reconcileCommit(operationId: string): Result<{ applied: boolean; currentVersion: number }>
```

源码说明（原注释，仅作来源）

```text
/**
   * Settle an unknown commit by reading the device back. The readback
   * (object value + config version) is registered as evidence and cited
   * in the reconcile note; the change is never resubmitted.
   */
```

<a id="fn-apv-fixture-driver-apvdriver-rollback-method"></a>
## ApvDriver.rollback

ID `fn-apv-fixture-driver-apvdriver-rollback-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L303)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
rollback(toVersion: number): Result<{ newVersion: number }>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-driver-apvdriver-closesession-method"></a>
## ApvDriver.closeSession

ID `fn-apv-fixture-driver-apvdriver-closesession-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L325)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
closeSession(): Result<{ closed: true }>
```

源码说明（原注释，仅作来源）

```text
/** Closing is a safety action: allowed even while halted. */
```

<a id="fn-apv-fixture-driver-apvdriver-verifyclean-method"></a>
## ApvDriver.verifyClean

ID `fn-apv-fixture-driver-apvdriver-verifyclean-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/driver.ts#L336)；SHA-256 `358a75be2b708013559ebfdb39b5ab670b58fadd354dfd9d0bcff9a0dcf9acaa`。

```ts
verifyClean(baselineConfig: Record<string, string>): {
    sessionResidue: boolean;
    stagedResidue: boolean;
    configMatchesBaseline: boolean;
  }
```

源码说明（原注释，仅作来源）

```text
/** Cleanup verification against a baseline config (content equality). */
```

<a id="fn-apv-fixture-fixture-apvfixture-constructor-constructor"></a>
## ApvFixture.constructor

ID `fn-apv-fixture-fixture-apvfixture-constructor-constructor`；constructor / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L65)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
constructor()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-state-getter"></a>
## ApvFixture.state

ID `fn-apv-fixture-fixture-apvfixture-state-getter`；getter / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L69)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
get state(): FixtureState
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-configversion-getter"></a>
## ApvFixture.configVersion

ID `fn-apv-fixture-fixture-apvfixture-configversion-getter`；getter / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L72)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
get configVersion(): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-activesessionid-getter"></a>
## ApvFixture.activeSessionId

ID `fn-apv-fixture-fixture-apvfixture-activesessionid-getter`；getter / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L75)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
get activeSessionId(): string | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-hasstagedchange-getter"></a>
## ApvFixture.hasStagedChange

ID `fn-apv-fixture-fixture-apvfixture-hasstagedchange-getter`；getter / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L78)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
get hasStagedChange(): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-arm-method"></a>
## ApvFixture.arm

ID `fn-apv-fixture-fixture-apvfixture-arm-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L82)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
arm(injection: InjectionId): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-disarm-method"></a>
## ApvFixture.disarm

ID `fn-apv-fixture-fixture-apvfixture-disarm-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L85)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
disarm(injection: InjectionId): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-identity-method"></a>
## ApvFixture.#identity

ID `fn-apv-fixture-fixture-apvfixture-identity-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L89)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
#identity(): DeviceIdentity
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-delay-method"></a>
## ApvFixture.#delay

ID `fn-apv-fixture-fixture-apvfixture-delay-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L95)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
#delay(): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-receipt-method"></a>
## ApvFixture.#receipt

ID `fn-apv-fixture-fixture-apvfixture-receipt-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L99)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
#receipt(partial: Partial<Receipt>): Receipt
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-error-method"></a>
## ApvFixture.#error

ID `fn-apv-fixture-fixture-apvfixture-error-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L108)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
#error(errorCode: FixtureErrorCode, message: string): Receipt
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-requiresession-method"></a>
## ApvFixture.#requireSession

ID `fn-apv-fixture-fixture-apvfixture-requiresession-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L118)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
#requireSession(): Receipt | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-open-method"></a>
## ApvFixture.open

ID `fn-apv-fixture-fixture-apvfixture-open-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L125)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
open(): Receipt
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-read-method"></a>
## ApvFixture.read

ID `fn-apv-fixture-fixture-apvfixture-read-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L138)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
read(object: string): Receipt
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-stage-method"></a>
## ApvFixture.stage

ID `fn-apv-fixture-fixture-apvfixture-stage-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L147)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
stage(object: string, value: string, baseVersion: number): Receipt
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-commit-method"></a>
## ApvFixture.commit

ID `fn-apv-fixture-fixture-apvfixture-commit-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L173)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
commit(stageId: string): Receipt & { receiptLost?: boolean; disconnected?: boolean }
```

源码说明（原注释，仅作来源）

```text
/**
   * Commit outcome markers: a normal receipt, `receiptLost` (INJ-APV-1:
   * applied, receipt never arrives), or `disconnected` (INJ-APV-2: the
   * connection drops mid-commit and, in this fixture's deterministic
   * model, the change is NOT applied — the caller cannot know that).
   */
```

<a id="fn-apv-fixture-fixture-apvfixture-rollback-method"></a>
## ApvFixture.rollback

ID `fn-apv-fixture-fixture-apvfixture-rollback-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L198)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
rollback(toVersion: number): Receipt
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-close-method"></a>
## ApvFixture.close

ID `fn-apv-fixture-fixture-apvfixture-close-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L214)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
close(): Receipt
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-fixture-apvfixture-externaladvance-method"></a>
## ApvFixture.externalAdvance

ID `fn-apv-fixture-fixture-apvfixture-externaladvance-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L224)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
externalAdvance(object: string, value: string): void
```

源码说明（原注释，仅作来源）

```text
/** Test-side external actor: advances the config outside any session flow. */
```

<a id="fn-apv-fixture-fixture-apvfixture-reportedidentity-method"></a>
## ApvFixture.reportedIdentity

ID `fn-apv-fixture-fixture-apvfixture-reportedidentity-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L231)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
reportedIdentity(): DeviceIdentity
```

源码说明（原注释，仅作来源）

```text
/** Identity as the device currently reports it (drift-aware). */
```

<a id="fn-apv-fixture-fixture-apvfixture-snapshotstate-method"></a>
## ApvFixture.snapshotState

ID `fn-apv-fixture-fixture-apvfixture-snapshotstate-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/fixture.ts#L236)；SHA-256 `0d9e25c732d8894d044063ed5070fded0af7b4620d15bcfba9801f77cf3abec4`。

```ts
snapshotState(): {
    config: Record<string, string>;
    configVersion: number;
    state: FixtureState;
    sessionActive: boolean;
    staged: boolean;
  }
```

源码说明（原注释，仅作来源）

```text
/** Deep snapshot for cleanup assertions. */
```

<a id="fn-apv-fixture-scenarios-makestack-function"></a>
## makeStack

ID `fn-apv-fixture-scenarios-makestack-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L24)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
export function makeStack()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-scenarios1-function"></a>
## scenarioS1

ID `fn-apv-fixture-scenarios-scenarios1-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L46)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
function scenarioS1(): ScenarioResult
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-scenarios1-t-callable-value"></a>
## scenarioS1.t

ID `fn-apv-fixture-scenarios-scenarios1-t-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L49)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
(name: string, passed: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-scenarios2-function"></a>
## scenarioS2

ID `fn-apv-fixture-scenarios-scenarios2-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L80)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
function scenarioS2(): ScenarioResult
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-scenarios2-t-callable-value"></a>
## scenarioS2.t

ID `fn-apv-fixture-scenarios-scenarios2-t-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L83)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
(name: string, passed: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-scenarios3-function"></a>
## scenarioS3

ID `fn-apv-fixture-scenarios-scenarios3-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L118)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
function scenarioS3(): ScenarioResult
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-scenarios3-t-callable-value"></a>
## scenarioS3.t

ID `fn-apv-fixture-scenarios-scenarios3-t-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L121)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
(name: string, passed: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-scenarios4-function"></a>
## scenarioS4

ID `fn-apv-fixture-scenarios-scenarios4-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L143)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
function scenarioS4(): ScenarioResult
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-scenarios4-t-callable-value"></a>
## scenarioS4.t

ID `fn-apv-fixture-scenarios-scenarios4-t-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L146)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
(name: string, passed: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-apv-fixture-scenarios-runallscenarios-function"></a>
## runAllScenarios

ID `fn-apv-fixture-scenarios-runallscenarios-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/apv-fixture/src/scenarios.ts#L171)；SHA-256 `8be8e62d574c3828de87a3c87015858ef2cef9949ae18dea89bcee0f59e4d618`。

```ts
export function runAllScenarios(): ScenarioResult[]
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
