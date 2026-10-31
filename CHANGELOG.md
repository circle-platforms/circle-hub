# Changelog

All notable changes to circle-hub are listed here, newest first. Repository releases start at 0.1.0. Changes after the latest release are listed under Unreleased.

## Unreleased

The Hub is being rebuilt as a standard MCP server; see [docs/hub-r4-brief.md](docs/hub-r4-brief.md). Nothing below has been released.

### Removed

- The archive of the platform that preceded the hub (`references/platform`) is no longer part of this repository. `references/source-manifest.json` and `npm run verify:references` now cover only the frozen Circle baseline in `foundation/circle` (287 files). The skill and product-line packs of the retired server moved to a private repository.
- **Breaking: the task-and-approval server is retired.** The `/v1` HTTP API, the supervisor, the worker, the admin CLI, the development stack, the connectors, the harness adapters, the packs and their tests were removed ahead of the redesign. Nothing in the redesign reads their routes, migrations, database or configuration, so a 0.2.0 deployment cannot be upgraded in place, and the hub extension in released Circle versions, which calls the `/v1` API, does not work with the redesigned Hub. The removed code stays readable in Git (the v0.2.0 tag and commit ca66002). The history of the earlier temporary deployment is recorded as lost and is not migrated.
- **Breaking: the `CIRCLE_SERVER_*` configuration fallback is gone; circle-server is no longer supported anywhere.** circle-hub reads only `CIRCLE_HUB_*`. From 2026-10-16 the retired server and its scripts refused to start while any `CIRCLE_SERVER_*` variable was set, even an empty one or one beside its `CIRCLE_HUB_*` replacement, and named each variable and its replacement without printing a value; the redesigned Hub keeps this rule (planned). The `hub.environment.deprecated` notice is gone with the fallback.

### Added

- **One-click install on macOS and Linux** (owner decision 76). `install.sh` downloads the release bundle for the machine, checks its SHA-256, and sets the Hub up with its own commands (init with HTTPS, key, certificates, `deploy --bundle`, service, setup code). Bundles (`tools/build-bundle.ts`) carry Node 24, the dependencies and PostgreSQL per platform; `deploy --bundle` deploys one without npm ci after checking its tree digest, platform and symlinks. The PostgreSQL 18 client every deploy backs up with comes from Homebrew's libpq on macOS and `postgresql-client-18` on Linux, or from the directory `CIRCLE_HUB_LIBPQ_BIN` names. `.github/workflows/release.yml` installs a fresh bundle on Ubuntu for every change to the installer and drafts a release with all four bundles on a version tag.
- **Management in the web console** (owner decision 75). Administrators create and disable users, issue and revoke tokens (shown once), upload a pack as a zip and publish, assign, retire, activate and deactivate packs, grant publish rights, add, enable, disable and reset resources, set and withdraw secrets, and run knowledge sync as a background job, all from `/console/admin`. Each action runs the matching `circle-hub` command in the server process as the signed-in administrator (same checks, records and messages); backup, restore, deploy and rollback stay on the command line. The first administrator is created at `/console/setup` with a one-time code from the new `circle-hub setup-code`.
- **Built-in HTTPS** (owner decision 74). `circle-hub init --https-port <p> [--https-host <ip>]` pins an HTTPS listener in the deployment settings; `circle-hub tls init|issue|status` keeps a private certificate authority and the server certificate it signs in `<data root>/tls` (EC P-256, made with node:crypto; never backed up). `serve` opens the HTTPS listener beside the HTTP one, with its own Host authorities and `Secure` console cookies. A TLS proxy and the built-in HTTPS are exclusive.
- The generic model (`contracts/model.json`, version 5), the error-code registry (`contracts/codes.json`) and the contracts generated from them in `contracts/generated`: vocabulary, protocol codes, JSON Schemas and the six MCP tools. `npm run gen:contracts` regenerates them, `npm run verify:contracts` checks them, and `tools/show-element.ts` prints model elements.
- The milestone 1 architecture brief, human brief and progress record under `docs/`. The earlier briefs, progress records and handoffs are marked historical and the old design pages superseded; none was deleted.

### Changed

- The `Hub checks` workflow now runs type checking, the contracts check, unit tests, acceptance on a temporary PostgreSQL, the reference archive check and the docs checks (`.github/checks`) on Ubuntu. Each test job lists its counts and every skipped test in the job summary and fails when no test ran, so the acceptance job fails until the acceptance suite exists. Tests that need macOS or libpq (the pack sandbox's network denial, the keychain, the launchd check, backup, restore and deploy) skip there, so CI is no evidence for those paths.
- The unit jobs of `Hub checks` install the PostgreSQL 18 client, so the backup, restore and deploy tests run on Ubuntu. A new `macOS-only paths` workflow runs the tests that need sandbox-exec, the keychain, plutil or launchd on `macos-15` on every push to `main`, nightly and on demand, but not on pull requests. The docs checks refuse a test that calls a pack function in the sandbox without a skip guard.
- The tests of the pack sandbox run on every pull request: the `Linux isolation` jobs of `Hub checks` install bubblewrap and AppArmor, load the Hub's AppArmor policy for the job's Node, fail when the isolation does not work and run the unit and acceptance files that guard on the sandbox. `tools/run-macos-tests.ts` is now `tools/run-guarded-tests.ts`, which selects the macOS and the Linux files from the same skip guards.
- The unit, acceptance and Linux isolation jobs of `Hub checks` list their slowest test files in the job summary and keep Node's junit report for 14 days, so a file that holds up its shard shows, and the measured durations that balance the shards can be checked against a run. The test runners write that report when `JUNIT_REPORT` names a file.

### Fixed

- **A document too large for its skill parser is answered with what to do about it.** When a parse runs out of the sandbox's memory or output limit, the answer now says so and asks for the original to be split, or the parser to need less, as a document over the cache budget already did. It used to ask the administrator to check the skill pack and the sandbox, and a reread failed in the same way.
- **A skill parse is no longer cut off after 5 s.** Each parse and locate call of a skill parser now has 30 s in the pack sandbox, so a document that parses on one machine is not refused on a slower one; a 2 MB document had taken up to 4.2 s on a busy macOS runner. Memory, not time, is what stops a large document: measured on CI runners and a development Mac, documents of 2 to 8.5 MB, depending on their shape, reach the sandbox's memory limit, so the declared 16 MiB is not reached for those shapes (`hub/refs/README.md`, Skill parser limits).
- **Several hooks recovering a dead session lock at once no longer drop a capture.** operation-capture moves a dead owner's file aside before it removes the lock, and that quarantined file reads as a dead owner to the other waiters too, so one of them can move it aside again. In knowledge-contribution 1.3.1 and earlier, the first waiter then failed to remove its own quarantine (ENOENT), or met a lock file that was being removed (no links left) and took it for an invalid owner. Either way the hook returned silently with only an `errors.jsonl` entry, and that tool output was neither recorded nor uploaded. In 1.3.2 the waiter looks again instead. Mutual exclusion was never affected.
- **defect-to-case compares a case whose command takes an IPv6 address or a prefix length by its declared structure.** The product's command-tree producer publishes a union-typed argument (IPADDR is IPv4 or IPv6) as several catalog signatures under one signature reference. defect-to-case 1.6.20 checked a command identity against the first of them only, so an argument of any later alternative (an IPv6 address, or a prefix length where the mask comes first) never matched: a draft with one stayed unknown in the duplicate check, and an indexed case with one was counted as lacking its author's structure declaration, which left every other draft checked against that index unknown unless it duplicated another case. defect-to-case 1.6.21 accepts an identity that is complete under one of those signatures. They have to agree on everything but each argument's typed alternative; where they disagree, the identity stays unresolved instead of following the first.
- **A configuration command with an address argument no longer leaves a case-compile plan pending.** The product's command-tree producer publishes a union-typed argument (IPADDR is IPv4 or IPv6) as several catalog signatures under one signature reference. When the product declared inverse enum pairs, case-compile 3.8.5 read any such command as an ambiguous enum inverse, even with no enum in it, so its plan checks stayed pending with "声明的枚举互逆不能在同一签名中得到唯一完整身份". case-compile 3.8.6 reads a declared pair position by position across those signatures: a position where none of them declares an enum holding the pair is no alternative, and the declared prefix inverse applies as before. Signatures that disagree on such an enum still stay unknown.
- **The start-up sweep finds orphaned sandbox processes when the Hub lives under a path outside ASCII on macOS.** The sweep ran `ps` with an empty environment; in that C locale `ps` prints every byte outside ASCII in `vis` notation (a folder named `开发` as `M-eM-<M^@M-eM^OM^Q`), so the bootstrap path never matched and sandbox processes an earlier Hub process left behind kept running. `ps` still gets a fixed environment, now holding only `LC_CTYPE=UTF-8`. Linux reads the argv from `/proc` and was not affected.
- **Pack extraction works on macOS 15.** A pack's read-only tree is built under a temporary name and renamed into place; macOS 15 refuses to rename a read-only directory (macOS 26 and Linux allow it), so every pack function failed there with `EACCES`. When that rename is refused and no tree is in place yet, the directory is made writable for the move and read-only again at its new name.

## 0.2.0 - 2026-10-15

### Removed

- Retired the built-in `famx-case-execute` capability and the `cases.verify`, `cases.execute` and `cases.observe` worker path. New execution uses independently approved modules through `module-execute`; old native tasks are never rebound to a new implementation.

### Changed

- Preserved migration 20 unchanged and added migration 44 to make legacy gateway receipts read-only, including insert, update, delete and truncate. Historical task inputs, results and artifact references remain readable.
- The compatible mindmap compiler is version 1.1.0 and writes `circle-hub` as its workbook creator. Hub configuration no longer injects the retired native gateway lookup; deprecated input fallback remains documented.

## 0.1.0 - 2026-10-15

### Changed

- **Licensed under the Apache License 2.0**, as Circle is. `LICENSE` carries the canonical text, `NOTICE` names the copyright holder, records that the repository was under the MIT License until 2026-10-13 and reserves the Circle and Circle Hub marks, and the design specifications in `docs/design` are under CC BY 4.0. `CONTRIBUTING.md` has Circle's contributor terms (a sign-off on every commit and a license to the project); `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, the issue and pull request templates and `.gitattributes` follow Circle's, in English. The documentation is published at <https://circle-platforms.github.io/circle-hub/> with the same site setup as Circle's.
- **Renamed to circle-hub.** The repository and the project are now circle-hub, the team hub for Circle. Hub executables use `circle-hub` and configuration uses `CIRCLE_HUB_*`; former `CIRCLE_SERVER_*` keys are deprecated fallbacks only when the corresponding new key is absent. Circle 1.7.0 uses the `hub` extension, `/hub`, `hub_*` and `hub_tool_*` with only `CIRCLE_HUB_*` per-run injection and no old-name aliases; the confirmed RPC commit is `fd8524a`.
- **Public repository.** The hub is public with secret scanning, push protection, Dependabot alerts and private vulnerability reporting enabled. Packs moved to their own public repository, [circle-packs](https://github.com/circle-platforms/circle-packs).
- **Design written down.** The object standard, the vocabulary and state enumerations, the five levels and their elements, approvals on change sets with a run-time enforcement chain, roles per scope, the Circle integration and the product-line pack exemplar are in [docs/design](docs/design/README.md).

- `packages/harness-adapters`: a pure library that imports Claude Code, Codex CLI, OpenCode, Gemini CLI and Cursor primitives (skills, commands, agents, instructions, hooks, MCP servers) into the neutral `hub-*/1` manifests and exports them back — bytes stay outside the manifests, configuration shapes keep key names only, secrets are stripped by structure, and exports take the original file table; brief and open decisions in `docs/harness-adapters-brief.md`.
### Added (phase 2, branch server-s2)

- Governed generic execution flows with pinned module tools, controlled source bytes, verified provider receipts, leases and unknown-outcome reconciliation; product-specific flow logic lives in packs. Observation windows honor both item and full-frame byte budgets, archive evicted observations for controlled reads and disclose bounded failure causes. The native execution path remains available in this release.

- Assets with lifecycle, a write-only credential vault and approvals bound to an input revision, a target identity and an action digest; a reviewer can close a request superseded by a newer version.
- Read-only connectors for WebDAV documents, build sites, a ticket-system mirror and an environment view; a per-identity tool catalog with ETags; per-source concurrency and spacing limits.
- Knowledge records (sources, evidence, entities, claims, assessments, snapshots) with asynchronous ingestion and incremental publishing.
- Uploaded source artifacts with roles and declared metadata; once approved, a stable source id binds every command tool, with receipts carrying the bound build identity.
- Skill packs pushed with their trial record, checked against declared tools, approved by another person, run by a headless Circle over a private RPC; scheduled and event-driven bots.
- Service clients with rotation and revocation, `/token`, RFC 7662 `/v1/introspect`, short-lived operation tokens for workers; native HTTPS; rule distribution by SHA.
- Execution against an MCP gateway: the hub re-verifies every device command of a workbook against the bound source before dispatch, keeps per-case originals and reconciles unknown outcomes.
- Module installation from a packs repository manifest; the server's own copy of the compile skill removed.
- Admin CLI for tasks, approvals and audit; graceful restart; paged work lists.

### Added (phase 1, branch server-s1)

- Authenticated HTTP API, PostgreSQL durable tasks with events and cursor replay, an independent worker, the first TypeScript capability pack, admin commands and the synthetic acceptance suite.

### Foundation

- Repository created from Circle's public TypeScript baseline with the preceding platform archived under `references/` and verified by SHA; MIT license confirmed for the project's own content.
