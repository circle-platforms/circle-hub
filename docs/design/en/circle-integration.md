# Integration with Circle

## hub is an enhancement of Circle, not another home page

Circle is the agent you run yourself; hub is the process the team runs. The same product, two ways to run it: `circle` and `circle hub`. An administrator uses Circle too, only with a different role, and there is no second administration program; a host without graphics uses the command line that comes with hub.

Why a resident process is still required: independent approval needs shared state; tasks and Evidence must outlive the session and the machine; what constrains the agent cannot run inside the agent process.

## Menu: extend, not side by side

B/C/D/E in the internal standard do not enter the user menu. In the user's eyes a skill is a skill and a tool is a tool, with no split between local and hub. Once connected to hub, Circle's menu items are extended:

| Circle menu | Once connected to hub | Corresponding standard |
|---|---|---|
| sessions | work: local sessions + hub tasks mixed together, with status; the "needs me" count (awaiting my approval / awaiting my response / exceptions) | C work |
| skills | local skills + hub skill packages, the same table, with a "source" column; tabs inside the page: skill package / product-line module / rule | E |
| tools · mcp servers | local tools + the hub tool catalog (`srv_*`), the same table | B's connectors, D's resource tools |
| approvals | local permissions + hub Approval requests, two tabs inside the page, not counted together | C approval |
| new · materials | sources, originals, claims, snapshots; appears only after logging in to hub | B |
| new · resources | gateways, workers, operations, the scene, Unknown outcomes; appears only after logging in | D |
| settings › hub | login, scope, people, policy, worker, notifications | C identity and policy |

The letters B/C/D/E remain only in the standard documents and in the small "object standard" label on a Registry page.

## The sync model

Circle stores no B/C/D/E locally; what it shows is always the projection hub computes for the current identity.

- **Pull**: every list is a hub query (with an ETag); task events are caught up by cursor, and a reconnect after a disconnect continues from the cursor, with nothing lost.
- **Push**: hub sends a notification stream for "needs me" items (Approval requests, awaiting a response, exceptions); Circle subscribes, and if it breaks, falls back to polling.
- **A card is a projection**: the approval card and the error card in a session correspond to Records on hub; before "approve" is clicked it is read once more, a card someone else has already handled becomes "already handled by someone", and it is not approved twice.
- **Status line**: "hub · synced 12 seconds ago / offline"; while offline the task keeps running on hub, and a reconnect refreshes it.
- **Circle installed alone, without logging in to hub**: these entries are absent, and Circle is a general-purpose harness. Once logged in, a person sees only what is inside their own scope, and counts are computed on the server by identity.
- One Circle connects to one hub at a time (the first version).

## What a session (L0) looks like

Left column: the "needs me" count, the "work" list (local sessions and hub tasks mixed), and Circle's existing menu (including the extended items). Middle: the session; hub's accepted, Evidence, passed the gate, and Verification come back as event lines; things that need a person are inline cards — an error card (Error code + the facts + the applicant's choice) and an approval card (Change set + Binding + Eligibility + approve / decline). The side column on the right: this task's phase, Binding, Evidence, and output. Bottom: the input box and the status line.

## The common shape of the interface

- Except for binary downloads, every response is a JSON envelope: `data` on success, `error` (code / category / message / details / retryable) on failure; every endpoint except login requires a Bearer token. An ordinary request body is capped at 64 KiB, an original upload at 16 MiB. An invalid or expired credential is 401 `UNAUTHENTICATED`; a scope refusal is 403 `FORBIDDEN_SCOPE`.
- On a 401 from any poll, a client only reports that the sign-in expired and asks for an explicit login; it never pops up a password box on its own, and it never renews a run token.
- The admission of a write is idempotent: the idempotencyKey is 8–200 characters, the partition is tenant/scope/principal/action, and the online window is twenty-four hours; the same key with the same content returns the original admission (`deduplicated:true`), and the same key with different content is 409 `IDEMPOTENCY_MISMATCH`. A retry keeps the original key and the original content; changed content takes a new key. The admission transaction commits the task, the idempotency record, the outbox, and the wakeup together.
- An output produced from the same scope, the same source bytes, and the same method and contract versions reuses the same artifact id.

## The read projections of tasks and approvals

- The task list and the task detail share the same TaskView projection: the task identity, tenant/scope/principal, title, phase, the current input revision, the input, the revision, the flow version, and the pending inputs; a task bound to a capability pack also carries the pack id and version. The pending list contains historical responses too, and a client prompts only for an item whose status is open and whose revision equals the current one.
- The list filters by the current identity's tenant and authorized scopes first, then takes the newest by creation time, ties broken by task id descending; it includes readable tasks others created in the scope and is not narrowed to the caller's own. With no readable task or no authorized scope it returns an empty array; without the read permission it is 403 `FORBIDDEN_ACTION`. limit defaults to 20 and allows 1–100; an illegal limit is 400 `INVALID_PAYLOAD`, never silently truncated.
- The approvals list is an ApprovalView: approvalId, task, input revision, applicant, target identity, action digest, action, status, decider, expiry; every record is returned in creation-time and id ascending order, including those of old revisions, and an undecided one's decider is null. An approved on an old revision does not prove the current action is still authorized — the execution exit still checks the revision, the target identity, the action digest, and the validity. Reading approvals needs only tasks.read and grants neither answering them nor operating resources; reading never changes an approval's state and produces no Decision or event.

## Event catch-up

- A task's events page in ascending seq, at most 500 per page, with an optional waitMs long poll (0–30 seconds); the reply carries the page and the latest cursor after. A client keeps a processed cursor per task: it advances to the last seq after a successful consumption, an empty page keeps the cursor, and a reconnect catches up from it. A seq may have gaps across tasks and is not required to be continuous.
- A client disconnect or a closed terminal never triggers a cancel; a cancel is only an explicit call, and it is a request, not a proof that the remote side has stopped.

## The notification stream and the work queues

- Notifications are a projection of the durable outbox: the paged query returns items / cursor / hasMore (limit 1–200), and the SSE stream continues with the same cursor or a Last-Event-ID; a notification event carries id=seq, and a cursor event gives the next cursor even when the page has no notification. Events invisible to the current identity are filtered before paging, and the cursor may step over filtered sequence numbers. The server re-checks identity and role on every round: an expired session gets session.expired, a revoked grant gets permission.revoked, an internal error gets stream.error, and then the stream closes; a password is never asked inside the stream. SSE connections are capped per tenant/principal (four by default), the excess is `NOTIFICATION_STREAM_LIMIT`, and a disconnect releases the slot.
- The retention window is bounded: by default at least the latest 10000 events, at most 100000 rows, with an age target of seven days (hard caps win). When events before the window have been pruned, the first response's replayWindow.minCursor is greater than zero, and a client must not take the response as the full history; a stale cursor past the window is `CURSOR_EXPIRED` (details carry minCursor), after which the client re-reads the retained window from cursor=0, deduplicates by seq, and fills the task and approval facts beyond the window from the current-state queries; historical bodies come from B's originals, and the past order is never reconstructed from the current state. Task-event catch-up follows the same window discipline. The window is not protected by a principal's read watermark: events produced by other scopes worldwide also shorten one's window, and a few days offline does not guarantee a full catch-up; following online is preferred, and a polling round's total budget stays under the lower of bounds like "window size / (4 × global peak event rate)" and a quarter of the age cap — with the peak unknown, start with a short interval and let minCursor or a cursor gap trigger a state rebuild.
- The work queues are five buckets — awaiting my approval / awaiting my response / submitted by me / owned by me / exceptions — each with count, oldestWaitMs, overSla, and slaMs. Approval counts filter by the current administrator eligibility, the two-person rule, and the applicant; inputs and bot failures belong to the owner only; a private task is never exposed through a queue. The exceptions cover unknown/failed, expired or superseded requests, failed bot admissions, and offline workers, each group counted separately, and a group a facet does not apply to is explicitly reported as omitted, never claimed to be truly zero platform-wide. The SLA thresholds are stated in the response (by default twenty-four hours for approvals, five minutes for inputs, one hour for the rest); "owned by me" reads only durable assignment records and never infers an assignment from model text or the applicant's identity. A worker's offline state comes from its heartbeat threshold (ninety seconds by default), independent of the exception SLA, and is never guessed from its business results.
- Assignment: an owner who can read the task and holds the input permission, or an administrator of the scope, may set the assignee and the dueAt, and a member cannot change another's task; the assignee must be an active member or administrator of the same scope; an assignment grants no read access to a private task, and a private task can only be assigned to its owner. The dueAt is the queue's SLA date, independent of the execution deadline; a scope policy may adjust the five buckets' slaMs separately through one-item Change sets, a count prefers the task's own dueAt, and when scope values disagree, slaMs is null with the per-scope basis given.

## The body projection of events

- Task events, admin events, and notifications project the same event with the same fixed field set: metadata like the status/reason code, the rule version and verdict, the fence, the tool name, and the run binding is inlined; the bodies of results, tool outputs, model text, call arguments, and error details are not inlined.
- An event with a task identity also carries `content:{sha256,size,downloadPath,retained?}`: the body is read back on demand at the content path as the original bytes, the response-header digest matches content.sha256, and the permission follows the task's visibility; retained is the list of B references the body already holds (each with its own id, SHA, and download path), which reference their own SHAs and are never confused with content.sha256. A body is readable only inside the retention window, past it is `CURSOR_EXPIRED`; the originals referenced by retained stay readable under B's current permissions and are not deleted with the window.
- A notification carries only the id, the status/reason code, and the evidence references; the full result comes from the task result endpoint. The canonical events include approval requested/decided/superseded, task waiting-review/waiting-input/delivered/failed/cancelled, operation unknown, bot started/output/admission-failed, and the Change set states; the legacy names stay in the task-event compatibility stream while the notification catalog uses the canonical ones. Both an input rewrite and a new Change set emit the superseded event and name the superseder.

## The tool catalog and calls

- The catalog is computed for the current identity: permissions, scopes, asset read permissions, personal credential permissions, and the current asset revision that is approved and running, each checked in turn; disabling, a revision, or a permission revocation takes effect on the next catalog and call immediately. A tool name uses only lowercase letters, digits, dots, and underscores, is unique within the tenant, and multiple instances take aliases; a conflicting registration is refused (`TOOL_NAME_CONFLICT`).
- A catalog response carries an ETag and `Vary: Authorization`: an unchanged catalog for the same identity is a 304 (no body — do not parse it), a changed one is a 200 replacing the whole catalog; a catalog cache is never shared across identities. A tool's input schema is what the catalog actually returned, and a client maintains no second copy.
- A call carries an idempotency key of 8–200 characters: the same identity/scope/tool/key with the same canonicalized input reuses the original task and result; the same key with different content is `IDEMPOTENCY_MISMATCH`. Even a synchronous read call runs on an authenticated worker — the platform persists the task, the input revision, the operation, the lease, and the fence, and the materials side verifies the bytes' SHA before anything is returned. A synchronous wait timeout returns `UPSTREAM_TIMEOUT` with the task id and remoteStoppingVerified:false in details — this is not a cancel; changing the arguments means a new call, and a tool task's input revision is immutable. A failed receipt can still be re-read under its key; a fresh query takes a new key.
- A tool call's task and events belong to the caller personally from the start (see [Roles and scope](roles.md)): others in the scope cannot read its queries or candidates through the task endpoints either. The collapse of failure classifications is in [Approvals and the enforcement chain](approvals-and-enforcement.md#the-classification-of-source-failures).
- The resolution order of an instance alias is fixed: the product-line manifest's default prefix, then the package prefix, and finally the package id (hyphens turned into underscores); an explicit alias wins. A product line that is not installed or declared gets no prefix; once the product line is removed and the server restarted, the tools it explicitly bound are hidden from the catalog, and after it is reinstalled, the original approved bindings work again.

## Triggers and bots

- A trigger and a bot are both draft Assets that run only after an independent approval and activation by the owner: a scheduled trigger (with an interval of at least one minute) or a connector-event trigger; the components must be in the same scope, and the skill's manifest must allow the trigger kind. A bot's run identity is its registrant, and its result channel is the Circle event stream; channels are registered extensibly.
- Missed scheduled occurrences collapse into the single most recent due run, never replayed one by one; each run's trigger records {kind, dueAt, firstDueAt, skippedOccurrences}, and the cursor advances strictly into the future. A failed admission is rolled back independently: the runs entry has status=failed with taskId=null and an error carrying the classification (without source details), and the event cursor advances — no task and no bot.output is forged. A refused event is not retried, and later events are admitted as usual.
- To prevent self-triggering, the platform ignores any source.changed observation produced by a bot's run; explicitly registered connector events and human tool reads still trigger. A connector event is deduplicated by source/scope/external id, and the same id with different content is refused.

---

This document is one of circle-hub's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle Hub and qingshanfeihu and a link to the original. See the [design specifications index](README.md#license).
