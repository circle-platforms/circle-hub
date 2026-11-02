# Changelog

All notable changes to circle-hub are listed here, newest first. Repository releases start at 0.1.0. Changes after the latest release are listed under Unreleased.

## Unreleased

The Hub is being rebuilt as a standard MCP server; see [docs/hub-r4-brief.md](docs/hub-r4-brief.md). Nothing below has been released.

### Removed

- The archive of the platform that preceded the hub (`references/platform`) is no longer part of this repository. `references/source-manifest.json` and `npm run verify:references` now cover only the frozen Circle baseline in `foundation/circle` (287 files). The skill and product-line packs of the retired server moved to a private repository.
- **Breaking: the task-and-approval server is retired.** The `/v1` HTTP API, the supervisor, the worker, the admin CLI, the development stack, the connectors, the harness adapters, the packs and their tests were removed ahead of the redesign. Nothing in the redesign reads their routes, migrations, database or configuration, so a 0.2.0 deployment cannot be upgraded in place, and the hub extension in released Circle versions, which calls the `/v1` API, does not work with the redesigned Hub. The removed code stays readable in Git (the v0.2.0 tag and commit ca66002). The history of the earlier temporary deployment is recorded as lost and is not migrated.
- **Breaking: the `CIRCLE_SERVER_*` configuration fallback is gone; circle-server is no longer supported anywhere.** circle-hub reads only `CIRCLE_HUB_*`. From 2026-10-16 the retired server and its scripts refused to start while any `CIRCLE_SERVER_*` variable was set, even an empty one or one beside its `CIRCLE_HUB_*` replacement, and named each variable and its replacement without printing a value; the redesigned Hub keeps this rule (planned). The `hub.environment.deprecated` notice is gone with the fallback.

### Added

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


- Knowledge-space security review: preserve independent source captures, restrict run quotation lookup to declared inputs, hide personal audit history and citation counts from grantees, inspect shared-path imports, and register team directories as Hub actions. A temporary registered refusal prevents personal grounds from entering shared results until decision 84 phase 3.
- Search migration 10 stores one bounded token document per immutable entry record and lightweight version references. Reads bypass write queues, and imports check the complete next snapshot before saving original bytes. Model 18 and four protocol-only skill patch releases accompany these changes.

- **Console knowledge spaces** — personal/team/shared columns, owner entry and private-file forms, directory grants, current verification state, history-selected diffs and four-scope search. Team administrators import team knowledge and adjust personal quotas; password sessions, CSRF and current path authorization guard every operation.
- **Hub knowledge spaces** — decision 86 implements decision 84 phase 2 with model 17: personal/team CAS trees, immutable history, verified or unverified entries, directory grants/revocations, private originals and administrator-adjustable 1 GiB personal capacity. Existing product trees mount into team knowledge without data migration or hash changes.
- **Scoped knowledge reads** — the existing six tools add caller-authored personal entries, private imports and GIN bigram search outside runs. Runs freeze the initiator/team snapshots; old references recheck current grants and personal citation counts remain separate from team counts. Skill protocol mirrors/manifests advance html-format/mindmap-format to 1.0.4 and xml-format/workbook-format to 1.0.5 without parser changes.

- **Workflow terminology** — decision 85 starts the owner-approved UI rename in model 16: workflows, generic skills, product knowledge sources and business-system integrations retain their existing codes. The display-only publication-state axis preserves existing records and permissions; generated protocol mirrors and release manifests advance html-format/mindmap-format to 1.0.3 and xml-format/workbook-format to 1.0.4, with no parser changes.
- **Workflow browsing** — the existing `/console/packs` links now open separate workflow and generic-skill columns; workflow acceptance requirements appear near the top of each detail page without a stage graph.
- **Source catalog locations** — product knowledge sources appear under knowledge and business-system integrations under connections, with matching detail breadcrumbs and existing visibility rules.
- **Publication context and wording** — task filters, team assignments, records, search, CLI and answer text use workflow display terms. The shared publication operation shows the kind and return location of each entry point while retaining the uploaded manifest and existing commands.
- **Password-reset login recovery** — a successful reset through the console's command bridge clears the target account's login lock immediately; failed resets and other accounts retain their counters.
- **Workflow navigation design** — the navigation guide and decision 85 document the implemented names, source locations and publication entry points, while the approved personal/team knowledge and workflow design remains the basis for later stages.

- **Same-version bundle upgrades** — the installer stages each commit separately, deploys with its fixed Node path and updates the compatibility runtime link only after success; previous runtimes remain available for recovery.

- **Knowledge decision 84** — records the owner’s personal/team knowledge and workflow naming decisions; the earlier local-only proposal is retained as superseded research, with implementation and renaming deferred. The future 工作流 page distinguishes 通用技能 (no acceptance) and 工作流 (existing packs with acceptance); product/system placement remains open.

- **Resumable administrator initialization** — the installer checks database accounts after deployment migrations, retries an incomplete first-admin setup and gives explicit host recovery commands without a terminal.

- **Password recovery command** — `user password-reset` recovers initial passwords, terminates console sessions and powers Team resets through the command bridge.

- **Password-only console sign-in** — every account, administrators included, signs in to the console with username and password; tokens only connect Circle, the administrator backup token sign-in is removed, one-time links from Circle lead to the password form and the setup page no longer opens a session.

- **Password wording** — Chinese console, installer, CLI and credential messages consistently use “密码” under the owner’s second-round correction.

- **Installer workflow login check** — the fresh-runner install uses synthetic credentials on stdin and checks the username/password page, as approved in decision 83's second round.

- **Account status vocabulary** — decision 83's second round gives account states generated labels in model 15, distinct from occupied runtime environments.

- **Console hover guidance** — decision 83 applies heading hints to the remaining detail, management and authorization pages while retaining facts and commands.

- **Username and password login** — decision 83 adds administrator/member password accounts, first-use changes, Team password resets, bounded browser sessions and stdin-only installer initialization. MCP authorization remains account-bound.

- **Knowledge integration research** — decision 83 inventories requirements and compares personal/team designs; decision 84 supersedes its proposed boundaries, with implementation outside this task.

- **Circle device lists** — decision 83 shows device names and disconnect actions without token identifiers in tables.

- **Team page** — decision 83 adds the eighth navigation entry and moves member and permission management out of Settings.

- **Console scope** — decision 83 reserves separate future pages for schedules and bots without adding placeholders.

- **Knowledge flow** — decision 83 groups the diagram into personal and team columns with a shared submission boundary.

- **Knowledge browsing** — decision 83 gives role-specific empty states and per-product version selectors for comparison.

- **Knowledge intake pending items** — decision 83 moves the pending queue to knowledge and hides it when empty.

- **Console requests** — decision 83 combines waiting and overdue requests, showing member names and generated status labels without record digests.

- **Console walkthrough task lists** (owner decision 83). Empty unfiltered task lists show their empty state without filters or zero counters; active filters remain available to clear, and ordering explanations use a hover hint.
- **circle-hub's own mark** (owner decision 82). The console no longer shows Circle's ring: its mark is the Hub at the centre with the Circles on an orbit around it, in Circle's four colours, drawn inline on every page, and the browser shows it as the console's icon (`GET /console/favicon.svg`; the pages' `img-src` is now `'self'`).
- **Targeted connection-login reset** (owner decision 81). Administrators can clear the failure record for the credentials typed in a blocked connection attempt, through its form or `POST /console/api/systems/test/forget`. It removes only that stop from the vault and the running process, retains concurrent newer failures and other credentials, and never sends a login or retries automatically. No CLI command is added.
- **Runtime environment response times** (owner decision 81). Each environment shows its observed calls in the last 24 hours, with median and slowest send-to-receive time, from the existing dispatch journal. The bounded scan discloses partial counts, duplicate transport/read records count once, and new timed exchanges send a coalesced administrator-only `environment.status` event.
- **Connection trial actions** (owner decision 81). Each completed connection attempt appends an observed `trial-report@1` action, with the new B05 action kind `trial` (尝试读取): administrator, times, pack/version, environment, login and route outcomes, never addresses, credential contents or source text. Administrators can inspect them on the records page. Audit-write failures are logged without changing the report or repeating a source request.
- **MCP standard authorization** (owner decision 78). The Hub is the authorization server of its own `/mcp` (OAuth 2.1 with PKCE S256; RFC 8414, 7591, 8707, 9728, 7009, 9207): an unauthenticated `/mcp` answer names the resource metadata, clients register themselves (public clients only; https, loopback http or private-use redirect URIs; at most 100 registrations in 10 minutes), the browser approves on the console's authorization page with an invitation code or the console session (no password), and the token endpoint exchanges a one-time code (2 minutes, bound to the client, redirect URI, resource and PKCE challenge) for an ordinary revocable Hub token labelled with the client's name. No refresh token: revoking the token disconnects the client. `POST /oauth/revoke` revokes by value. Migration 7 adds the registered clients, the invitations and the client of each token.
- **Invitation codes.** `circle-hub user invite <user>` and the console's 添加成员 issue a twelve-character code, shown once, kept as its SHA-256, valid 24 hours and used once. 添加成员 can still issue a token for a client without the standard authorization.
- **One-time login links.** A client asks with its token (`POST /console/api/login-links`) for a link that opens a console session on that token within 5 minutes, once, after the browser confirms which account it signs in. A page opened without a session leads back to itself after signing in.
- **Two-step pack publication.** `circle-hub pack publish <dir> [--stage] --dry-run` runs every check of publish and writes nothing; the console checks an uploaded zip that way, keeps it as a stage for 30 minutes with the difference from the current version, and publishes it in a second step.
- **Search, citations, the connection test, read counts and environment states in the console** (owner decision 79). `GET /console/api/search` and the sidebar's 搜索 find tasks, packs, knowledge, records and members within what the reader may see, in bounded scans that say when they stopped. A knowledge node shows its entries' provenance and how many accepted submissions cited it in the last 30 days (counted from when submissions started to be indexed by the knowledge they cite). 测试连接 tries a system pack read-only with typed settings and saves nothing; each business system shows its reads of the last 24 hours with their times. Each runtime environment shows whether it is available, in use, frozen or deactivated, from the dispatch records, or unknown, with the new vocabulary axis `environment_state`. The Hub's state shows the newest backup and the database size.
- **Exact citation counts, read events and a connection test that remembers failed logins** (owner decision 80). The runs engine's maintenance indexes, in the background, the citations of submissions accepted before citations were indexed (`backfillCitations`, through the new `RecordStore.addIndex`; resumable, records unchanged); once a pass reaches its end, the console's 30-day counts are exact. A read of a business system that ends sends `system.status` for that system. The connection test keeps the digests of failed logins in the vault entry `login-stop.trial`, so the same values are not sent again after a restart either; a record that cannot be read refuses the login.
- **Live updates of the console.** `GET /console/api/stream` sends server-sent events (`task.updated`, `request.updated`, `pack.published`, `knowledge.published`, `system.added`, `system.status` and `environment.status` for configuration changes, `member.connected`, `import.progress`) with ids only, to accounts that may see the object; one inline module script, allowed by its hash, refreshes the marked modules of the signed-in pages, says 连接中断 when the stream breaks and polls every 15 seconds until it is back. The pages keep working with scripts off; automatic refreshes do not extend a session.
- **Write interfaces of the console**: `POST /console/api/members`, `/systems`, `/knowledge/imports`, `/packs/stage` and `/packs/stage/<id>/publish|discard` run the commands of the forms for an administrator's session with the CSRF token in `X-CSRF-Token`; `/console/api/commands` answers the command of any other operation and runs nothing.
- **The console follows the design canvas** (owner decision 77). Seven places (overview, tasks, knowledge, packs, connections, records, settings) in a side navigation; every task shows its execution process (the run's calls, the Hub's checks, the requests and dispatch jobs) above the run's full record; every value under its interface term, a new `ui` field of the vocabulary (`uiLabelOf`), with the derived `task_result` added to the vocabulary and each tool's Chinese name in its definition (`label`, never published to models). The console runs four operations (adding a member, connecting a business system, publishing a task pack, importing knowledge); every other one shows its `circle-hub` command for the administrator's Circle. Still server-rendered, with no script and one stylesheet allowed by its hash. A read-only JSON interface under `/console/api` answers what the pages show, with the same session and visibility.
- **One-click install on macOS and Linux** (owner decision 76). `install.sh` downloads the release bundle for the machine, checks its SHA-256, and sets the Hub up with its own commands (init with HTTPS, key, certificates, `deploy --bundle`, service, setup code). Bundles (`tools/build-bundle.ts`) carry Node 24, the dependencies and PostgreSQL per platform; `deploy --bundle` deploys one without npm ci after checking its tree digest, platform and symlinks. The PostgreSQL 18 client every deploy backs up with comes from Homebrew's libpq on macOS and `postgresql-client-18` on Linux, or from the directory `CIRCLE_HUB_LIBPQ_BIN` names. `.github/workflows/release.yml` installs a fresh bundle on Ubuntu for every change to the installer and drafts a release with all four bundles on a version tag.
- **Management in the web console** (owner decision 75). Administrators create and disable users, issue and revoke tokens (shown once), upload a pack as a zip and publish, assign, retire, activate and deactivate packs, grant publish rights, add, enable, disable and reset resources, set and withdraw secrets, and run knowledge sync as a background job, all from `/console/admin`. Each action runs the matching `circle-hub` command in the server process as the signed-in administrator (same checks, records and messages); backup, restore, deploy and rollback stay on the command line. The first administrator is created at `/console/setup` with a one-time code from the new `circle-hub setup-code`.
- **Built-in HTTPS** (owner decision 74). `circle-hub init --https-port <p> [--https-host <ip>]` pins an HTTPS listener in the deployment settings; `circle-hub tls init|issue|status` keeps a private certificate authority and the server certificate it signs in `<data root>/tls` (EC P-256, made with node:crypto; never backed up). `serve` opens the HTTPS listener beside the HTTP one, with its own Host authorities and `Secure` console cookies. A TLS proxy and the built-in HTTPS are exclusive.
- The generic model (`contracts/model.json`, version 5), the error-code registry (`contracts/codes.json`) and the contracts generated from them in `contracts/generated`: vocabulary, protocol codes, JSON Schemas and the six MCP tools. `npm run gen:contracts` regenerates them, `npm run verify:contracts` checks them, and `tools/show-element.ts` prints model elements.
- The milestone 1 architecture brief, human brief and progress record under `docs/`. The earlier briefs, progress records and handoffs are marked historical and the old design pages superseded; none was deleted.

### Changed

- The `Hub checks` workflow now runs type checking, the contracts check, unit tests, acceptance on a temporary PostgreSQL, the reference archive check and the docs checks (`.github/checks`) on Ubuntu. Each test job lists its counts and every skipped test in the job summary and fails when no test ran, so the acceptance job fails until the acceptance suite exists. Tests that need macOS or libpq (the pack sandbox's network denial, the keychain, the launchd check, backup, restore and deploy) skip there, so CI is no evidence for those paths.
- The unit jobs of `Hub checks` install the PostgreSQL 18 client, so the backup, restore and deploy tests run on Ubuntu. A new `macOS-only paths` workflow runs the tests that need sandbox-exec, the keychain, plutil or launchd on `macos-15` on every push to `main`, nightly and on demand, but not on pull requests. The docs checks refuse a test that calls a pack function in the sandbox without a skip guard.
- The tests of the pack sandbox run on every pull request: the `Linux isolation` jobs of `Hub checks` install bubblewrap and AppArmor, load the Hub's AppArmor policy for the job's Node, fail when the isolation does not work and run the unit and acceptance files that guard on the sandbox. `tools/run-macos-tests.ts` is now `tools/run-guarded-tests.ts`, which selects the macOS and the Linux files from the same skip guards.
- The unit, acceptance and Linux isolation jobs of `Hub checks` list their slowest test files in the job summary and keep Node's junit report for 14 days, so a file that holds up its shard shows, and the measured durations that balance the shards can be checked against a run. The test runners write that report when `JUNIT_REPORT` names a file.

### Fixed

- Personal-content upgrades preserve independently owned definitions, pack files and workflow objects; private imports have distinct capture identities. Mere mentions no longer retain cleared originals.

- Personal-content upgrades now resume correctly when historical team trees mount product knowledge.

- Console workflow cards distinguish received grants from personal ownership and show team member assignments.
  Sharing receipts display statements and team links. Knowledge/memory navigation, state chips, sizes, times,
  directory actions and grant forms follow decision 88; narrow tables scroll without splitting states or times.

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
