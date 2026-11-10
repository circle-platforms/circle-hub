# Changelog

All notable changes to circle-hub are listed here, newest first. Repository releases start at 0.1.0. Changes after the latest release are listed under Unreleased.

## Unreleased

- Remove the last summary panes of the console (decision 151, steps 7 and 8, first part): the connections, team, records and settings pages have no side pane while nothing is selected. The panes repeated figures the pages already show; the one fact only a pane had, the team's capacity, stands above the member list, and its action stays the page's 团队容量… button. The pane of a selected system, client, environment, member, call or credential is unchanged.
- Stop repeating a list in a side pane on the knowledge, workflow and skill pages (decision 151, step 5, first part): the knowledge home is one list with its total in the head and the tabs and search in one row; a folder's own count stands with its other facts and its recent changes are the version record below; the shared layout of knowledge, workflows and skills no longer adds a summary pane, so the workflow, skill, memory and original lists lose theirs as well. A scope's count stays beside the scope in the navigation, and the pane of a selected item is unchanged.
- Open a task's page with its result beside what still waits, and put the rest into six tabs (decision 151, step 4): the result block shows the task result, its pending count and receipt next to 还需处理, the three largest kinds of waiting request with a link to all of them. 验收要求 (each requirement with what it came to across the items), 条目, 请求, 过程, 来源 and 技术信息 are tabs addressed by `?tab=`; the side pane is gone and `?view=record` opens 技术信息. Identifiers, hashes and the session appear only under 技术信息. Each tab reads only what it shows: the call log, the text of every submission, the source blocks and the per-item results are no longer all read to open the page.
- Show the task page as two lists and merge equal requests (decision 151, step 3): 任务 and 等待回应中的请求 are tabs with their counts instead of one table under the other. The task table keeps six columns (the workflow version, the session and each row's technical identifier are gone; a result says how many requests of the task wait), the workflow filter is a list of the workflows on the page by name instead of a field for a pack identifier, and the summary pane that repeated the filter counts is gone. Waiting requests are merged by kind, missing content and next action into one row with the number of requests, the tasks they belong to, the recipients, the earliest deadline and how many are overdue; a page draws at most 100 kinds and says when it leaves some out. The task detail page merges its requests the same way.
- Rebuild the overview around what needs attention (decision 151, step 2): four figures first (tasks with those still awaiting a submission, passed out of those with a result, undecided requirements, waiting requests with the number of kinds they merge into), then the tasks that need attention beside the statistics. The attention list puts a task that waits for someone first and says what it still owes ("67 项未决 · 70 条请求等待回应中"), with its runner and start time. Check results, daily tasks, business-system reads and the Hub's state stand in the side column; the four folded sections, the planned features and the chart of the period's call spans are gone, and with the chart the 500-line call-log read of every overview.
- Stop `circle-hub` at once under a Node older than 24, and name the cause when the sandbox cannot isolate (issue 291): on a deployment the service and the commands ran under the system's Node 22. The sandbox always starts its child with `--permission`, but that Node has no `process.permission.drop`, so the probe refused every pack function (knowledge sync, seeding, projections) while the health check answered 200 and the message listed four possible causes. The entry now refuses a Node older than 24 with the version, the binary that ran and what to use instead, before any module loads; and a call refused for lack of isolation says which probe failed (for example that the Node that runs the Hub has no `process.permission.drop` and needs to be 24 or later) instead of the general sentence. The service does not need `NODE_OPTIONS=--permission`.
- Give skills their own place in the console and group the navigation (decision 151): the navigation has ten places in four groups divided by a line (总览 | 任务、知识库、工作流、技能 | 连接、团队、记录 | 设置、运行状况). 技能 (`/console/skills`) lists generic skills only and 工作流 lists workflows only, each with its own counts, recent list and publishing entry; the purpose of the kind is the hint of the place's title. A skill's page links from `/console/skills/<id>`, still answers under `/console/packs/<id>`, stands in the skills place and no longer repeats its kind in the trail.
- Void a run's earlier waiting requests when an accepted submission issues its own (model 41, B07 R[10], decision 150): every accepted submission issued a full set of requests and left the earlier sets waiting, so a run submitted 56 times listed 3,920 waiting requests for 70 open gaps. The earlier requests are now closed by an appended record that points at the later result and reads 已作废 (never 已回答); request records are not rewritten. A criterion change's judgment, a dispatched job's disposition, a rerun of the run and a repair asked of the pack's author are left to the step that closes them. Requests issued before this change are voided the next time their run takes an accepted submission, not retroactively.
- Show a knowledge entry's statement in the text colour with an underline instead of link blue: the link colour returns on hover and keyboard focus, so a long statement no longer outweighs the status and the other links beside it.
- Fit the knowledge folder's entry table into its box and name where the reader is: the statement wraps and the other columns stay on one line instead of scrolling inside the table with the status out of sight, an entry becomes a block with its column names on a screen of 760 px or less, and a line under the tabs says the scope, the content and the folder.
- Say plainly what goes into the optional fields of the knowledge and memory editors: the memory body hint "纯文本保存，不执行 Markdown" now says the body may use Markdown marks, is saved as written and is neither rendered nor converted; the structured data field says an empty field means none and that a filled one must be a JSON object, with an example; the applicability field says it must be a JSON object and an empty field means not declared, and shows "留空表示未声明" instead of the protocol value null as its placeholder. Nothing about what is accepted or stored changed (an empty field was already read as no data and no applicability).
- Say beside the two abstract column heads of the requirement table what they mean: 交付规则 explains that 记账型 delivers when every item has a final state, complete evidence and a known or handled effect and shows delivered counts, never "通过", while 门禁型 needs every required requirement satisfied on the same run and artifact; 接受的生产者 explains that a fact is worked out by the Hub by rule, a judgment is given by a model, and an independent judgment must come from someone other than the drafter, checked as the workflow prescribes. The formal names and values are unchanged and the notes come from the model's definition of done (V06) and requirement item (W02); the workflow page and the task page both show them.
- Say on a production result's page what 生产结果 is and what its link to the task page is: the page now says it is the result the Hub works out by rule when the task starts, a product of the workflow and not a result from the production environment, and the link read "查看运行（权威视图）" (a claim of authority with no statement of how it relates to this page) and now reads "查看任务完整记录（以任务页的记录为准）". The formal names 生产结果, 任务 and 运行 are unchanged; unifying how the console alternates between 任务 and 运行 needs the vocabulary owners and is not done here.
- Let the task page read a window of a task's submissions instead of its whole history: `getRun` takes an optional `history` window (newest 50 submissions, older ones by an opaque cursor), and for that read it loads results only for the listed rows, the current result and the production result, instead of every result body and a readability check for each. The page says how many submissions it lists, pins the submission behind the current result when it is older than the window, and links to older submissions and back; the withdrawn-grounds notice is judged over the results shown, and the page says so. Callers that need the whole history (the record reader's receipt check, the export, the JSON task view, the result page) read it as before. Finding the current result is still a backward scan whose length is its distance from the newest result; this does not remove it. Synthetic runs only: with the current result at the newest submission, a window read loads the same 118 result bodies at 110 and at 220 submissions where the whole read loads 211 and 321.
- Say beside the source type 声明 and the team-source status of an original what they mean: 声明 now carries a tooltip saying the bytes were provided by the uploader, nothing independent was collected and that is not a verification; 未署名 says the uploader has not yet confirmed the original as a team source, that unsigned uploads are not accepted by team knowledge and that this has nothing to do with who uploaded it; 已署名为团队来源 says the uploader confirmed it, that everyone can read it and that a signature is neither a digital signature nor a copyright transfer. The formal labels are unchanged; the list and the detail of an original both show them.
- Say in plain words what the sharing dialog's settings decide: it said "多项分享设置取并集，收回一项不影响其余设置；工作流使用权限与结果的分享范围分别判定" and now says that an item can have several sharing settings, that revoking one may leave it readable through another, that sharing only decides who can read and never creates or deletes the independent copies already shared to the team, and that a workflow's use permission and the sharing of its results are set separately. The revoke dialog says the same about the other settings and still says that what was already read cannot be taken back. Wording only: no permission or sharing behavior changed.
- Show byte counts in the console's one unit style: a memory's size in the memory list and its version table, and a route's size in a business-system trial report, read "164 字节" while other pages read "151 B". They now read "164 B" with the exact count in the tooltip ("164 字节"), 1024-based like the rest of the console. Times, the word 版本 for knowledge, workflow and product versions, and other wording of #244 are not changed.
- Say on the team knowledge import page what is general and what belongs to a product source: the card that needs a product is now titled 按产品来源导入 and says it imports from the sources the enabled product packs declare, instead of promising builds, manuals and command trees to every importer; the product field says that what a source holds is the product pack's to declare. The route that needs no product pack stays beside it unchanged.
- Open the task page with what the task came to instead of with its execution timeline: a result block above the process shows the task result, its pending count, the receipt and the counts by classification, with a link to the evidence, and the requests waiting for someone sit directly under it instead of far down the full record. The process stays below as a secondary area and every section of the full record is still there. On a narrow screen the default view still shows the inspector (whose head carries the result) and the full record opens with the result block first.
- Say beside the verified status of a knowledge entry what it covers: the status chip in the lists carries a tooltip, and the entry's own view a visible line, saying the quotations and paths were checked verbatim and that this does not make the statement a confirmed fact. The formal label 已验证 is unchanged and the sentence was only in the editing hint before.
- Give the console's neutral page and an old run a next step in plain words: a run recorded without a submission deadline said "旧运行没有记录期限，请以它为前驱开新修订" and now says it recorded none and to continue from a new revision of the task; the neutral page (absent and forbidden alike, byte for byte the same) now also says to go back to the overview or the list and, if still needed, to ask the content's owner or an administrator. Nothing tells the two cases apart and no continue button is promised.
- Name empty child knowledge folders explicitly and show compact path-preserving entries on their parent page. Keep the selected folder's empty state and owner-only new-entry action contextual, with accurate source-less note guidance.
- Show connection sections as a sticky page directory with native anchors and location feedback, keeping every section readable together. Explain workflow, skill and system-integration purposes on lists and publishing pages while retaining manifest kind validation and permissions.
- Put recent and still-unfinished overview tasks before statistics in both visual and keyboard order, with an eight-task preview and a full-list link. Keep compact two-column mobile statistics and fold trends, system/knowledge context, planned features and health without dropping their evidence tables or changing unknown/zero semantics; remove the duplicate overview inspector.
- Put knowledge and memory creation/revision into a standalone main-column editing foreground after authorization, with exact return links and existing concurrency/security tokens. Keep primary text and save/cancel accessible, group optional structured data and extra sources without dropping values, and expand folded groups for native invalid-field focus.
- Label inter-call gaps as unobserved intervals rather than client-local processing, preserving their bounds. Describe credential-based client lists and topology as registered relationships, identify the last credential-use timestamp and disclose that neither registration nor missing observations establish current online/offline status.
- Show wholly missing sampled curves as unknown without a numeric scale, while retaining their unknown table cells, recorded events and any independently known report points. Name the delay table's millisecond unit and disclose the distinct curve, tooltip and hourly-table aggregation windows.
- Distinguish timeline events with only a recorded instant from measured intervals in tooltips, accessible names and data tables: event duration is unrecorded, while actual zero and nonzero millisecond spans remain measured values.
- Keep long console-dialog headings and footer actions in place while the body scrolls. Distinguish retained knowledge-entry records (including historical and withdrawn entries) from the current readable entries loaded on this page, and retain coverage for consistent unified workflow/skill scope counts.
- Scope console explanations to authorized records and workflow-applicable checks, label delivered results without claiming downstream adoption, and describe quota accounting as capacity statistics rather than billing.
- Preserve safe knowledge and memory drafts after rejected edits, with accessible validation feedback, original version conditions and a fresh intent for a corrected refused memory write. Omit credential-like fields from the returned editor. When a form's result cannot be confirmed, keep the input and clear its busy display while requiring an explicit check-before-edit step instead of automatically resending.
- Show a check function's module and export rather than `[object Object]`, omit the repeated workflow breadcrumb, and label call-duration readouts and their accessible table with milliseconds, including a single-call statistic.
- Make `job explain-release` say what dispatch would refuse after every release condition holds: the run's lineage must hold every resource key the executor declares for the whole dispatch window. A new report field `lease_coverage` shares dispatch's own check, lists the declared keys the lineage lacks and says the executor's target is the whole bed; the command prints a `租约覆盖` line and exits 1 while it is unmet or unknown. The clause-3 verdict `satisfied` keeps its meaning, because the Hub's own dispatch of an accepted run picks its executor by it and then reports the refusal to the runner. Before, a run that booked only the devices it needed passed `explain-release` and was then refused with `LEASE_UNAVAILABLE`. Reading only; the executor is not contacted. test-bed's own hint to book the whole bed is not part of this change.
- Group the consequences of a permanent member deletion in the console preview by what they touch (removed, transferred, kept, references and sharing, account and sign-in, irreversible) and title it as a preview of the effects that deletes nothing, instead of one long paragraph under a title that read like a confirm button. The host command prints the same paragraph as before; a test fails when either form drops a consequence of the other. The member's own copy is named as the copy on their client device.
- Read what a run froze of a test-bed booking through the test-bed pack (1.2.18), which writes it: the knowledge layer kept its own copies of the manifest shape, the device lease key `bed/<bed>/<device>` and the device pointer, so a change in the pack would have emptied the booked devices' builds or widened the device and bed check without any error. The pack now exports `frozenBeds`, `bookedInstalls`, `bookedBedLease` and the key helpers; its writers use the same key helper, and a test pins readers and writers together and fails when a device key is written by hand again. A frozen manifest the pack cannot read now refuses the device and bed declaration of an operation record with a message naming the pack, instead of being taken for no manifest. A pack version change: publish test-bed 1.2.18 with the Hub.
- Decide whether a caller may read a record of a run from the run's header, not from its whole detail: the record reader behind every `rec:` read of the tools called the full run read for each record, which loads every submission, result body and request of the run, and now reads the run record and its grounds only. A synthetic run with 24 historical results of 64 KiB loads 50 result bodies through the old read and none through the new one, with the same verdict for the runner, an administrator and a member before, during and after a share. A submission read by someone other than its runner still reads the receipts, because that answer depends on them.
- Return compact verified task statistics to console lists and overviews, releasing each full summary's isolated read cache before retaining its status/count projection. Reuse the same result reducer for full details, preserve current-head/privacy/unknown semantics, and keep the four-worker page bound; full body verification, list run views and remaining history costs are unchanged.
- Decide whether the console live stream may tell an account about a task without reading the task's whole history: the stream called the full detail read for every task event and subscriber, which loads every submission, result and request of the run, and now asks a visibility check that applies the same rule and reads none of them. A synthetic run with 24 historical results of 64 KiB and one production result loads 50 result bodies through the detail read (25 listed, then the same 25 searched for the newest accepted one) and none through the check. This does not shorten the detail page itself or establish a deployed timeout fix.
- Scope same-byte dispatch attempt history, repetition rounds and windows to the verified task lineage, so an independent task can execute the same verified artifact after historical occupancy is settled. Preserve same-lineage no-resend rules, unknown physical-target freezes and conservative refusal for unbound legacy records; keep old records readable without rewriting them.
- Align case-compile's primary synthetic example with the interval command actually declared by its bundled contract and catalog, derive its IDs/quotes again, and verify the complete client-generated workbook successor. Preserve the former multi-command source/plan as a four-command refusal control. Move pack/generator identity to 3.9.19 and recompute only version-bound synthetic workbook samples; frozen authorities and validation logic are unchanged.
- Add a discoverable `spec_list` input to the source-read workflow (0.1.8) for manual-store's configured specification inventory. List direct members first and read only explicitly chosen exact file paths; unexamined sources, missing resource configuration and empty or partial inventories never establish that no specification exists.
- Make existing source-review requests reachable on the administrator records page with independent pagination, named recipients, deadlines and historical progress. Recheck each pinned source's permissions and omit its bytes and credential findings; an expired request is not accepted and a recorded request is not proof of external notification.
- Verify the existing nested-cache effective-tier controls against scanner updates and revoked acceptances, and distinguish explicit per-capture retention from a cross-record credential finding. No read-tier policy is relaxed or changed.
- Bound a console page's simultaneous task-summary reads to four workers instead of launching every heavy result at once, preserving all rows, their order and unavailable/unknown outcomes. This does not replace full result bodies with compact projections or establish a deployed timeout fix.
- Retain synthetic regressions for four-case whole-workbook verification with a frozen contract larger than 3 MiB, and exact-reference source accounting without raising limits. Verify bundled example ids and quotations at the engine boundary while explicitly retaining refusal for commands not declared by the synthetic catalog and contract.
- Stop a task summary from loading every historical validation body to choose its current result: read newest candidates individually and production candidates by the existing submission index, preserving the current head and its read permissions. Full task detail and full run bodies still need their separate performance work.
- Let member deletion finish when a publisher concurrently removes the same private extraction cache: a directory disappearing between its inspection, permission change or durability-sync open is already gone, while permission and I/O errors still refuse completion. Cover both races with deterministic filesystem regressions and verify private workflow transfer in the deletion browser checks.

- Let a client sign in with a device code (RFC 8628), as GitHub's device login does: it shows a user code, a person types it on the console's `/console/device` page and approves on the usual authorization page, and the client's poll of `/oauth/token` gets an ordinary Hub token. Nothing has to open a browser on the client's side or take a redirect back to it, which a desktop client that cannot open the sign-in page needs.
- Say that an object of a business system exists and that its content awaits review when its answer holds unreviewed suspected credentials: the reader got a neutral "not available", and a read that only reads failed. Such a run now binds that observation and ends normally, with coverage marked partial and nothing said of the content or the hit; any other caller gets the same fact as `SOURCE_PENDING_REVIEW`, and a run's read asks a named administrator to review it, once per object while the request stays open. A system pack says which JSON route answers with the object itself (`object_route`; PLM bugs and stories so far). Every other held answer (a lookup or list, a read of one revision, an id with a hit of its own) and an echo of a credential the Hub sent stay neutral. A run's readers no longer get the digest of a held answer from the manifest, the inputs of generated content or the views given to functions; parts kept from it (`keep`) still name it as their source.
- Read the reservations of all runs once in a maintenance pass: each run read them all again to find its own jobs, 6 of the 7.5 GB a full pass read on 843 runs. A pass now reads 1.5 GB in 65 seconds instead of 105.
- Keep a business system's read counts under its name on the console overview: a column of their own squeezed the name to one character per line.
- Show every workflow briefly in `list_task_packs` when the whole details do not fit one answer: on a deployment with 22 workflows the details filled two pages, 43,000 characters, and a model paged on every question to reach the one it wanted; one answer of under 20,000 characters now holds them all, and an exact `pack_id` reads one in full.
- Let a route name the parts of a JSON answer a read may still use when the whole answer is held for scan findings (`keep` in `system.json`): the PLM build record carries the full text of every bug of that build, 2.8 MB, and a credential-like word in one of them held the whole answer, so a bug read lost the name of its build. The answer stays stored as it came and held; the Hub generates the declared parts from it and scans them on their own, so a hit in them keeps them held too.
- Name what else a workflow reads in the same system when an object is absent: the same number can be another kind of object.
- Bind the observation "system S has no X, read at T" into a run that only reads when an optional input has no such object, as the model allows, so a pure read ends `ok`; the answer names what else that workflow reads there. A required input, or a workflow with requirements, is still refused with `SOURCE_ABSENT`.
- Tell a model that an item of an external system is read through a workflow, in the server instructions and under a knowledge search, which covers knowledge entries only.

- Make the console overview read what it needs once: 17 seconds to under 5 on a deployment with 120 tasks in the window, the page byte for byte the same. A value a read scope froze is named by its identity in a memo key instead of being spelled out field by field (a third of the page's CPU went to naming whole runs and results), a verified record skips the checks an unknown value needs when it is frozen, one lookup per root serves every ground that cites it, a run summary reads a run's results once, and the requests and product lines of the page are asked together. Every read of the Hub takes the first two.
- Make the console's 任务 page read the requests of its own tasks and draw at most 100 of them, saying how many there are: it read every request of the Hub and drew them all, 29,656 rows and 13.8 MB of page in 18 seconds, now 65 KB in 1 second.
- Read several values of an index without comparing record bodies: `findMany` chose its rows with `DISTINCT` over whole rows, a second on 9 MB of job events, and the jobs of a lease are read in one query instead of one each. `list_task_packs` goes from 2.4 seconds to about 1 on a deployment with a long job history.
- Scan equal bytes once: a credential scan depends only on the bytes and took 3.5 seconds on the event loop for a 2.8 MB answer, so the last scans are kept by digest; they hold offsets and detector names only. Read a product's version lines from its build records instead of working out every build's root, in one read scope: every `start_run` paid for this to freeze the knowledge spaces, 39,558 rows and 4.2 seconds, now 4,250 rows and 1.3 seconds.
- Fix what a review of this batch confirmed. The append cursor could settle past a transaction still open, because `pg_snapshot_xmax` is one past the last completed id and not the first not started: a horizon now takes a real id, and a writer takes its id before its position. A client name with a lone surrogate no longer stops the resource samples or loses a call-log line. An absence observation is fed to knowledge by no path. A search warns until a damaged scope is repaired. On 运行状况, 按客户端 and 按发布 count the requests that have a call-log line, 按发布 reads a release by its deployments, and an unknown stays 未知 where the page said 0 or no calls.
- Tell a model to leave `client_key` out of `start_run` unless it repeats a call whose answer was lost: 17 of 67 calls made one up from the object read, which a later session hit as `IDEMPOTENCY_MISMATCH` when anything differed and as an old run when nothing did.
- Name the phases of `start_run` and of the console overview as trace steps, so what they cost shows in `trace show` instead of hiding in the root step.

- List runs from an index entry (migration 29): a page of runs used to cast every run body to JSON to sort, 7 to 11 seconds a page on a deployment with 240 MB of runs, three pages for the console overview. `putRun` writes the entry, the migration adds it to stored runs, and a run without one keeps the original statement.
- Read a pack listing and a pack lookup in one read scope, so an owner's publish decisions are read once and not once per pack, list the installed skills once per listing, and list the caller's packs once for `tools/list`: on a deployment with 323 pack versions `tools/list` read 196,000 rows and took 19 to 27 seconds, longer than the 8 seconds a client waits before it reports that the first message was not saved.

- Make an idle maintenance round cost what changed, not the history (decision 146): a scheduled round reads the account list and the end of the append log, 2 queries however many runs and requests exist, instead of every run body and three scans of every request (about 16 seconds, 383 queries and 318 MB a minute on production data). A round takes the runs and requests a new record names through a cursor that also sees records committing out of order, and deadlines from schedules in memory; no migration, no new right for the runtime role. The first pass after a start and the half-hourly pass over everything are unchanged.
- Build the knowledge search index in the background instead of inside searches (migration 30, step `index-knowledge`): a search reads what is ready in one statement and names the rest in its warnings, with what comes next, and writes nothing. The first search after the cutover had been one `get_nodes` call of 268.9 s and 97,844 queries. A round at start, on a new version and on a moved root works in batches of 256 rows with multi-row statements, gives the event loop a turn between batches, reads no entry body of a product and resumes from the rows it has. A version over a limit is refused once and stays refused, across restarts, until the limit rises or the content changes, instead of being tried again at every search. Product mounts, which no member writes, get their own limit, `CIRCLE_HUB_MAX_PRODUCT_INDEX_BYTES` (default 1 GiB); `CIRCLE_HUB_MAX_SPACE_INDEX_BYTES` (64 MiB) stays the bound on personal and team spaces, and a release that does not know the new name refuses to start with it set.

- Add the console's 运行状况 page, the ninth navigation item, for administrators (decisions 146 and 147, step 3 of the observability design): six resource cards with their value now and a 24-hour curve, the background tasks by what they read, the crash and restart list with one crash open (what was running, the 5 minutes before it), calls by client and declared platform, p95 by release, and the trace writer's own numbers. Every read is bounded by a time window and a row limit, aggregates and downsamples in SQL and runs on a connection of its own with a statement timeout, so what the page costs does not grow with the tables. Clients may now declare `clientInfo.platform` at MCP `initialize`: it is recorded as a declaration in `trace_spans.client_platform` (migration 31, model 40), outside the records that bind a client to its writes.
- Record the running Hub's resources and crashes (decision 146, step 2, migration 28, package `hub/health`): a sample every 10 seconds of process CPU, the event loop, memory, sandbox, pool, database, disk and connections into `resource_samples`; start, clean stop and abnormal exit into `process_events`; an in-flight request log in the unit's runtime directory, so a crash names what was running and who; Node's crash reports read at the next start. The service definitions add a heap limit sized from host memory (a quarter, 2 to 8 GB), the report flags, and forbid memory dumps (`LimitCORE=0` and `CoredumpFilter=0` on Linux, core limit 0 on macOS), so run `circle-hub service install` or deploy to apply them. Backups hold the diagnostic tables without their rows. New commands for administrators: `circle-hub health`, `circle-hub crashes`; `circle-hub db top` reads `pg_stat_statements` on the host.
- Record what every request and background round does (decision 146, step 1 of the observability design): each MCP call, console request, sync request, background round and CLI command is a trace of named steps with resource usage, written by a bounded background writer to the new `trace_spans` table (migration 27, kept 14 days, outside the record chain, no inputs or outputs), read with `circle-hub trace list|show|top`; tool calls also accept `_meta.traceparent`, and model B08 gains the fields, the retention rule and the axes `step_type`, `step_level` and `trace_origin`.

- Record token and invitation issuance, use and revocation as append-only `token_issuance` records in the same transaction as the token or invitation row change, including the tokens revoked by member deletion (model 38, R01 R[12], decision 136 ⑫). Records hold ids, accounts, actors, times, labels and client ids, never a token, an invitation code or a hash; history before this change stays in the `tokens` and `invitations` rows.

- Stop the console overview from exhausting the heap: a long argument enters a read memo key as its SHA-256, so concurrent readability checks no longer each hold a whole run and result as key text; the overview reads requests only for the runs it lists, and run listings that show no request fields ask for none (`requests: false`).

- Index `record_index` by digest (migration 26): counting a record's index entries before adding more scanned every entry (193 ms over 3.1 million on the owner's deployment), and personal purges delete index rows by digest.

## 0.3.0 - 2026-11-04

The first release of the redesigned Hub (milestone 1 and the work after it) and the first with the one-click install bundles for macOS and Linux on arm64 and x64. Public main is the single code line: the integration line was ported in four sanitized batches and sealed, and the owner's production deployment now runs main (decisions 136, 144 and 145 in `docs/hub-r4-progress.md`; the state, what is proven and what cannot be, in `docs/hub-status-2026-11.md`).

- End the lease and dispatch pools an administrator command opened, so a command exits once it has printed instead of 30 seconds later (#175).
- Size the managed PostgreSQL settings from host memory (or the cgroup limit) and preload `pg_stat_statements` when the binaries ship it, creating the extension in the `postgres` maintenance database only (#176).
- Default the first administrator's username to `admin` (an empty answer at the installer prompt, `init-admin` and `user create --role admin` without a name, pre-filled on `/console/setup`) and add `circle-hub user rename <用户> <新名字>` for administrators, with a `user_history` snapshot and migration 25 granting the runtime role `UPDATE (name)` on `users`, so an existing first administrator can be renamed to `admin`

- Merge the integration line's model changes into model 37 (consolidation step 3): read failures answer `SOURCE_ABSENT` or the new `SOURCE_NOT_PERMITTED` for team, product and business-system content and stay neutral only for another member's personal space and credential or login failures (D05 R[3], decision 136 ③); errors and fixes are claims (D05 R[8]); choice lists list every option first (A05 R[1]); requests keep their starting permissions (B03, B04) and a session may reuse its declared model identity (W07 F[0]); 台架 and 运行环境 read 自动化测试环境; `fed-case@1` gains ten optional fields. The code follows in step 4. html-format and mindmap-format 1.0.18, workbook-format and xml-format 1.0.19 and knowledge-contribution 1.3.19 carry only the regenerated contract files.

- Unify the decision registry in `docs/hub-r4-progress.md`: public main's former decisions 74–88 are now 121–135 and 89–94 are now 138–143 (table at the top of the page), with sanitized summaries of the integration line's decisions 71–120 and the owner's decisions 136 and 137; citations across the repository follow, and model 36 changes only cited numbers.

- Apply the owner's rulings on issue 141: share one team-marked entry with only its sources from 仅保存在本机 (sync capability `share-single-item`), report `never_synced` for a first-connection notice (`first-sync-notice`), purge the run-held copies of purged personal originals and mark those runs' grounds 根据不可用, and hand a deleted member's private workflows and skills to the deleting administrator.

- Scan base64 runs of any length in one linear pass, so an upload with a base64 run of about 6 MB or more gets its credential scan instead of a stack overflow (#153).

- Keep the vault master key and the operator token in private files under the data root on macOS as on Linux, retire `CIRCLE_HUB_KEYCHAIN_SERVICE` and `CIRCLE_HUB_KEYCHAIN_ACCOUNT` (a process that sets either refuses to start and says where the keys are), and run the key tests on Ubuntu (decision 137). A macOS deployment whose key is still in the keychain moves it with the earlier release's `key export --confirm` piped into the new release's `key import`, then `operator-token reissue`.

- Publish the neutral knowledge sync v1 specification with a discovery document at `/.well-known/knowledge-sync`, `detail` on sync errors, console confirmation for purges asked over the sync API, and recorded client provenance on knowledge entries.

- Keep team and member management available when the knowledge service or personal spaces feature is absent.

- Prefer the sharer's own signed original before team and granted equal-byte copies while keeping exact attribution boundaries.

- Bound retained team knowledge and memory with administrator quotas that survive personal purge and reuse member capacity controls.

- Release sync write admission when a peer disconnects before body reading, and replay legacy document runs across their actual upgrade boundary.

- Serialize team sharing with private ground owners before copying their originals.

- Retire request-local read proofs after member deletion, deactivation and personal purge while preserving console batching and transaction-bound objects.
- Batch exact historical capacity reads without trusting cumulative counters or retaining every entry body at once.

- Bound waiting private publication requests and return busy feedback after releasing rejected uploads.

- Remove orphaned personal and team pack staging on service startup while preserving live publishers.

- Preserve fresh shared pack staging during member cleanup without delaying removal of private cache remnants.

- Mask deleted member names in administrator CLI listings while retaining stable member identifiers.

- Narrow frozen upload declarations by the source hash index before decoding registrations during run admission and upgrade.

- Bound private pack staging per member and keep sandbox publication checks outside pooled database transactions.

- Separate deleted-member names from status badges and show readable deletion categories with host-execution instructions.

- Freeze all deleted-account fields and token revocation history, verify deletion manifests inside PostgreSQL, and show tombstones consistently without revival or new-grant actions.

- Purge private installs and original captures with deleted members while preserving exact existing team and frozen-run holders.

- Add permanent member tombstones and guarded digest-only deletion receipts over the existing personal payload purger.

- Share exact native capacity accounting with personal sync admission and freeze archive and attribution requests to their admitted epoch.

- Integrate personal sync with the shared console shell, Inspector, confirmation dialogs and current-state feedback.

- Admit sync requests before appending audit records so unknown routes and rate refusals cannot grow the log.

- Freeze portable v1 personal-sync exchange examples and verify two-client conflicts and knowledge grounds over HTTP.

- Expose personal knowledge and memory sync over a scoped Bearer-only HTTP API with bounded batches and audit receipts.
  Add password-console mode controls that atomically purge personal payloads or resume with a fresh epoch.

- Keep logical record digest reads indexed when reconstructing run-held personal uploads.

- Preserve exact run-held personal uploads across personal-space purge while removing their personal links.

- Refuse runtime database roles with effective temporary-object privileges at authorization and startup.

- Prevent temporary type shadowing in every owner-defined personal storage function.

- Apply personal sync snapshots atomically with state comparison, deterministic conflicts and fresh evidence checks.
  Console and MCP writes share the epoch and capacity boundary; manifest sync does not install workflows.

- Keep local personal views empty and allow their owner to return to Hub storage through a fresh epoch.

- Synchronize legacy object directories before completing retirement.

- Check cleared team grounds through the existing exact source index.

- Bound repeated legacy personal-tree traversal and keep retirement holder lookups indexed.

- 升级后，私人空间用量从不可变记录确定性重算，修正旧计数少计或多计；成员看到的已用容量可能增加。
  已有内容及版本保持不变，真实用量达到上限时拒收后续写入。管理员可用 MB/GB 精确调整额度；
  成员页、我的空间和超限提示统一显示一位小数的 KB/MB/GB，Tooltip 或纯文本保留精确字节。

- 成员停用与恢复使用事务内账号检查，冻结私人写入和分享，保留原件与团队副本；已归档原文隐藏重复保存入口。

The Hub is being rebuilt as a standard MCP server; see [docs/hub-r4-brief.md](docs/hub-r4-brief.md). Nothing below has been released.

### Removed

- The archive of the platform that preceded the hub (`references/platform`) is no longer part of this repository. `references/source-manifest.json` and `npm run verify:references` now cover only the frozen Circle baseline in `foundation/circle` (287 files). The skill and product-line packs of the retired server moved to a private repository.
- **Breaking: the task-and-approval server is retired.** The `/v1` HTTP API, the supervisor, the worker, the admin CLI, the development stack, the connectors, the harness adapters, the packs and their tests were removed ahead of the redesign. Nothing in the redesign reads their routes, migrations, database or configuration, so a 0.2.0 deployment cannot be upgraded in place, and the hub extension in released Circle versions, which calls the `/v1` API, does not work with the redesigned Hub. The removed code stays readable in Git (the v0.2.0 tag and commit ca66002). The history of the earlier temporary deployment is recorded as lost and is not migrated.
- **Breaking: the `CIRCLE_SERVER_*` configuration fallback is gone; circle-server is no longer supported anywhere.** circle-hub reads only `CIRCLE_HUB_*`. From 2026-10-16 the retired server and its scripts refused to start while any `CIRCLE_SERVER_*` variable was set, even an empty one or one beside its `CIRCLE_HUB_*` replacement, and named each variable and its replacement without printing a value; the redesigned Hub keeps this rule (planned). The `hub.environment.deprecated` notice is gone with the fallback.

### Added

- The knowledge console has a source archive with space-scoped browsing, explicit saving, exact-capture links and
  server-verified quote locations. Every match is available through bounded pages; HTML remains escaped and downloads
  are current-access attachments. Saving an ordinary upload preserves its original capture, ACL and frozen run declaration.

- Uploaders can explicitly attribute an exact private upload as a declared team knowledge source. Unsigned sharing is
  refused with a next step; successful sharing records the signer and a separately authorized team copy while preserving
  the original private capture and ACL. Console confirmation explains the consequence; attribution alone publishes nothing.

- Console vocabulary values use the model's interface labels, while static copy follows the shared Chinese wording and
  spacing rules. Explanations appear in keyboard-accessible tooltips; rendered-page checks preserve original evidence.
  Selected and hovered row helpers, control borders and chart loading states meet the shared contrast requirements.

- Console rows select contextual actions instead of carrying buttons. Keyboard selection, dialogs, pending submissions,
  live refresh and success messages share consistent behavior; charts offer matching hover, keyboard and table views,
  with unified periods and compact numeric/time formatting. Native forms and strict hash-based CSP remain supported.

- The remaining console areas share sections, statistics, badges and dialogs with contextual overviews. System, call and
  member selections open responsive inspectors; task evidence remains accessible on phones. Inspector actions are grouped
  at the foot, destructive actions open confirmations, and overview check results use a thin segmented bar instead of a ring.

- Knowledge, memory and workflow views use shared lists and tables with contextual inspectors. Readable names replace
  inline hashes; technical references remain available through explicit view entries. Wide tables scroll within their
  containers on narrow screens, and knowledge selection exposes the existing batch sharing preview.

- The console shares a three-column shell and responsive navigation across all areas, with a segmented theme control
  beside the account. Sign-in and setup pages use a centred panel with the same form components and a footer theme control.

- The console uses the shared Circle design tokens and local system fonts, with a persistent system/light/dark theme
  switch on signed-in and sign-in pages. Fixed scripts and styles remain allowed only by their content hashes.

- Personal sync now has scoped internal heads, stable item identities, atomic batch staging, frozen inventories and durable replay receipts.
  Staging and private device metadata count toward personal capacity; expired unreferenced objects can be collected safely.
  Native projection, verified commits and the HTTP API remain pending.

- Personal knowledge and memory payloads can be cleared by account and epoch while immutable digest capsules remain.
  A scoped upgrade preserves logical record identities; team copies survive and dependent legacy grounds become unverified.
  Restoring an older backup can restore cleared content, which the restore command now states. Sync HTTP handlers are still pending.

- Personal knowledge and memory sync now has an independent HTTP contract and shared client encoding fixtures.
  The contract preserves original evidence bytes and keeps MCP at six tools; HTTP handlers are not yet implemented.

- Memory refusal audits and unchanged-write receipts cannot be read as generic records or evidence. Owners see safe
  refusal summaries and administrators see counts; administrators retain visibility of grants in which they participate.

- Credential scanning checks Unicode compatibility forms, invisible characters, HTML entities, encoded text and split
  path segments without rewriting stored content. Memory revocation remains effective for disabled accounts, unchanged
  writes preserve versions, and administrator-disabled team memories cannot be bypassed through another share.
  The standalone capture skill mirrors the same scanner without runtime dependencies, rechecks pending historical
  captures, and recovers stale locks atomically so concurrent captures retain their upload/event chain.
  Already normalized Unicode text avoids whole-file replacement buffers; capture records and view continuations retain
  their exact scanner-version provenance while tree content remains unchanged.
  The client-script gate pins the stale-owner quarantine call to its reviewed function, preserving checks on every other
  filesystem rename.

- Memory space limits count enabled titles, paths and bodies and default to 20 enabled documents per space. Session
  lists and reads enforce the same limits, and upgrades preserve existing memory versions and historical usage.

- Knowledge and workflows share permission-filtered space navigation and narrow-screen scope tabs. Owners select
  verified knowledge for checked sharing; team rows show source and submitter. Workflow audiences follow actual
  assignments, and administrator member metadata exposes capacity and all-administrator grant counts only.

- Versioned memory stays separate from evidence and knowledge grants. The existing six tools support bounded reads,
  optimistic writes and checked team sharing; the console provides plain-text editing, independent grants and history.
  Re-sharing preserves administrator edits, and current session eligibility is rechecked on every continuation.

- Personal workflow and skill methods cannot use named documents, business-system reads, leases or external effects;
  retained publications and dynamic outputs pass the same start boundary. Accepted raw submissions recheck current
  ground access. Team knowledge verification uses team parsers, and withdrawal warnings hide unreadable ancestor
  identities behind counts. Sharing destinations are scanned without persisting credential-bearing paths in receipts.

- Own ordinary uploads bound as run inputs now declare that exact capture to the run's current readers, with visible
  provenance and no global read grant. Administrator imports likewise declare their own ordinary uploads. Source/root
  permission checks preserve exact-validator outcomes and bounded byte-read retries; absent and forbidden references
  remain indistinguishable. Personal-space originals and personal-credential sources keep independent authorization.

- Personal grant audit summaries are limited to participants, or all-administrator grants for administrator views; administrators see safe sharing receipts without private input content. Frozen source capture checks prevent an authorized equal-byte copy from lending another capture's private metadata, and standalone binding/reader components tolerate missing knowledge services.

- Sharing revisions now supersede only the submitter's own prior team entry from the same personal lineage, preserving withdrawal history. MCP and the console accept a team directory, default to the personal path, and show the target in merged/refused receipts while retaining the private origin.

- Second knowledge-space review: reject private input metadata before run creation, retain exactly one safe import-refusal audit after rollback, protect production rechecks, and serialize writes per space. Migration 11 counts current-version index references incrementally, isolates product quotas and adds configurable limits. Model 19 search warnings preserve usable matches without treating skipped scopes as a complete search; the four generic skills only update protocol mirrors and patch manifests.

- Verified personal knowledge can be submitted to the team through MCP or the console. Ordered checks resolve grounds,
  verify quotations, reject private-credential/unsigned-upload sources, deduplicate team content and scan credentials.
  Merges preserve the original and record submitter/source; owners see safe merged/rejected receipts and can withdraw
  their team submissions. Dependent entries/results show current withdrawal qualifiers without rewriting history.
- Members can publish personal workflows and generic skills using the existing validators and sandbox. Owner-managed
  use grants include specific members or all administrators; administrators have no default access. Pack ids, immutable
  files and frozen skill closures keep their personal namespace. Team promotion requires the existing publish right;
  new team runs follow assignments, while old personal results keep their audience. Result admission/read checks every
  actual reader's underlying grounds and rechecks grants on cached retries. Console sign-in remains password-only.


- Knowledge-space security review: preserve independent source captures, restrict run quotation lookup to declared inputs, hide personal audit history and citation counts from grantees, inspect shared-path imports, and register team directories as Hub actions. A temporary registered refusal prevents personal grounds from entering shared results until decision 131 phase 3.
- Search migration 10 stores one bounded token document per immutable entry record and lightweight version references. Reads bypass write queues, and imports check the complete next snapshot before saving original bytes. Model 18 and four protocol-only skill patch releases accompany these changes.

- **Console knowledge spaces** — personal/team/shared columns, owner entry and private-file forms, directory grants, current verification state, history-selected diffs and four-scope search. Team administrators import team knowledge and adjust personal quotas; password sessions, CSRF and current path authorization guard every operation.
- **Hub knowledge spaces** — decision 133 implements decision 131 phase 2 with model 17: personal/team CAS trees, immutable history, verified or unverified entries, directory grants/revocations, private originals and administrator-adjustable 1 GiB personal capacity. Existing product trees mount into team knowledge without data migration or hash changes.
- **Scoped knowledge reads** — the existing six tools add caller-authored personal entries, private imports and GIN bigram search outside runs. Runs freeze the initiator/team snapshots; old references recheck current grants and personal citation counts remain separate from team counts. Skill protocol mirrors/manifests advance html-format/mindmap-format to 1.0.4 and xml-format/workbook-format to 1.0.5 without parser changes.

- **Workflow terminology** — decision 132 starts the owner-approved UI rename in model 16: workflows, generic skills, product knowledge sources and business-system integrations retain their existing codes. The display-only publication-state axis preserves existing records and permissions; generated protocol mirrors and release manifests advance html-format/mindmap-format to 1.0.3 and xml-format/workbook-format to 1.0.4, with no parser changes.
- **Workflow browsing** — the existing `/console/packs` links now open separate workflow and generic-skill columns; workflow acceptance requirements appear near the top of each detail page without a stage graph.
- **Source catalog locations** — product knowledge sources appear under knowledge and business-system integrations under connections, with matching detail breadcrumbs and existing visibility rules.
- **Publication context and wording** — task filters, team assignments, records, search, CLI and answer text use workflow display terms. The shared publication operation shows the kind and return location of each entry point while retaining the uploaded manifest and existing commands.
- **Password-reset login recovery** — a successful reset through the console's command bridge clears the target account's login lock immediately; failed resets and other accounts retain their counters.
- **Workflow navigation design** — the navigation guide and decision 132 document the implemented names, source locations and publication entry points, while the approved personal/team knowledge and workflow design remains the basis for later stages.

- **Same-version bundle upgrades** — the installer stages each commit separately, deploys with its fixed Node path and updates the compatibility runtime link only after success; previous runtimes remain available for recovery.

- **Knowledge decision 131** — records the owner’s personal/team knowledge and workflow naming decisions; the earlier local-only proposal is retained as superseded research, with implementation and renaming deferred. The future 工作流 page distinguishes 通用技能 (no acceptance) and 工作流 (existing packs with acceptance); product/system placement remains open.

- **Resumable administrator initialization** — the installer checks database accounts after deployment migrations, retries an incomplete first-admin setup and gives explicit host recovery commands without a terminal.

- **Password recovery command** — `user password-reset` recovers initial passwords, terminates console sessions and powers Team resets through the command bridge.

- **Password change keeps the session** — after a successful password change the console continues in a fresh session bound to the new password revision instead of asking for a second sign-in; other console sessions of the account still end. The change form names the account in a hidden `autocomplete="username"` field so browsers file the new password under it.
- **Password-only console sign-in** — every account, administrators included, signs in to the console with username and password; tokens only connect Circle, the administrator backup token sign-in is removed, one-time links from Circle lead to the password form and the setup page no longer opens a session.

- **Password wording** — Chinese console, installer, CLI and credential messages consistently use “密码” under the owner’s second-round correction.

- **Installer workflow login check** — the fresh-runner install uses synthetic credentials on stdin and checks the username/password page, as approved in decision 130's second round.

- **Account status vocabulary** — decision 130's second round gives account states generated labels in model 15, distinct from occupied runtime environments.

- **Console hover guidance** — decision 130 applies heading hints to the remaining detail, management and authorization pages while retaining facts and commands.

- **Username and password login** — decision 130 adds administrator/member password accounts, first-use changes, Team password resets, bounded browser sessions and stdin-only installer initialization. MCP authorization remains account-bound.

- **Knowledge integration research** — decision 130 inventories requirements and compares personal/team designs; decision 131 supersedes its proposed boundaries, with implementation outside this task.

- **Circle device lists** — decision 130 shows device names and disconnect actions without token identifiers in tables.

- **Team page** — decision 130 adds the eighth navigation entry and moves member and permission management out of Settings.

- **Console scope** — decision 130 reserves separate future pages for schedules and bots without adding placeholders.

- **Knowledge flow** — decision 130 groups the diagram into personal and team columns with a shared submission boundary.

- **Knowledge browsing** — decision 130 gives role-specific empty states and per-product version selectors for comparison.

- **Knowledge intake pending items** — decision 130 moves the pending queue to knowledge and hides it when empty.

- **Console requests** — decision 130 combines waiting and overdue requests, showing member names and generated status labels without record digests.

- **Console walkthrough task lists** (owner decision 130). Empty unfiltered task lists show their empty state without filters or zero counters; active filters remain available to clear, and ordering explanations use a hover hint.
- **circle-hub's own mark** (owner decision 129). The console no longer shows Circle's ring: its mark is the Hub at the centre with the Circles on an orbit around it, in Circle's four colours, drawn inline on every page, and the browser shows it as the console's icon (`GET /console/favicon.svg`; the pages' `img-src` is now `'self'`).
- **Targeted connection-login reset** (owner decision 128). Administrators can clear the failure record for the credentials typed in a blocked connection attempt, through its form or `POST /console/api/systems/test/forget`. It removes only that stop from the vault and the running process, retains concurrent newer failures and other credentials, and never sends a login or retries automatically. No CLI command is added.
- **Runtime environment response times** (owner decision 128). Each environment shows its observed calls in the last 24 hours, with median and slowest send-to-receive time, from the existing dispatch journal. The bounded scan discloses partial counts, duplicate transport/read records count once, and new timed exchanges send a coalesced administrator-only `environment.status` event.
- **Connection trial actions** (owner decision 128). Each completed connection attempt appends an observed `trial-report@1` action, with the new B05 action kind `trial` (尝试读取): administrator, times, pack/version, environment, login and route outcomes, never addresses, credential contents or source text. Administrators can inspect them on the records page. Audit-write failures are logged without changing the report or repeating a source request.
- **MCP standard authorization** (owner decision 125). The Hub is the authorization server of its own `/mcp` (OAuth 2.1 with PKCE S256; RFC 8414, 7591, 8707, 9728, 7009, 9207): an unauthenticated `/mcp` answer names the resource metadata, clients register themselves (public clients only; https, loopback http or private-use redirect URIs; at most 100 registrations in 10 minutes), the browser approves on the console's authorization page with an invitation code or the console session (no password), and the token endpoint exchanges a one-time code (2 minutes, bound to the client, redirect URI, resource and PKCE challenge) for an ordinary revocable Hub token labelled with the client's name. No refresh token: revoking the token disconnects the client. `POST /oauth/revoke` revokes by value. Migration 7 adds the registered clients, the invitations and the client of each token.
- **Invitation codes.** `circle-hub user invite <user>` and the console's 添加成员 issue a twelve-character code, shown once, kept as its SHA-256, valid 24 hours and used once. 添加成员 can still issue a token for a client without the standard authorization.
- **One-time login links.** A client asks with its token (`POST /console/api/login-links`) for a link that opens a console session on that token within 5 minutes, once, after the browser confirms which account it signs in. A page opened without a session leads back to itself after signing in.
- **Two-step pack publication.** `circle-hub pack publish <dir> [--stage] --dry-run` runs every check of publish and writes nothing; the console checks an uploaded zip that way, keeps it as a stage for 30 minutes with the difference from the current version, and publishes it in a second step.
- **Search, citations, the connection test, read counts and environment states in the console** (owner decision 126). `GET /console/api/search` and the sidebar's 搜索 find tasks, packs, knowledge, records and members within what the reader may see, in bounded scans that say when they stopped. A knowledge node shows its entries' provenance and how many accepted submissions cited it in the last 30 days (counted from when submissions started to be indexed by the knowledge they cite). 测试连接 tries a system pack read-only with typed settings and saves nothing; each business system shows its reads of the last 24 hours with their times. Each runtime environment shows whether it is available, in use, frozen or deactivated, from the dispatch records, or unknown, with the new vocabulary axis `environment_state`. The Hub's state shows the newest backup and the database size.
- **Exact citation counts, read events and a connection test that remembers failed logins** (owner decision 127). The runs engine's maintenance indexes, in the background, the citations of submissions accepted before citations were indexed (`backfillCitations`, through the new `RecordStore.addIndex`; resumable, records unchanged); once a pass reaches its end, the console's 30-day counts are exact. A read of a business system that ends sends `system.status` for that system. The connection test keeps the digests of failed logins in the vault entry `login-stop.trial`, so the same values are not sent again after a restart either; a record that cannot be read refuses the login.
- **Live updates of the console.** `GET /console/api/stream` sends server-sent events (`task.updated`, `request.updated`, `pack.published`, `knowledge.published`, `system.added`, `system.status` and `environment.status` for configuration changes, `member.connected`, `import.progress`) with ids only, to accounts that may see the object; one inline module script, allowed by its hash, refreshes the marked modules of the signed-in pages, says 连接中断 when the stream breaks and polls every 15 seconds until it is back. The pages keep working with scripts off; automatic refreshes do not extend a session.
- **Write interfaces of the console**: `POST /console/api/members`, `/systems`, `/knowledge/imports`, `/packs/stage` and `/packs/stage/<id>/publish|discard` run the commands of the forms for an administrator's session with the CSRF token in `X-CSRF-Token`; `/console/api/commands` answers the command of any other operation and runs nothing.
- **The console follows the design canvas** (owner decision 124). Seven places (overview, tasks, knowledge, packs, connections, records, settings) in a side navigation; every task shows its execution process (the run's calls, the Hub's checks, the requests and dispatch jobs) above the run's full record; every value under its interface term, a new `ui` field of the vocabulary (`uiLabelOf`), with the derived `task_result` added to the vocabulary and each tool's Chinese name in its definition (`label`, never published to models). The console runs four operations (adding a member, connecting a business system, publishing a task pack, importing knowledge); every other one shows its `circle-hub` command for the administrator's Circle. Still server-rendered, with no script and one stylesheet allowed by its hash. A read-only JSON interface under `/console/api` answers what the pages show, with the same session and visibility.
- **One-click install on macOS and Linux** (owner decision 123). `install.sh` downloads the release bundle for the machine, checks its SHA-256, and sets the Hub up with its own commands (init with HTTPS, key, certificates, `deploy --bundle`, service, setup code). Bundles (`tools/build-bundle.ts`) carry Node 24, the dependencies and PostgreSQL per platform; `deploy --bundle` deploys one without npm ci after checking its tree digest, platform and symlinks. The PostgreSQL 18 client every deploy backs up with comes from Homebrew's libpq on macOS and `postgresql-client-18` on Linux, or from the directory `CIRCLE_HUB_LIBPQ_BIN` names. `.github/workflows/release.yml` installs a fresh bundle on Ubuntu for every change to the installer and drafts a release with all four bundles on a version tag.
- **Management in the web console** (owner decision 122). Administrators create and disable users, issue and revoke tokens (shown once), upload a pack as a zip and publish, assign, retire, activate and deactivate packs, grant publish rights, add, enable, disable and reset resources, set and withdraw secrets, and run knowledge sync as a background job, all from `/console/admin`. Each action runs the matching `circle-hub` command in the server process as the signed-in administrator (same checks, records and messages); backup, restore, deploy and rollback stay on the command line. The first administrator is created at `/console/setup` with a one-time code from the new `circle-hub setup-code`.
- **Built-in HTTPS** (owner decision 121). `circle-hub init --https-port <p> [--https-host <ip>]` pins an HTTPS listener in the deployment settings; `circle-hub tls init|issue|status` keeps a private certificate authority and the server certificate it signs in `<data root>/tls` (EC P-256, made with node:crypto; never backed up). `serve` opens the HTTPS listener beside the HTTP one, with its own Host authorities and `Secure` console cookies. A TLS proxy and the built-in HTTPS are exclusive.
- The generic model (`contracts/model.json`, version 5), the error-code registry (`contracts/codes.json`) and the contracts generated from them in `contracts/generated`: vocabulary, protocol codes, JSON Schemas and the six MCP tools. `npm run gen:contracts` regenerates them, `npm run verify:contracts` checks them, and `tools/show-element.ts` prints model elements.
- The milestone 1 architecture brief, human brief and progress record under `docs/`. The earlier briefs, progress records and handoffs are marked historical and the old design pages superseded; none was deleted.

### Changed

- The `Hub checks` workflow now runs type checking, the contracts check, unit tests, acceptance on a temporary PostgreSQL, the reference archive check and the docs checks (`.github/checks`) on Ubuntu. Each test job lists its counts and every skipped test in the job summary and fails when no test ran, so the acceptance job fails until the acceptance suite exists. Tests that need macOS or libpq (the pack sandbox's network denial, the keychain, the launchd check, backup, restore and deploy) skip there, so CI is no evidence for those paths.
- The unit jobs of `Hub checks` install the PostgreSQL 18 client, so the backup, restore and deploy tests run on Ubuntu. A new `macOS-only paths` workflow runs the tests that need sandbox-exec, the keychain, plutil or launchd on `macos-15` on every push to `main`, nightly and on demand, but not on pull requests. The docs checks refuse a test that calls a pack function in the sandbox without a skip guard.
- The tests of the pack sandbox run on every pull request: the `Linux isolation` jobs of `Hub checks` install bubblewrap and AppArmor, load the Hub's AppArmor policy for the job's Node, fail when the isolation does not work and run the unit and acceptance files that guard on the sandbox. `tools/run-macos-tests.ts` is now `tools/run-guarded-tests.ts`, which selects the macOS and the Linux files from the same skip guards.
- The unit, acceptance and Linux isolation jobs of `Hub checks` list their slowest test files in the job summary and keep Node's junit report for 14 days, so a file that holds up its shard shows, and the measured durations that balance the shards can be checked against a run. The test runners write that report when `JUNIT_REPORT` names a file.

### Fixed

- Sharing audit and team provenance views mask cleared personal folder paths while retaining team copies and safe receipt facts.

- Personal payload guards reject cleared-epoch inserts and unrelated upload bindings; completion journals are owner-managed.

- Personal-content upgrades preserve independently owned definitions, pack files and workflow objects; private imports have distinct capture identities. Mere mentions no longer retain cleared originals.

- Personal-content upgrades now resume correctly when historical team trees mount product knowledge.

- Console workflow cards distinguish received grants from personal ownership and show team member assignments.
  Sharing receipts display statements and team links. Knowledge/memory navigation, state chips, sizes, times,
  directory actions and grant forms follow decision 135; narrow tables scroll without splitting states or times.

- **A document too large for its skill parser is answered with what to do about it.** When a parse runs out of the sandbox's memory or output limit, the answer now says so and asks for the original to be split, or the parser to need less, as a document over the cache budget already did. It used to ask the administrator to check the skill pack and the sandbox, and a reread failed in the same way.
- **A skill parse is no longer cut off after 5 s.** Each parse and locate call of a skill parser now has 30 s in the pack sandbox, so a document that parses on one machine is not refused on a slower one; a 2 MB document had taken up to 4.2 s on a busy macOS runner. Memory, not time, is what stops a large document: measured on CI runners and a development Mac, documents of 2 to 8.5 MB, depending on their shape, reach the sandbox's memory limit, so the declared 16 MiB is not reached for those shapes (`hub/refs/README.md`, Skill parser limits).
- **Several hooks recovering a dead session lock at once no longer drop a capture.** operation-capture moves a dead owner's file aside before it removes the lock, and that quarantined file reads as a dead owner to the other waiters too, so one of them can move it aside again. In knowledge-contribution 1.3.1 and earlier, the first waiter then failed to remove its own quarantine (ENOENT), or met a lock file that was being removed (no links left) and took it for an invalid owner. Either way the hook returned silently with only an `errors.jsonl` entry, and that tool output was neither recorded nor uploaded. In 1.3.2 the waiter looks again instead. Mutual exclusion was never affected.
- **defect-to-case compares a case whose command takes an IPv6 address or a prefix length by its declared structure.** The product's command-tree producer publishes a union-typed argument (IPADDR is IPv4 or IPv6) as several catalog signatures under one signature reference. defect-to-case 1.6.20 checked a command identity against the first of them only, so an argument of any later alternative (an IPv6 address, or a prefix length where the mask comes first) never matched: a draft with one stayed unknown in the duplicate check, and an indexed case with one was counted as lacking its author's structure declaration, which left every other draft checked against that index unknown unless it duplicated another case. defect-to-case 1.6.21 accepts an identity that is complete under one of those signatures. They have to agree on everything but each argument's typed alternative; where they disagree, the identity stays unresolved instead of following the first.
- **A configuration command with an address argument no longer leaves a case-compile plan pending.** The product's command-tree producer publishes a union-typed argument (IPADDR is IPv4 or IPv6) as several catalog signatures under one signature reference. When the product declared inverse enum pairs, case-compile 3.8.5 read any such command as an ambiguous enum inverse, even with no enum in it, so its plan checks stayed pending with "声明的枚举互逆不能在同一签名中得到唯一完整身份". case-compile 3.8.6 reads a declared pair position by position across those signatures: a position where none of them declares an enum holding the pair is no alternative, and the declared prefix inverse applies as before. Signatures that disagree on such an enum still stay unknown.
- **The start-up sweep finds orphaned sandbox processes when the Hub lives under a path outside ASCII on macOS.** The sweep ran `ps` with an empty environment; in that C locale `ps` prints every byte outside ASCII in `vis` notation (a folder named `开发` as `M-eM-<M^@M-eM^OM^Q`), so the bootstrap path never matched and sandbox processes an earlier Hub process left behind kept running. `ps` still gets a fixed environment, now holding only `LC_CTYPE=UTF-8`. Linux reads the argv from `/proc` and was not affected.
- **Pack extraction works on macOS 15.** A pack's read-only tree is built under a temporary name and renamed into place; macOS 15 refuses to rename a read-only directory (macOS 26 and Linux allow it), so every pack function failed there with `EACCES`. When that rename is refused and no tree is in place yet, the directory is made writable for the move and read-only again at its new name.

## 0.2.0 - 2026-10-15

### Removed

- Retired the built-in `famx-case-execute` capability and the `cases.verify`, `cases.execute` and `cases.observe` worker path. New execution uses independently approved modules through `module-execute`; old native tasks are never rebound to a new implementation.

### Changed

- Preserved migration 20 unchanged and added migration 44 to make legacy gateway receipts read-only, including insert, update, delete and truncate. Historical task inputs, results and artifact references remain readable.
- The compatible mindmap compiler is version 1.1.0 and writes `circle-hub` as its workbook creator. Hub configuration no longer injects the retired native gateway lookup; deprecated input fallback remains documented.

## 0.1.0 - 2026-10-15

### Changed

- **Licensed under the Apache License 2.0**, as Circle is. `LICENSE` carries the canonical text, `NOTICE` names the copyright holder, records that the repository was under the MIT License until 2026-10-13 and reserves the Circle and Circle Hub marks, and the design specifications in `docs/design` are under CC BY 4.0. `CONTRIBUTING.md` has Circle's contributor terms (a sign-off on every commit and a license to the project); `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, the issue and pull request templates and `.gitattributes` follow Circle's, in English. The documentation is published at <https://circle-platforms.github.io/circle-hub/> with the same site setup as Circle's.
- **Renamed to circle-hub.** The repository and the project are now circle-hub, the team hub for Circle. Hub executables use `circle-hub` and configuration uses `CIRCLE_HUB_*`; former `CIRCLE_SERVER_*` keys are deprecated fallbacks only when the corresponding new key is absent. Circle 1.7.0 uses the `hub` extension, `/hub`, `hub_*` and `hub_tool_*` with only `CIRCLE_HUB_*` per-run injection and no old-name aliases; the confirmed RPC commit is `fd8524a`.
- **Public repository.** The hub is public with secret scanning, push protection, Dependabot alerts and private vulnerability reporting enabled. Packs moved to their own public repository, [circle-packs](https://github.com/circle-platforms/circle-packs).
- **Design written down.** The object standard, the vocabulary and state enumerations, the five levels and their elements, approvals on change sets with a run-time enforcement chain, roles per scope, the Circle integration and the product-line pack exemplar are in [docs/design](docs/design/README.md).

- `packages/harness-adapters`: a pure library that imports Claude Code, Codex CLI, OpenCode, Gemini CLI and Cursor primitives (skills, commands, agents, instructions, hooks, MCP servers) into the neutral `hub-*/1` manifests and exports them back — bytes stay outside the manifests, configuration shapes keep key names only, secrets are stripped by structure, and exports take the original file table; brief and open decisions in `docs/harness-adapters-brief.md`.
### Added (phase 2, branch server-s2)

- Governed generic execution flows with pinned module tools, controlled source bytes, verified provider receipts, leases and unknown-outcome reconciliation; product-specific flow logic lives in packs. Observation windows honor both item and full-frame byte budgets, archive evicted observations for controlled reads and disclose bounded failure causes. The native execution path remains available in this release.

- Assets with lifecycle, a write-only credential vault and approvals bound to an input revision, a target identity and an action digest; a reviewer can close a request superseded by a newer version.
- Read-only connectors for WebDAV documents, build sites, a ticket-system mirror and an environment view; a per-identity tool catalog with ETags; per-source concurrency and spacing limits.
- Knowledge records (sources, evidence, entities, claims, assessments, snapshots) with asynchronous ingestion and incremental publishing.
- Uploaded source artifacts with roles and declared metadata; once approved, a stable source id binds every command tool, with receipts carrying the bound build identity.
- Skill packs pushed with their trial record, checked against declared tools, approved by another person, run by a headless Circle over a private RPC; scheduled and event-driven bots.
- Service clients with rotation and revocation, `/token`, RFC 7662 `/v1/introspect`, short-lived operation tokens for workers; native HTTPS; rule distribution by SHA.
- Execution against an MCP gateway: the hub re-verifies every device command of a workbook against the bound source before dispatch, keeps per-case originals and reconciles unknown outcomes.
- Module installation from a packs repository manifest; the server's own copy of the compile skill removed.
- Admin CLI for tasks, approvals and audit; graceful restart; paged work lists.

### Added (phase 1, branch server-s1)

- Authenticated HTTP API, PostgreSQL durable tasks with events and cursor replay, an independent worker, the first TypeScript capability pack, admin commands and the synthetic acceptance suite.

### Foundation

- Repository created from Circle's public TypeScript baseline with the preceding platform archived under `references/` and verified by SHA; MIT license confirmed for the project's own content.
