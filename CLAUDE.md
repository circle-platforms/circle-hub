# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the binding rule set (authorizations, git, evidence, ownership); read it first. This file only adds commands and the architecture map. `docs/hub-r4-architecture.md` is the engineering brief; `docs/hub-r4-progress.md` records phase progress and the owner's decisions.

## What this is

circle-hub is a standard MCP server (streamable HTTP, Bearer token) that **verifies results and never generates them**. It has six tools (`list_task_packs`, `upload_file`, `start_run`, `get_nodes`, `resolve_reference`, `submit_result`), task packs, a content-addressed knowledge tree per product line and version, append-only records, and a web console (read-only pages; administrators also manage users, tokens, packs, resources, secrets and knowledge sync there, decision 122, each action running the matching CLI command). It serves HTTPS itself when configured (decision 121, `circle-hub tls`) and installs with one command on macOS and Linux (`install.sh`, release bundles, decision 123). It calls no model; reviewing models run only on the Circle (client) side. Pre-rename names are dead: only `circle-hub` and `CIRCLE_HUB_*` exist, and a process seeing any retired `CIRCLE_SERVER_*` variable must refuse to start.

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
npm run verify:references && npm run test:references   # after touching provenance tooling
npm test                          # contracts check + unit + docs + acceptance + references

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

Packages under `hub/` with a strict dependency direction (cross-package calls go through each package's `api.ts` only, no cycles):

`server → runs, knowledge, connectors, records, platform, refs, rules`; `runs → knowledge(api), rules, refs, records`; `knowledge/connectors → rules(sandbox), refs, records`; `rules → refs(types)`; `refs, records → contracts`.

- `records`: append-only `records` table + content-addressed objects + the few mutable stores (users, hashed tokens, root pointers with CAS, vault). Record digest = SHA-256 of RFC 8785 canonical JSON. Applied migrations never change; add a new one.
- `refs`: reference resolution, deterministic parsers, verbatim quote check. `rules`: interpreters and the sandbox that runs pack functions (child process, Node permission model plus macOS `sandbox-exec` network denial).
- `runs`: pack loading, run engine, validation, per-(item, requirement, layer) terminal state and partitions. Unknown stays unknown, never failure or success.
- `knowledge`: tree, roots, producers, placement. `connectors`: read-only access to business systems (GET / allow-listed read routes only).
- `server`: MCP endpoint, console, `circle-hub` CLI (`bin/circle-hub`). `platform`: key files (the vault master key and the operator token under `<data root>/keys`, on every platform; no macOS keychain), launchd/systemd, PG lifecycle, backup/restore.
- `packs/` holds product / workflow / system packs; **core code must not name any product, command or customer** — product content lives in packs. `tests/fixtures` and `scripts/real/` (owner-run, read-only against real systems) are the only places real-system structure appears.
- `foundation/circle` (public source baseline) is frozen: do not edit, run or import it. `references/` now holds only its SHA manifest (`npm run verify:references` checks the 287 files); the archive of the preceding platform was removed from this public repository on 2026-10-30 and must not be added back. The earlier implementation is readable via `git show ca66002:<path>`; copy and adapt, never import.

## Conventions that bite

- ESM, erasable TS syntax only (no `enum`, parameter properties, namespaces); imports end in `.ts`; dependencies are exactly those in `package.json`.
- User-facing text is Chinese; tool/schema descriptions and code comments are English.
- Errors throw typed errors carrying a registered code (`PROTOCOL_CODES`, `CORE_VIOLATION_CODES`, `<pack>.<code>`); new codes are requested from the contracts owner, not invented.
- A failed read follows D05 R[3] (model 37): for team, product and business-system content, absent is `SOURCE_ABSENT` and present but unreadable is `SOURCE_NOT_PERMITTED`; another member's personal-space content and credential or login failures stay neutral (`SOURCE_UNAVAILABLE`), with the real cause only in the admin call log. Code still answers the model-36 neutral form until consolidation step 4 ports it.
- Pack functions are pure modules (`export default function (input: unknown): unknown`).
- Tests and CI use only scripted models and synthetic fixtures (addresses in 192.0.2.0/24); never open the owner's environment file or credential stores.
- Commits: one capitalized imperative English sentence, no prefix, no final period, `git commit -s`, explicit paths only (no `git add -A/.`/`commit -a`). Work happens on task branches opened from `hub-redesign`; no push or PR without the owner's decision.
