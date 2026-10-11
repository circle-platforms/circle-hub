# 公共格式与基础规则

`contracts` 让各部分对同一件事使用一致的表达。它定义任务、操作、输入、结果、错误、证据引用和人工回答的格式，也规定哪些状态可以转到哪些状态。

其中的函数会检查引用有没有缺项、人工回答是否对应原问题、声明只读的操作是否真的没有声明写入，以及结果是否带着需要的证据引用。还有一些函数负责把状态转换成命令行退出码，或导出其他程序能使用的格式说明。

这些检查只解决格式和明确规则的问题。证据引用存在，不代表证据内容足以支持结论；格式通过，也不代表实际设备操作成功。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-contracts-bindings-validatebindingclosure-function"></a>
## validateBindingClosure

ID `fn-contracts-bindings-validatebindingclosure-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/bindings.ts#L80)；SHA-256 `048fae47bb0152483662fbf0349ed7ddaec3b7de8c2b20e9ec4214effcc918d5`。

```ts
export function validateBindingClosure(
  bindings: BindingSet,
  opts: BindingClosureOptions,
): string[]
```

源码说明（原注释，仅作来源）

```text
/**
 * Program-side closure check. Returns human-readable issues; an empty
 * array means the binding set is closed for the declared work.
 */
```

<a id="fn-contracts-effects-deriveadmissiontier-function"></a>
## deriveAdmissionTier

ID `fn-contracts-effects-deriveadmissiontier-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/effects.ts#L69)；SHA-256 `63ad92206f38df2d5e3063a01696f8eb884a6cfae687ab393b789e43262b2c01`。

```ts
export function deriveAdmissionTier(effect: EffectDescriptor): AdmissionTier
```

源码说明（原注释，仅作来源）

```text
/** EFF-02 / AUTH-05: irreversible effects always need separate admission. */
```

<a id="fn-contracts-effects-isreadonlyconsistent-function"></a>
## isReadOnlyConsistent

ID `fn-contracts-effects-isreadonlyconsistent-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/effects.ts#L81)；SHA-256 `63ad92206f38df2d5e3063a01696f8eb884a6cfae687ab393b789e43262b2c01`。

```ts
export function isReadOnlyConsistent(effect: EffectDescriptor): boolean
```

源码说明（原注释，仅作来源）

```text
/**
 * EFF-01: a "read-only" claim is only consistent when nothing is written
 * and nothing leaves the boundary. Resource occupation (lease, session)
 * does not break read-only data semantics but must still be declared,
 * which the descriptor forces.
 */
```

<a id="fn-contracts-effects-occupiesresources-function"></a>
## occupiesResources

ID `fn-contracts-effects-occupiesresources-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/effects.ts#L85)；SHA-256 `63ad92206f38df2d5e3063a01696f8eb884a6cfae687ab393b789e43262b2c01`。

```ts
export function occupiesResources(effect: EffectDescriptor): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-contracts-ids-prefixedid-callable-value"></a>
## prefixedId

ID `fn-contracts-ids-prefixedid-callable-value`；callable-value / internal；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/ids.ts#L9)；SHA-256 `a6cf73d683403070892490ecd821815018965cd86a088977f741d6d1aeba3663`。

```ts
(prefix: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-contracts-index-contractjsonschemas-function"></a>
## contractJsonSchemas

ID `fn-contracts-index-contractjsonschemas-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/index.ts#L33)；SHA-256 `101dc807c32147032a8e556ba22d175389c14e1d728d829c2986ae7c2ab8df2d`。

```ts
export function contractJsonSchemas(): Record<string, unknown>
```

源码说明（原注释，仅作来源）

```text
/**
 * JSON Schemas generated from the same Zod source, for wire consumers
 * that do not run TypeScript. Generated, never hand-maintained.
 */
```

<a id="fn-contracts-pending-evaluatependingresponse-function"></a>
## evaluatePendingResponse

ID `fn-contracts-pending-evaluatependingresponse-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/pending.ts#L62)；SHA-256 `a923d042fae23cb3bf7f9700437efb65878cbc52a5fff3f4e79625668a227471`。

```ts
export function evaluatePendingResponse(
  pending: PendingInput,
  response: PendingInputResponse,
): PendingResponseOutcome
```

源码说明（原注释，仅作来源）

```text
/**
 * HUM-02: a late response to a superseded revision, or after expiry,
 * must be rejected — it never advances the current revision.
 */
```

<a id="fn-contracts-pending-requiressensitivechannel-function"></a>
## requiresSensitiveChannel

ID `fn-contracts-pending-requiressensitivechannel-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/pending.ts#L80)；SHA-256 `a923d042fae23cb3bf7f9700437efb65878cbc52a5fff3f4e79625668a227471`。

```ts
export function requiresSensitiveChannel(p: PendingInput): boolean
```

源码说明（原注释，仅作来源）

```text
/** Credential and MFA decisions must use the sensitive channel (HUM-04). */
```

<a id="fn-contracts-records-validateassessment-function"></a>
## validateAssessment

ID `fn-contracts-records-validateassessment-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/records.ts#L73)；SHA-256 `48edea2efeacb5d84e0aeee9d7a95073dcaaeedf367e6647d1fea0c400b52086`。

```ts
export function validateAssessment(a: AssessmentRecord): string[]
```

源码说明（原注释，仅作来源）

```text
/**
 * A supports/refutes conclusion with no evidence cited is not a judgement,
 * it is an assertion. Flag it; insufficient-evidence / abstained may
 * legitimately have no supporting evidence.
 */
```

<a id="fn-contracts-records-evaluatecompletion-function"></a>
## evaluateCompletion

ID `fn-contracts-records-evaluatecompletion-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/records.ts#L119)；SHA-256 `48edea2efeacb5d84e0aeee9d7a95073dcaaeedf367e6647d1fea0c400b52086`。

```ts
export function evaluateCompletion(checklist: CompletionChecklist): {
  canDeliver: boolean;
  missing: string[];
}
```

源码说明（原注释，仅作来源）

```text
/**
 * `delivered` may only be produced when every required item is satisfied
 * (VER-03). Execution success alone never satisfies this by itself.
 */
```

<a id="fn-contracts-vocab-responsestatusforexitcode-function"></a>
## responseStatusForExitCode

ID `fn-contracts-vocab-responsestatusforexitcode-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/vocab.ts#L49)；SHA-256 `082dc79f75e080a6a0fe9b071bcc1622fa1f49c02436ee36062e4b9009e79307`。

```ts
export function responseStatusForExitCode(
  code: number,
): ResponseStatus | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-contracts-vocab-isfinalstatus-function"></a>
## isFinalStatus

ID `fn-contracts-vocab-isfinalstatus-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/vocab.ts#L58)；SHA-256 `082dc79f75e080a6a0fe9b071bcc1622fa1f49c02436ee36062e4b9009e79307`。

```ts
export function isFinalStatus(status: ResponseStatus): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-contracts-vocab-cantasktransition-function"></a>
## canTaskTransition

ID `fn-contracts-vocab-cantasktransition-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/vocab.ts#L113)；SHA-256 `082dc79f75e080a6a0fe9b071bcc1622fa1f49c02436ee36062e4b9009e79307`。

```ts
export function canTaskTransition(from: TaskPhase, to: TaskPhase): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-contracts-vocab-canoperationtransition-function"></a>
## canOperationTransition

ID `fn-contracts-vocab-canoperationtransition-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/vocab.ts#L155)；SHA-256 `082dc79f75e080a6a0fe9b071bcc1622fa1f49c02436ee36062e4b9009e79307`。

```ts
export function canOperationTransition(
  from: OperationStatus,
  to: OperationStatus,
): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-contracts-vocab-errorcodeinfo-function"></a>
## errorCodeInfo

ID `fn-contracts-vocab-errorcodeinfo-function`；function / exported；主归属建议 F；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/contracts/src/vocab.ts#L227)；SHA-256 `082dc79f75e080a6a0fe9b071bcc1622fa1f49c02436ee36062e4b9009e79307`。

```ts
export function errorCodeInfo(code: ErrorCode): ErrorCodeInfo
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
