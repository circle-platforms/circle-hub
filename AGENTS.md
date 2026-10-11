# Instructions for agents

## Current scope

This is the private circle-server repository. The user has authorized creating it from Circle and organizing the previous infosec-platform code as references, committing and publishing that initialization. No production server, device/browser experiment, dependency installation, deployment or external model spending is authorized by this step.

Read README.md, docs/bootstrap.md and references/README.md first. The product boundaries follow infosec-platform ADR 0028. Circle remains a generic harness; its default plugin library owns the optional server connector. Do not create a separate connector repository, connector Project or Web administration site.

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
