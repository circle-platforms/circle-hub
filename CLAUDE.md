# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the binding rule set (authorizations, git, evidence, ownership); read it first. This file only adds commands and the architecture map. `docs/hub-r4-architecture.md` is the engineering brief; `docs/hub-r4-progress.md` records phase progress and the owner's decisions. `.github/checks/package-edges.json` governs `hub/` package boundaries and cycles, and `.github/checks/doc-set.json` governs the maintained `docs/` inventory (alongside temporary exceptions in `.github/checks/exceptions.json`).

## What this is

circle-hub is a standard MCP server (streamable HTTP, Bearer token) that **verifies results and never generates them**. It has six tools (`list_task_packs`, `upload_file`, `start_run`, `get_nodes`, `resolve_reference`, `submit_result`), task packs, a content-addressed knowledge tree per product line and version, append-only records, and a web console (read-only pages; administrators also manage users, teams, tokens, packs, resources, secrets and knowledge sync there, decision 122, each action running the matching CLI command). Knowledge spaces consist of each member's personal space plus one Hub-wide **public space** (`公共空间` in UI/docs; internal storage identifier `team` stays), while created **teams** (`团队`, managed via `circle-hub team` and the web console) control workflow and business-system resource assignment and do not yet own separate per-team knowledge spaces. It serves HTTPS itself when configured (decision 121, `circle-hub tls`) and installs with one command on macOS and Linux (`install.sh`, release bundles, decision 123). It calls no model; reviewing models run only on the Circle (client) side. Only `circle-hub` and `CIRCLE_HUB_*` exist (`CIRCLE_HUB_TOKEN` is CLI-only and refused by `serve`); `hub/config/retired.ts` currently makes a Hub process refuse to start if any retired `CIRCLE_SERVER_*` prefix variable or retired keychain variable (`CIRCLE_HUB_KEYCHAIN_SERVICE`, `CIRCLE_HUB_KEYCHAIN_ACCOUNT`) is set.

## Commands

Node >= 24, TypeScript run directly (type stripping; no build step).

```sh
npm ci
npm run typecheck                 # tsc --noEmit
npm run verify:contracts          # contracts/generated matches model.json, codes.json, contracts/src
npm run gen:contracts             # regenerate contracts/generated (never hand-edit it)
npm run test:unit                 # runs tools/run-unit-tests.ts (contracts, hub, packs, scripts)
npm run test:acceptance           # tests/acceptance, temporary loopback PostgreSQL, concurrency 1
npm run test:docs                 # .github/checks/*.test.ts
npm test                          # contracts check + unit + docs + acceptance

node --test hub/runs/some.test.ts           # single test file
node --test --test-name-pattern="x" file.ts # single test by name
node --test "hub/server/**/*.test.ts"       # one package (a package agent's own check)

node tools/show-element.ts B01 W06          # print model elements
node tools/show-element.ts --vocab partition # print a vocabulary axis

bash install.sh --dry-run --version <x.y.z>  # the installer's plan, changing nothing
node tools/build-bundle.ts --platform darwin-arm64 --out <dir>   # build one release bundle
```

Tests start a temporary PostgreSQL from `embedded-postgres` (via `hub/testing/postgres.ts`). Backup/restore/deploy, `sandbox-exec` network denial and launchd tests need macOS and/or libpq (`pg_dump`/`pg_restore` of PG 18; `brew install libpq` or `CIRCLE_HUB_LIBPQ_BIN`) and skip elsewhere — a skip is not a pass; report skips explicitly. Never run `npm install` in a task worktree.

## Architecture

Design authority is `contracts/model.json` (generic model: elements + vocabulary axes). Where the brief and the model disagree, the model wins. `contracts/generated/` (`vocabulary.ts`, `protocol.ts`) is the only source of enumerations, record kinds, error codes and labels (`labelOf`); never hand-write an enumeration or coin a term.

There are 15 packages under `hub/` with a strict dependency direction (cross-package calls go through each package's `api.ts` entrypoint, or `hub/config/index.ts` for `config`, with no cycles; enforced by `.github/checks/package-boundaries.ts` and `.github/checks/package-cycles.ts` from `.github/checks/package-edges.json`, plus temporary transition exceptions in `.github/checks/exceptions.json`). Leaf prefixes/packages: `config`, `platform`, and `contracts/`. Shared modules: `hub/ports.ts` (type-only shared interfaces) and `hub/listen.ts` (shared pure module). Narrow exceptions in `package-edges.json`: `hub/telemetry/usage.ts` (entrypoint exception importable only by `records`, `refs`, `rules`) and `hub/knowledge/directory-sources.ts -> packs/skill/adoc-format/api.ts` (pack exception).

Allowed direct dependencies (`package -> allowed_dependencies`):
- `config`, `platform`: `[]` (leaves)
- `records`: `config`
- `telemetry`: `config`, `records`
- `rules`: `telemetry`
- `refs`: `records`, `rules`, `telemetry`
- `connectors`: `records`, `refs`, `rules`, `telemetry`
- `health`, `jev`, `requests`: `records`
- `leases`: `config`, `records`
- `knowledge`: `connectors`, `jev`, `records`, `refs`, `rules`, `telemetry`
- `dispatch`: `connectors`, `leases`, `records`, `refs`, `telemetry`
- `runs`: `connectors`, `dispatch`, `knowledge`, `leases`, `records`, `refs`, `requests`, `rules`, `telemetry`
- `server`: `config`, `connectors`, `dispatch`, `health`, `knowledge`, `leases`, `platform`, `records`, `refs`, `requests`, `rules`, `runs`, `telemetry` (all other 13 `hub/` packages except `jev`)

Package responsibilities:
- `config`: Hub environment schema (`CIRCLE_HUB_*`), `retired.ts` (`CIRCLE_SERVER_*`, retired keychain vars) and runtime guards.
- `records`: append-only `records` table + content-addressed objects + the few mutable stores (users, teams, hashed tokens, root pointers with CAS, vault). Record digest = SHA-256 of RFC 8785 canonical JSON. `hub/records/migrations.ts` currently holds a single consolidated `baseline` migration (`version: 1`); applied migrations never change, and future schema changes append new checksummed migrations after it.
- `telemetry`: operational telemetry metrics/events and `usage.ts` helper.
- `rules`: interpreters and the sandbox that runs pack functions (child process, Node permission model plus macOS `sandbox-exec` or Linux bubblewrap/AppArmor network denial).
- `refs`: reference resolution, deterministic parsers, verbatim quote check.
- `connectors`: read-only access to business systems (GET / allow-listed read routes only).
- `knowledge`: tree, roots, producers, placement, personal spaces and the Hub-wide public space (`公共空间`, internal id `team`).
- `dispatch`: worker/task dispatch and scheduling.
- `runs`: pack loading, run engine, validation, per-(item, requirement, layer) terminal state and partitions. Unknown stays unknown, never failure or success.
- `health`, `jev`, `leases`, `requests`: database/system readiness checks (`health`), external evidence/JEV helpers for `knowledge` (`jev`), distributed leases (`leases`), and run/review request state (`requests`).
- `server`: MCP endpoint, web console, `circle-hub` CLI (`bin/circle-hub`). `platform`: key files (the vault master key and the operator token under `<data root>/keys`, on every platform; no macOS keychain), launchd/systemd, PG lifecycle, backup/restore/deploy/rehearsal.
- `packs/` holds product / workflow / system packs; **core code must not name any product, command or customer** — product content lives in packs. `tests/fixtures` and `scripts/real/` (owner-run, read-only against real systems) are the only places real-system structure appears.
- Circle Hub has no `foundation/` or `references/` directory; third-party notices and the upstream Circle attribution live in `NOTICE` and `THIRD_PARTY_NOTICES.md`. The earlier implementation is readable via `git show ca66002:<path>`; copy and adapt, never import.
- Maintained docs under `docs/` are governed by `.github/checks/doc-set.json` (`published`, `kept_internal`, `historical`, plus `docs/whitepaper.md` under `reserved`) and enforced with `.github/checks/exceptions.json` by `.github/checks/doc-set.ts` and `.github/checks/docs.test.ts`.

## Conventions that bite

- ESM, erasable TS syntax only (no `enum`, parameter properties, namespaces); imports end in `.ts`; dependencies are exactly those in `package.json`.
- User-facing text is Chinese; tool/schema descriptions and code comments are English.
- Errors throw typed errors carrying a registered code (`PROTOCOL_CODES`, `CORE_VIOLATION_CODES`, `<pack>.<code>`); new codes are requested from the contracts owner, not invented.
- A failed read follows D05 R[3] in `contracts/model.json`: for public-space (internal id `team`), product and business-system content, absent is `SOURCE_ABSENT` and present but unreadable is `SOURCE_NOT_PERMITTED`; another member's personal-space content and credential or login failures stay neutral (`SOURCE_UNAVAILABLE`), with the real cause only in the admin call log.
- Naming (`团队` vs `公共空间`): user-facing UI and documentation label the all-account shared space **Public space / 「公共空间」** (distinct from created teams; internal storage id `team` stays), while **Team / 「团队」** refers strictly to created teams used for workflow and business-system assignment (no separate per-team knowledge spaces yet).
- Pack functions are pure modules (`export default function (input: unknown): unknown`).
- Tests and CI use only scripted models and synthetic fixtures (addresses in 192.0.2.0/24); never open the owner's environment file or credential stores.
- Commits: one capitalized imperative English sentence, no prefix, no final period, `git commit -s`, explicit paths only (no `git add -A/.`/`commit -a`). Work happens on task branches opened from `hub-redesign`; no push or PR without the owner's decision.
