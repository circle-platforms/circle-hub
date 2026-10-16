# Changelog

All notable changes to circle-hub are listed here, newest first. Repository releases start at 0.1.0. Changes after the latest release are listed under Unreleased.

## Unreleased

### Added

- General approval requests (`POST /v1/approval-requests`) accept a text or file for a named quorum of approval roles (`manager`, `security`, `dpo`, `legal`, `finance`, `hr`, `it`). A full approval publishes the text into searchable team knowledge. `GET /v1/approvals/pending` lists what the caller can decide, and the content route returns the submitted filename and media type.
- `hub-task` admits a task. MCP tools `hub_task` and `hub_packs` call that admission and list pack descriptors. `hub_task` and `hub_packs` count as running built-in tools when a skill is pushed.
- Audit export is `GET /v1/admin/audit/export` and `circle-hub admin audit --format json|csv`, with IANA timezone, action, principal and time filters. `circle-hub help` prints usage before a token is required.
- HTTP errors include `messageZh`. `Accept-Language` containing `zh` also returns the Chinese text in `message` and keeps `messageEn`.
- Loopback OIDC login is `GET /v1/auth/oidc/start` and `POST /v1/auth/oidc/callback` when `CIRCLE_HUB_OIDC_CONFIG` is set. SCIM is described in `docs/design/sso-scim.md` and has no endpoint.
- Team-visible approved knowledge is published into the stable snapshot during the review, so search can find it. The record owner can download their own source. Downloads use the stored filename and content type.
- Blocked approval and knowledge-access attempts are written to the audit log. A decline may include `reason`. Module verification returns every manifest error it has already found in `details.manifestErrors`.
- Node.js 24 is checked before a hub process reads configuration. `npm ci` uses `engine-strict`. An older Node exits with `HubEnvironmentError` and https://nodejs.org/en/download.
- `package.json` `allowScripts` allows the eight pinned `@embedded-postgres/*@18.4.0-beta.17` platform packages. Their postinstall only recreates symlinks shipped in the tarball.
- [docs/quickstart.md](docs/quickstart.md) and [docs/quickstart.en.md](docs/quickstart.en.md) describe deploy, Circle connect (`/extensions enable hub`, `/hub login`), stop/restart, runtime profiles, Linux sandbox limits, and the environment variables.
- `dev:stack` accepts stable `CIRCLE_HUB_PORT` and `CIRCLE_HUB_DEV_PASSWORD`, `CIRCLE_HUB_DEV_APPROVER_PASSWORD`, `CIRCLE_HUB_DEV_SERVICE_PASSWORD`, `CIRCLE_HUB_DEV_WORKER_PASSWORD`. Unset passwords stay random. A non-TTY start says to signal the pid instead of pressing Ctrl+C.
- Skill run accepts a unique manifest name as well as a `skp_` id. `POST /v1/sources` checks optional `x-capability-pack-id` before storing bytes. Skill views add `lifecycle`, `registration` and `statusLabel`. Task views add `phaseLabel`. Empty or shortened trials return `warnings` and stay HTTP 201.
- Teams are created by a change set and can be named in knowledge readers and approval roles. `dev:stack` seeds developer, approver, counsel and controller across Legal and Finance.
- `GET /v1/knowledge/snapshots/current` returns the stable snapshot id. `expectedSnapshotId: null` matches only when that id is null.
- The skill owner installs an approved package with `POST /v1/skillpacks/{id}/install`. The manifest id then appears in `GET /v1/packs` and can be submitted as a capability. `POST /v1/skillpacks/{id}/runs` still accepts an approved package before install.
- Judgement assets (`policy-rule-table`, `metric-definition`, `incident-start`) are approved by a person. A skill run cites them with `judgementPins`.

### Changed

- A skill push rejects an unknown tool name immediately. A known connector tool that is not running can still be submitted and stays blocked until that connector is running.
- `GET /v1/admin/audit` without export parameters is still a JSON array.
- A missing Circle runtime profile returns `RUNTIME_NOT_CONFIGURED` and names `CIRCLE_RUNTIME_CONFIG`. Linux process isolation still returns `SANDBOX_UNAVAILABLE` and names the platform.
- Unknown capability pack ids return `TARGET_NOT_FOUND`. Retired `lbx-healthcheck` and `apv-case-execute` stay `UNSUPPORTED_VERSION`.
- Bot and skill-run trigger failures name the trigger kind and the triggers the skill declares. A rejected bot occurrence says it was not accepted. Protocol values `registered` and `admitted` are unchanged.
- Pack `title` values are English. Chinese titles are `titleZh`. The packaged Circle client binding in the compatibility matrix is 1.7.4; the RPC acceptance pin remains fd8524a.

### Removed

- **Breaking: the `CIRCLE_SERVER_*` configuration fallback is gone; circle-server is no longer supported anywhere.** circle-hub reads only `CIRCLE_HUB_*`. The server, supervisor, worker, `circle-hub` CLI and the development and PostgreSQL scripts now refuse to start while any `CIRCLE_SERVER_*` variable is set, even an empty one or one beside its `CIRCLE_HUB_*` replacement. They exit with status 1 and a `HubEnvironmentError` that names each variable and its replacement and never prints a value. The `hub.environment.deprecated` notice is gone with the fallback. A deployment still configured with `CIRCLE_SERVER_*` names will not start after upgrading. To migrate, rename each variable by replacing the `CIRCLE_SERVER_` prefix with `CIRCLE_HUB_` (for example `CIRCLE_SERVER_DATABASE_CONFIG` becomes `CIRCLE_HUB_DATABASE_CONFIG`), remove the old names from the environment, service definitions and env files, then start the new version. Values, configuration file formats, routes and the database are unchanged.

## 0.2.0 - 2026-10-15

### Removed

- Retired the built-in `apv-case-execute` capability and the `cases.verify`, `cases.execute` and `cases.observe` worker path. New execution uses independently approved modules through `module-execute`; old native tasks are never rebound to a new implementation.

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
