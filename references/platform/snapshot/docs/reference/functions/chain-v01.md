# 产品知识问答

`chain-v01` 把资料读取、产品和版本筛选、信息抽取、判断与答案登记连起来。它尽量给出可找到来源的答案，遇到冲突或没有依据时明确说明。

当前抽取方法只覆盖样本涉及的几类指标，例如连接数、会话超时和地址池。相关函数会识别问题中的指标或产品名，从资料中提取数值和原句，再交给判断方法。另有校准程序把结果与固定样本比较。

这条问答流程是一个小范围的参考，不能据此说任意产品问题都能回答。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-chain-v01-calibration-runcalibration-function"></a>
## runCalibration

ID `fn-chain-v01-calibration-runcalibration-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/calibration.ts#L70)；SHA-256 `fb8e65324a445648fe8a7f49d28e2b1319a2660e1c508a2b69dc41b5a00b756d`。

```ts
export function runCalibration(
  samples: StandardSample[],
  assessor: Assessor = new ScriptedAssessor(),
): CalibrationReport
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-calibration-runcalibration-runone-callable-value"></a>
## runCalibration.runOne

ID `fn-chain-v01-calibration-runcalibration-runone-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/calibration.ts#L76)；SHA-256 `fb8e65324a445648fe8a7f49d28e2b1319a2660e1c508a2b69dc41b5a00b756d`。

```ts
(
    sampleId: string,
    key: string,
    expected: SampleExpected,
    qa: KnowledgeQaService,
    ctx: { tenantId: string; scopeId: string; snapshotId: string },
    question: SampleQuestion,
  ) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-metrics-digits-callable-value"></a>
## digits

ID `fn-chain-v01-metrics-digits-callable-value`；callable-value / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/metrics.ts#L16)；SHA-256 `3f0307a26e2a0845943176502f7b99ab097bc026f0218b5ff4a28abd08cba6c9`。

```ts
(raw: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-metrics-cnordigits-callable-value"></a>
## cnOrDigits

ID `fn-chain-v01-metrics-cnordigits-callable-value`；callable-value / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/metrics.ts#L29)；SHA-256 `3f0307a26e2a0845943176502f7b99ab097bc026f0218b5ff4a28abd08cba6c9`。

```ts
(raw: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-metrics-detectmetric-function"></a>
## detectMetric

ID `fn-chain-v01-metrics-detectmetric-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/metrics.ts#L81)；SHA-256 `3f0307a26e2a0845943176502f7b99ab097bc026f0218b5ff4a28abd08cba6c9`。

```ts
export function detectMetric(questionText: string): MetricDef | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-metrics-extractfacts-function"></a>
## extractFacts

ID `fn-chain-v01-metrics-extractfacts-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/metrics.ts#L94)；SHA-256 `3f0307a26e2a0845943176502f7b99ab097bc026f0218b5ff4a28abd08cba6c9`。

```ts
export function extractFacts(content: string, metric: MetricDef): ExtractedFact[]
```

源码说明（原注释，仅作来源）

```text
/** Extract at most one value per metric from one source's content. */
```

<a id="fn-chain-v01-metrics-detectquestionproduct-function"></a>
## detectQuestionProduct

ID `fn-chain-v01-metrics-detectquestionproduct-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/metrics.ts#L116)；SHA-256 `3f0307a26e2a0845943176502f7b99ab097bc026f0218b5ff4a28abd08cba6c9`。

```ts
export function detectQuestionProduct(questionText: string): string | undefined
```

源码说明（原注释，仅作来源）

```text
/** Product named in the question text, when it names one (LBX-200 ...). */
```

<a id="fn-chain-v01-metrics-sourceproduct-function"></a>
## sourceProduct

ID `fn-chain-v01-metrics-sourceproduct-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/metrics.ts#L121)；SHA-256 `3f0307a26e2a0845943176502f7b99ab097bc026f0218b5ff4a28abd08cba6c9`。

```ts
export function sourceProduct(input: {
  product?: string;
  content: string;
}): string | undefined
```

源码说明（原注释，仅作来源）

```text
/** Product a source speaks about: explicit field, else its first mention. */
```

<a id="fn-chain-v01-service-registrylike-register-interface-method"></a>
## RegistryLike.register

ID `fn-chain-v01-service-registrylike-register-interface-method`；interface-method / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/service.ts#L46)；SHA-256 `628c1211915559fe9b01b56a6115abcbcf2d67b57170e906d909ea3c46609c1e`。

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

<a id="fn-chain-v01-service-idgenlike-next-interface-method"></a>
## IdGenLike.next

ID `fn-chain-v01-service-idgenlike-next-interface-method`；interface-method / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/service.ts#L56)；SHA-256 `628c1211915559fe9b01b56a6115abcbcf2d67b57170e906d909ea3c46609c1e`。

```ts
next(prefix: string): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-service-bindinghash-function"></a>
## bindingHash

ID `fn-chain-v01-service-bindinghash-function`；function / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/service.ts#L59)；SHA-256 `628c1211915559fe9b01b56a6115abcbcf2d67b57170e906d909ea3c46609c1e`。

```ts
function bindingHash(parts: string[]): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-service-knowledgeqaservice-constructor-constructor"></a>
## KnowledgeQaService.constructor

ID `fn-chain-v01-service-knowledgeqaservice-constructor-constructor`；constructor / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/service.ts#L75)；SHA-256 `628c1211915559fe9b01b56a6115abcbcf2d67b57170e906d909ea3c46609c1e`。

```ts
constructor(deps: {
    store: KnowledgeStore;
    assessor: Assessor;
    registry: RegistryLike;
    ids: IdGenLike;
  })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-service-knowledgeqaservice-answer-method"></a>
## KnowledgeQaService.answer

ID `fn-chain-v01-service-knowledgeqaservice-answer-method`；method / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/service.ts#L87)；SHA-256 `628c1211915559fe9b01b56a6115abcbcf2d67b57170e906d909ea3c46609c1e`。

```ts
answer(input: {
    tenantId: string;
    scopeId: string;
    snapshotId: string;
    question: QuestionInput;
    askedAt: string;
  }): AnswerResult
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v01-service-knowledgeqaservice-answer-registerevidence-callable-value"></a>
## KnowledgeQaService.answer.registerEvidence

ID `fn-chain-v01-service-knowledgeqaservice-answer-registerevidence-callable-value`；callable-value / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v01/src/service.ts#L160)；SHA-256 `628c1211915559fe9b01b56a6115abcbcf2d67b57170e906d909ea3c46609c1e`。

```ts
(fact: (typeof facts)[number]): string =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
