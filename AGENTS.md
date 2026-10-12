# Instructions for agents

## Current scope

This is the public circle-server repository. On 2026-10-12 the user authorized phase two in docs/server-s2-brief.md: enterprise objects, five kinds of actions and governed capability definitions, beginning with the synthetic defect lifecycle. Use TypeScript, exact-version dependencies with a committed lockfile, and real temporary PostgreSQL. Local server and worker execution is authorized only with synthetic data and temporary directories. If embedded-postgres cannot run, ask rather than substitute a different database.

Work and commit only in the isolated server-s2 branch, starting from server-s1. Keep server-s1 reserved for PR #5 corrections. If PR #5 merges, rebase server-s2 onto the new main baseline before continuing. Push, PR creation, GitHub settings or release-workflow changes, and any deployment require a further user decision. Circle's client and extension remain Claude's responsibility; do not change Circle's repository.

Use scripted models and synthetic connectors only. Paid or real models, real devices and enterprise systems, real Circle data and Python runtime dependencies are outside this authorization. InfoTest at ../InfoTest_Engine is a read-only behavioral reference: never run, import or copy its code, configuration values, credentials, hosts or business data. The existing compilation skills and archived executables must not implement any runtime path. Do not change foundation/circle or references bytes or import archived modules into runtime entry points.

The revised phase-two source is a read-only PLM JSON query mirror of the issue tracker, using each user's own SSO JWT directly in the Authorization header. Do not commit its service address or token values. Sanitized structure and behavior observations are now supplied in docs/server-s2-progress.md. Implement a synthetic HTTP JSON mirror and TypeScript mappings from those observations, with wholly fictional data and runtime-only origins and credentials. Source responses use JSON code even when HTTP is 200. Preserve unknown values and missing publication evidence. Remove the superseded dual-tracker and HTML plans, and remove the inherited superseded tracker fixture during the compatibility migration while retaining mechanism coverage.

New committed content must contain no credential values, internal addresses, real business data, machine-specific absolute paths or conversation dumps. Refer to other local repositories with relative paths. Preserve historical provenance instead of rewriting immutable references.

Read README.md, docs/bootstrap.md, references/README.md, docs/bcde-integration-plan.md, docs/server-build-brief.md, docs/server-s1-progress.md and docs/server-s2-brief.md first. Update docs/server-s2-progress.md after each completed step with actual commands, results and remaining work. Write each acceptance before implementing it. The product boundaries follow infosec-platform ADR 0028. Core code implements generic storage, permissions, task governance and execution; system and product behavior belongs to connector, object-mapping, method or policy packages. Preserve phase-one API behavior and mechanism coverage while extracting its specific implementations. Circle remains a generic harness with the optional server connector. Do not create a separate connector repository, connector Project, Web administration site or console application. The authenticated HTTP API and admin CLI share one authorization path.

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
