# Instructions for agents

## Project status

This repository contains design and research documents, isolated reference implementations and the frontend workbench. Do not treat proposals as implemented features or accepted decisions. Read README.md, docs/decisions/0001-project-direction.md and docs/discussion/topics.md first.

The latest user instruction authorizes an isolated local research sandbox: inspect obtainable upstream source, study closed-source official documentation, install sandbox-only research dependencies, and run local synthetic protocol/browser/failure experiments. Focus on proven mechanisms and our needs, especially complex-network debugging and analysis. The user additionally authorized implementing the actual TypeScript/React frontend framework, installing its frontend dependencies, building it, running isolated browser checks, and publishing its code and documentation. Web is the current design and preview host for the future desktop renderer. Earlier synthetic demos remain historical references. The user also authorized publishing product, security, operations and agile plans plus GitHub backlog/project organization. This does not authorize production backend implementation, deployment, production equipment, real Circle data, external model spending, or host routing/DNS/VPN changes. Read ADR 0005 for the historical planning scope and the current sandbox research record for this scope change.

For knowledge work, read docs/knowledge-v1.md and ADR 0003 as the current design baseline. It is not a declaration that the service has been implemented. Implementation details and the remaining platform topics are handled incrementally.

For capability placement, read docs/object-boundaries-v1.md and ADR 0004. A–E are runtime responsibilities; F/G are cross-cutting engineering. MCP/tool/skill/hook are mechanisms, not owners. The inventory contains static declarations and recommendations, not a runtime availability or test-pass claim.

## Product direction

- The platform serves the full lifecycle of all InfoSec product lines. Load-balancer engineering provides the initial basis for common abstractions and validation; it does not limit the product scope. Keep product-specific commands, models and verdict rules in capability packages and adapters, not in the shared platform core. Initial APV validation does not establish compatibility with other product lines.
- Excel compilation and test-case review are examples, not the limits of the platform.
- Preserve Circle as an existing general-purpose harness, not a mandatory platform dependency. A must be replaceable by Pi, OpenCode or another compatible harness; B/C/D/E share business logic and state through common contracts and thin adapters. All other new self-maintained application code, services, workers, MCP adapters, tools, validators and executable skill scripts must be TypeScript.
- Previous InfoTest and compile projects are references for requirements, data, behavior and failures. Do not port their Python runtime into this project or wrap it as the new production implementation.
- Keep domain rules and generic harness mechanisms separate. Investigate existing work before inventing a replacement abstraction.

## Harness interface correction

- The latest split is ADR 0028: Circle remains a generic harness; its default plugin library owns the optional server connector. Users configure a server IP/domain and authenticate. circle-server owns B/C/D/E and its administration/operations entry points. Do not create a separate connector repository, connector Project, or Web administration site. Shared-code synchronization, compatibility and coordinated releases remain proposals in docs/circle-server-plan.md. This documentation task does not authorize creating the server repository, implementing production services, changing Circle core or deploying. Preserve existing experiments and source-bound validation records.

- A is the replaceable harness responsibility: ongoing conversations, model calls, context, tool/skill loading, tool execution interaction, interruptions and continuation. A native Web interface must express that role, not force every user message through product/task-category forms or fixed workflow cards.
- B/C/D/E each need their own observation and management paths. Session, long-lived work, actual execution and knowledge/method versions retain separate owners and identities. The old workbench demo was rejected; five harness interface alternatives remain layout references, none selected. The latest direction is a standalone desktop client, with official ZCode source studied as a framework reference. Desktop adoption, upstream reuse scope and runtime selection remain proposals until settled; browser-only demos do not establish desktop functionality.

## Frontend composition

- The user accepted continuing the current frontend and proposed a shared Circle application UI with composable platform components. Implement and review first-party frontend plugins within the existing frontend scope. UI enablement does not install Circle extensions, grant business permissions or terminate work.
- Keep the shell, harness adapter, UI contributions and B/C/D/E authorities separate. Circle integration is still a proposal: its 1.0.4 RPC is headless, skips MCP/extensions and has no interactive approval reply channel. Recheck the actual version before implementing transport. This frontend task does not authorize modifying or running Circle against real user data.

## Truth and disclosure

- Follow ADR 0024: assign 100 percent established content to scripts within explicit rules, inputs and applicability; use LLM judgment for other content. Fully disclose actual inputs and outputs, transformations, failures, retries and observed effects to authorized users. Keep script facts, model judgments and verified outcomes distinct. Never promote schema validity or model confidence into factual certainty. Protect secrets and mark redaction; do not publish raw business data to Git.
- Network diagnosis spans physical through application layers and requires both product knowledge and networking knowledge. Designs must identify topology, traffic, fault location, observation points and the evidence each check can establish. Local synthetic experiments do not establish physical-network behavior.

## Working with decisions

- User-facing documentation is Chinese. Code identifiers and public API names should be clear English.
- Separate confirmed decisions, proposals, observations and open questions.
- Follow current user authorization. A topic being open does not require repeated permission for already authorized work; explain consequential unresolved choices and continue independent work.
- Do not begin broad implementation merely because it appears in the roadmap. The user intends to discuss implementation topic by topic.
- Record a decision and its scope after it is accepted. Update affected documents together and preserve the history of corrections.

## Evidence and execution

- Distinguish a model conclusion, a tool return, a produced artifact, an observed effect and a verified outcome.
- Bind evidence to its source, version, input, target, run and relevant time. Preserve original bytes where exact content matters.
- Historical observations cannot silently become expected behavior. Missing evidence remains unverified.
- Ordinary event callbacks are not enforcement boundaries. Required checks belong on the authoritative execution or completion path.
- Use scripted models, local gateways and isolated resources for development verification. Never experiment against real Circle user data or production equipment.
- An interrupted local call does not establish that a remote operation stopped. Verify actual execution state.
- Say what was actually inspected or tested. Do not reuse old test totals as current validation.

## Repository and sensitive data

- This is a private repository. Do not commit passwords, access tokens, keys, internal connection strings, full conversation dumps or raw business documents/logs.
- Use deployment aliases in research records. Keep operational connection information outside Git.
- Inspect status and diffs before edits. Preserve work you did not create; do not stash, reset or overwrite it.
- Use isolated worktrees for concurrent implementation. Stage explicit paths; never use git add -A, git add . or git commit -a.
- Commit and push only when the user authorizes them. The initialization request authorized initial publication; current authorization covers research, plans, GitHub work organization and the frontend framework in this private repository. It does not authorize production backend implementation or deployment.
- Keep commit messages as one capitalized imperative English sentence, without a prefix or final full stop.
