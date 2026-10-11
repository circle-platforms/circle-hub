# 用例评审

`chain-v04` 先把 Markdown 用例拆成可处理的条目，再按已声明的几项规则寻找问题，保存位置、严重程度和判断记录。

当前规则关注归属/权限检查、关键操作的异常分支、凭据明文和前后矛盾。评审报告还要经用户确认才能交付。修改了用例后，需要针对新版本再检查。

这里也有校准程序，用正确样本、缺陷样本和修订样本检查规则表现。规则没有发现问题，只能说明在它检查的范围内没有发现问题，不能证明整个用例完全正确。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-chain-v04-calibration-runv04calibration-function"></a>
## runV04Calibration

ID `fn-chain-v04-calibration-runv04calibration-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/calibration.ts#L49)；SHA-256 `a0406d0310cec28cb6fa617953bc7c877589f9fac213bd0b5cd4c967d67e0b04`。

```ts
export function runV04Calibration(input: {
  baselineCases: UseCase[];
  defectSample: DefectSample;
  revisionCase: UseCase;
}): V04CalibrationReport
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v04-parse-parseusecasemarkdown-function"></a>
## parseUseCaseMarkdown

ID `fn-chain-v04-parse-parseusecasemarkdown-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/parse.ts#L11)；SHA-256 `33f22711e53c4f119b14f12c4c2d78ffb25cdc58edc35a98bab8a885f954a30a`。

```ts
export function parseUseCaseMarkdown(md: string): UseCase[]
```

源码说明（原注释，仅作来源）

```text
/**
 * Split a Markdown use-case collection (`## UC-01 ...` headings, the
 * SMP-V04-01 form) into individual cases. Text before the first heading
 * (titles, coverage notes) is not a case.
 */
```

<a id="fn-chain-v04-rules-hasassertedguard-function"></a>
## hasAssertedGuard

ID `fn-chain-v04-rules-hasassertedguard-function`；function / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/rules.ts#L32)；SHA-256 `c9541d63a5f3e69fefedff39c16bc5c91e2d0eabb9eb760a27f6e2255086c335`。

```ts
function hasAssertedGuard(text: string): boolean
```

源码说明（原注释，仅作来源）

```text
/**
 * A guard counts only when it is actually asserted. Sample texts may
 * *mention* a guard in a negated annotation ("未提登录与归属校验"),
 * which is the absence of a guard, not its presence: an occurrence
 * preceded (within 6 chars) by a negation character does not count.
 */
```

<a id="fn-chain-v04-rules-reviewcasedimensions-function"></a>
## reviewCaseDimensions

ID `fn-chain-v04-rules-reviewcasedimensions-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/rules.ts#L47)；SHA-256 `c9541d63a5f3e69fefedff39c16bc5c91e2d0eabb9eb760a27f6e2255086c335`。

```ts
export function reviewCaseDimensions(kase: UseCase): FindingDraft[]
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v04-service-registrylike-register-interface-method"></a>
## RegistryLike.register

ID `fn-chain-v04-service-registrylike-register-interface-method`；interface-method / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/service.ts#L38)；SHA-256 `588fd585f04f24a9c308d25d84377a27c9c1bea661b8c5a1e4c0dcc85abebcf0`。

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

<a id="fn-chain-v04-service-idgenlike-next-interface-method"></a>
## IdGenLike.next

ID `fn-chain-v04-service-idgenlike-next-interface-method`；interface-method / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/service.ts#L48)；SHA-256 `588fd585f04f24a9c308d25d84377a27c9c1bea661b8c5a1e4c0dcc85abebcf0`。

```ts
next(prefix: string): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v04-service-hashcases-function"></a>
## hashCases

ID `fn-chain-v04-service-hashcases-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/service.ts#L51)；SHA-256 `588fd585f04f24a9c308d25d84377a27c9c1bea661b8c5a1e4c0dcc85abebcf0`。

```ts
export function hashCases(cases: UseCase[]): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v04-service-reviewservice-constructor-constructor"></a>
## ReviewService.constructor

ID `fn-chain-v04-service-reviewservice-constructor-constructor`；constructor / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/service.ts#L68)；SHA-256 `588fd585f04f24a9c308d25d84377a27c9c1bea661b8c5a1e4c0dcc85abebcf0`。

```ts
constructor(deps: { registry: RegistryLike; ids: IdGenLike })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v04-service-reviewservice-review-method"></a>
## ReviewService.review

ID `fn-chain-v04-service-reviewservice-review-method`；method / public；主归属建议 E；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v04/src/service.ts#L73)；SHA-256 `588fd585f04f24a9c308d25d84377a27c9c1bea661b8c5a1e4c0dcc85abebcf0`。

```ts
review(input: {
    tenantId: string;
    scopeId: string;
    cases: UseCase[];
    reviewedAt: string;
  }): ReviewReport
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
