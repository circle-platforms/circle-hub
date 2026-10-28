# Compatibility matrix

This page translates the [Chinese original](compatibility.md); where the two differ, the Chinese text is authoritative.

The three repositories are versioned separately: circle (the agent), circle-hub (the MCP server) and circle-packs (packs). Who depends on whom, and what is authoritative, is written here. Changing any row is a deliberate upgrade, not something done in passing.

## Current state (2026-10-21)

| Component | Version / commit | Authoritative source | Notes |
|---|---|---|---|
| circle-hub | hub-redesign branch, milestone 1 under construction; the last release, 0.2.0, is the retired server | [Hub r4 progress](hub-r4-progress.md) | Being rebuilt; there is no deployable version yet, and release metadata does not establish production availability |
| Contracts | generic model version 5 (`MODEL_VERSION`) | `contracts/model.json`, `contracts/codes.json`; generated files in `contracts/generated` | `npm run verify:contracts` checks that the generated files match their sources |
| MCP | `@modelcontextprotocol/sdk` 1.32.1 | the root `package.json` | Six tools, streamable HTTP, Bearer token; the server is planned |
| Circle | connects as an ordinary MCP client and needs no hub extension | the MCP protocol and the tool schemas | Planned: the six generic MCP-client improvements of D06 R[1] and the removal of the old hub extension, as local commits on a separate Circle branch; changing Circle needs the owner's explicit authorization, with the scope in [AGENTS.md](https://github.com/circle-platforms/circle-hub/blob/main/AGENTS.md#authorizations-and-limits) and the grant recorded in decision 8 of the [Hub r4 progress](hub-r4-progress.md#决定). The hub extension in released Circle versions calls the retired `/v1` client API and cannot connect to the redesigned Hub |
| `foundation/circle` | Circle **1.0.4** source baseline, frozen | the source record in `references/README.md` | Source reference only: it is not installed, and its installer is not run; it is not a runtime dependency of hub |
| circle-packs | see its CHANGELOG | the circle-packs repository | Holds the packs of the retired server (`modules.json`, `product-line/1`, `hub-*/1`), which the redesigned Hub does not read; milestone 1 does not change that repository |

## Isolation of pack functions

Following the [Hub r4 architecture](hub-r4-architecture.md), a task pack's functions run in a restricted child process (implemented by the rules package, under review): the Node permission model forbids file writes and child processes and allows reading only the extracted pack; the architecture brief records that on Node 24.17 the permission model was found not to restrict network access, so the child process also runs under macOS `sandbox-exec` with network denied; time, memory and input and output sizes are limited as well. Where `sandbox-exec` is missing, pack functions are refused by default (`SANDBOX_UNAVAILABLE`). Equivalent isolation on other platforms is not decided yet.

Public CI runs on Ubuntu. The unit jobs install the PostgreSQL 18 client from the PostgreSQL apt repository, so backup, restore and deploy run there. Ubuntu has no `sandbox-exec`, keychain or launchd, so the pack sandbox and the tests that prove the network denial against a really listening loopback server, the keychain, plutil and the launchd checks skip there. The `macOS-only paths` workflow runs them on `macos-15` on every push to main, nightly and on demand; pull requests do not trigger it and it is not a required check, so a pull request's checks are no evidence for these paths. A skip is not a pass; each phase still records a full local macOS run, with commands, counts and skipped tests, in the [Hub r4 progress](hub-r4-progress.md). The CI job summary lists every skipped test.

## Contracts

| Contract | Defined by | Used by |
|---|---|---|
| The generic model | `contracts/model.json` | the generator `tools/gen-contracts.ts`; `tools/show-element.ts` |
| Vocabulary, protocol and core violation codes, reference forms, record kinds | `contracts/generated/vocabulary.ts` and `protocol.ts`, generated from the model and `contracts/codes.json` | every Hub package; labels only through `labelOf` |
| JSON Schemas of records, results, pack files and tables (keyed `name@major`, all registered in `SCHEMA_REGISTRY`) | `contracts/src/*.ts`, of which `pack`, `knowledge`, `resources` and `tables` are written by the packages that own them; after a change the owning package runs `npm run gen:contracts` and hands the generated files in with it, and the contracts package reviews the generated diff; generated into `contracts/generated/schemas` | the Hub; pack authors; any client that reads validation results |
| Inputs, outputs and annotations of the six MCP tools | `contracts/src/tools.ts`, generated into `contracts/generated/tools.json` | any MCP client |
| File layout of a task pack | the pack file list in the model's format proposals (`PACK_FILE_PATHS`) | pack authors; the Hub's publish check |

## Release order

1. The Hub first: when the model or a contract changes, raise the major version of the affected schema (`name@major`) and update this page; a release needs a separate decision by the owner.
2. Circle does not release in step with the Hub: it is only an MCP client and depends on the MCP protocol and the tool schemas.
3. Task packs carry their own versions; an upload runs the pack's positive and negative samples automatically (the publish check), and a pack that fails is not published.

Replacing the `foundation/circle` baseline and renaming identifiers in each repository are separate decisions, each recorded in History below.

## Retired

The following belonged to the retired task-and-approval server (up to 0.2.0) and no longer holds, or no longer matters, for the redesigned Hub; the previous table is in [this page at ca66002](https://github.com/circle-platforms/circle-hub/blob/ca66002fb6bfc3220547d0fdd895bfae83345943/docs/compatibility.en.md): the Circle runtime fd8524a used for acceptance and the `CIRCLE_BIN` / `CIRCLE_COMMIT` gate; the Circle release binding v1.7.3 and the target baseline of the hub extension; the client API the hub extension used (the [client API handoff](client-api-handoff.md)); the circle-packs originals used for hub acceptance and the hub dependency set pinned by circle-packs CI; the cexg execution gateway; macOS seatbelt process isolation for product-pack Tools/Hooks and its acceptance paths; the schemas and contracts `circle-packs/modules/1`, `product-line/1`, `hub-*/1` and the `/mcp` endpoint; and the old release order of hub first, then circle's hub extension, then packs.

## History

- 2026-10-13: this page was created. The rename has not started; the acceptance Circle commit is 8b2ceb6; foundation/circle is 1.0.4; circle's main line is 1.1.1.
- Evening of 2026-10-13: 7420 upgraded in place to server-s2 8e212a6 (§5, migration 28); circle mainline 1.2.1; circle-hub and circle-packs relicensed under Apache-2.0 with signed-off commits; circle-packs acceptance pinned at 316760a (products/famx 1.2.0).

- 2026-10-14: separated Circle's latest public release 1.4.1, the extension target baseline 1.2.1 and the pinned RPC acceptance commit; neither the acceptance commit nor the frozen reference was upgraded. The hub dependency set for circle-packs CI is pinned to dc93c69826f73f16d2f20f7520ba4c6663d014ac. Local synthetic test results are recorded separately and do not establish real-product or production acceptance.
- 2026-10-14: renamed the hub CLI to `circle-hub` and deployment variables to `CIRCLE_HUB_*`. A former `CIRCLE_SERVER_*` key is a deprecated fallback only when the new key is absent; an empty new value does not fall back. Circle-owned extension identifiers, commands and injected protocol remain unchanged, as do routes, schemas, existing worktree paths and historical provenance. Circle and independent pack upgrades require their own confirmation.
- 2026-10-14: with maintainer confirmation, pack-loader acceptance moved from 224daa6 (FAMX 1.2.1) to ba06eed (FAMX 1.2.2). Frozen catalog bytes and hashes were verified before running: product-line 31/31, four skill modules 57/57, catalog tools 4/4. The commit's README/CI combined entry point reports 61 as the sum of the latter two categories; all three are recorded separately.

- 2026-10-15: prepared the first hub repository release, 0.1.0. The verification stack at 1b4a6dc uses products/famx 1.4.0 from packs d91b23d; the existing pinned acceptance inputs remain separate. Batch delivery succeeded with 13 passing and 8 failing device cases, not an all-pass device acceptance. That was the first-release preparation snapshot. The maintainer later authorized D directly; the final decision is recorded below.

- 2026-10-15: D removes the native capability and worker; migration 20 is byte-identical and migration 44 makes historical receipts read-only. The compatible compiler becomes 1.1.0. The maintainer confirmed fd8524a / Circle 1.7.0 as the RPC acceptance pin, covering only the hub protocol. The packaged client separately targets v1.7.1 / 259364f. The v1.7.0 tag encountered a refresh-view timing failure and was retained without publication; 1.7.1 adds only the independently merged refresh fix to the integration. Packs tool-name consumers are independently versioned and do not auto-activate on release.

- 2026-10-15: published hub v0.1.0 (8f3b839), packs v0.1.0 (1f8948c) and hub v0.2.0 (2f9cd20). The 7420 stack was rolled to the same v0.2.0 commit; all 19 historical tasks and 2,450 original objects retained their hashes, and legacy receipts are read-only. The scripted runtime moved to fd8524a / 1.7.0 without changing its model configuration; another identity approved the new profile while the previous profile remained byte-identical. No new model or device task was submitted. Circle package publication and application installation are verified separately through its release page and local receipts; a tag or queued build does not establish delivery.

- 2026-10-15: the complete opt-in battery for hub main a0a42bb exited 0: contracts 20/20, methods 282/282, acceptance 403/403 and references 7/7, totaling 712 tests with no failures or skips. All three CI workflows for the same commit succeeded. Circle 1.7.1 was installed locally, where the actual interface exposed missing cold-start integration initialization and object loss when a view exceeded its byte budget. Its release was cancelled and no 1.7.1 Release was published. The client binding moves to 1.7.2 / 1914c58 with trusted startup initialization and a complete-view byte projection; the RPC pin remains fd8524a. Publication and local application acceptance are determined by their respective receipts, not by the version binding.

- 2026-10-15: 1.7.2 / 1914c58 passed local cold-start and large-view application acceptance. An isolated deterministic reproduction then showed a delayed background read recreating a deleted directory after close. Its formal Release was cancelled and the tag retained. The client binding moves to 1.7.3 / ae0b0d5 with three safeguards: bounded draining of a host not yet installed, an abort check after the asynchronous token read, and a closed dataDir getter that does not create directories. Three failing old-code regressions and nine passing targeted checks are recorded separately. The observed Windows ENOTEMPTY is not assigned a single cause; temporary-directory cleanup retries do not replace assertions about real effects after close. The RPC pin, Hub source, packs, migrations and existing business results remain unchanged.

- 2026-10-16: the maintainer retired the deprecated fallback for the pre-rename hub environment names; the pre-rename name is no longer supported anywhere. Hub processes read only `CIRCLE_HUB_*`. A server, supervisor, worker, CLI or development and PostgreSQL script whose environment still has a variable with the former prefix, even an empty one or one beside its replacement, refuses to start and names each `CIRCLE_HUB_*` replacement without printing values. Existing deployments configured with the former names must be redeployed with `CIRCLE_HUB_*` names before upgrading past this change. Circle's extension protocol, the pinned RPC acceptance commit, routes, schemas and migrations are unchanged.

- 2026-10-21: the task-and-approval server implementation was retired (00a5022), and the Hub is being rebuilt from the generic model as a standard MCP server. The current state, contracts and release order on this page now follow the new design, and the old content is listed under Retired. Circle connects as an ordinary MCP client and no longer needs a hub extension. The history of the earlier temporary deployment is recorded as lost and is not migrated.
- 2026-10-22: the Circle row says that changing Circle needs the owner's explicit authorization and scope; the statement that isolation and platform tests skipped on Ubuntu CI are not passes is restored, rewritten for the rebuilt sandbox, keychain, launchd and backup and restore; the page says who regenerates the contracts after a package changes its own contract file.
- 2026-10-29: the CI paragraph describes the current split: the Ubuntu unit jobs install the PostgreSQL 18 client, so backup, restore and deploy run there; the tests that need macOS run in the `macOS-only paths` workflow, which pull requests do not trigger.
