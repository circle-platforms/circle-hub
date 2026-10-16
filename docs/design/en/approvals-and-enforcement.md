# Approvals and the enforcement chain

## Only one approval concept: the Change set

One submission = one Change set = one Decision. A Change set may contain Assets of several objects: the skill package in one module, the product-line manifest, one rule, one connector instance. The Independent reviewer looks once and decides once, and the Decision binds the combined digest of every Asset; after it passes, each Asset's lifecycle updates atomically, and if it is declined, all of them are declined.

- The Binding of an Approval request: `inputRevisionId` (the task's input revision), `targetIdentity` (the ordered digest of each item's sha256), `actionDigest` (the digest of the action and the parameters). If any one changes, the request is invalidated, and it is applied for again.
- The applicant ≠ the approver. The platform is not an approver: a record writes only "verified by rule X vN", and does not write approved.
- What a Change set **references** is not approved again: the connector, the original, and the gateway that a skill package references are already approved Assets. Verification only checks that every reference is present and is approved / running; if one is not ready, the request is held as blocked and the reasons are listed, and it is checked again when a dependency changes.
- A new Change set for the same Asset supersedes the old one: the old request is closed as superseded.
- Only two cases are approved again: the bytes changed (a new version), or the action changed (registering a method ≠ executing on a device).
- An Approval request and its pending input share a validity period: one day by default, adjustable in the deployment configuration (one second to thirty days); an ordinary clarification input has its own period (five minutes by default). Extending the period does not lift the re-checks of the revision, the target identity, the action digest, or the execution exit.
- Every authorized response attempt is recorded as a Decision, including rejected attempts; a repeated Decision on the same request is `DECISION_CONFLICT`. Each Decision record keeps the policy and Eligibility context of its moment, and is not rewritten by later responses or policy changes.
- A pending draft is visible to the people in the same tenant and authorized scope who hold the approve permission, so they can review the definition and the digests; this does not add the approver to readers, and grants no access to originals, knowledge content, credentials, or runs. Credential references stay private and are no longer visible through the pending request once the approval is done or the asset is disabled.
- When a referenced Asset is not approved / running, the Change set stays open and is marked blocked, with the reasons listed; approving it is `DEPENDENCY_NOT_APPROVED` with the reasons attached. A dependency's lifecycle change triggers a re-check through a durable queue, and a restart re-checks too.
- A response must carry the Binding back verbatim; a difference in the revision, the target identity, or the action digest invalidates it. Declining an old request that has been superseded answers `approve:false` along that request's own Binding: what is checked is its revision, its applicant, its digests, and the asset versions of its time, and the original applicant is not required to still hold permissions. Declining closes that request as declined and ends its registration task normally — that is the completion of the governance flow, not an approval of the content; the new version's approval and execution eligibility are unaffected.
- The single-asset registration endpoints (assets, skills, modules) each produce a one-item Change set automatically; a change that spans several items must be decided once through the Change set's approval endpoint, never item by item.
- A task's pending input binds the current input revision: a response or a replacement, one of the two, never an implicit edit through a natural-language message; a response against an old revision is `INPUT_REVISION_STALE`, one past the deadline is `INPUT_EXPIRED`; terminal and unknown tasks accept no input replacement, and new work is expressed as a new submission. Once the input revision advances, the old execution bindings and waiting reasons lapse with it.

## At run time there is no approval, only the Enforcement chain

At the moment a Change set is approved, the person has already decided three things: the method (the byte digest), the resources it declares it will touch (writes), and who can use it (the scope policy). On each run after that, what the platform does is not a Decision; it carries out the policy the person has set:

1. **Permission**: this person has the right to execute in this scope, and the resource policy allows them — the policy is data, and it was approved once.
2. **Binding**: the method version is approved, the resource version is running, and the original is approved; the pin is fixed at claim time.
3. **Verification**: deterministic rules — the command is in the bound tree, the function contract, the self-destruct rule, and the build the resource reports = the bound build.
4. **Lease**: the resource lease + fencing. What it resolves is a conflict, not an authorization.
5. **Audit and Evidence**: every step leaves a trace as-is.

A local Circle run and a hub worker run follow the same chain: only the worker touches an external system, and where the model runs makes no difference.

There is one more forced re-check after claiming and before dispatching: the platform fetches the current rule original again and verifies it once more, and the result must equal the approved digest — a stale cache left by an ordinary query does not pass. The re-check record is persisted, bound to the current operation and fence, and only after it is consumed exactly once is the dispatch intent authorized — a dispatch intent proves only that the platform admitted one submission, not that the resource has been dispatched to.

## Only three results

| Result | Condition | What the platform does |
|---|---|---|
| pass | all five steps pass | execute, and deliver the output with its sha |
| error | a failure the script can prove 100% true | return the fixed Error code and the facts (which command, which tree, the rule version, the two build values, evidenceId). Where the applicant can fix it by changing the input, the task stops at waiting-input and writes waitingReason; otherwise failed |
| unknown | the script cannot determine it | the status is unknown, everything observed is disclosed, and it is **not resent**; the applicant chooses to check (reconcile), mark it failed, or give up |

In these cases an approver can make no meaningful decision: they cannot make a command appear in the tree, and they cannot turn the device into a different build. So at run time there is no "exception approval", and there is no "pre-authorization".

### The error-code catalog

The identifiers of provably true failures are all fixed; a client branches on the code and never parses free text. This table is checked code by code against the registry in `packages/contracts/src/index.ts`, and the registry is authoritative for the HTTP status and the category; a package may extend the registry through `registerErrorCodes` — see the two notes after the table.

| Group | Code | HTTP · category | Meaning |
|---|---|---|---|
| admission and request | `INVALID_PAYLOAD` | 400 · validation | the request shape or a value is illegal; an illegal value is never silently truncated |
| admission and request | `BODY_TOO_LARGE` | 413 · validation | the request body exceeds the cap |
| admission and request | `UNSUPPORTED_VERSION` | 400 · validation | the capability package is not installed, or no runner exists for the pinned flow version |
| admission and request | `RESULT_TOO_LARGE` | 413 · validation | the result exceeds the cap; never truncated into posing as the whole |
| admission and request | `SKILLPACK_CHECK_FAILED` | 422 · validation | the skill's declared tools mismatch the trial-run record or the current catalog |
| admission and request | `IMPORT_NOT_DECLARED` | 422 · validation | the module has an import outside its declarations |
| admission and request | `TARGET_NOT_FOUND` | 404 · target | the target does not exist |
| admission and request | `RATE_LIMITED` | 429 · transient | over the rate limit; no credentials or user names echoed |
| identity and permission | `UNAUTHENTICATED` | 401 · permission | the credential is invalid or expired |
| identity and permission | `FORBIDDEN_SCOPE` | 403 · permission | outside the authorized scope |
| identity and permission | `FORBIDDEN_ACTION` | 403 · permission | the action is not held |
| identity and permission | `FORBIDDEN_TARGET` | 403 · permission | the target is outside the authenticated policy |
| identity and permission | `PERMISSION_DENIED` | 403 · permission | a permission refusal in the Enforcement chain |
| identity and permission | `SELF_APPROVAL` | 403 · permission | the applicant cannot approve its own request |
| identity and permission | `SHARING_REQUIRED` | 403 · permission | sharing or promotion needs explicit consent |
| identity and permission | `APPROVAL_REQUIRED` | 409 · permission | an approved and active registration is required |
| identity and permission | `CONNECTOR_DISABLED` | 409 · permission | the connector is disabled |
| identity and permission | `IDENTITY_UNMAPPED` | 409 · permission | the identity cannot be mapped to an authorized principal (registered, with no throw site yet) |
| identity and permission | `OBJECT_NOT_VISIBLE` | 404 · permission | the object is not visible to the current identity |
| identity and permission | `ASSET_NOT_VISIBLE` | 404 · permission | the asset is not visible to the current identity |
| binding and conflict | `IDEMPOTENCY_MISMATCH` | 409 · conflict-stale | the same idempotency key carried different content |
| binding and conflict | `INPUT_REVISION_STALE` | 409 · conflict-stale | the response targets an old input revision |
| binding and conflict | `INPUT_EXPIRED` | 409 · conflict-stale | the response is past its validity |
| binding and conflict | `DECISION_CONFLICT` | 409 · conflict-stale | a repeated decision on the same request |
| binding and conflict | `APPROVAL_STALE` | 409 · conflict-stale | the revision or record the approval binds has changed |
| binding and conflict | `SOURCE_HASH_MISMATCH` | 409 · conflict-stale | the source bytes' SHA differs from the registration |
| binding and conflict | `TOOL_NAME_CONFLICT` | 409 · conflict-stale | a tool name conflict |
| binding and conflict | `RUNTIME_VERSION_MISMATCH` | 409 · conflict-stale | the runner's executable or revision fails verification |
| binding and conflict | `TARGET_IDENTITY_MISMATCH` | 409 · target | the target identity differs from the pinned value |
| lease | `FENCING_STALE` | 409 · lease | the fence no longer is the current lease |
| lease | `LEASE_EXPIRED` | 409 · lease | the execution lease has expired |
| lease | `RESOURCE_BUSY` | 409 · lease | the resource is frozen by an unknown; a new submission is refused |
| source | `SOURCE_ABSENT` | 404 · source-absent | the source does not exist |
| source | `SOURCE_FORBIDDEN` | 403 · permission | no permission on the source; the collapsed code for an ordinary caller |
| source | `SOURCE_LOGIN_EXPIRED` | 401 · authentication | the source login has expired |
| source | `SOURCE_UNREACHABLE` | 503 · source-unreachable | the source is unreachable |
| source | `SOURCE_NOT_APPROVED` | 409 · dependency | the source is not approved, including a configuration-digest mismatch after a plaintext exception lapses |
| execution | `COMMAND_NOT_IN_TREE` | 422 · execution | the command is not in the bound tree |
| execution | `DESTRUCTIVE_COMMAND` | 422 · execution | a destructive rule is hit |
| execution | `BUILD_MISMATCH` | 409 · execution | the reported build differs from the bound build |
| execution | `GATEWAY_UNREACHABLE` | 503 · execution | the gateway is unreachable |
| execution | `LEASE_UNAVAILABLE` | 409 · execution | the lease is unavailable |
| execution | `RUNTIME_FAILED` | 502 · execution | the runner failed, or a private execution request was rejected |
| execution | `SANDBOX_UNAVAILABLE` | 503 · execution | no supported isolation adapter |
| execution | `HOOK_FAILED` | 422 · execution | a Hook handler returned no legal verdict |
| execution | `RECEIPT_PROCESSING_FAILED` | 500 · execution | processing a receipt failed, without internal details |
| dependency and evidence | `DEPENDENCY_NOT_APPROVED` | 409 · dependency | a referenced dependency is not approved or not running |
| dependency and evidence | `EVIDENCE_INSUFFICIENT` | 409 · semantic-insufficient | the evidence is insufficient for the conclusion |
| dependency and evidence | `ARTIFACT_VERIFICATION_FAILED` | 409 · semantic-insufficient | the artifact or evidence fails verification against the statement to be proven |
| transient and fallback | `UPSTREAM_TIMEOUT` | 504 · transient | an upstream timeout; a read-only operation may retry with a new key |
| transient and fallback | `INTERNAL_ERROR` | 500 · internal | the internal fallback; an unregistered code falls back to its status and category |

Codes a package registers through `registerErrorCodes`: `CURSOR_EXPIRED` (409 · validation) and `NOTIFICATION_STREAM_LIMIT` (429 · permission) are registered by the tasks package; `INVALID_EXECUTION_WORKBOOK` (422 · validation), `COMMAND_VALIDATION_FAILED` (422 · validation), and `GATEWAY_REFUSED` (422 · execution) are registered by the execution product pack.

Codes thrown but not registered: `CONFIRMATION_REQUIRED`, `CONFIRMATION_STALE`, `MODEL_PROXY_UNAVAILABLE`, `MODEL_UPSTREAM_REJECTED` — they fall back to `INTERNAL_ERROR`'s HTTP status and category, keeping only the code itself.

### Errors and waiting-input

A failure the applicant can fix by changing the input stops at waiting-input: source not approved, gateway unavailable, lease insufficient, and build mismatch each write their own waitingReason, the pending list carries the matching request, and the applicant submits a new revision through the original input endpoint; the revision keeps its private ownership and delegation and drops the old execution bindings and waiting reasons. Failures no input change can fix — a missing command, an argument violation, a permission refusal — are failed outright.

### The classification of source failures

Source failures collapse for an ordinary caller: absent and forbidden are both reported as `SOURCE_FORBIDDEN`, and only an identity holding the diagnostic permission (sources.diagnose) sees the full classification. Only a confirmed absence enters the absent cache; an expired login, a permission refusal, and an unreachable source are never treated as absence. The details of a failure locate only the references the caller itself submitted, and do not leak a record's existence, ownership, or content.

### Read timeouts

For an operation declared effect=read, an upstream timeout, a synchronous wait timeout, an unknown report, or a lost lease is failed + `UPSTREAM_TIMEOUT`: retryable=true, sideEffects=none, the resource is not frozen, and no independent side-effect check is demanded; retrying takes a new key or a changed query. A write operation keeps the original rule: unknown, frozen, and checked independently.

### The discipline of the unknown

A lost lease, a worker disconnect, a cancel after dispatch, a timeout: the operation turns unknown, the resource freezes, and a new submission gets `RESOURCE_BUSY`; nothing is resent and nothing is re-dispatched automatically, and a report from an old fence is rejected. A cancel is only a request: a locally observed process exit is not a remote stop, and `remoteStoppingVerified:false` is written as-is. A reconcile is a read-only check by another worker under the original identity: only when the terminal state and the input digest both match does the operation become reconciled, delivered, and unfrozen; if the check sees no terminal state, only the check operation itself is failed, and the original task stays unknown with the resource still frozen. A dispatch break without a remote task identity cannot recover automatically — reconcile against the resource first, never blindly re-submit.

### Pre-dispatch refusals and the remote lease

An explicit refusal by the resource at its lease, environment, or contract-check stage — a receipt with no task identity and no dispatched marker — is a provably true failed, and the resource is not frozen; the original reason and the full receipt stay in gatewayRefusal, a definite code is used when one exists, otherwise `GATEWAY_REFUSED`; a refusal at the environment stage is not uniformly read as a build mismatch, and text without stage information is not guessed into a dispatch state. A receipt carrying a task identity or a dispatched marker, any failure after the submission, and any error without a provable stage are unknown, and the possibly still active remote lease is kept. The remote lease is released only after the dispatch is proven not to have happened or a terminal state is confirmed; the release outcome is recorded as observed (remoteLeaseReleased true/false, with the reason kept on failure) and never overwrites the main error.

## What if production equipment needs the two-person rule

Do not invent another concept. When a resource is registered it declares `executionIsChange: true`. An execution submission against it is first registered as an execution-submission draft Asset (freezing the input revision, the method digest, the resource version, the original id, and the workbook sha), as one item of a Change set, and only after approval does it enter the Enforcement chain. A test bed does not declare this by default, and goes straight through the Enforcement chain. One concept, two declarations. Such an approval is consumed exactly once by the operation it belongs to, and a Decision is never reassigned to another operation.

## Credentials and resources

- Credentials are written and not read: at registration or rotation they enter the vault, at execution the worker injects them, and everything returned to the client passes through redaction.
- Model keys never enter the harness process either: for each run the worker starts a model proxy bound to an ephemeral loopback port, and the harness's credential file holds only that endpoint and a single-use nonce; the proxy checks the nonce, strips inbound credential headers, injects the real key, forwards only to the model endpoints of the approved runtime profile, and shuts down when the run ends. The proxy records no request bodies, only metadata in the run's events; if it cannot start or the upstream rejects it, the run fails with a fixed error code and never falls back to writing the real key into a file. Output masking (run token, nonce, model key) is the last line, not the boundary.
- There are three credential modes: a short-lived token issued by the platform, external OAuth, and a static key. A resource with only one caller (for example, the gateway that hub's worker calls) uses a static key, compared locally, and does not call back to the platform.
- The endpoint, the CA, and the timeout live in the runtime profile file on the platform host, not in the database and not in Git; runtime-profile, as an Asset, binds the profile name, the version, and the configuration digest, and a dependency requires approved / running.
- Local cancel ≠ remote stop; on timeout, first check the original operation and the scene; if it cannot be confirmed, it stays unknown.
- The static-key mode: the value has a minimum length, registration and rotation are write-only, and the response carries only the reference and the mode; the worker fetches the current value and injects it before each call whose authorization has been checked. A shared resource that is approved and running lets a currently authorized member use its bound key without the member seeing the credential's metadata or plaintext. Disabling the credential, a resource revision, a role revocation, or a lease or fence change each triggers a fresh check.
- A short-lived token issued by the platform (a run token): it authorizes only the tools, scopes, and tasks declared for this run, bound to the operation and the fence; it is renewed by the worker holding a valid lease, never past that operation's deadline; it lapses immediately when the task ends, is cancelled, the lease expires, the fence ages out, or the input revision changes. It reaches the child process over private local IPC and lives only in memory and the process environment, never on disk; it cannot go through the session refresh or logout endpoints, and it cannot be used to register assets, submit other tasks, or approve. A single worker holds one run slot at a time, and that slot also serves the run's child tool calls.
- External OAuth: the issuer and the endpoints live only in the issuance configuration outside the repository, the connector configuration references it, and a request cannot carry an arbitrary endpoint; a remote endpoint must be HTTPS (except a loopback synthetic test), the CA is verified every time, and redirects are not followed. Both device-code and client-credentials grants return only a credential reference and expiry metadata on success — values never enter the API, events, audit, or the repository — and credentials are not shared across scopes or owners. Renewal replaces atomically inside a private single-writer lock: an unrotated refresh token is kept; an unknown or incomplete renewal receipt stops replay, marks the rotation pending, and demands re-registration, so that a replayed old token cannot revoke the whole family; a definite 5xx keeps the existing session; with neither expires_in nor a configured default lifetime, the expiry is unknown and never invented.
- The plaintext exception: a non-loopback source that uses authentication requires HTTPS by default. Where plain intranet HTTP is genuinely needed, an administrator declares `allowPlaintextAuthentication: true` in the configuration of the corresponding runtime-profile Asset, and that version takes effect only after an Independent reviewer's decision — this exception can never be self-approved, even where the scope allows ordinary self-decisions; writing the field into the runtime file directly grants nothing. When the current version is no longer approved/running or its configuration digest no longer matches, a call returns `SOURCE_NOT_APPROVED`; unapproved HTTP authentication is `SOURCE_FORBIDDEN`, without the original address or credentials. Every approved plaintext-authentication operation is permanently marked `plaintextAuthentication: true` in the dispatch intent, the audit, and the fetched Evidence, with a reference to the asset version that approved it; cached re-reads keep the mark, and a later revocation does not rewrite historical Evidence.
- The model proxy's boundary: it binds one ephemeral loopback port, and the single-use nonce is valid for that run only; the target is pinned by the currently approved runtime profile, and the Host, the query string, and the path cannot switch targets; inbound credential headers are all stripped. Request and response are each capped at 16 MiB, SSE is streamed through, bodies are not recorded, and model traffic is not stored as Evidence; the events carry only upstreamHost, statusCode, requestBytes, responseBytes, durationMs, and requestNumber. Failing to start or a disconnect is `MODEL_PROXY_UNAVAILABLE`, and an upstream rejection or overflow is `MODEL_UPSTREAM_REJECTED`; cancel, timeout, unknown, and local exit all close the proxy, and a late event after the close does not overwrite the local exit already observed.
- The isolation boundary: a Skill, a Tool, and a Hook share the same host isolation boundary — an untrusted process and its descendants are restricted in file reads and writes, network egress, and process information, and only the current run directory, the fixed harness's trusted code and dependencies, the explicit CA, and the loopback endpoints are opened; neither the vault nor the runtime configuration can be read directly or through a symlink. macOS uses seatbelt. Linux uses bubblewrap and, when landlock and seccomp are available, tightens the same policy: a read-only system tree, writes only in the workspace and the sandbox's private temporary directory, the network off by default, and no home mount. A system without a supported isolation adapter, a missing bubblewrap, or an inability to limit approved loopback TCP fails with `SANDBOX_UNAVAILABLE` and never falls back to running as the same user without isolation. Hooks and Tools run in the same tool-host child process with a ten-second and 16 MiB response limit and a 256 MiB heap limit; Hooks run in batches of at most 200 subjects in order, stopping at the first block; subjects are validated against a strict schema first, and host command lines are parsed literally only.
- Output masking: artifacts and events byte-replace the run token, the proxy nonce, and the model key, keep every other byte as-is, record sanitized, and recompute the SHA. Masking is the last line, not the boundary.
- Worker draining and replacement are cooperative: a worker asked to be replaced stops claiming new work and may finish a claim already in flight before it exits, and no device operation is force-killed to meet an upgrade deadline; replacement swaps the process and leaves the data alone. An independently deployed worker is drained and replaced by its own process manager, and the platform's replacement-requested flag does not mean it has been upgraded.

## The enforcement chain's fixed rules on device execution

The Enforcement chain is generic; its rules for a "table-driven device execution" kind of work are as follows. The permitted device methods, check-point kinds, host-name set, and device naming rule are closed sets declared by the product contract — their content lives in the packs, not in this standard.

### Verification

- A task is verified before it is claimed: the platform relocates the build against the retained original bytes, parses the full command paths and overloads, re-reads every device command in the workbook (including the initialization rows), and runs the deterministic command check; a missing command, an argument violation, or an input that cannot be proven is failed.
- The gate accepts only literal lines: the method closed set is declared by the product contract, and anything outside the set — input variables, temporary register substitution, vague invocations, and unverified functions — is `INVALID_EXECUTION_WORKBOOK` and must first be expanded into checkable literal lines; a disabled lifecycle method is not passed. One execution caps the number of explicit dispatches, and the device indexes are further limited by the current device count.
- The host-method closed set comes from the resource declaration and the product contract, and a host command is interpreted by the literal shell argument contract: multiple lines form one argument, a single line is split on commas outside quotes only, outer quotes are stripped, and the only keyword arguments allowed are the keys the contract declares. The output register is kept for later check points; the input register substitution is forbidden. The closed set can be narrowed by an approved Hook through the allowed-host set of the resource declaration — omitting it or an empty array keeps the product contract — and operations can also narrow per host with a host command policy (an exact command allowlist, byte and timeout caps, whether multiline is allowed): narrowing never widens, the policy is pinned into the target identity with the runtime profile, and changing it invalidates old approvals. A host method whose role has no verified mapping is refused outright, never inferred by name.
- The error location shape is fixed: row (from 1), autoid, object, method, plus the column for a non-literal cell; a whole-workbook format error has null in those fields. Host commands and register contents are never echoed.

### Dispatch and the two environment observations

- Before dispatching, the platform is forced to fetch the current command originals again and re-check them, and the result must equal the approved tree and command proof; it then takes the resource lease and runs the environment check (build, device count, readiness), refusing to dispatch when any is not met. It never switches the build, the bed, or initializes devices on its own.
- The environment observation (`execution.environment.observed`, whose observationSource is the pre-submission environment self-check) proves only the external check at that moment before submission; the resource may then run its own environment and contract checks, the first pass does not override the second refusal, and the second refusal's original reason is kept as-is.

### Device attribution and log parsing

- A device number in the workbook is determined by the order of the device management addresses in the configuration; a device name is never an ordering basis. The ordered addresses come from three sources by priority: the ordered-address field of the environment self-check's report, the topology's bound address set, and the name rule over the topology's devices; the first two are used only when actually returned. The third source holds only when every device name follows the product contract's naming rule, the index set equals the device count exactly, and each log line's address falls uniquely within the corresponding device's interface address set. Arbitrary names, missing/duplicate/out-of-range indexes, and non-unique address attribution all refuse attribution: the corresponding device step is unknown with unmapped=device_map_unavailable. A device number is never guessed from an arbitrary host name or command text; a shared address belongs to no device and advances no device's command cursor.
- Parsing advances a command cursor per device: the same command on different devices, or repeated on one device, each gets its own log span; a missing command only marks its own step unknown. A check point matches only an explicit log frame to a workbook row, and a mismatch in count, pattern, method, timeliness, or case identity is unknown/unmapped. A whole-case verdict never widens into per-step verdicts: a case pass does not prove each step passed; a task status=succeeded does not mean the tests all passed; missing evidence is delivered as partial. Host-method logs still match by host name — a route independent of the device index.

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
