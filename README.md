<h1 align="center">circle-hub</h1>

<p align="center">The team hub for Circle: shared knowledge, durable tasks, governed execution and versioned methods for agents that touch real systems.</p>

<p align="center">
  <a href="https://circle-platforms.github.io/circle-hub/">Docs</a> ·
  <a href="docs/design/README.md">Design</a> ·
  <a href="docs/compatibility.md">Compatibility</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

---

The team hub for [Circle](https://github.com/circle-platforms/circle): one daemon a team runs so that everyone's Circle shares the same knowledge, tasks, execution resources and methods — and so that agents touching real systems stay inside rules a person approved.

Circle stays a generic harness. circle-hub extends it: when a Circle signs in to a hub, its existing menus gain the hub's entries (work, skills, tools, approvals, knowledge, resources). An administrator is a Circle user with an admin role in a scope, not a separate console.

## Why a hub

Any team that lets agents work on real systems — devices, test beds, document stores, ticketing — runs into the same five problems:

1. Knowledge lives in one person's notes instead of a shared, versioned, reviewed source.
2. Work dies with the chat window; nothing survives a disconnect or a restart.
3. The only human gate is a permission prompt the agent's own process shows.
4. Credentials and endpoints end up in prompts, configs and logs.
5. Skills are copied around with no record of what they call or who approved them.

circle-hub answers each with one of its four objects, and keeps the agent's runtime (Circle) separate from the thing that constrains it.

## Four objects, one standard

| Object | Owns | Examples |
|---|---|---|
| **B · Knowledge** | source revisions, evidence, claims, snapshots, artifacts | read-only connectors to document stores, build sites and ticket mirrors; uploaded sources with roles |
| **C · Work** | identities, scopes, tasks, input revisions, approval requests, decisions, audit, bots | durable PostgreSQL tasks; approvals bound to an input revision, a target identity and an action digest |
| **D · Execution** | resources, operations, leases, live output, unknown outcomes | workers that call an MCP gateway with credentials injected from a write-only vault |
| **E · Methods** | skill packs, product-line modules, rules, flow versions | skill packs with recorded trials; deterministic rules the hub re-runs before dispatch |

Every object is made of the same five parts — records, assets, an approval policy, evidence, extension points — so every registry page in Circle has the same shape and every product line plugs in the same way. Three rules hold everywhere:

- **Everything pluggable is an asset**: kind · version · sha256 · declaration · configuration · lifecycle (draft → approved by an independent reviewer → running → retired).
- **Approvals happen on change sets, never at run time.** A run goes through the enforcement chain — permission, binding, verification, lease, audit — and ends in success, a fixed error code with the facts, or an honestly disclosed unknown. The platform is never an approver.
- **Evidence belongs to the hub.** Tool returns are stored verbatim with an evidence id; agents hold pointers; script facts and model judgments are labelled apart.

The design is written up in [docs/design](docs/design/README.md) (Chinese, with an [English translation](docs/design/en/README.md)).

## What works today

- Authenticated HTTP API (`/v1`), PostgreSQL durable tasks with input revisions, events and cursor replay, a supervisor with graceful restart, optional native HTTPS.
- Assets with lifecycle, write-only credential vault, independent-reviewer approvals bound to revision + target identity + action digest; superseded requests can be closed.
- Read-only connectors (WebDAV documents, build sites, a ticket-system mirror, an environment view) with per-source rate limits, SHA-pinned originals and identity-scoped caching; a tool catalog computed per identity.
- Knowledge records of two kinds — script-extracted product facts and reviewed conversation candidates — with immutable snapshots and asynchronous ingestion.
- Uploaded source artifacts (files with roles and declared metadata) that, once approved, bind every command tool to a stable source id.
- Skill packs pushed from Circle with their trial record, checked against the declared tools, approved by another person and run by a headless Circle; scheduled and event-driven bots.
- Service clients, `/token`, RFC 7662 `/v1/introspect`, short-lived operation tokens for workers; execution against an MCP gateway with the hub re-verifying every device command before dispatch.
- Execution flows run through `module-execute` with independently approved product modules; the former built-in `apv-case-execute` capability is retired. Historical task results remain readable.
- Module installation from a packs repository (`modules.json`): frozen bytes, submitted as ordinary assets, never auto-approved.

The acceptance suite (contracts, methods, acceptance, references) runs entirely on synthetic sources and a temporary PostgreSQL; the real-source observations are recorded separately in [docs](docs/README.md).

## In progress

The active brief is [docs/server-s2-brief-r3.md](docs/server-s2-brief-r3.md): roles per scope (admin / member / viewer) with a two-person rule, change sets as the single approval concept, the enforcement chain with fixed error codes and `waitingReason`, a notification stream and work queues, a static-secret credential mode for execution resources, and paged registry queries. Hub executables and configuration use `circle-hub` and `CIRCLE_HUB_*`; the former environment names remain deprecated fallbacks. The Circle extension uses `hub` and `/hub`; the former extension name and command are not aliases.

## Quick start

Node.js 24.

```sh
npm ci
npm run dev:stack     # temporary PostgreSQL + server + worker, bound to localhost, synthetic sources only
npm test              # contracts, methods, acceptance, references
npm run typecheck
```

`dev:stack` prints the local address, the development sign-in and a synthetic sample; Ctrl+C removes the temporary environment. Nothing in the repository or the suite connects to a real system, and no runtime address, credential or business original belongs in Git.

## Packs

Skill packs and product-line packs are not part of the hub. They live in their own repositories, are versioned and SHA-pinned on their own, and are installed through the hub's own mechanism (push → trial record → independent approval). The first packs repository is [circle-packs](https://github.com/circle-platforms/circle-packs); [the product-line pack exemplar](docs/design/product-line-pack.md) shows the layout and the adaptation sheet every pack fills in, with a synthetic product line as the worked example.

## Status

circle-hub is under development and not a supported production release: sign-in is a development login, acceptance is synthetic, and one team has used it end to end. Read [SECURITY.md](SECURITY.md) for the support scope before deploying it anywhere that matters.

## Documentation

- [Design](docs/design/README.md) ([English](docs/design/en/README.md)) — object standard, vocabulary and states, levels and elements, approvals and the enforcement chain, roles, Circle integration, product-line packs.
- [Client API handoff](docs/client-api-handoff.md) · [Historical native execution](docs/case-execution-handoff.md) · [Resource identity](docs/resource-identity-handoff.md) · [Module installation](docs/module-installation.md) · [Admin CLI](docs/admin-cli.md)
- [Phase records](docs/README.md) — briefs, progress and real-source observations.
- [Compatibility matrix](docs/compatibility.md) — which Circle commit the acceptance runs against, the frozen source baseline, the extension branch, pack schemas and the release order across the three repositories.
- [References](references/README.md) — the archived platform that preceded the hub; frozen, verified by SHA, never imported at runtime.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) for coding agents, and the [compatibility matrix](docs/compatibility.md) for what the three repositories expect of each other. Report security problems as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

circle-hub is one of three repositories: [circle](https://github.com/circle-platforms/circle) is the agent, circle-hub is the hub it signs in to, and [circle-packs](https://github.com/circle-platforms/circle-packs) holds the skill packs and product-line packs installed on the hub.

## License

circle-hub is released under the [Apache License 2.0](LICENSE). The [NOTICE](NOTICE) file names the copyright holder and reserves the Circle and Circle Hub names, logos and icons: the license covers the code and its documentation, not the marks. The design specifications in [docs/design](docs/design/README.md) are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and must be credited, with a link to the original, when reused. Until 2026-10-13 the repository was under the MIT License. The frozen Circle source baseline in `foundation/circle` keeps its MIT license; it, the archived platform in `references/` and the dependencies are described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Contributions are accepted under the [contributor terms](CONTRIBUTING.md#contributor-terms).
