<h1 align="center">circle-hub</h1>

<p align="center">A standard MCP server for verified results, task packs and a knowledge tree.</p>

<p align="center">
  <a href="https://circle-platforms.github.io/circle-hub/">Docs</a> ·
  <a href="docs/design/en/generic-model.md">Model</a> ·
  <a href="docs/hub-r4-brief.md">Milestone</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

---

circle-hub is the team hub for [Circle](https://github.com/circle-platforms/circle), being rebuilt as a standard [MCP](https://modelcontextprotocol.io) server. A model works in the client; the Hub hands out the work, checks what comes back at its boundary and keeps the record. It never generates content.

## What the Hub is

This is the design that milestone 1 is building; [Status](#status) says what exists today.

- **Task packs** say what to review and how a result is checked: requirement templates, slot schemas, checks, a procedure for the model and the pack's own deterministic functions. Product, workflow and system packs are separate, and product knowledge lives only in packs, never in the core.
- **Verified results.** On submission the Hub resolves every exact value to a reference, checks quotations verbatim against the sources, re-runs the pack's checks in a sandbox and computes a terminal state for every item, requirement and layer. Each item lands in exactly one partition, and unknown stays unknown.
- **A knowledge tree** per product line and version, content-addressed and built from the sources by deterministic parsers; knowledge that needs judgment stays on the client and enters through separate contribution runs, checked verbatim by the Hub, and the Hub calls no model. A run locks the root it reads.

The contracts define six tools: `list_task_packs`, `upload_file`, `start_run`, `get_nodes`, `resolve_reference` and `submit_result`. Records are append-only and everything else is derived from them. Circle is to connect through an ordinary MCP server entry and shows no Hub-specific interface.

The design authority is the generic model in [contracts/model.json](contracts/model.json), summarised in [docs/design/en/generic-model.md](docs/design/en/generic-model.md).

## Status

Milestone 1 is built and deployed, and nothing here is a supported release. The model, the contracts generated from it, the [architecture brief](docs/hub-r4-architecture.md), the packages under `hub/` (server, read-only console, knowledge tree, read-only connectors, dispatch), the packs and a persistent single-machine deployment listening on loopback are in place; [docs/hub-r4-progress.md](docs/hub-r4-progress.md) says which parts have landed and been reviewed, and what is still open. The task-and-approval server that came before (up to 0.2.0) is retired, and its briefs and handoffs are kept as [historical records](docs/README.md#历史记录).

## Run the checks

Node.js 24 on macOS or Linux; Windows is not supported. The PostgreSQL server is not installed separately: tests start a temporary one from the `embedded-postgres` development dependency. Backup, restore and deploy also need `pg_dump` and `pg_restore` of the same major version (PostgreSQL 18 today): `brew install libpq`, or set `CIRCLE_HUB_LIBPQ_BIN`. Without them those tests skip, and a skip is not a pass.

```sh
npm ci
npm run typecheck
npm run verify:contracts   # contracts/generated matches contracts/model.json, contracts/codes.json and contracts/src
npm run test:unit
npm run test:acceptance    # temporary PostgreSQL, synthetic fixtures, scripted models
npm run verify:references  # frozen Circle baseline, checked by SHA
npm test                   # contracts check, unit, docs, acceptance and reference tests
node --test ".github/checks/*.test.ts"   # docs checks
```

`node tools/show-element.ts B01 W06` prints model elements and `node tools/show-element.ts --vocab partition` prints a vocabulary axis. Tests and CI use only synthetic fixtures and scripted models and never reach a real system. Only the deployed Hub and the owner's own scripts read real systems, and only to read. CI runs on Ubuntu, where the pack sandbox's tests run under bubblewrap and AppArmor and the tests that need macOS skip; a separate macOS workflow runs them on every push to main and nightly, and each phase records a local macOS run in the progress page.

## Documentation

- [Milestone 1 brief](docs/hub-r4-brief.md) · [architecture](docs/hub-r4-architecture.md) · [progress and decisions](docs/hub-r4-progress.md)
- [Generic model](docs/design/en/generic-model.md) · [the five-element checklist](docs/design/en/object-standard.md) · [design index](docs/design/en/README.md) (Chinese originals in [docs/design](docs/design/README.md))
- [Compatibility matrix](docs/compatibility.en.md): what circle, circle-hub and circle-packs expect of each other.
- [Source manifest](references/README.md): the frozen Circle source baseline in `foundation/circle`, verified by SHA, never imported at runtime.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) for coding agents. Report security problems as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

circle-hub works with [circle](https://github.com/circle-platforms/circle): Circle is the agent, and circle-hub is the MCP server it connects to. The packs live under `packs/` in this repository.

## License

circle-hub is released under the [Apache License 2.0](LICENSE). The [NOTICE](NOTICE) file names the copyright holder and reserves the Circle and Circle Hub names, logos and icons: the license covers the code and its documentation, not the marks. The design specifications in [docs/design](docs/design/README.md) are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and must be credited, with a link to the original, when reused. Until 2026-10-13 the repository was under the MIT License. The frozen Circle source baseline in `foundation/circle` keeps its MIT license; it, the archived platform in `references/` and the dependencies are described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Contributions are accepted under the [contributor terms](CONTRIBUTING.md#contributor-terms).
