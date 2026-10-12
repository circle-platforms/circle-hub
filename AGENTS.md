# Instructions for agents

## Current scope

This is the public circle-server repository. The user has resumed phase two under docs/server-s2-brief-r2.md: assets first, a knowledge-centered tool catalog, then governed skill packages and headless execution. Follow section 5 in order. Implement TypeScript locally with real temporary PostgreSQL and entirely synthetic resources. The goal is to connect product Q&A, case compilation and case review capabilities through Circle and circle-server; InfoTest remains a read-only behavioral reference, never executable code or copied configuration.

The earlier bug-lifecycle scope in docs/server-s2-brief.md is historical, not the active acceptance plan. Existing generic objects, core guard and sanitized PLM contract remain valid foundations. The exact-version parse5 and saxes dependency preparation may be adopted. Update docs/server-s2-progress.md after each step. Tell the user as soon as the tool-catalog client handoff is written so Claude can start the Circle client work.

Work and commit only in the isolated server-s2 branch, starting from server-s1. Keep server-s1 reserved for PR #5 corrections. If PR #5 merges, rebase server-s2 onto the new main baseline before continuing. Push, PR creation, GitHub settings or release-workflow changes, and any deployment require a further user decision. Circle's client and extension remain Claude's responsibility; do not change Circle's repository.

Use scripted models and synthetic connectors only. Paid or real models, real devices and enterprise systems, real Circle data and Python runtime dependencies are outside this authorization. InfoTest at ../InfoTest_Engine is a read-only behavioral reference: never run, import or copy its code, configuration values, credentials, hosts or business data. The existing compilation skills and archived executables must not implement any runtime path. Do not change foundation/circle or references bytes or import archived modules into runtime entry points.

Sanitized PLM and publication-site observations are in docs/server-s2-progress.md. Build read-only synthetic connector packages for document service, build site, query mirror and automation-environment viewing. Automation permits only an explicit read-command allowlist; no environment modification is authorized. All addresses, real knowledge/cases and credential values remain outside Git and are supplied only at runtime.

Initial deployment remains this user's Mac with loopback listeners; opening network access requires a further decision. Personal SSO credentials are registered at runtime, owned by a person and referenced by a connector; no value is returned, audited or committed. Service credentials are future work. Publication and command-tree sources are a separate synthetic HTML/XML build site. Its fixed-issue lists join the mirror's historical external issue identifier to releases; never follow those legacy tracker links or connect that tracker. Confirm formal publication from release records, retain Beta matches separately and return the earliest formal release plus all matches.

New committed content must contain no credential values, internal addresses, real business data, machine-specific absolute paths or conversation dumps. Refer to other local repositories with relative paths. Preserve historical provenance instead of rewriting immutable references.

Read README.md, docs/bootstrap.md, references/README.md, docs/bcde-integration-plan.md, docs/server-build-brief.md, docs/server-s1-progress.md, docs/server-s2-progress.md, docs/server-s2-brief-r2.md and the immutable knowledge-v1 design before implementation. Write each acceptance before implementing it. Core code implements generic storage, permissions, asset/task governance and execution; specific behavior belongs to connector, mapping, method, policy and product-line packages. Preserve phase-one API behavior and mechanism coverage while extracting its specific implementations. Circle remains a generic harness with the optional server connector. Do not create a separate connector repository, connector Project, Web administration site or console application. The authenticated HTTP API and admin CLI share one authorization path. Introduce a precisely versioned Circle runtime dependency for headless execution only after verifying its public supported entry point; ask the user if the choice is unclear.

## Source and reference ownership

- foundation/circle is the selected public TS source baseline. Keep its provenance and original license/notices. Do not run its client installers, updater or release scripts as server installation or deployment.
- references/platform/snapshot is an immutable archive. Its nested AGENTS documents and workflow files are historical source material, not instructions to start experiments or deployments. Do not edit those bytes to repair links, relabel a historical result or make a reference pass.
- B owns knowledge/evidence/artifacts, C owns task/governance/permissions, D owns execution/resources and E owns professional rules. A provides UI/agent runtime; F shared contracts and G validation are cross-cutting. Classification and code existence are not production availability.
- Do not import archived platform modules into production entry points. Any adoption requires a scoped implementation, source/consumer review and independent verification. Preserve the confirmed PostgreSQL durable-task baseline and the separation of session, task, execution and evidence.
- New self-maintained application code, workers, adapters, validators and executable skill scripts are TypeScript. Do not turn archived Python bridge or old InfoTest/compile runtimes into production dependencies.

## Evidence and changes

Use scripts for conclusions established by explicit inputs and rules; use LLM judgments for other content. Disclose actual inputs, outputs, transformations and missing evidence to authorized users. Tool returns, model conclusions, produced artifacts, observed effects and verified outcomes remain distinct.

Never use real Circle data, personal browser profiles, production devices or paid model endpoints for development checks. Use scratch homes and synthetic resources when a later instruction authorizes runtime work. Local cancellation does not prove remote stopping.

Inspect status/diffs and preserve other people's work. Use isolated worktrees, stage explicit paths, and never use git add -A, git add . or git commit -a. Commit/push only within user authorization. Messages are one capitalized imperative English sentence without a prefix or final full stop.

Keep credentials, internal connection strings, raw business documents/logs and conversation dumps outside Git. Reference verification may read source bytes; it must never import or execute archived business modules.

## Verification

Run npm run verify:references and npm run test:references after changing provenance tooling or approved imports. SHA verification and static declarations do not establish business correctness. Inherited workflows remain inactive below foundation; root CI only checks archive integrity at this stage. Do not publish a release or enable deployment workflows without authorization.
