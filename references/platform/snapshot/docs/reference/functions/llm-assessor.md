# 真实模型评测的调用与判断

`llm-assessor` 为 P3-5 评测构造提示、调用模型并形成判断记录。预算跟踪器记录调用和用量，调用函数按现有策略处理传输错误与重试；判断适配器把输入和证据绑定到返回记录。无法解析或不在约定范围的结论转成弃答，预算超限向上报错。

当前调用通过外部桥接命令完成，不是已选定的 circle-server 生产模型接入。这里说明实际源码，未执行桥接、未读取密钥、未调用模型或重跑评测。语义准确率、预算策略与完整披露仍需各自验收；新增函数条目的归属只是待评审建议，静态登记不证明业务正确。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-llm-assessor-budget-budgettracker-constructor-constructor"></a>
## BudgetTracker.constructor

ID `fn-llm-assessor-budget-budgettracker-constructor-constructor`；constructor / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/budget.ts#L34)；SHA-256 `50bbfd74bc1ec1c0c86c4732d3e7e04a87e07f2177d322a7514db6c3538e89ab`。

```ts
constructor(
    readonly maxCalls = 120,
    readonly maxTokens = 1_500_000,
  )
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-budget-budgettracker-totaltokens-getter"></a>
## BudgetTracker.totalTokens

ID `fn-llm-assessor-budget-budgettracker-totaltokens-getter`；getter / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/budget.ts#L39)；SHA-256 `50bbfd74bc1ec1c0c86c4732d3e7e04a87e07f2177d322a7514db6c3538e89ab`。

```ts
get totalTokens(): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-budget-budgettracker-assertcallallowed-method"></a>
## BudgetTracker.assertCallAllowed

ID `fn-llm-assessor-budget-budgettracker-assertcallallowed-method`；method / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/budget.ts#L43)；SHA-256 `50bbfd74bc1ec1c0c86c4732d3e7e04a87e07f2177d322a7514db6c3538e89ab`。

```ts
assertCallAllowed(purpose: string): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-budget-budgettracker-snapshot-method"></a>
## BudgetTracker.snapshot

ID `fn-llm-assessor-budget-budgettracker-snapshot-method`；method / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/budget.ts#L56)；SHA-256 `50bbfd74bc1ec1c0c86c4732d3e7e04a87e07f2177d322a7514db6c3538e89ab`。

```ts
snapshot()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-budget-callfailed-constructor-constructor"></a>
## CallFailed.constructor

ID `fn-llm-assessor-budget-callfailed-constructor-constructor`；constructor / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/budget.ts#L70)；SHA-256 `50bbfd74bc1ec1c0c86c4732d3e7e04a87e07f2177d322a7514db6c3538e89ab`。

```ts
constructor(
    message: string,
    readonly attempts: CallAttempt[],
  )
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-budget-callmessages-function"></a>
## callMessages

ID `fn-llm-assessor-budget-callmessages-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/budget.ts#L107)；SHA-256 `50bbfd74bc1ec1c0c86c4732d3e7e04a87e07f2177d322a7514db6c3538e89ab`。

```ts
export function callMessages(
  budget: BudgetTracker,
  purpose: string,
  request: Record<string, unknown>,
): { response: MessagesResponse; text: string }
```

源码说明（原注释，仅作来源）

```text
/**
 * One logical model call. Retry rule (frozen plan §3): only
 * transport/5xx failures retry, at most 2 retries, every attempt
 * logged. Content or parse problems are the caller's business and
 * are never retried here.
 */
```

<a id="fn-llm-assessor-budget-parsemodeljson-function"></a>
## parseModelJson

ID `fn-llm-assessor-budget-parsemodeljson-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/budget.ts#L175)；SHA-256 `50bbfd74bc1ec1c0c86c4732d3e7e04a87e07f2177d322a7514db6c3538e89ab`。

```ts
export function parseModelJson(text: string): Record<string, unknown> | null
```

源码说明（原注释，仅作来源）

```text
/** Extract the first JSON object from a model text reply, or null. */
```

<a id="fn-llm-assessor-llm-assessor-llmassessor-constructor-constructor"></a>
## LlmAssessor.constructor

ID `fn-llm-assessor-llm-assessor-llmassessor-constructor-constructor`；constructor / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/llm-assessor.ts#L46)；SHA-256 `789d2bc2917c18ca1c8ab049caa8b5527d0952e4bc36974a90a7d5a3c8ca6965`。

```ts
constructor(private readonly budget: BudgetTracker)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-llm-assessor-llmassessor-assess-method"></a>
## LlmAssessor.assess

ID `fn-llm-assessor-llm-assessor-llmassessor-assess-method`；method / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/llm-assessor.ts#L48)；SHA-256 `789d2bc2917c18ca1c8ab049caa8b5527d0952e4bc36974a90a7d5a3c8ca6965`。

```ts
assess(input: AssessInput): AssessmentRecord
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-llm-assessor-llmassessor-assess-abstain-callable-value"></a>
## LlmAssessor.assess.abstain

ID `fn-llm-assessor-llm-assessor-llmassessor-assess-abstain-callable-value`；callable-value / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/llm-assessor.ts#L59)；SHA-256 `789d2bc2917c18ca1c8ab049caa8b5527d0952e4bc36974a90a7d5a3c8ca6965`。

```ts
(reason: string, extra: string[] = []) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-prompts-buildassessuser-function"></a>
## buildAssessUser

ID `fn-llm-assessor-prompts-buildassessuser-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/prompts.ts#L32)；SHA-256 `20eb84cb0d277741dc107f2896ca97d10868d273fc98bac11201db2f3cb47c77`。

```ts
export function buildAssessUser(input: AssessInput): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-llm-assessor-prompts-buildreviewuser-function"></a>
## buildReviewUser

ID `fn-llm-assessor-prompts-buildreviewuser-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/llm-assessor/src/prompts.ts#L85)；SHA-256 `20eb84cb0d277741dc107f2896ca97d10868d273fc98bac11201db2f3cb47c77`。

```ts
export function buildReviewUser(caseId: string, text: string): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
