# Changelog

All notable changes to circle-hub are listed here, newest first. Repository releases start at 0.1.0. Changes after the latest release are listed under Unreleased.

## Unreleased

The Hub is being rebuilt as a standard MCP server; see [docs/hub-r4-brief.md](docs/hub-r4-brief.md). Nothing below has been released.

### Removed

- **Breaking: the task-and-approval server is retired.** The `/v1` HTTP API, the supervisor, the worker, the admin CLI, the development stack, the connectors, the harness adapters, the packs and their tests were removed ahead of the redesign. Nothing in the redesign reads their routes, migrations, database or configuration, so a 0.2.0 deployment cannot be upgraded in place, and the hub extension in released Circle versions, which calls the `/v1` API, does not work with the redesigned Hub. The removed code stays readable in Git (the v0.2.0 tag and commit ca66002). The history of the earlier temporary deployment is recorded as lost and is not migrated.
- **Breaking: the `CIRCLE_SERVER_*` configuration fallback is gone; circle-server is no longer supported anywhere.** circle-hub reads only `CIRCLE_HUB_*`. From 2026-10-16 the retired server and its scripts refused to start while any `CIRCLE_SERVER_*` variable was set, even an empty one or one beside its `CIRCLE_HUB_*` replacement, and named each variable and its replacement without printing a value; the redesigned Hub keeps this rule (planned). The `hub.environment.deprecated` notice is gone with the fallback.

### Added

- The generic model (`contracts/model.json`, version 5), the error-code registry (`contracts/codes.json`) and the contracts generated from them in `contracts/generated`: vocabulary, protocol codes, JSON Schemas and the six MCP tools. `npm run gen:contracts` regenerates them, `npm run verify:contracts` checks them, and `tools/show-element.ts` prints model elements.
- The milestone 1 architecture brief, human brief and progress record under `docs/`. The earlier briefs, progress records and handoffs are marked historical and the old design pages superseded; none was deleted.

### Changed

- The `Hub checks` workflow now runs type checking, the contracts check, unit tests, acceptance on a temporary PostgreSQL, the reference archive check and the docs checks (`.github/checks`) on Ubuntu. Each test job lists its counts and every skipped test in the job summary and fails when no test ran, so the acceptance job fails until the acceptance suite exists. Tests that need macOS or libpq (the pack sandbox's network denial, the keychain, the launchd check, backup, restore and deploy) skip there, so CI is no evidence for those paths.
- The unit jobs of `Hub checks` install the PostgreSQL 18 client, so the backup, restore and deploy tests run on Ubuntu. A new `macOS-only paths` workflow runs the tests that need sandbox-exec, the keychain, plutil or launchd on `macos-15` on every push to `main`, nightly and on demand, but not on pull requests. The docs checks refuse a test that calls a pack function in the sandbox without a skip guard.

### Fixed

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
