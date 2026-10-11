# 脑图转 Excel

`chain-v05` 接收主题树或 XMind 的内容 JSON，先把它们转换成同一种树，再按约定把节点编成表格行，生成工作簿。

它记录哪些节点无法解释，无法全部处理时把遗漏写出来。生成后还能重新读工作簿，检查表名、表头、行和说明信息。标题整理、内容摘要和节点遍历等小函数帮助保持输出一致。

当前处理的是结构转换。真实 XMind 文件的版本范围、完整业务用例、命令和预期生成，还没有因此得到证明。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-chain-v05-compile-compilerows-function"></a>
## compileRows

ID `fn-chain-v05-compile-compilerows-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/compile.ts#L25)；SHA-256 `7f46eb0dfeef6ba0ba8293adf6299fcc728ced92a6c7675f52290ad84458286e`。

```ts
export function compileRows(root: TopicNode): WorkbookRow[]
```

源码说明（原注释，仅作来源）

```text
/**
 * Row rule (§3.2): the root and depth-1 module nodes are groupings only;
 * every topic at depth >= 2 is exactly one row, depth-first.
 */
```

<a id="fn-chain-v05-compile-compilerows-walk-callable-value"></a>
## compileRows.walk

ID `fn-chain-v05-compile-compilerows-walk-callable-value`；callable-value / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/compile.ts#L28)；SHA-256 `7f46eb0dfeef6ba0ba8293adf6299fcc728ced92a6c7675f52290ad84458286e`。

```ts
(node: TopicNode, depth: number, segments: string[]) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-ir-normalizetitle-function"></a>
## normalizeTitle

ID `fn-chain-v05-ir-normalizetitle-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/ir.ts#L20)；SHA-256 `5d75b9bd1b954aa6ecc74f1aff8299084ca984cb18be3d4749ca8f8ab2232629`。

```ts
export function normalizeTitle(raw: string): string
```

源码说明（原注释，仅作来源）

```text
/** Title normalization (§1): trim, internal newlines become single spaces. */
```

<a id="fn-chain-v05-ir-canonical-function"></a>
## canonical

ID `fn-chain-v05-ir-canonical-function`；function / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/ir.ts#L24)；SHA-256 `5d75b9bd1b954aa6ecc74f1aff8299084ca984cb18be3d4749ca8f8ab2232629`。

```ts
function canonical(node: TopicNode): unknown
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-ir-irhash-function"></a>
## irHash

ID `fn-chain-v05-ir-irhash-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/ir.ts#L33)；SHA-256 `5d75b9bd1b954aa6ecc74f1aff8299084ca984cb18be3d4749ca8f8ab2232629`。

```ts
export function irHash(root: TopicNode): string
```

源码说明（原注释，仅作来源）

```text
/** SHA-256 of the canonical IR serialization (§1). */
```

<a id="fn-chain-v05-ir-sha256hex-function"></a>
## sha256Hex

ID `fn-chain-v05-ir-sha256hex-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/ir.ts#L39)；SHA-256 `5d75b9bd1b954aa6ecc74f1aff8299084ca984cb18be3d4749ca8f8ab2232629`。

```ts
export function sha256Hex(data: string | Buffer): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-parse-isobject-function"></a>
## isObject

ID `fn-chain-v05-parse-isobject-function`；function / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/parse.ts#L10)；SHA-256 `a4ca4d45e90e3d64ffce09b291275636c127b88023c7e3e929d2b52d682d468e`。

```ts
function isObject(v: unknown): v is Record<string, unknown>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-parse-converttreenode-function"></a>
## convertTreeNode

ID `fn-chain-v05-parse-converttreenode-function`；function / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/parse.ts#L18)；SHA-256 `a4ca4d45e90e3d64ffce09b291275636c127b88023c7e3e929d2b52d682d468e`。

```ts
function convertTreeNode(
  raw: unknown,
  path: string,
  unmapped: UnmappedEntry[],
  isRoot: boolean,
): TopicNode | undefined
```

源码说明（原注释，仅作来源）

```text
/* ------------------------------------------------------------------ */
/* Topic-tree JSON: a bare IR node, or an object carrying `root`.      */
/* ------------------------------------------------------------------ */
```

<a id="fn-chain-v05-parse-parsetopictree-function"></a>
## parseTopicTree

ID `fn-chain-v05-parse-parsetopictree-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/parse.ts#L61)；SHA-256 `a4ca4d45e90e3d64ffce09b291275636c127b88023c7e3e929d2b52d682d468e`。

```ts
export function parseTopicTree(data: unknown): ParseOutcome
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-parse-convertxmindtopic-function"></a>
## convertXmindTopic

ID `fn-chain-v05-parse-convertxmindtopic-function`；function / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/parse.ts#L82)；SHA-256 `a4ca4d45e90e3d64ffce09b291275636c127b88023c7e3e929d2b52d682d468e`。

```ts
function convertXmindTopic(
  raw: unknown,
  path: string,
  unmapped: UnmappedEntry[],
): TopicNode | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-parse-parsexmindcontent-function"></a>
## parseXmindContent

ID `fn-chain-v05-parse-parsexmindcontent-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/parse.ts#L137)；SHA-256 `a4ca4d45e90e3d64ffce09b291275636c127b88023c7e3e929d2b52d682d468e`。

```ts
export function parseXmindContent(data: unknown): ParseOutcome
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-service-invalidpayload-function"></a>
## invalidPayload

ID `fn-chain-v05-service-invalidpayload-function`；function / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/service.ts#L29)；SHA-256 `535937cf6f0cd7ec1cb0d0a8f31ade66042a53eeec89c9a5d9e2b3f53bd820e4`。

```ts
function invalidPayload(message: string): StructuredError
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-service-compilemindmap-function"></a>
## compileMindmap

ID `fn-chain-v05-service-compilemindmap-function`；function / exported；主归属建议 E；设计 draft-contract；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/service.ts#L46)；SHA-256 `535937cf6f0cd7ec1cb0d0a8f31ade66042a53eeec89c9a5d9e2b3f53bd820e4`。

```ts
export async function compileMindmap(input: {
  data: unknown;
  format: MindmapFormat;
  sourceSha256: string;
  generatedAtIso?: string;
}): Promise<CompileResult>
```

源码说明（原注释，仅作来源）

```text
/**
 * The V05 compile operation. Unparseable input fails as a whole with no
 * workbook; unmappable elements produce `partial` with the list carried
 * in the result and in the workbook's 说明 sheet (contract §3.5).
 */
```

<a id="fn-chain-v05-workbook-buildworkbook-function"></a>
## buildWorkbook

ID `fn-chain-v05-workbook-buildworkbook-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/workbook.ts#L28)；SHA-256 `d57bbdb88af83c237d33080a6528eebfaa75c1c8a77042bb8dba739b4e3946d6`。

```ts
export async function buildWorkbook(
  rows: WorkbookRow[],
  meta: WorkbookMeta,
): Promise<Buffer>
```

源码说明（原注释，仅作来源）

```text
/** Build the two-sheet workbook exactly per contract §3.1/§3.4. */
```

<a id="fn-chain-v05-workbook-celltext-function"></a>
## cellText

ID `fn-chain-v05-workbook-celltext-function`；function / internal；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/workbook.ts#L63)；SHA-256 `d57bbdb88af83c237d33080a6528eebfaa75c1c8a77042bb8dba739b4e3946d6`。

```ts
function cellText(v: unknown): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-chain-v05-workbook-readworkbook-function"></a>
## readWorkbook

ID `fn-chain-v05-workbook-readworkbook-function`；function / exported；主归属建议 E；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/chain-v05/src/workbook.ts#L69)；SHA-256 `d57bbdb88af83c237d33080a6528eebfaa75c1c8a77042bb8dba739b4e3946d6`。

```ts
export async function readWorkbook(buf: Buffer): Promise<ReadBack>
```

源码说明（原注释，仅作来源）

```text
/** Round-trip reader used by the verification side of the chain (§3.5). */
```

</details>
