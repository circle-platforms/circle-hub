# 保存在数据库中的任务

`platform-pg` 开始把任务保存到 PostgreSQL。创建任务时，任务记录、重复请求记录和待发送通知一起提交；只有提交成功后才算正式受理。

它支持读取任务、改变进度、更新输入、提出问题和保存用户回答。多人同时修改同一项任务时，会检查是否仍在修改同一版内容。输入变化后，原完成清单失效。

交付前会检查清单、引用和签字人的角色。它还把需要通知其他部分的事情保存下来，再逐项发送，接收方处理重复通知。

这部分已有独立的本地验证记录，但还不能代表整个长期任务系统已经完成。真实身份接入、所有证据种类的检查、完整恢复和外部操作仍需要继续完善。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-platform-pg-service-durabletaskservice-constructor-constructor"></a>
## DurableTaskService.constructor

ID `fn-platform-pg-service-durabletaskservice-constructor-constructor`；constructor / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L35)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
constructor(pool: Pool, ids: { next(prefix: string): string })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-migrate-method"></a>
## DurableTaskService.migrate

ID `fn-platform-pg-service-durabletaskservice-migrate-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L40)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async migrate(): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-tx-method"></a>
## DurableTaskService.#tx

ID `fn-platform-pg-service-durabletaskservice-tx-method`；method / internal；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L44)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async #tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-outbox-method"></a>
## DurableTaskService.#outbox

ID `fn-platform-pg-service-durabletaskservice-outbox-method`；method / internal；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L59)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async #outbox(client: PoolClient, taskId: string, kind: string, payload: unknown): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-accepttask-method"></a>
## DurableTaskService.acceptTask

ID `fn-platform-pg-service-durabletaskservice-accepttask-method`；method / public；主归属建议 C；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L66)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async acceptTask(input: {
    tenantId: string;
    scopeId: string;
    principalId: string;
    title: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<Result<TaskRow & { deduplicated: boolean }>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-taskbyid-method"></a>
## DurableTaskService.#taskById

ID `fn-platform-pg-service-durabletaskservice-taskbyid-method`；method / internal；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L110)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async #taskById(client: PoolClient | Pool, taskId: string): Promise<TaskRow | undefined>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-gettask-method"></a>
## DurableTaskService.getTask

ID `fn-platform-pg-service-durabletaskservice-gettask-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L130)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async getTask(ctx: Ctx, taskId: string): Promise<Result<TaskRow>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-transition-method"></a>
## DurableTaskService.transition

ID `fn-platform-pg-service-durabletaskservice-transition-method`；method / public；主归属建议 C；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L139)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async transition(
    ctx: Ctx,
    taskId: string,
    to: TaskPhase,
    expectedRevision: number,
  ): Promise<Result<TaskRow>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-reviseinput-method"></a>
## DurableTaskService.reviseInput

ID `fn-platform-pg-service-durabletaskservice-reviseinput-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L173)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async reviseInput(ctx: Ctx, taskId: string, expectedRevision: number): Promise<Result<TaskRow>>
```

源码说明（原注释，仅作来源）

```text
/** Replace the task's input: new revision id, checklist voided. */
```

<a id="fn-platform-pg-service-durabletaskservice-addscopemember-method"></a>
## DurableTaskService.addScopeMember

ID `fn-platform-pg-service-durabletaskservice-addscopemember-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L197)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async addScopeMember(ctx: Ctx, actorId: string, role: string): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-requestinput-method"></a>
## DurableTaskService.requestInput

ID `fn-platform-pg-service-durabletaskservice-requestinput-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L205)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async requestInput(
    ctx: Ctx,
    taskId: string,
    input: { decisionType: string; sensitiveChannel?: boolean; ttlMs: number },
    nowMs: number,
  ): Promise<Result<{ requestId: string }>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-respond-method"></a>
## DurableTaskService.respond

ID `fn-platform-pg-service-durabletaskservice-respond-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L231)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async respond(
    ctx: Ctx,
    taskId: string,
    response: {
      requestId: string;
      inputRevisionId: string;
      actorId: string;
      role: string;
    },
    nowMs: number,
  ): Promise<Result<{ outcome: "accepted" | "stale-revision" | "expired" }>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-registerverification-method"></a>
## DurableTaskService.registerVerification

ID `fn-platform-pg-service-durabletaskservice-registerverification-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L288)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async registerVerification(
    taskId: string,
    refId: string,
    kind: string,
    note: string,
  ): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-attachchecklist-method"></a>
## DurableTaskService.attachChecklist

ID `fn-platform-pg-service-durabletaskservice-attachchecklist-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L301)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async attachChecklist(
    ctx: Ctx,
    taskId: string,
    items: { itemId: string; kind: string; required: boolean }[],
  ): Promise<Result<{ itemCount: number }>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-satisfyitem-method"></a>
## DurableTaskService.satisfyItem

ID `fn-platform-pg-service-durabletaskservice-satisfyitem-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L324)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async satisfyItem(
    ctx: Ctx,
    taskId: string,
    itemId: string,
    input: { refId: string; actorId: string },
  ): Promise<Result<{ satisfied: true }>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-platform-pg-service-durabletaskservice-deliver-method"></a>
## DurableTaskService.deliver

ID `fn-platform-pg-service-durabletaskservice-deliver-method`；method / public；主归属建议 C；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L378)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async deliver(ctx: Ctx, taskId: string, expectedRevision: number): Promise<Result<TaskRow>>
```

源码说明（原注释，仅作来源）

```text
/** The C-T01 delivery gate: every bypass path is rejected. */
```

<a id="fn-platform-pg-service-durabletaskservice-publishoutbox-method"></a>
## DurableTaskService.publishOutbox

ID `fn-platform-pg-service-durabletaskservice-publishoutbox-method`；method / public；主归属建议 C；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/platform-pg/src/service.ts#L450)；SHA-256 `1929f90cb01a76600aaa22ccc1583b1ff64dc3165d2582913a5c7650f9abdcb7`。

```ts
async publishOutbox(
    limit: number,
    handler: (event: { eventId: string; taskId: string; kind: string }) => Promise<void>,
  ): Promise<number>
```

源码说明（原注释，仅作来源）

```text
/** Publish pending outbox events once per batch; handler dedupes by event id. */
```

</details>
