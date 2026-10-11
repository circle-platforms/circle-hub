# 怎样记录 AI 或程序的判断

`assessor` 为判断方法提供同一种结果形式。每次判断都要说明使用的方法、输入和证据，以及支持、反驳、冲突或证据不足等结果。

当前默认方法是按规则工作的程序。没有证据时不作支持判断，多份资料数值冲突时保留冲突。它用于检查流程能否正确传递判断结果，不能当作真实模型的质量证明。

以后接真实模型，可以沿用结果形式，但仍需记录模型版本并单独测量判断质量。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-assessor-index-assessor-assess-interface-method"></a>
## Assessor.assess

ID `fn-assessor-index-assessor-assess-interface-method`；interface-method / public；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/assessor/src/index.ts#L33)；SHA-256 `6f5d4fcb22c9ba561ae68f013a0b44493d0c1d692daadb7529fef97c6b041ae8`。

```ts
assess(input: AssessInput): AssessmentRecord
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-assessor-index-scriptedassessor-assess-method"></a>
## ScriptedAssessor.assess

ID `fn-assessor-index-scriptedassessor-assess-method`；method / public；主归属建议 E；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/assessor/src/index.ts#L47)；SHA-256 `6f5d4fcb22c9ba561ae68f013a0b44493d0c1d692daadb7529fef97c6b041ae8`。

```ts
assess(input: AssessInput): AssessmentRecord
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
