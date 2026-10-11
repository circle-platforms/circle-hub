# 本地登录测试站

`test-site` 提供一个本地 HTTP 网站，用来检查登录、失败计数、锁定、验证码、退出和会话失效。

客户端负责发送 HTTP 请求和保存测试 cookie。登录驱动把账号和验证码的待输入请求接到任务中，再根据页面中的明确状态标记判断结果。场景程序检查错误密码、账号锁定、验证码过期和旧会话残留。

这部分的 HTTP 驱动直接发送请求；后续 `execution` 的浏览器 worker 已另外接入本地测试站。不同记录的验证范围分别保留，不能据此说用户实时查看、视觉理解或真实业务站点已经验证。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-test-site-client-siteclient-constructor-constructor"></a>
## SiteClient.constructor

ID `fn-test-site-client-siteclient-constructor-constructor`；constructor / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/client.ts#L20)；SHA-256 `c8afe0b5d33d629e6eeefe250176462151fa4c5164de3529e8479d36f550ce86`。

```ts
constructor(baseUrl: string)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-client-siteclient-cookie-getter"></a>
## SiteClient.cookie

ID `fn-test-site-client-siteclient-cookie-getter`；getter / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/client.ts#L24)；SHA-256 `c8afe0b5d33d629e6eeefe250176462151fa4c5164de3529e8479d36f550ce86`。

```ts
get cookie(): string | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-client-siteclient-savecookie-method"></a>
## SiteClient.saveCookie

ID `fn-test-site-client-siteclient-savecookie-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/client.ts#L28)；SHA-256 `c8afe0b5d33d629e6eeefe250176462151fa4c5164de3529e8479d36f550ce86`。

```ts
saveCookie(): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-client-siteclient-restoresavedcookie-method"></a>
## SiteClient.restoreSavedCookie

ID `fn-test-site-client-siteclient-restoresavedcookie-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/client.ts#L32)；SHA-256 `c8afe0b5d33d629e6eeefe250176462151fa4c5164de3529e8479d36f550ce86`。

```ts
restoreSavedCookie(): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-client-siteclient-discardsavedcookie-method"></a>
## SiteClient.discardSavedCookie

ID `fn-test-site-client-siteclient-discardsavedcookie-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/client.ts#L36)；SHA-256 `c8afe0b5d33d629e6eeefe250176462151fa4c5164de3529e8479d36f550ce86`。

```ts
discardSavedCookie(): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-client-siteclient-request-method"></a>
## SiteClient.request

ID `fn-test-site-client-siteclient-request-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/client.ts#L41)；SHA-256 `c8afe0b5d33d629e6eeefe250176462151fa4c5164de3529e8479d36f550ce86`。

```ts
async request(method: string, path: string, body?: Record<string, unknown>): Promise<PageResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-client-siteclient-get-method"></a>
## SiteClient.get

ID `fn-test-site-client-siteclient-get-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/client.ts#L73)；SHA-256 `c8afe0b5d33d629e6eeefe250176462151fa4c5164de3529e8479d36f550ce86`。

```ts
get(path: string): Promise<PageResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-client-siteclient-post-method"></a>
## SiteClient.post

ID `fn-test-site-client-siteclient-post-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/client.ts#L77)；SHA-256 `c8afe0b5d33d629e6eeefe250176462151fa4c5164de3529e8479d36f550ce86`。

```ts
post(path: string, body?: Record<string, unknown>): Promise<PageResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-constructor-constructor"></a>
## WebLoginDriver.constructor

ID `fn-test-site-driver-weblogindriver-constructor-constructor`；constructor / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L46)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
constructor(deps: {
    client: SiteClient;
    tasks: TaskService;
    ops: OperationService;
    ids: { next(prefix: string): string };
    ctx: { tenantId: string; scopeId: string; principalId: string; runId: string };
  })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-begincredentialrequest-method"></a>
## WebLoginDriver.beginCredentialRequest

ID `fn-test-site-driver-weblogindriver-begincredentialrequest-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L60)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
beginCredentialRequest(taskId: string): Result<PendingInput>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-beginmfarequest-method"></a>
## WebLoginDriver.beginMfaRequest

ID `fn-test-site-driver-weblogindriver-beginmfarequest-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L73)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
beginMfaRequest(taskId: string): Result<PendingInput>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-runop-method"></a>
## WebLoginDriver.#runOp

ID `fn-test-site-driver-weblogindriver-runop-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L86)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
#runOp<T>(name: string, kind: "read" | "effect", fn: () => Promise<T>): Promise<T>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-classifyloginpage-method"></a>
## WebLoginDriver.#classifyLoginPage

ID `fn-test-site-driver-weblogindriver-classifyloginpage-method`；method / internal；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L109)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
#classifyLoginPage(page: PageResult): LoginStepResult
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-submitcredentials-method"></a>
## WebLoginDriver.submitCredentials

ID `fn-test-site-driver-weblogindriver-submitcredentials-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L125)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
async submitCredentials(
    taskId: string,
    response: PendingInputResponse,
  ): Promise<Result<LoginStepResult>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-submitmfa-method"></a>
## WebLoginDriver.submitMfa

ID `fn-test-site-driver-weblogindriver-submitmfa-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L151)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
async submitMfa(
    taskId: string,
    response: PendingInputResponse,
  ): Promise<Result<LoginStepResult>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-pollmfapage-method"></a>
## WebLoginDriver.pollMfaPage

ID `fn-test-site-driver-weblogindriver-pollmfapage-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L187)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
async pollMfaPage(): Promise<LoginStepResult>
```

源码说明（原注释，仅作来源）

```text
/** Observe the MFA page without submitting (the timeout observation). */
```

<a id="fn-test-site-driver-weblogindriver-openhome-method"></a>
## WebLoginDriver.openHome

ID `fn-test-site-driver-weblogindriver-openhome-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L199)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
async openHome(): Promise<LoginStepResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-driver-weblogindriver-logout-method"></a>
## WebLoginDriver.logout

ID `fn-test-site-driver-weblogindriver-logout-method`；method / public；主归属建议 D；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/driver.ts#L206)；SHA-256 `0d636b7eab2ba8ba47e020cf7ebef1173afe617e75e6cf766a757e4e5d9d57bb`。

```ts
async logout(): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-makestack-function"></a>
## makeStack

ID `fn-test-site-scenarios-makestack-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L36)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
export async function makeStack(): Promise<Stack>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-disposestack-function"></a>
## disposeStack

ID `fn-test-site-scenarios-disposestack-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L70)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
export async function disposeStack(s: Stack): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-respondwith-function"></a>
## respondWith

ID `fn-test-site-scenarios-respondwith-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L74)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
function respondWith(
  s: Stack,
  requestId: string,
  inputRevisionId: string,
  decision: unknown,
  key: string,
): PendingInputResponse
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-attemptlogin-function"></a>
## attemptLogin

ID `fn-test-site-scenarios-attemptlogin-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L94)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
export async function attemptLogin(
  s: Stack,
  username: string,
  password: string,
): Promise<LoginStepResult>
```

源码说明（原注释，仅作来源）

```text
/** One full credential cycle: request -> human decision -> submit. */
```

<a id="fn-test-site-scenarios-submitmfafromsimulator-function"></a>
## submitMfaFromSimulator

ID `fn-test-site-scenarios-submitmfafromsimulator-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L118)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
export async function submitMfaFromSimulator(s: Stack): Promise<LoginStepResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-scenarios1-function"></a>
## scenarioS1

ID `fn-test-site-scenarios-scenarios1-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L134)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
async function scenarioS1(): Promise<ScenarioResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-scenarios1-t-callable-value"></a>
## scenarioS1.t

ID `fn-test-site-scenarios-scenarios1-t-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L137)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
(name: string, passed: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-scenarios2-function"></a>
## scenarioS2

ID `fn-test-site-scenarios-scenarios2-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L153)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
async function scenarioS2(): Promise<ScenarioResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-scenarios2-t-callable-value"></a>
## scenarioS2.t

ID `fn-test-site-scenarios-scenarios2-t-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L156)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
(name: string, passed: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-scenarios3-function"></a>
## scenarioS3

ID `fn-test-site-scenarios-scenarios3-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L183)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
async function scenarioS3(): Promise<ScenarioResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-scenarios3-t-callable-value"></a>
## scenarioS3.t

ID `fn-test-site-scenarios-scenarios3-t-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L186)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
(name: string, passed: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-scenarios4-function"></a>
## scenarioS4

ID `fn-test-site-scenarios-scenarios4-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L217)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
async function scenarioS4(): Promise<ScenarioResult>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-scenarios4-t-callable-value"></a>
## scenarioS4.t

ID `fn-test-site-scenarios-scenarios4-t-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L220)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
(name: string, passed: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-scenarios-runallscenarios-function"></a>
## runAllScenarios

ID `fn-test-site-scenarios-runallscenarios-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/scenarios.ts#L244)；SHA-256 `091b3eab6c27eb95bb092abcddef1fcfc6734973b41aa3bfabbce66dd290e038`。

```ts
export async function runAllScenarios(): Promise<ScenarioResult[]>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-clocklike-now-interface-method"></a>
## ClockLike.now

ID `fn-test-site-site-clocklike-now-interface-method`；interface-method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L37)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
now(): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-page-function"></a>
## page

ID `fn-test-site-site-page-function`；function / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L40)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
function page(state: string, body: string): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-constructor-constructor"></a>
## TestSite.constructor

ID `fn-test-site-site-testsite-constructor-constructor`；constructor / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L54)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
constructor(clock: ClockLike)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-start-method"></a>
## TestSite.start

ID `fn-test-site-site-testsite-start-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L58)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
async start(): Promise<string>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-stop-method"></a>
## TestSite.stop

ID `fn-test-site-site-testsite-stop-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L71)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
async stop(): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-simulatormfacode-method"></a>
## TestSite.simulatorMfaCode

ID `fn-test-site-site-testsite-simulatormfacode-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L78)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
simulatorMfaCode(sessionId: string): string | undefined
```

源码说明（原注释，仅作来源）

```text
/** Out-of-band simulator access: the current MFA code for a session. */
```

<a id="fn-test-site-site-testsite-sessionidforcookie-method"></a>
## TestSite.sessionIdForCookie

ID `fn-test-site-site-testsite-sessionidforcookie-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L82)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
sessionIdForCookie(cookieHeader: string | undefined): string | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-activesessioncount-method"></a>
## TestSite.activeSessionCount

ID `fn-test-site-site-testsite-activesessioncount-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L87)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
activeSessionCount(): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-failcount-method"></a>
## TestSite.failCount

ID `fn-test-site-site-testsite-failcount-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L91)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
failCount(accountId: string): number
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-islocked-method"></a>
## TestSite.isLocked

ID `fn-test-site-site-testsite-islocked-method`；method / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L95)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
isLocked(accountId: string): boolean
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-nextcode-method"></a>
## TestSite.#nextCode

ID `fn-test-site-site-testsite-nextcode-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L99)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
#nextCode(): string
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-sessionof-method"></a>
## TestSite.#sessionOf

ID `fn-test-site-site-testsite-sessionof-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L104)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
#sessionOf(req: IncomingMessage): Session | undefined
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-sendhtml-method"></a>
## TestSite.#sendHtml

ID `fn-test-site-site-testsite-sendhtml-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L109)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
#sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-redirect-method"></a>
## TestSite.#redirect

ID `fn-test-site-site-testsite-redirect-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L114)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
#redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-readbody-method"></a>
## TestSite.#readBody

ID `fn-test-site-site-testsite-readbody-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L119)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
async #readBody(req: IncomingMessage): Promise<Record<string, unknown>>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-loginpage-method"></a>
## TestSite.#loginPage

ID `fn-test-site-site-testsite-loginpage-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L137)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
#loginPage(res: ServerResponse, opts: { error?: string; failCount?: number; state?: string } = {}): void
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-test-site-site-testsite-handle-method"></a>
## TestSite.#handle

ID `fn-test-site-site-testsite-handle-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/test-site/src/site.ts#L145)；SHA-256 `198285329ee34b110983f4182c9fd3611702e5153b635391e628cf853226d9ca`。

```ts
async #handle(req: IncomingMessage, res: ServerResponse): Promise<void>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

</details>
