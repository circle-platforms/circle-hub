# Platform direction and roadmap

This page translates the [Chinese original](roadmap.md); where the two differ, the Chinese text is authoritative.

This page says what the Circle platform ([circle](https://github.com/circle-platforms/circle), circle-hub and [circle-packs](https://github.com/circle-platforms/circle-packs)) is for, how far it has got, and the order of the work ahead. The "now" column follows the code, the [README](../README.md) and the [changelog](../CHANGELOG.md). The plans are a direction and an order, not dated commitments. The work itself is tracked in the Issues of the three repositories.

## The problem

Every company has its own systems: an issue tracker, code repositories, a knowledge base, an office automation (OA) system, test environments and devices. Connecting an agent to them is not the hard part; MCP and connectors are plentiful. The hard part comes after:

- With many people, many agents and many shared resources at once, who may touch what?
- Before an action runs, who approves it, and exactly which content did they approve?
- After it runs, what is left behind, and can someone else check it?
- When the outcome is uncertain, does the system pretend it succeeded?

In that setting any single error can do serious damage: configuration pushed to the wrong device, a test bed taken by two tasks at once, code pushed to the wrong branch, an issue whose status no longer matches the facts. The Circle platform lets agents work together on top of a company's existing systems, with every step defined, approved and checkable.

## Three principles

1. **Programs do what is certain; the model does what is not.** The model interprets intent, makes choices and writes. Every check that has one right answer is done by a script against a versioned authoritative source: device commands against the command tree of the bound build, quotations word for word against the original, fields extracted by script.
2. **Approval happens at change time and is bound to content.** An approval request binds an input revision, a target identity and an action digest; when the content changes, the earlier approval no longer applies. Requesters cannot approve their own changes, and the platform is never the approver. Runs are not approved again; they go through the enforcement chain: permission, binding, verification, lease, audit.
3. **Evidence belongs to the hub, and unknown is reported as unknown.** Tool returns are kept as received under an evidence id and the agent gets only a pointer; script facts and model judgements are marked apart. An outcome that cannot be confirmed is recorded as unknown, and writes are not retried on a guess.

## Where it comes from

The Circle platform grew out of InfoTest, an internal automation system of a network-equipment test team. The team found that tasks which must be right to the character, such as device commands and test-case scripts, cannot be solved by a single skill, so it turned test-case generation into compilation: testers write a mind map, the model recomposes intent and writes, and programs check structure and every command against the command tree. That approach was later extracted into a programmatic skill any harness can call. After that, the team split what it needed — knowledge, tasks, approvals, execution resources and skill distribution — into separate objects, which became today's three repositories: Circle is the general agent, circle-hub the team hub and circle-packs the domain packs. The earlier platform's design and research are archived under [references](../references/README.md) and never imported at run time.

## The golden path: one sentence through an R&D chain

The target scenario is an engineer saying:

> Which bugs were assigned to me today that need reproducing and fixing? Handle them yourself.

The agent works through nine steps inside one durable task. Before every action that touches a shared resource or writes to a system of record, it hands a person an approval bound to that content. The person no longer approves "may this tool be used" but "this device, this configuration diff, this branch".

| Step | Systems | What guards it | Now |
|---|---|---|---|
| 1 Find today's bugs assigned to me | Issue tracker | Tool catalog computed per identity; evidence | Read-only connector over an issue-tracker mirror: search by product, status and date, read details |
| 2 Connect and set up the test environment | Test beds, inventory | Resource leases, anti-stale tokens | Read-only environment view; execution flows have leases |
| 3 Push configuration | Device under test | Every command checked against the bound build; change-set approval; re-check before dispatch | Approved product modules run through `module-execute`; the hub re-verifies every device command before dispatch |
| 4 Generate traffic | Tester or traffic generator | Resource leases; approval bound to the action digest | None |
| 5 Reproduce and analyze | Code, logs, captures | Evidence; script facts kept apart from model judgements | Circle's general tools (read code, search, LSP, run commands, subtasks) |
| 6 Fix | Code repository | Circle's permission modes and approvals | Available |
| 7 Verify | Web management UI | Isolated browser sessions; `%NAME%` variables and secrets kept out of prompts | Circle's browser tools, with record and replay |
| 8 Open a merge request | Code host | Change-set approval; the fix linked to the bug and the verification | Only git in a shell; pushes go through Circle's approvals |
| 9 Update the bug and log hours | Issue tracker, OA | Approval bound to content; linked to the same task's evidence | None |

The cross-cutting pieces are already in the hub: PostgreSQL durable tasks (input revisions, events, cursor replay), asset lifecycles, a write-only credential vault, independent approvals bound to content, evidence, skill packs carrying a trial record and approved by another person, and an MCP endpoint any harness can use; roles per scope and change sets are being completed. All of this is accepted on synthetic sources and a temporary PostgreSQL. Sign-in is development login only, so the hub is not yet for writes to real systems.

## Roadmap

Ordered by whether finishing an item lets the whole path run end to end for the first time. Writes to real systems are not turned on for a stage until the stage before it is done.

### Stage 1: make writes safe for real systems

- Real sign-in through the company's existing identity provider, replacing development login.
- Finish the [phase-two brief r3](server-s2-brief-r3.md): roles per scope with the two-person rule, change sets as the only approval concept, the enforcement chain with fixed error codes, the notification stream and work queues, and the static-secret credential mode for execution resources.
- Make gateway delivery to real devices work.

### Stage 2: run the golden path

- **Issue tracker**: an "assigned to me" query; writes (comment, resolve, reassign) as approved actions bound to content and evidence.
- **Test environments**: test beds grow from a read-only view into execution resources that can be reserved and initialized, reusing the existing leases.
- **Configuration push**: besides compiled workbooks, a single configuration or a set of them goes through the same command check, approval and pre-dispatch re-check.
- **Code host**: a merge-request connector (for example GitLab or Gitea), with the hub recording which bug and which verification each fix belongs to.
- **Traffic**: software traffic tools as leased execution resources; MCP interfaces from tester vendors sit behind the gateway. The platform does not build testers.
- **Hours**: the OA worklog entry as the last write, bound to the same task's evidence.
- **Reproduce-and-fix pack**: these steps written as a domain pack that states which parts are model judgement and which are checked by script, going through trial runs and independent approval like the existing mind-map compile pack.

### Stage 3: let any team connect its own systems

- **Adapter SDK**: connectors are assets like skills, with a version and SHA, running only after a trial run and independent approval. Connecting a new system means installing a pack.
- **Govern any harness**: the hub offers check, approval and evidence steps to other agents over MCP. `packages/harness-adapters` already imports the skills, commands, agents, hooks and MCP configuration of Claude Code, Codex CLI, OpenCode, Gemini CLI and Cursor into neutral manifests and exports them back.
- **A browser held by D**: people and agents see the same approved browser session and can take over when needed ([integration plan](bcde-integration-plan.md), S3).

### Stage 4: operations and reach

- Backup and restore, draining workers, keeping in-flight work across upgrades, and a compatibility list for mixed versions (integration plan, S5).
- Methods for locating network problems along business paths, extended fault by fault (integration plan, S4).
- Other R&D settings where output must be right to the character and actions touch shared physical resources.

## Non-goals

- No general chat front door, and no competing with collaboration suites for the employee's entry point.
- No race on connector count. Long-tail systems are connected by the teams that use them, through the adapter SDK.
- No model of our own; models are replaceable, and domain packs must pass their checks on different models.
- No testers or traffic generators of our own; they are connected as governed resources.
- No writes to real systems until real sign-in and the two-person rule are in place.

## Taking part

- Ideas, requests and problems go to the Issues of the relevant repository: [circle](https://github.com/circle-platforms/circle/issues), [circle-hub](https://github.com/circle-platforms/circle-hub/issues), [circle-packs](https://github.com/circle-platforms/circle-packs/issues).
- To connect your own system or write a domain pack, start with the [product-line pack exemplar](design/en/product-line-pack.md) and the [design](design/en/README.md).
- What the three repositories require of each other is in the [compatibility matrix](compatibility.en.md).
- Report security issues privately as [SECURITY.md](../SECURITY.md) describes; never post credentials or business logs in a public issue.
