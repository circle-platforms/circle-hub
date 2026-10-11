# 产品资料和知识快照

`knowledge` 保存一份资料的修订和内容摘要，记录它属于哪个项目、产品和版本，以及是否撤回。读取时按所属范围检查，避免把另一个项目的资料混进来。

它还把一组资料修订固定成快照。某次问答或测试可以使用指定快照，后来新资料加入时，原任务仍能知道自己用了哪一版资料。资料被撤回后，读取和答题时需要重新检查它的状态。

目前这是最小实现。完整知识库还要处理更多资料形式、对象关系、检索、发布和回滚。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-knowledge-index-clocklike-now-interface-method"></a>
## ClockLike.now

ID `fn-knowledge-index-clocklike-now-interface-method`；interface-method / internal；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L31)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
now(): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-idgenlike-next-interface-method"></a>
## IdGenLike.next

ID `fn-knowledge-index-idgenlike-next-interface-method`；interface-method / internal；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L34)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
next(prefix: string): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-knowledgestore-constructor-constructor"></a>
## KnowledgeStore.constructor

ID `fn-knowledge-index-knowledgestore-constructor-constructor`；constructor / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L43)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
constructor(clock: ClockLike, ids: IdGenLike)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-knowledgestore-key-method"></a>
## KnowledgeStore.#key

ID `fn-knowledge-index-knowledgestore-key-method`；method / internal；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L48)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
#key(tenantId: string, scopeId: string, id: string): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-knowledgestore-addrevision-method"></a>
## KnowledgeStore.addRevision

ID `fn-knowledge-index-knowledgestore-addrevision-method`；method / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L52)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
addRevision(input: {
    sourceRevisionId: string;
    tenantId: string;
    scopeId: string;
    content: string;
    product?: string;
    version?: string;
    status?: "active" | "withdrawn";
  }): Result<SourceRevision>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-knowledgestore-setstatus-method"></a>
## KnowledgeStore.setStatus

ID `fn-knowledge-index-knowledgestore-setstatus-method`；method / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L83)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
setStatus(
    tenantId: string,
    scopeId: string,
    sourceRevisionId: string,
    status: "active" | "withdrawn",
  ): Result<SourceRevision>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-knowledgestore-getrevision-method"></a>
## KnowledgeStore.getRevision

ID `fn-knowledge-index-knowledgestore-getrevision-method`；method / public；主归属建议 B；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L99)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
getRevision(
    tenantId: string,
    scopeId: string,
    sourceRevisionId: string,
  ): Result<SourceRevision>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-knowledgestore-createsnapshot-method"></a>
## KnowledgeStore.createSnapshot

ID `fn-knowledge-index-knowledgestore-createsnapshot-method`；method / public；主归属建议 B；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L123)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
createSnapshot(input: {
    tenantId: string;
    scopeId: string;
    sourceRevisionIds: string[];
    snapshotId?: string;
  }): Result<KnowledgeSnapshot>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-knowledgestore-getsnapshot-method"></a>
## KnowledgeStore.getSnapshot

ID `fn-knowledge-index-knowledgestore-getsnapshot-method`；method / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L147)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
getSnapshot(
    tenantId: string,
    scopeId: string,
    snapshotId: string,
  ): Result<KnowledgeSnapshot>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-knowledge-index-knowledgestore-revisionsof-method"></a>
## KnowledgeStore.revisionsOf

ID `fn-knowledge-index-knowledgestore-revisionsof-method`；method / public；主归属建议 B；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/knowledge/src/index.ts#L171)；SHA-256 `76278299127e0fc4c7c01207615548b20f5ae3bd4054da735e42165f68fc0c16`。

```ts
revisionsOf(snapshot: KnowledgeSnapshot): SourceRevision[]
```

源码说明（原注释，仅作来源）

```text
/** Member revisions of a snapshot, with their live status. */
```

</details>
