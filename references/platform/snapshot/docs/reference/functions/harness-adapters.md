# 外部入口的接入验证

`harness-adapters` 保存接入验证用的脚本化模型端点和驱动材料。模型端点按预先写好的计划发出工具调用，记录请求，用来检查固定版本客户端怎样传递工具、输入与结果。

P3-4 另有三入口的局部运行记录，其中 Circle 使用 loader 路径，平台任务由 stub 的状态文件承载。它不能证明全屏 UI、真实模型质量、PG 业务服务全链或用户实时查看已经完成。本轮只读取源码与记录，不重跑这些实验。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-harness-adapters-scripted-llm-log-function"></a>
## log

ID `fn-harness-adapters-scripted-llm-log-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/harness-adapters/src/scripted-llm.mjs#L22)；SHA-256 `a3e990d338f2b6ddae89a1808b01a9f7386f6f07b0ed3a59442017217ef93781`。

```ts
function log(entry)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-harness-adapters-scripted-llm-picktool-function"></a>
## pickTool

ID `fn-harness-adapters-scripted-llm-picktool-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/harness-adapters/src/scripted-llm.mjs#L26)；SHA-256 `a3e990d338f2b6ddae89a1808b01a9f7386f6f07b0ed3a59442017217ef93781`。

```ts
function pickTool(tools, suffix)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-harness-adapters-scripted-llm-completion-function"></a>
## completion

ID `fn-harness-adapters-scripted-llm-completion-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/harness-adapters/src/scripted-llm.mjs#L31)；SHA-256 `a3e990d338f2b6ddae89a1808b01a9f7386f6f07b0ed3a59442017217ef93781`。

```ts
function completion(step, tools)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-harness-adapters-scripted-llm-ssechunks-function"></a>
## sseChunks

ID `fn-harness-adapters-scripted-llm-ssechunks-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/harness-adapters/src/scripted-llm.mjs#L60)；SHA-256 `a3e990d338f2b6ddae89a1808b01a9f7386f6f07b0ed3a59442017217ef93781`。

```ts
function sseChunks(body)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
