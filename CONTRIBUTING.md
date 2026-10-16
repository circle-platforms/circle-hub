# Contributing to circle-hub

Thanks for helping. This page is what you need to make a change that can be merged. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Read the [design](docs/design/README.md) ([English](docs/design/en/README.md)) first. It is the constraint: each of the four objects is made of the same five parts; everything that plugs in is an asset; approvals happen only on change sets; execution goes through the enforcement chain; the platform is not the approver; product content stays out of the core. A change that has to go around one of these changes the design first and the code after.

## Before you start

- **Bugs.** Open an issue with the bug report form. Say the commit, what you put in, what you expected and what you saw.
- **Ideas and larger changes.** Open an issue first and describe the problem you want solved. A change to the object standard, the approval model or the enforcement chain is easier to agree on before the code exists than after.
- **Security.** Anything that may involve a vulnerability or sensitive data follows [SECURITY.md](SECURITY.md), not a public issue.
- **The other repositories.** Circle's client and its hub extension live in [circle](https://github.com/circle-platforms/circle); skill packs and product-line packs live in [circle-packs](https://github.com/circle-platforms/circle-packs) and follow the [product-line pack exemplar](docs/design/product-line-pack.md). What the three repositories expect of each other is in the [compatibility matrix](docs/compatibility.md).

## Set up

circle-hub needs Node.js 24 or newer. PostgreSQL is not installed separately: the tests and the development stack use an embedded, temporary instance.

```bash
git clone https://github.com/circle-platforms/circle-hub
cd circle-hub
npm ci
npm run dev:stack     # temporary PostgreSQL, server and worker, bound to this machine only
```

`dev:stack` prints the local address, the development sign-in and a synthetic sample; Ctrl+C removes the temporary environment.

## Test

```bash
npm run typecheck
npm test              # contracts, methods, acceptance, references
```

The `Hub checks` workflow runs type checking, contract tests, method tests and synthetic service acceptance in scratch Circle data directories with temporary loopback PostgreSQL. On Ubuntu it installs bubblewrap and gcc so Linux isolation tests can run; a missing `bwrap` skips those cases instead of executing them unsandboxed. `Reference integrity` checks the frozen archives separately. The Circle RPC acceptance cases require the separately confirmed `CIRCLE_BIN` and `CIRCLE_COMMIT`; public CI does not provide that runtime, so those cases explicitly report skips rather than passes. A development runtime profile is created with `npm run runtime:profile` ([docs/runtime-profile.md](docs/runtime-profile.md)).

- Every behaviour change comes with a standalone sample that reproduces the original problem. Old test records and source summaries are not evidence that something works today.
- Acceptance runs on synthetic sources, synthetic devices and the development identity only: no real system, no paid model, no real device. Read-only observations of real sources are recorded separately and never counted as passes.
- The core guard tests scan `apps/` and `packages/` for product and system names. A connector may name a system; nothing may name a product line.

## Make a change

- New self-maintained code is TypeScript, with dependencies at exact versions.
- `foundation/circle` and `references/` are frozen bytes: do not change them, and do not import them from a runtime entry point. Adopting a behaviour from them records its source, its license, what changed and a new acceptance.
- An interface change updates `packages/contracts` and [docs/client-api-handoff.md](docs/client-api-handoff.md) in the same pull request, with the old and the new shape written down. The real RPC tests against the pinned Circle commit keep passing.
- Documentation is written in natural Chinese, with the design also in English under `docs/design/en`; interface and code identifiers are clear English. Keep implemented behaviour, confirmed direction, proposals and unverified scope apart.

## Releases

Add a line under `## Unreleased` in `CHANGELOG.md` with every change a user would notice. Versions start at 0.1.0 with the first tagged release. The [compatibility matrix](docs/compatibility.md) says what a release changes for Circle and for the packs, and in which order the three repositories release.

## Change the docs

Files in `docs/` describe what the code does today. If you change behaviour, change the page that mentions it in the same pull request. Progress goes into the phase records under `docs/`, not into the README, which stays the public face. The pages are published at <https://circle-platforms.github.io/circle-hub/> by `.github/workflows/pages.yml`.

## Commit messages

One short imperative sentence in English, capitalised, with no prefix and no full stop, for example `Bind an approval to the input revision and the action digest`. Put the why in the pull request. Stage explicit paths; never `git add -A`, `git add .` or `git commit -a`.

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
