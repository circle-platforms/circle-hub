# Contributing to circle-hub

Thanks for helping. This page is what you need to make a change that can be merged. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Read the [generic model](docs/design/en/generic-model.md) ([中文](docs/design/generic-model.md)), which summarises the design authority `contracts/model.json`, and the [milestone architecture](docs/hub-r4-architecture.md) first. They are the constraint: the Hub verifies results and never generates them; facts come only from versioned rules and integrity-checked observations of the target, re-run by the Hub at its boundary; every exact value resolves to a reference; unknown stays unknown; records are append-only; enumerations and codes come only from the generated contracts; product knowledge stays in packs, out of the core. A change that has to go around one of these changes the model first and the code after.

## Before you start

- **Bugs.** Open an issue with the bug report form. Say the commit, what you put in, what you expected and what you saw.
- **Ideas and larger changes.** Open an issue first and describe the problem you want solved. A change to the model, the six tools or a record shape is easier to agree on before the code exists than after.
- **Security.** Anything that may involve a vulnerability or sensitive data follows [SECURITY.md](SECURITY.md), not a public issue.
- **The other repositories.** Circle lives in [circle](https://github.com/circle-platforms/circle). It connects to the Hub as an ordinary MCP client and needs no Hub extension. Milestone 1 plans six generic MCP-client improvements there and the removal of Circle's existing hub extension, and changing Circle needs the owner's explicit authorization; the scope is stated once in [AGENTS.md](AGENTS.md#authorizations-and-limits). [circle-packs](https://github.com/circle-platforms/circle-packs) holds the skill packs and product-line packs of the retired server, which the redesigned Hub does not read. Milestone 1's packs live under `packs/` in this repository: the product pack, the case-review workflow packs, the system packs and a synthetic second product pack, with no hosts, credentials or real content. What the three repositories expect of each other is in the [compatibility matrix](docs/compatibility.md).

## Set up

circle-hub needs Node.js 24 or newer. The PostgreSQL server is not installed separately: tests start a temporary one from the `embedded-postgres` development dependency. Backup, restore and deploy also need `pg_dump` and `pg_restore` of the same major version as that server (PostgreSQL 18 today): `brew install libpq`, or point `CIRCLE_HUB_LIBPQ_BIN` at a directory that has them. Without them those tests skip, and a skip is not a pass.

```bash
git clone https://github.com/circle-platforms/circle-hub
cd circle-hub
npm ci
```

The Hub server itself is not built yet (see the [progress](docs/hub-r4-progress.md)), so there is no development stack to start.

## Test

```bash
npm run typecheck
npm test              # contracts check, unit, docs, acceptance and reference tests
```

`npm test` runs `verify:contracts`, `test:unit`, `test:docs`, `test:acceptance` and `test:references`; `npm run verify:references` checks the frozen archives by SHA; `node --test ".github/checks/*.test.ts"` runs the docs checks. The `Hub checks` workflow runs type checking, the contracts check, unit tests, acceptance on a temporary loopback PostgreSQL, the reference archive check (the frozen archives, by SHA) and the docs checks on Ubuntu. Each test job lists its counts and every skipped test in the job summary and fails when no test ran, so the acceptance job stays red until the acceptance suite exists (phase 4). What needs macOS or libpq skips on Ubuntu (the pack sandbox's network denial, the keychain, the launchd check, backup, restore and deploy): CI is no evidence for those paths, and each phase records a full local macOS run in the [progress](docs/hub-r4-progress.md).

- Every behaviour change comes with a standalone sample that reproduces the original problem. Old test records and source summaries are not evidence that something works today.
- Tests and acceptance run on synthetic fixtures and scripted models only: no real system, no real model endpoint, no real device. Fixtures mirror the structure of real systems, never their content, and addresses use 192.0.2.0/24. Read-only observations of real systems are recorded separately and never counted as passes.
- Core code names no product, command or customer, and writes no enumeration by hand: vocabulary values and labels come from `contracts/generated/vocabulary.ts`, and record kinds, protocol and core violation codes, reference forms and pack file paths from `contracts/generated/protocol.ts`. Product specifics live in product packs and system specifics in system packs.

## Make a change

- New code is TypeScript run directly by Node 24 (erasable syntax only, imports ending in `.ts`, ESM), with exactly the dependencies in `package.json`, at exact versions; adding one is a separate decision.
- `foundation/circle` and `references/` are frozen bytes: do not change them, and do not import them from a runtime entry point. Adopting a behaviour from them records its source, its license, what changed and a new acceptance.
- A contract change edits `contracts/model.json`, `contracts/codes.json` or `contracts/src` and regenerates `contracts/generated` with `npm run gen:contracts` in the same pull request; never edit the generated files by hand. Records are append-only, and an applied database migration never changes: add a new one instead.
- Documentation is written in natural Chinese, with the design also in English under `docs/design/en`; interface and code identifiers are clear English. In the Hub itself, user-facing text is Chinese, while tool and schema descriptions for models and code comments are English. Keep implemented behaviour, confirmed direction, proposals and unverified scope apart.

## Releases

Add a line under `## Unreleased` in `CHANGELOG.md` with every change a user would notice. Versions start at 0.1.0 with the first tagged release. The [compatibility matrix](docs/compatibility.md) says what a release changes for Circle and for the packs, and in which order the three repositories release.

## Change the docs

Files in `docs/` describe what the code does today, except the pages marked historical or superseded, which are kept as records and not updated. If you change behaviour, change the page that mentions it in the same pull request. Phase progress and the owner's decisions go into `docs/hub-r4-progress.md`, each with its source; a package's own decisions and limits go into its README; the root README stays the public face. The pages are published at <https://circle-platforms.github.io/circle-hub/> by `.github/workflows/pages.yml`, which builds `docs/` alone: link a file outside `docs/` by its absolute GitHub URL on `main`, never by a relative path. The docs checks (`.github/checks`) refuse such links, vocabulary tables that differ from the generated vocabulary, counts of the model's pending items that differ from the model, a recorded decision without a source, and local paths.

## Commit messages

One short imperative sentence in English, capitalised, with no prefix and no full stop, for example `Reject a submission whose quotation is not in its source`. Put the why in the pull request. Stage explicit paths; never `git add -A`, `git add .` or `git commit -a`.

## Pull requests

- Keep a pull request to one change.
- Run the tests and say so in the description: what changed, why, which users are affected and what was actually verified. Merging, acceptance and release are recorded separately.
- Never commit credentials, tokens, internal addresses, real business logs, user sessions or absolute paths from your machine.
- Sign off every commit (`git commit -s`); see [Contributor terms](#contributor-terms).
- Fill in the checklist in the template.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Contributor terms

circle-hub is open source today, and the people behind it may later offer it under commercial terms as well, next to the open-source version. So that this stays possible without asking every contributor again, every contribution (code, tests, documentation, design, translations, synthetic samples) is accepted on the terms below. There is no separate form to sign: submitting a contribution means you accept them.

### Sign off your commits

Every commit in a pull request carries a `Signed-off-by` line with your real name and an email address you control. `git commit -s` adds it. The line is your certification of the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

- the contribution was created in whole or in part by you, and you have the right to submit it under the licenses of this repository; or
- it is based on previous work that, to the best of your knowledge, is under a compatible open-source license, and you have the right to submit that work, with or without your changes, under the same licenses; or
- it was given to you by someone who certified one of the above, and you have not changed it;
- and you understand that the contribution, with your sign-off, is public and is kept with the project.

A pull request whose commits are not signed off is not merged.

### License to the project

You keep the copyright in your contribution. By submitting it you grant qingshanfeihu, the Circle project and any person or organization that later takes over the maintenance of circle-hub (together, the project owner) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable copyright license, with the right to sublicense through several tiers, to reproduce, prepare derivative works of, publicly display, publicly perform, distribute and otherwise use your contribution and derivative works of it, under the Apache License 2.0, under CC BY 4.0, or under any other terms the project owner chooses, including commercial, proprietary and dual-license terms.

You also grant the project owner and every recipient of circle-hub a patent license on the terms of section 3 of the Apache License 2.0 for the patent claims you can license that your contribution infringes by itself or combined with circle-hub.

You confirm that you may grant these rights: if your employer or anyone else holds rights in your work, you have their permission or they have waived those rights. If the contribution includes work by others, say so in the pull request and name the license it comes under. These terms do not transfer your copyright, and they do not oblige the project owner to use your contribution.

If you cannot agree to these terms, do not submit the contribution.

## License

circle-hub's code and documentation are released under the [Apache License 2.0](LICENSE). The [NOTICE](NOTICE) file names the copyright holder and reserves the Circle and Circle Hub names, logos and icons, which no license here covers. The design specifications in [docs/design](docs/design/README.md) are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). A contribution is released under the license of the part it changes, in addition to the terms above. Until 2026-10-13 the repository was under the MIT License. The frozen Circle baseline in `foundation/circle` and the archived platform in `references/` keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
