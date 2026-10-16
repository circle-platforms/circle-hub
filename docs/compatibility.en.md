# Compatibility matrix

This page translates the [Chinese original](compatibility.md); where the two differ, the Chinese text is authoritative.

The three repositories are versioned separately: circle (harness), circle-hub (the platform), and circle-packs (packs). Who depends on whom, and what is authoritative, is written here. Changing any row is a deliberate upgrade, not something done in passing.

## Current state (2026-10-16)

| Component | Version / commit | Authoritative source | Notes |
|---|---|---|---|
| circle-hub | **0.2.0** (native execution retirement; first repository release 0.1.0) | versioned release, `docs/design` | Deployment observations and exact revisions are recorded separately in the phase progress; release metadata does not establish production availability |
| `foundation/circle` | Circle **1.0.4** source baseline, frozen | the source record in `references/README.md` | Source reference only: it is not installed, and its installer is not run; it is not a runtime dependency of hub |
| Circle runtime used for acceptance | Circle main-line commit **fd8524a** (confirmed by the user, Circle 1.7.0, hub protocol) | `CIRCLE_BIN` / `CIRCLE_COMMIT`, a strict Git gate | **This is the real test dependency**: acceptance RPC cases accept only this commit; changing the commit requires the user's confirmation and an update of the gate |
| Circle release binding | **v1.7.4 → 9123753467e56b40120a91ed79fc0694edeba516** (previous binding v1.7.3 → ae0b0d5) | Circle’s tag and Release | Public release of 2026-10-16. The release page records the complete build and publication status. This hub did not re-run RPC acceptance against the 1.7.4 binary; the acceptance pin remains fd8524a |
| Target baseline for hub's Circle-side extension | Circle 1.7.4's bundled hub extension, extension manifest version **0.1.0** | Circle tag v1.7.4 | The extension's own 0.1.0 is not hub package 0.2.0 and not HTTP API 1.0.0. hub and /hub have no old aliases; this row stays separate from the pinned RPC acceptance commit |
| circle's hub extension | release commit 9123753; extension version 0.1.0 | hub's `docs/client-api-handoff.md` and [quickstart.en.md](quickstart.en.md) | Current Circle uses hub, /hub, hub_* and hub_tool_* without old aliases. Connect with `/extensions enable hub`, then `/hub login <url> developer` |
| circle-packs `main` | see its CHANGELOG | hub's pack loader and schemas | product-line pack tests use the locked dependencies from hub commit `dc93c69826f73f16d2f20f7520ba4c6663d014ac`; circle-packs `.github/workflows/checks.yml` pins it instead of following main; this is a test dependency, not a production compatibility claim |
| circle-packs originals used for hub acceptance | **1f8948c07a9756a3e5dec66f15c25a670fd1e4c2**, APV **1.4.1** | That commit’s `modules.json` and original file SHAs | The packs repository’s synthetic suite is 143/143 with no skips. Hub’s opt-in module/provider protocol acceptance is recorded separately in the phase progress; package tests do not replace it. A release does not activate or approve modules. |
| execution gateway cexg | 0.3.1 (static secret) | the compile-excel-server repository | hub's worker needs the §7 static-secret credential mode in order to call it |

## Process isolation and acceptance platforms

Protected device execution that runs product-pack Tools/Hooks, and headless Circle skill execution, require host process isolation. macOS uses **seatbelt** (`sandbox-exec`). Linux uses **bubblewrap** (`bwrap`): a read-only system tree, writes only in the run workspace and the sandbox's private temporary directory, the network off unless a loopback endpoint is approved, and no mount of the home directory or secret paths. When the kernel provides landlock and this machine can compile the helper shipped with the repository, landlock and seccomp tighten the same boundary. If a loopback endpoint is approved, landlock network rules (ABI 4 or newer) must limit TCP to those ports; otherwise the run fails closed and does not share the host network. A missing `bwrap`, a refused user namespace, or the inability to apply that network limit returns `SANDBOX_UNAVAILABLE` with an install or `sysctl` hint. The command does not fall back to an ordinary process, and no test switch weakens production isolation. Native synthetic dispatch with no rule handlers does not enter the Tool/Hook subprocess; its passing result does not establish isolation.

| Acceptance path | Prerequisites | Report when missing |
|---|---|---|
| Product-pack Tool/Hook subprocesses and device execution relying on those rules | An available macOS seatbelt or Linux bubblewrap adapter | Each execution case reports the missing isolation prerequisite through the shared harness and skips; it is not a pass |
| Circle skill execution, cancellation, runtime revisions and script isolation | That isolation, plus an explicitly supplied pinned Circle build and Git commit. On Linux, an approved loopback endpoint also needs landlock ABI 4 and a C compiler | The shared harness reports missing prerequisites; a genuine execution failure with prerequisites present still fails |
| Uploads, authentication, source/asset registration and approval, registry queries, static module checks and native read-only connectors | Temporary PostgreSQL and the relevant synthetic sources | Continue running; an isolated case in the same file does not skip the whole file |
| The unsupported-host isolation rejection test | An environment with no supported adapter | Continue asserting `SANDBOX_UNAVAILABLE`; report it separately, not as a passing isolation-positive path |

Pack unit tests and hub Tool/Hook loading-and-execution acceptance are distinct: a pass in the former does not prove the latter can run on the current host. The first four `module-install` registration/validation/CLI cases do not require isolation; its final real RPC case does. Direct Tool/Hook calls in `r3-product-hooks` do require isolation. Public Ubuntu CI installs bubblewrap and gcc and then runs these isolated paths; a missing tool still skips and is not a pass. Full Circle RPC acceptance still needs the pinned Circle build, a temporary database, a synthetic gateway and a scripted model. It does not establish real-device or paid-model acceptance. See [runtime-profile.en.md](runtime-profile.en.md) for the development runtime profile.

## Schemas and contracts

| Schema | Defined by | Used by |
|---|---|---|
| `circle-packs/modules/1` (modules.json) | circle-packs `tools/modules.ts` | hub's installer |
| `product-line/1` | hub design `docs/design/product-line-pack.md` | a pack's `product-line.json`; hub's loader |
| `hub-hook/1`, `hub-skill/1`, `hub-tool/1`, `hub-provider/1`, `hub-instruction/1`, `hub-agent/1`, `hub-command/1`, `hub-permission/1` | hub design `docs/design/harness-primitives.md`, `permission-export.md` | a pack's hooks, skill registration, and `packages/harness-adapters` |
| dependency set of a pack's Tool implementations | hub's `package.json`: exceljs 4.4.0, read-excel-file 9.3.12, fflate 0.8.3, zod 4.6.5, saxes 5.0.1, parse5 8.0.1 | a pack's `tools[].imports`; checked at load; an import outside the declaration is reported as `IMPORT_NOT_DECLARED`; Node built-in modules are not allowed either |
| hub client API | `docs/client-api-handoff.md` | circle's hub extension |
| `/mcp` endpoint | `docs/design/harness-primitives.md` | any MCP client |

## Release order

1. hub first: when a schema or the client API changes, raise that schema's version, tag the release, and update this page.
2. circle's hub extension next: merge against hub's tag, and declare the hub version range it supports.
3. packs last: update `product-line.json` and hooks to hub's schema version; each pack carries its own version.

Upgrading the Circle commit used for acceptance, replacing the `foundation/circle` baseline and renaming identifiers in each repository are separate decisions, each recorded in History below. This hub CLI/configuration rename does not rename Circle's extension protocol or upgrade independently versioned packs.

## History

- 2026-10-13: this page was created. The rename has not started; the acceptance Circle commit is 8b2ceb6; foundation/circle is 1.0.4; circle's main line is 1.1.1.
- Evening of 2026-10-13: 7420 upgraded in place to server-s2 8e212a6 (§5, migration 28); circle mainline 1.2.1; circle-hub and circle-packs relicensed under Apache-2.0 with signed-off commits; circle-packs acceptance pinned at 316760a (products/apv 1.2.0).

- 2026-10-14: separated Circle's latest public release 1.4.1, the extension target baseline 1.2.1 and the pinned RPC acceptance commit; neither the acceptance commit nor the frozen reference was upgraded. The hub dependency set for circle-packs CI is pinned to dc93c69826f73f16d2f20f7520ba4c6663d014ac. Local synthetic test results are recorded separately and do not establish real-product or production acceptance.
- 2026-10-14: renamed the hub CLI to `circle-hub` and deployment variables to `CIRCLE_HUB_*`. A former `CIRCLE_SERVER_*` key is a deprecated fallback only when the new key is absent; an empty new value does not fall back. Circle-owned extension identifiers, commands and injected protocol remain unchanged, as do routes, schemas, existing worktree paths and historical provenance. Circle and independent pack upgrades require their own confirmation.
- 2026-10-14: with maintainer confirmation, pack-loader acceptance moved from 224daa6 (APV 1.2.1) to ba06eed (APV 1.2.2). Frozen catalog bytes and hashes were verified before running: product-line 31/31, four skill modules 57/57, catalog tools 4/4. The commit's README/CI combined entry point reports 61 as the sum of the latter two categories; all three are recorded separately.

- 2026-10-15: prepared the first hub repository release, 0.1.0. The verification stack at 1b4a6dc uses products/apv 1.4.0 from packs d91b23d; the existing pinned acceptance inputs remain separate. Batch delivery succeeded with 13 passing and 8 failing device cases, not an all-pass device acceptance. That was the first-release preparation snapshot. The maintainer later authorized D directly; the final decision is recorded below.

- 2026-10-15: D removes the native capability and worker; migration 20 is byte-identical and migration 44 makes historical receipts read-only. The compatible compiler becomes 1.1.0. The maintainer confirmed fd8524a / Circle 1.7.0 as the RPC acceptance pin, covering only the hub protocol. The packaged client separately targets v1.7.1 / 259364f. The v1.7.0 tag encountered a refresh-view timing failure and was retained without publication; 1.7.1 adds only the independently merged refresh fix to the integration. Packs tool-name consumers are independently versioned and do not auto-activate on release.

- 2026-10-15: published hub v0.1.0 (8f3b839), packs v0.1.0 (1f8948c) and hub v0.2.0 (2f9cd20). The 7420 stack was rolled to the same v0.2.0 commit; all 19 historical tasks and 2,450 original objects retained their hashes, and legacy receipts are read-only. The scripted runtime moved to fd8524a / 1.7.0 without changing its model configuration; another identity approved the new profile while the previous profile remained byte-identical. No new model or device task was submitted. Circle package publication and application installation are verified separately through its release page and local receipts; a tag or queued build does not establish delivery.

- 2026-10-15: the complete opt-in battery for hub main a0a42bb exited 0: contracts 20/20, methods 282/282, acceptance 403/403 and references 7/7, totaling 712 tests with no failures or skips. All three CI workflows for the same commit succeeded. Circle 1.7.1 was installed locally, where the actual interface exposed missing cold-start integration initialization and object loss when a view exceeded its byte budget. Its release was cancelled and no 1.7.1 Release was published. The client binding moves to 1.7.2 / 1914c58 with trusted startup initialization and a complete-view byte projection; the RPC pin remains fd8524a. Publication and local application acceptance are determined by their respective receipts, not by the version binding.

- 2026-10-15: 1.7.2 / 1914c58 passed local cold-start and large-view application acceptance. An isolated deterministic reproduction then showed a delayed background read recreating a deleted directory after close. Its formal Release was cancelled and the tag retained. The client binding moves to 1.7.3 / ae0b0d5 with three safeguards: bounded draining of a host not yet installed, an abort check after the asynchronous token read, and a closed dataDir getter that does not create directories. Three failing old-code regressions and nine passing targeted checks are recorded separately. The observed Windows ENOTEMPTY is not assigned a single cause; temporary-directory cleanup retries do not replace assertions about real effects after close. The RPC pin, Hub source, packs, migrations and existing business results remain unchanged.

- 2026-10-16: the maintainer retired the deprecated fallback for the pre-rename hub environment names; the pre-rename name is no longer supported anywhere. Hub processes read only `CIRCLE_HUB_*`. A server, supervisor, worker, CLI or development and PostgreSQL script whose environment still has a variable with the former prefix, even an empty one or one beside its replacement, refuses to start and names each `CIRCLE_HUB_*` replacement without printing values. Existing deployments configured with the former names must be redeployed with `CIRCLE_HUB_*` names before upgrading past this change. Circle's extension protocol, the pinned RPC acceptance commit, routes, schemas and migrations are unchanged.
- 2026-10-16: the packaged client binding moves to Circle 1.7.4 / 9123753467e56b40120a91ed79fc0694edeba516. The hub extension manifest in that release is version 0.1.0, which is not hub package 0.2.0 and not HTTP API 1.0.0. The RPC acceptance pin remains fd8524a / Circle 1.7.0; this row does not mean the acceptance suite was re-run against the 1.7.4 binary. Connection steps are in `docs/quickstart.md`.
- 2026-10-16: Linux skill, Tool and Hook runs use bubblewrap, plus landlock and seccomp when landlock and a local C compiler are available. A missing `bwrap`, or an inability to limit approved loopback TCP, returns `SANDBOX_UNAVAILABLE` and does not silently drop isolation. `npm run runtime:profile` writes a development `CIRCLE_RUNTIME_CONFIG` outside the repository. The example shape in `config/runtime-profile.development.example.json` is not loaded automatically.
