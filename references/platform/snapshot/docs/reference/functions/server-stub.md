# 通信方式的测试服务

`server-stub` 是一个受脚本控制的测试服务。同一份输入可以通过 MCP、命令行或 HTTP 调用，检查三条入口是否返回同样的业务结果。

它可以模拟立即完成、慢任务、等待回答、目标失败和丢回执，也能保存和恢复测试状态。它的辅助函数负责整理请求、状态、错误和下一步提示。

这是协议试验台。正式产品不能把它当作拥有真实权限、持久任务和设备操作能力的服务。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-server-stub-cli-main-function"></a>
## main

ID `fn-server-stub-cli-main-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/cli.ts#L20)；SHA-256 `69ca82ce00600f5f35de8e38b876b6c541f14e3e9f9dd87df3be795926156310`。

```ts
function main(): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-http-server-createstubhttpserver-function"></a>
## createStubHttpServer

ID `fn-server-stub-http-server-createstubhttpserver-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/http-server.ts#L16)；SHA-256 `359e73c9599e18f0569c68dcecb6f78d72be0de7f8c458439f4ec52ba324317c`。

```ts
export function createStubHttpServer(service: LongTaskService): Server
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-mcp-server-persist-function"></a>
## persist

ID `fn-server-stub-mcp-server-persist-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/mcp-server.ts#L43)；SHA-256 `6442f8dcf8a8ccdb565575ace408653606e9c3e9fcdb72b71c687b88e1d27203`。

```ts
function persist(): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-mcp-server-logline-function"></a>
## logLine

ID `fn-server-stub-mcp-server-logline-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/mcp-server.ts#L50)；SHA-256 `6442f8dcf8a8ccdb565575ace408653606e9c3e9fcdb72b71c687b88e1d27203`。

```ts
function logLine(path: string | undefined, entry: Record<string, unknown>): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-mcp-server-get-method"></a>
## get

ID `fn-server-stub-mcp-server-get-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/mcp-server.ts#L112)；SHA-256 `6442f8dcf8a8ccdb565575ace408653606e9c3e9fcdb72b71c687b88e1d27203`。

```ts
get()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-mcp-server-set-method"></a>
## set

ID `fn-server-stub-mcp-server-set-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/mcp-server.ts#L115)；SHA-256 `6442f8dcf8a8ccdb565575ace408653606e9c3e9fcdb72b71c687b88e1d27203`。

```ts
set(fn: (message: unknown) => void)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-snapshot-method"></a>
## LongTaskService.snapshot

ID `fn-server-stub-service-longtaskservice-snapshot-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L60)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
snapshot(): unknown
```

源码说明（原注释，仅作来源）

```text
/* ---------------- persistence (used by the CLI transport) -------- */
```

<a id="fn-server-stub-service-longtaskservice-restore-method"></a>
## LongTaskService.restore

ID `fn-server-stub-service-longtaskservice-restore-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L72)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
static restore(data: unknown): LongTaskService
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-now-method"></a>
## LongTaskService.now

ID `fn-server-stub-service-longtaskservice-now-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L97)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
private now(): string
```

源码说明（原注释，仅作来源）

```text
/* ---------------- helpers ---------------------------------------- */
```

<a id="fn-server-stub-service-longtaskservice-makeerror-method"></a>
## LongTaskService.makeError

ID `fn-server-stub-service-longtaskservice-makeerror-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L102)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
private makeError(
    code: ErrorCode,
    message: string,
    userAction?: string,
  ): StructuredError
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-respond-method"></a>
## LongTaskService.respond

ID `fn-server-stub-service-longtaskservice-respond-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L120)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
private respond(
    requestId: string,
    status: ResponseStatus,
    extra: Partial<ResponseEnvelope> = {},
  ): ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-fail-method"></a>
## LongTaskService.fail

ID `fn-server-stub-service-longtaskservice-fail-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L140)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
private fail(
    requestId: string,
    code: ErrorCode,
    message: string,
    userAction?: string,
  ): ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-parseenvelope-method"></a>
## LongTaskService.parseEnvelope

ID `fn-server-stub-service-longtaskservice-parseenvelope-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L153)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
private parseEnvelope(
    raw: unknown,
  ):
    | { ok: true; env: import("@infosec/contracts").RequestEnvelope }
    | { ok: false; response: ResponseEnvelope }
```

源码说明（原注释，仅作来源）

```text
/** Parse + platform-level checks shared by all six calls. */
```

<a id="fn-server-stub-service-longtaskservice-opfrompayload-method"></a>
## LongTaskService.opFromPayload

ID `fn-server-stub-service-longtaskservice-opfrompayload-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L185)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
private opFromPayload(
    env: import("@infosec/contracts").RequestEnvelope,
  ): OpRecord | ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-statusresponse-method"></a>
## LongTaskService.statusResponse

ID `fn-server-stub-service-longtaskservice-statusresponse-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L209)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
private statusResponse(
    env: import("@infosec/contracts").RequestEnvelope,
    op: OpRecord,
  ): ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-submit-method"></a>
## LongTaskService.submit

ID `fn-server-stub-service-longtaskservice-submit-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L229)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
submit(raw: unknown): ResponseEnvelope
```

源码说明（原注释，仅作来源）

```text
/* ---------------- the six calls ---------------------------------- */
```

<a id="fn-server-stub-service-longtaskservice-status-method"></a>
## LongTaskService.status

ID `fn-server-stub-service-longtaskservice-status-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L307)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
status(raw: unknown): ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-result-method"></a>
## LongTaskService.result

ID `fn-server-stub-service-longtaskservice-result-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L318)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
result(raw: unknown): ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-input-method"></a>
## LongTaskService.input

ID `fn-server-stub-service-longtaskservice-input-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L327)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
input(raw: unknown): ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-cancel-method"></a>
## LongTaskService.cancel

ID `fn-server-stub-service-longtaskservice-cancel-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L358)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
cancel(raw: unknown): ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-reconcile-method"></a>
## LongTaskService.reconcile

ID `fn-server-stub-service-longtaskservice-reconcile-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L389)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
reconcile(raw: unknown): ResponseEnvelope
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-longtaskservice-advance-method"></a>
## LongTaskService.advance

ID `fn-server-stub-service-longtaskservice-advance-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L408)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
private advance(op: OpRecord): void
```

源码说明（原注释，仅作来源）

```text
/* ---------------- scripted progression ---------------------------- */
```

<a id="fn-server-stub-service-isfinal-function"></a>
## isFinal

ID `fn-server-stub-service-isfinal-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L467)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
function isFinal(op: OpRecord): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-responsestatusforop-function"></a>
## responseStatusForOp

ID `fn-server-stub-service-responsestatusforop-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L475)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
function responseStatusForOp(op: OpRecord): ResponseStatus
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-pendinginputsof-function"></a>
## pendingInputsOf

ID `fn-server-stub-service-pendinginputsof-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L502)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
function pendingInputsOf(op: OpRecord)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-server-stub-service-nextactionsfor-function"></a>
## nextActionsFor

ID `fn-server-stub-service-nextactionsfor-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/server-stub/src/service.ts#L519)；SHA-256 `eb17738a90fd027e5cda929be8fc5de540ee981d2f7d63d30c8e1ec42f5e584a`。

```ts
function nextActionsFor(op: OpRecord): ResponseEnvelope["nextActions"]
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
