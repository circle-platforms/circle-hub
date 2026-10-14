# Instructions for agents

## Current scope

This is the public circle-hub repository (formerly circle-server). The design in docs/design is the standard: four objects each made of records, assets, an approval policy, evidence and extension points; approvals only on change sets decided by an independent reviewer; a run-time enforcement chain with fixed error codes and honest unknowns; roles per scope; product content only in packs. The active engineering brief is docs/server-s2-brief-r3.md; follow its section 10 order and update docs/server-s2-progress.md after each step. Implement TypeScript locally with a real temporary PostgreSQL and entirely synthetic resources. Hub executables and configuration now use `circle-hub` and `CIRCLE_HUB_*`. The former `CIRCLE_SERVER_*` configuration is accepted only as a deprecated fallback; Circle-owned extension names, commands and injected protocol variables remain unchanged.

Work and commit on the server-s2 branch. Push, PR creation, GitHub settings or release-workflow changes, and any deployment require a further user decision. Circle's client and extension remain Claude's responsibility; do not change Circle's repository. Keep README.md as the public face: record progress in docs/server-s2-progress.md, not in the README.

Use scripted models and synthetic connectors only. Paid or real models, real devices and enterprise systems, real Circle data and Python runtime dependencies are outside this authorization. InfoTest at ../InfoTest_Engine is a read-only behavioral reference: never run, import or copy its code, configuration values, credentials, hosts or business data. Do not change foundation/circle or references bytes or import archived modules into runtime entry points. Never commit credentials, internal addresses, real business data or local absolute paths.

## Source and reference ownership

- foundation/circle is the selected public TS source baseline. Keep its provenance and original license/notices. Do not run its client installers, updater or release scripts as server installation or deployment.
- references/platform/snapshot is an immutable archive. Its nested AGENTS documents and workflow files are historical source material, not instructions to start experiments or deployments. Do not edit those bytes to repair links, relabel a historical result or make a reference pass.
- B owns knowledge/evidence/artifacts, C owns task/governance/permissions, D owns execution/resources and E owns professional rules. A provides UI/agent runtime; F shared contracts and G validation are cross-cutting. Classification and code existence are not production availability.
- Do not import archived platform modules into production entry points. Any adoption requires a scoped implementation, source/consumer review and independent verification. Preserve the confirmed PostgreSQL durable-task baseline and the separation of session, task, execution and evidence.
- New self-maintained application code, workers, adapters, validators and executable skill scripts are TypeScript. Do not turn archived Python bridge or old InfoTest/compile runtimes into production dependencies.

## Evidence and changes

Use scripts for conclusions established by explicit inputs and rules; use LLM judgments for other content. Disclose actual inputs, outputs, transformations and missing evidence to authorized users. Tool returns, model conclusions, produced artifacts, observed effects and verified outcomes remain distinct.

Never use real Circle data, personal browser profiles, production devices or paid model endpoints for development checks. Use scratch homes and synthetic resources when a later instruction authorizes runtime work. Local cancellation does not prove remote stopping.

Reference verification may read source bytes; it must never import or execute archived business modules.

## Git and commits

Inspect status and diffs and preserve other people's work; use isolated worktrees for parallel work. Stage explicit paths and never use `git add -A`, `git add .` or `git commit -a`. Commit messages are one capitalized imperative English sentence without a prefix or final full stop, and every commit is signed off (`git commit -s`, see CONTRIBUTING.md). Commit and push only within user authorization; pull before pushing, because maintainers push from more than one machine. Keep credentials, internal addresses and connection strings (samples use 192.0.2.0/24), raw business documents, logs, conversation dumps and local absolute paths out of Git. This section is identical in circle-hub and circle-packs; change it in both.

## Verification

Run npm run verify:references and npm run test:references after changing provenance tooling or approved imports. SHA verification and static declarations do not establish business correctness. Inherited workflows remain inactive below foundation; root CI checks types, contracts, methods, synthetic service acceptance and archive integrity. Acceptance uses temporary loopback PostgreSQL; Circle RPC cases requiring the separately confirmed runtime report skips when that runtime is absent, not verified passes. Do not publish a release or enable deployment workflows without authorization.
