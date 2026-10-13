# Approvals and the enforcement chain

## Only one approval concept: the Change set

One submission = one Change set = one Decision. A Change set may contain Assets of several objects: the skill package in one module, the product-line manifest, one rule, one connector instance. The Independent reviewer looks once and decides once, and the Decision binds the combined digest of every Asset; after it passes, each Asset's lifecycle updates atomically, and if it is declined, all of them are declined.

- The Binding of an Approval request: `inputRevisionId` (the task's input revision), `targetIdentity` (the ordered digest of each item's sha256), `actionDigest` (the digest of the action and the parameters). If any one changes, the request is invalidated, and it is applied for again.
- The applicant ≠ the approver. The platform is not an approver: a record writes only "verified by rule X vN", and does not write approved.
- What a Change set **references** is not approved again: the connector, the original, and the gateway that a skill package references are already approved Assets. Verification only checks that every reference is present and is approved / running; if one is not ready, the request is held as blocked and the reasons are listed, and it is checked again when a dependency changes.
- A new Change set for the same Asset supersedes the old one: the old request is closed as superseded.
- Only two cases are approved again: the bytes changed (a new version), or the action changed (registering a method ≠ executing on a device).

## At run time there is no approval, only the Enforcement chain

At the moment a Change set is approved, the person has already decided three things: the method (the byte digest), the resources it declares it will touch (writes), and who can use it (the scope policy). On each run after that, what the platform does is not a Decision; it carries out the policy the person has set:

1. **Permission**: this person has the right to execute in this scope, and the resource policy allows them — the policy is data, and it was approved once.
2. **Binding**: the method version is approved, the resource version is running, and the original is approved; the pin is fixed at claim time.
3. **Verification**: deterministic rules — the command is in the bound tree, the function contract, the self-destruct rule, and the build the resource reports = the bound build.
4. **Lease**: the resource lease + fencing. What it resolves is a conflict, not an authorization.
5. **Audit and Evidence**: every step leaves a trace as-is.

A local Circle run and a hub worker run follow the same chain: only the worker touches an external system, and where the model runs makes no difference.

## Only three results

| Result | Condition | What the platform does |
|---|---|---|
| pass | all five steps pass | execute, and deliver the output with its sha |
| error | a failure the script can prove 100% true | return the fixed Error code and the facts (which command, which tree, the rule version, the two build values, evidenceId). Where the applicant can fix it by changing the input, the task stops at waiting-input and writes waitingReason; otherwise failed |
| unknown | the script cannot determine it | the status is unknown, everything observed is disclosed, and it is **not resent**; the applicant chooses to check (reconcile), mark it failed, or give up |

Error codes: `COMMAND_NOT_IN_TREE` · `DESTRUCTIVE_COMMAND` · `BUILD_MISMATCH` · `GATEWAY_UNREACHABLE` · `PERMISSION_DENIED` · `LEASE_UNAVAILABLE` · `SOURCE_NOT_APPROVED`.

In these cases an approver can make no meaningful decision: they cannot make a command appear in the tree, and they cannot turn the device into a different build. So at run time there is no "exception approval", and there is no "pre-authorization".

## What if production equipment needs the two-person rule

Do not invent another concept. When a resource is registered it declares `executionIsChange: true`. An execution submission against it is first registered as an execution-submission draft Asset (freezing the input revision, the method digest, the resource version, the original id, and the workbook sha), as one item of a Change set, and only after approval does it enter the Enforcement chain. A test bed does not declare this by default, and goes straight through the Enforcement chain. One concept, two declarations.

## Credentials and resources

- Credentials are written and not read: at registration or rotation they enter the vault, at execution the worker injects them, and everything returned to the client passes through redaction.
- There are three credential modes: a short-lived token issued by the platform, external OAuth, and a static key. A resource with only one caller (for example, the gateway that hub's worker calls) uses a static key, compared locally, and does not call back to the platform.
- The endpoint, the CA, and the timeout live in the runtime profile file on the platform host, not in the database and not in Git; runtime-profile, as an Asset, binds the profile name, the version, and the configuration digest, and a dependency requires approved / running.
- Local cancel ≠ remote stop; on timeout, first check the original operation and the scene; if it cannot be confirmed, it stays unknown.
