# hub/server

## Sharing and personal publication (decision 87)

The console has a share action on the owner's verified entry and `/console/knowledge/submissions` for the owner's merged
or rejected receipts, with generated status text, registered codes and safe reasons. Team entries disclose submitter,
time and original entry address. A submitter can withdraw their own team copy; administrators can withdraw any team
entry. Entry and result views derive current withdrawn-ground notices without changing historical record bodies.

Workflows and generic skills each separate personal and team listings. Personal detail URLs keep `/console/packs/<id>`
and add `?space=<owner>` so equal ids remain independent; catalogs, task titles, search and JSON views keep that namespace.
`/console/packs/-/publish` stages and checks a personal zip, then confirms publication within 30 minutes and rechecks it.
The reserved `-/` path does not hide an existing pack whose id is `publish`. `/console/packs/do/` actions manage the owner's
stage, grants, revocation, retirement and team promotion. They reuse password sessions, first-change restrictions,
same-origin, CSRF, multipart/size limits and owner-bound stages; no administrator command bridge is used for member writes.
Promotion still checks team publish rights. Hover explanations disclose server backups and current grant boundaries.

The six-tool MCP interface remains unchanged in count. `upload_file.share_entry` returns a safe receipt with team version
and address, or registered refusal code/reason; `withdraw_entry` appends withdrawal state. `start_run.pack_space` selects a
personal workflow, and `get_nodes` reads an authorized pack or declared file using `pack`, `pack_space` and optional `file`.
Pure generic skills expose their SKILL.md without inventing acceptance requirements. Actual result readers must have every
underlying ground read right. Binding an ordinary own upload declares it to that run's readers only; personal-space
originals and personal-credential sources keep their independent restrictions. Per-result state is rechecked for raw `rec:` reads,
and text/structured replies expose live withdrawal qualifiers. Username/password remains the only console sign-in for
all roles; bearer tokens only authenticate MCP/Circle connections. No Circle repository or synchronization code changes.

Personal workflow runs cannot unlock named documents, including retained runs with an old input declaration. Their
publication/start gates exclude business-system inputs, leases and external effects; administrators use the same
personal capability boundary. Team workflows retain assignment-based access.

## Console spaces (decision 86)

Decision 88 replaces the former columns with one space panel, shared with workflows: all, personal, shared with me,
then team. Empty received groups disappear. Directory trees use current read permissions, product titles and hierarchy
names; narrow screens use a row of scope tabs. Knowledge and memory retain their selected view and scope in links.
`/console/knowledge/space` browses a selected immutable root,
its paths, entry grounds/current state and history. Owners add entries, replace or withdraw them, import originals and
append/revoke read-only directory grants. Team administrators import from team-observed sources or declare their own
ordinary uploads, and may withdraw team entries. Product browsing remains under virtual product mounts with its original permissions.
`/console/knowledge/space-diff` selects two history roots, defaulting to previous/current; product versions are labeled
separately. Search has four generated knowledge scopes, and every result marks its visibility. Private originals at
`/console/knowledge/source` recheck path authorization; administrators have no implicit access.

Owner form actions under `/console/knowledge/do/` use the signed-in password session, own-origin and CSRF checks;
first-password-change restrictions apply before every route. Only administrators adjust capacity from Team, which
reveals the quota without opening the member's content. Forms and imports have byte limits; personal originals create
no drafted entries. Hover text states visibility, non-recoverable prior reads after revocation and inclusion in server
backups. Synchronization and signing remain later phases, without a seventh MCP tool.

## Space tools (decision 86)

The server still publishes six MCP tools. `upload_file` takes exactly one of `file_path` (base64 bytes), `personal_entry`, `share_entry` or `withdraw_entry`.
The latter carries caller-authored kind, statement, data, optional applicability/path, and reference/quotation grounds;
missing grounds remain unverified. `replaces`, `expected_version` and `reason` support append-only edits. Its receipt
returns the space root, content id, status and exact tree address. File imports with `space=personal` store a private
original only; the Hub drafts nothing. Ordinary run-file uploads retain their behavior. Personal writes have no blanket
idempotent annotation, because a stale version or duplicate entry may be refused.

`get_nodes` accepts `space=team` or a personal owner id and defaults standalone reads to the caller. `search` plus generated
`scope` (personal/team/shared/all) is standalone only, with bounded cursor pages. With `run`, search is refused by the
registered `SPACE_SEARCH_IN_RUN` code; address reads use the run's frozen roots and initiator permissions. `resolve_reference`
reads space tree addresses and admitted constituent sources as well as legacy product roots. Node and exact-entry text disclose verification status, grounds and quotations because clients consume the text answer. Current grants are checked
again when an old address is used, and a raw `rec:` space record cannot disclose an ungranted directory.


Decision 85, item 2: the 工作流 navigation entry retains `/console/packs` so existing links stay valid. The page separates
工作流 from 通用技能 using generated kind labels and title hover explanations. Workflow details show acceptance requirements
in a full-width section above checks and version controls; the old stage graph is removed. Publication states derive from
the existing catalog fields through the generated `pack_status` display axis.

Decision 85, item 3: knowledge lists 产品知识来源 and connections lists 业务系统接入, with details returning to the matching
place. These lists use the existing permission-filtered pack catalog. Product lines come only from the active declaration
for the displayed version; absent metadata stays unknown. System mappings show existing resource bindings and their actual
versions without calling business systems. Members retain their existing knowledge access; the move grants no catalog rights.

Decision 85, item 4: server-owned console, CLI and answer text use the new display terms. Publication still uses the same
upload/check/publish commands and authorization; `?kind=product` and `?kind=system` select the title and return location.
Staged results retain the uploaded manifest's actual kind for display, without rewriting it or changing API payloads.
Stored records, author-provided content and diagnostics supplied by other packages are shown without rewriting their text.

Decision 85, item 5: after a successful console-bridged `user password-reset`, the console clears only that account's
`account:<username>` login-attempt counter. A refused form or failed command clears nothing; other accounts and peer-based
backup-login limits retain their counters. The existing administrator checks, command bridge and first-change requirement apply.

Decision 83, second round item 5: `user list --json` emits public account fields only (no password material or tokens). The installer uses it after deployment migrations to distinguish existing administrators from incomplete initialization.

Decision 83, second round item 4: `circle-hub user password-reset <user>` uses the host operator’s administrator identity, generates a one-time initial password and requires its first-use change. It appends the existing password-change history and revokes console credentials; account-bound MCP tokens remain valid. This command also recovers the sole administrator before the initial password was changed. Team resets run that command through the management bridge at `POST /console/admin/do/password-reset`; the old direct page reset route is absent. Administrator backup failures have separate counters for each socket peer; username failures still share the account counter across sources.

Decision 83, second round item 3: Chinese account, login and credential instructions consistently use “密码”, including console forms, CLI output and errors. Legacy source words remain recognized by the credential scanner.

The MCP server, the console (read-only pages, and management for administrators: decision 75), the HTTP surface and the server CLI of the Hub. Model elements: D05 (uniform
response), D06 (the six tools), B08 (call log), R01 and R02 (roles, visibility); brief sections 3, 6 and 9. The server is
built against the ports of `hub/ports.ts` (RunsService, KnowledgePort, WorkflowStore, PackCatalogPort,
ResourceCatalogPort), the run engine's extras (`ServerDeps.runsDetail`) and the real phase 1 packages (records, refs,
rules, config, platform); the console uses the pure `itemCell` of `hub/runs/api.ts`. The assembly (`hub/server/assemble.ts`
and `hub/server/assemble/`, its own README) plugs in the real runs, knowledge and connectors packages and registers the
administrator commands of `cli-admin.ts`.

| File | Content |
| --- | --- |
| `api.ts` | `ServerDeps` (with `runsDetail`), `HubApp`, `AppOptions`, `AssembleFunction`, `CommandAssembleFunction`, `CommandIo`, `AssemblyModule`, `CliCommand`/`registerCommand`, `ServerCallContext`, `TextContext`; re-exports `createApp`, `main`, `serve` |
| `app.ts` | `createApp(deps, options)` → `{ handler, listen(), close(), release }`: the request target parsed once, routes, Host and Origin checks, `/healthz`, the body budget, graceful close |
| `mcp.ts` | `POST /mcp`: bearer token per request, bounded body, one JSON-RPC request per POST, one SDK `Server` + stateless JSON transport per request, call-log lines |
| `tools.ts` | the six tools: input parsing, server-owned semantics, delegation, output validation, isError, annotations per caller, the text context of each answer |
| `text.ts`, `budget.ts`, `claims.ts` | the Chinese content text within `TEXT_BUDGET` (30,000 characters), page cursors, the fallback text of an answer whose text cannot be laid out, claims in `DISPLAY_ORDER`, terminal symbols and kinds, item cells |
| `readers.ts` | the refs `SourceReader` on `Artifacts.source` and the `RecordReader` with R02 visibility |
| `notes.ts` | admin notes and operator log text that records accept (no NUL, no lone surrogate, cut between code points) |
| `upload.ts` | strict base64, media types (given, by name, sniffed), the parser structure summary |
| `trace.ts`, `http.ts`, `release.ts` | W3C traceparent, Circle-Session-Id, loopback rules, body limits and the body budget, release.json |
| `console/` | sign-in, sessions, CSRF, CSP and the eight places of the design canvas: overview, tasks (list, waterfall and the run's record), knowledge, workflows (with generic skills), connections, records, team, settings; the four operations and the command dialogs; `style.ts` the stylesheet, `ui.ts` the blocks, `status.ts` the task result |
| `main.ts` | `serve [--migrate-only] [--migrate]`, `loadServerConfig` (serve refuses the operator token, commands accept it) |
| `cli.ts` | `main(argv)`: user, token, logs, run, platform delegation, `registerCommand` |
| `assemble.ts`, `assemble/`, `cli-admin.ts`, `testing-real.ts` | the assembly module (`assemble` for serve, `assembleCommand` for one command, `registerCommands`), the administrator commands and `operatorAdmin`, the real Hub for acceptance tests: see `assemble/README.md` |
| `docs.ts` | named documents (C4 of the device-pack core): `doc put/list/show` and the `doc:doc:` external ids answered by the Hub's own reader for runs of packs that declare them; see the module's header |
| `errors.ts` | `AssemblyMissingError` (a placeholder module, or one without the part a command needs), `UsageError`, `CliError` |
| `fakes.ts`, `testing.ts` | in-memory fakes of the ports and of the engine's extras, `createTestServer()` / `fakeDeps()` for tests |

## The HTTP surface

For a disposable Linux VM with `ip` and permission to execute `sudo -n ip`, run
`SYNTHETIC_VM_NETWORK_TEST=1 node --test hub/server/linux-listen-vm.ts` to exercise a real internal listener without an external system. It refuses to run unless the hostname is `lima-synthetic-hub` and the flag is present. The explicit
VM-only test creates a uniquely named dummy interface with the documentation address `192.0.2.77/32`, confirms the route
is local, supplies fake authentication dependencies, checks Host/Origin and health/port behavior, and removes only its
own interface in cleanup. It prints the randomly chosen interface name so an operator can remove that exact interface if
SIGKILL or a VM crash prevents cleanup; never delete other interfaces. It refuses an already-used address and refuses to contact it unless its route is local. This
script is deliberately outside the ordinary unit-test glob because changing a VM network interface is a privileged test
operation. A successful run does not establish an actual server deployment or connectivity to an enterprise system.
Antigravity independently reviewed the implementation at commit `d33b18655161bfeaeeaa2369c05a78bbb34de151` and
reported PASS after a read-only source review and synthetic checks. This review is not evidence of a deployment to the
target server. In particular, the VM check injects fake principals and call logging; its successful MCP initialization
does not validate a real identity store, colleague's Circle, actual credentials or the target network.

The default is loopback `127.0.0.1`; a specific internal IP requires an explicit allowed-host list. Wildcard and public
listeners are refused. The port comes from `CIRCLE_HUB_PORT`. With `CIRCLE_HUB_HTTPS_PORT` (owner decision 74) the app
opens a second listener with the certificate of `<data dir>/tls` (`AppOptions.tls`, read by `serve` before anything
starts) and serves the same routes there. Each listener answers only to its own authorities: an HTTPS name sent over
plain HTTP, or the reverse, is a 403. A request that arrived over that listener is secure for the console (the
`__Secure-` cookies with `Secure`), as one from the configured TLS proxy is; the HTTPS origins join the console's own
origins. `ListenInfo.https` gives the listening address. The request target is parsed once and never throws (`parseTarget`): an origin-form target is always a
path on this server, so `//x/mcp` is the path `//x/mcp` (404), never an authority `x` with the path `/mcp`; an absolute
`http://` target without user information is served by its path; anything else (`*`, a URL the parser refuses such as
`http://a:b/`) is 400 with `connection: close`. A request whose handling fails anyway is logged and answered 500; no
request can leave a rejection nobody handles. Every request then passes two checks, on every route:

- **Host** must exactly match an allowed name and listener port; loopback defaults retain `127.0.0.1` and `localhost`.
  The authority of an absolute-form target must also be allowed; a missing or other Host is 403 (DNS rebinding).
- **Origin**, when present, must match the declared origins; the default loopback listener keeps its existing loopback
  origin behavior. An explicit HTTPS proxy origin is accepted only on its distinct declared authority; no forwarded
  header changes this check. `null`, paths and other hosts are 403. Console form posts must match the current request Host.

The console distinguishes a request through the configured HTTPS authority and trusted proxy peer from direct HTTP.
HTTPS login and session cookies use separate `__Secure-` names and the `Secure` attribute; server-side nonces and
sessions are bound to that channel and cannot be replayed by renaming a cookie on direct HTTP. Direct HTTP keeps its
separate, non-Secure cookies for compatibility: anyone who can observe that connection can capture the credentials or
session, so use network restrictions or the explicitly configured TLS proxy. A trusted proxy peer is an IP boundary,
not authentication of a particular process. The proxy must terminate TLS, preserve the declared HTTPS authority, and
never forward plaintext client traffic under that authority; the Hub does not inspect TLS on its HTTP backend socket.

For a Circle MCP connection, select transport `streamable_http`, use this service's `/mcp` endpoint, and ensure the URL's
host exactly matches the deployment's allowed-host declaration (and its HTTPS proxy origin, when applicable). MCP still
requires a valid Bearer token on every request; a client gets one through the MCP standard authorization (below) or from
an administrator (`circle-hub token issue`). `/healthz` and the authorization's metadata and endpoints are unauthenticated.

Routes: `POST /mcp`; `GET|HEAD /healthz` (no token, `{"status":"ok","release":<id or null>}` with the id of
`release.json` in the code root, so a deploy tells the new process from the old one; a `release.json` that is not a
`circle-hub-release@1` record refuses to start); the standard authorization's `/.well-known/oauth-protected-resource`,
`/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` and `/oauth/{register,authorize,
token,revoke}`; `/console/**`; anything else 404. Responses carry `nosniff`,
`no-store`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`. The referrer policy is `same-origin`, not
`no-referrer`: under `no-referrer` a browser sends `Origin: null` with every form POST (Fetch, "append a request Origin
header"), so nobody could sign in to the console; requests to other origins still get no referrer.

**Body budget.** Each `/mcp` body may be as large as `limits.maxRequestBytes`; over all requests the process holds at most
`AppOptions.maxInflightBodyBytes` (default four times the request cap) of request bodies, from reading until the request is
answered. A declared body that does not fit, or a chunked one that stops fitting, is answered 503 with `Retry-After: 5`
and `connection: close` before the rest is read (logged as a transport failure).

`close()` stops accepting, closes idle connections, waits for requests in flight (`closeTimeoutMs`, 10 s by default),
closes every connection, then waits again (`closeGraceMs`, 15 s by default; both fit launchd's `ExitTimeOut` of 30 s) for
the handlers it cut off, so their call-log lines are written before `serve` stops the sandbox and closes the records; what
still runs after that is named in the operator's log. It never stops the database.

## MCP standard authorization (decision 78)

Owner decision 78 (2026-11-01, the seven open items of the interface doc confirmed as assumed): the Hub is both the
protected resource `/mcp` and its authorization server, by the MCP authorization specification (OAuth 2.1 with PKCE;
RFC 8414, 7591, 8707, 9728, 7009, 9207), in `oauth.ts`, with no new dependency.

- **Discovery.** An unauthenticated `/mcp` answer carries `WWW-Authenticate: Bearer realm="circle-hub",
  resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`, plus `error="invalid_token"` when a token was
  sent and does not work (the body stays the same for every reason). The resource metadata names `<origin>/mcp` and this
  Hub as its authorization server; the authorization server metadata offers the authorization code with PKCE S256 only,
  public clients only (`none`), no refresh token, and the `iss` response parameter. `<origin>` is the scheme of the
  channel and the Host the request came with (already checked against the allowed hosts).
- **Registration** (`POST /oauth/register`, RFC 7591): JSON; what the Hub does not support is replaced, not refused
  (RFC 7591 3.2.1): every client is public (`none`, no secret, whatever method was asked) and gets the authorization code
  only; a client whose `grant_types` or `response_types` leave the code out is refused. Redirect URIs are sent in the form
  a URL parser writes them (they are stored, shown and matched as sent), and are https to a plain DNS name or IP
  address, http on a loopback address (any port at authorization, RFC 8252 7.3) or a private-use scheme named by a
  reversed domain name (`com.example.app:`, RFC 8252 7.1, which leaves out the operating system's handlers such as `tel:`
  or `ms-msdt:`), never a fragment or user information. At most 20 registrations per sender and 100 in all in 10 minutes
  (then 503 `temporarily_unavailable`); a client that obtained no token and used no invitation within a day is removed at
  a later registration. The self-chosen `client_name` loses control and format characters, keeps 100 characters, and
  labels the client's token.
- **Authorization** (`GET /oauth/authorize`): every refusal (an unknown client, a redirect URI that is not registered, a
  response type other than `code`, no PKCE S256, a resource that is not this Hub's `/mcp`) is an error page and never a
  redirect: a client registers its redirect URIs itself, so redirecting before anybody looked at the request would make the
  Hub an open redirector (RFC 9700 4.11). An accepted request is kept in memory for `AUTHORIZATION_REQUEST_TTL_MS`
  (10 minutes; at most ten open per client and a hundred per sender, the oldest of that client or sender ending first, and
  5000 in all, beyond which new ones are refused rather than evicting others) and the browser goes to the console's authorization page `/console/authorize/<request>`
  (under `/console`, so the console session cookie is sent) with a cookie scoped to that page (`circle_hub_authorize`,
  SameSite=Lax, 10 minutes): the request belongs to that browser, and to every other one it does not exist, so nobody can
  finish, or watch, a request another browser identified itself on.
- **Token** (`POST /oauth/token`, form encoding, each parameter once): the code is used once, within
  `AUTHORIZATION_CODE_TTL_MS` (2 minutes), by the client it was issued to, with the same resource, the PKCE verifier of
  its challenge, and the same redirect URI when the authorization request named one (RFC 6749 4.1.3); an account that
  went away meanwhile is `invalid_grant`, never a 500; a code presented again, by any client, is refused and the token it gave is revoked
  (RFC 6749 4.1.2), also when the first exchange is still under way (it then revokes what it issues) and whatever the
  account's state.
  The answer is an ordinary Hub token (`Bearer`, no `expires_in`, no refresh token) issued by the account to itself,
  labelled with the client's name and bound to the client (`tokens.client_id`). Hub tokens are checked against the records
  on every request, so revocation is immediate: disconnecting a Circle is revoking its token (`circle-hub token revoke`).
- **Revocation** (`POST /oauth/revoke`, RFC 7009): whoever holds a token revokes it by its value; an unknown token gets
  the same 200.
- **Invitations**: `circle-hub user invite <user>` (an administrator; the console's 添加成员) prints a twelve-character
  code once; the records keep its SHA-256 (`invitations`, migration 7), valid 24 hours, used once by the client it
  authorized. Requests, codes and login links live in memory and end with the process, like console sessions.

Wire errors and descriptions are OAuth's own (ASCII, RFC 6749 5.2), not Hub codes. Circle's own client (the frozen
baseline) has no OAuth yet; until the generic MCP-client improvement lands in the Circle repository, Circle connects with
an issued token, while any client with the standard authorization connects with an invitation code.

## MCP (D05, D06)

Official SDK 1.32.1, streamable HTTP in stateless JSON mode: one low-level `Server` and one
`WebStandardStreamableHTTPServerTransport` per HTTP request; the body is read by the server (cap
`limits.maxRequestBytes`, declared or streamed; over it is 413 before parsing, `connection: close`), decoded as strict
UTF-8 (anything else is 400 / -32700, never decoded with replacement characters: RFC 8259), parsed, and handed to the
transport as `parsedBody`. **One JSON-RPC message per POST:** a JSON array (a batch) is 400 / -32600 before anything runs.
MCP 2025-06-18 removed batching, and in a batch two requests sharing an id, or a `notifications/cancelled` of a sibling,
would run calls that the call log and the HTTP answer never see. GET is 405 (no SSE stream), DELETE and other methods
405, a non-JSON media type 415, a body that is not JSON 400. The `Authorization: Bearer <token>` header is authenticated
on every request (`Principals.authenticate`): missing, unknown, revoked, disabled or another scheme give the same 401 body
with `WWW-Authenticate: Bearer realm="circle-hub"`, so revoking a token or disabling an account takes effect at the next
request. The token and cookies are not forwarded to the transport.

`initialize` answers `serverInfo.name = circle-hub`, `instructions = SERVER_INSTRUCTIONS` and the tools capability
(`listChanged: false`). `tools/list` gives the six tools with title, description, `inputSchema` and `outputSchema`
exactly as published in `contracts/generated/tools.json`, and annotations from `annotationsFor`: `start_run` is
open-world for a caller when start_run reads an external system for them (D06 F[2], D03 R[6]): an assigned pack has an
input slot accepting `system:type` (no slash) of an external system, or its workflow binds expected sources at start_run
(`expected_sources`, loaded with `WorkflowStore.forUser`); a pack that cannot be loaded counts as reading outside. The
Hub's own knowledge views (`knowledge:impact|facets|index`, system `knowledge`) are bound like external objects but read
inside the Hub, so a pack whose inputs take only them stays closed-world (`readsOutside` of `tools.ts`). For such a caller
the annotations equal `tools.json`.

Every tool call:

1. takes the arguments as the server parsed them from the body, not the SDK's validated copy (whose record schema drops
   members such as `__proto__`), and parses them with the tool's zod schema; a failure is a protocol error
   `SUBMISSION_SCHEMA_VIOLATION`, one per issue (at most 20) with the RFC 6901 pointer of the argument (an unknown key
   points at the key) and a Chinese fix, in the tool's empty shape (D05 R[3]). **Except `submit_result`**, whose arguments
   go to `RunsService.submitResult` exactly as received (see Deviations); the call log digests the same object;
2. runs the server's own semantics or the service, with `CallContext { traceId, sessionId }` plus `adminNote(reason)`;
3. adds the trace id and validates the answer against the tool's output schema; an answer that does not conform is never
   sent: the caller gets JSON-RPC error -32603 ("Hub 内部错误", with the trace id) and the reason goes to the admin note.
   A thrown error with a registered protocol `code` becomes that error answer (its message and fix); a thrown
   `SOURCE_UNAVAILABLE` is answered neutrally and its message goes to the admin note; anything else is -32603;
4. returns `structuredContent` (the validated answer), `isError = (call_result === 'error')` (the envelope makes this
   exactly "protocol error or a receipt that is not accepted"; unknown never is), and **one** content block of Chinese
   plain text (D05 R[0], display rule 11: content is plain text, the JSON is structuredContent). The real Circle client
   hands the model this text only (structuredContent never reaches it, and a result over about 50,000 characters does not
   reach it at all), so every text is laid out within `TEXT_BUDGET` (30,000 characters, `budget.ts`): the facts a model
   works from first, long lists cut by whole entries, and one note before the trace line naming what was left out and the
   exact call that reads it; the trace line `追踪 <trace>` is always last. A text that cannot be laid out (a defect, for
   example a production result the engine handed over without its partitions) never costs a valid answer: the call gets
   `fallbackText` (outcome, receipt and counts, the run, the error codes, the stored result, the console page, the trace)
   and the reason goes to the admin note. What the texts say:
   - `submit_result`: first the receipt, the partition counts and the unknown count; then per requirement how many items
     are satisfied, unsatisfied (by reason) or pending and per layer how many have each terminal (`本层不适用` for an
     undeclared layer); the errors (per code with the fix they share, then one line each with rounds left); the
     cross-item claims; the **问题与未知** list (one line per item and requirement that needs attention: id | label |
     partition | requirement | terminals | status | message); then every item with its requirements and the fields of
     their claims in `DISPLAY_ORDER` (D05 R[6]). An answer that carries a result, accepted or not, names its stored record
     (`存下的结果 rec:<digest>`) and the notes read the rest from it by page cursor.
   - `start_run`: the run, pack, target and locked root; for a production run (all requirements facts) the result first:
     its counts, the per-requirement counts, the 问题与未知 list and `完整结果 rec:<result>` with how to page through it;
     the procedure, the requirements, the sources and the evidence gaps (`数据缺口`); the items as **id | label |
     summary**, one line each (ItemProjection.summary: a model reads items as id, label and summary only), where the
     items are being said once by a rule (`位置：每个条目的位置都是 …` or `… 加上条目编号`), per item only for a short
     list that follows no rule (at most 50); the **compact slot schema** (one line per slot key: fields, closed sets,
     bounds) with the whole JSON Schema named at `rec:<run record>#/slots/schema`; an example `submit_result` on one line.
     Items, procedure lines and schema left out are read from the run record (`rec:<run record>#/items`, `/instructions`)
     by page cursor.
   - `get_nodes`: a page of a source, a record value or a validation result read by reference, with `下一页：get_nodes
     {"reference":…,"cursor":…}` while more follows; node children and entry data; the structure summary of a
     function-only source.
   - `list_task_packs`: every pack with its inputs, parameters, requirements and an example `start_run` call that
     parses with StartRunInput; `upload_file` and `resolve_reference` in the same style.

   The **text context** the server passes (`TextContext` of `text.ts`): `paging: true` for every tool (the server takes
   `get_nodes {reference, cursor}`, so texts offer page cursors rather than byte ranges); for `get_nodes` with a
   reference the caller's `cursor`; for `start_run`, from `ServerDeps.runsDetail.startRunDetailed`, `record:
   rec:<run record>`, `production` (the whole result, only when it is the one the answer's `result` names), `unavailable`
   and `gaps`; for `submit_result` `record: rec:<validation result>`, looked up with `runsDetail.getResult` by the
   result's run and submission digest. A missing or failed lookup is retried once; each miss records a private `defect.result_lookup_miss metric=1` event. Exhaustion preserves the receipt and result, adds a structured SOURCE_RETRYABLE diagnostic naming the missing reference, next retry time and console/admin recovery, and never charges a repair round.
   Without `runsDetail` start_run uses `RunsService.startRun` and the texts name the console page instead of records.

Trace id: the trace-id of a valid W3C `traceparent` (version 00 exactly four fields, not `ff`, no all-zero ids), else a
new random one per request. Session id: the `Circle-Session-Id` header, kept when it is 1-200 printable ASCII
characters, else `sha256:<hex>` (the call log's rule, so runs and call-log lines agree).

Semantics owned by the server:

- `list_task_packs`: `WorkflowStore.summaries(user)` filtered by `kind`.
- `upload_file`: `file_path` is base64, decoded strictly (canonical padding; a second spelling of the same bytes is
  refused); the cap is `min(limits.maxUploadBytes, MAX_UPLOAD_BYTES)`, checked before decoding; the media type is the
  argument's (validated like records), else by the file name's extension, else sniffed (JSON, HTML, XML, UTF-8 text,
  else `application/octet-stream`); `Artifacts.ingest` with origin `upload {session}`, author the caller, provenance
  `declared` by default or `client_captured` when the optional `provenance_type` explicitly says so (K03 R[7]); other
  provenance values are refused. This client declaration does not prove that model code never handled the bytes, and
  operation records stay declaration grade. Visibility is `{readers: [caller], admins: true, packs: [], shareable: true}`
  (B02 R[3]). A credential hit is a
  not-accepted answer `CREDENTIAL_IN_UPLOAD` (records' message with line and column, never the matched text) with the
  digest and size and no reference. An accepted answer has `src:<sha256>`, sha256, size, media type and, when a core
  parser recognises the bytes, `structure: {parser, summary}` (counts and shape only).
- `get_nodes`: with `run`, the run root from `RunsService.getRun` (absent or forbidden: neutral); with `root` (overrides
  the run's), `KnowledgePort.getNodes` (paths default `/`, depth 1; paging, the service's own cursor and coverage from the
  service); with `reference` (not combined with root, paths or depth; an optional `run` must be visible and scopes the
  reader), `resolveReference` of hub/refs with a `SourceReader` on `Artifacts.source(..., {consumer: 'function'})`, the
  `KnowledgePort.treeReader()` and a `RecordReader` with visibility, as consumer `model`: text only for
  `model_readable`, structure only for `function_bytes_only`, the note `含凭据，原文不可读` for `retain_only` (the reader
  gives refs `bytes: null` for a withheld source, and refs answers it without evaluating the selector). A `cursor` beside
  a reference is a page of its text (`pageCursor` of `text.ts`, bound to the canonical reference the content names): once
  the reference resolves, a cursor made for another reference, or a text that is not a page cursor, is
  `SUBMISSION_SCHEMA_VIOLATION` at `/cursor`; a reference that does not resolve keeps its own answer (absent and forbidden
  stay alike whatever the cursor). An empty `cursor` is no cursor, for a reference as for a subtree (hub/knowledge reads
  `''` so). A position past the content, or an offset between the two halves of a surrogate pair (the server's own cursors
  never split a character), is no page position: the first page is shown and the text says so. An empty partition or item
  list (every item delivered leaves three partitions empty) reads as its head, `条目 0 个`.
  Neither run, root nor reference is a schema violation.
- `start_run`: `ServerDeps.runsDetail.startRunDetailed` when the assembly gives it (the answer, the run record digest, the
  production result, the evidence gaps for the text), else `RunsService.startRun`.
- `resolve_reference`, `submit_result`: `RunsService`; a `submit_result` answer that carries a result also gets its stored
  record from `runsDetail.getResult`.

For readers without established permission, absent and forbidden give the same `SOURCE_UNAVAILABLE` ("对你不可用") shape; tests compare it byte for byte apart from the trace. Authorized bad cursors, missing locked roots, retry exhaustion and integrity faults have explicit corrections. Connector absence is a determined SOURCE_ABSENT observation, rather than this neutral answer.

**Record visibility by reference (R02).** Records decides `source_artifact` records for everyone, admins included
(`Artifacts.canRead`: a read with a person's own credential, `visibility.admins: false`, is theirs alone, B02 R[3]). A
knowledge-contribution record passes product and original-source read checks before any administrator branch. All
other claims are ordinary admin-only records; the Hub has no private candidate layer. Admins read remaining records. A user reads the `run`, `submission`,
`validation_result` and `action` records of a run `RunsService.getRun` lets them read (the run kinds of the runs engine);
the run is the body's `run`, or for a submission runs kept as JSON text because its arguments were not canonical JSON,
`received.run`. Nothing else (never `call_log`, `authorization` or other claims).

## Call log (B08)

One line per JSON-RPC request of an authenticated caller (`initialize`, `tools/list`, `tools/call` under the tool name,
`ping`, unknown methods), written through `CallLog.append` after the answer is ready and before it is sent: user, trace,
session, tool, run (the `run` argument when it is a run id, or the run `start_run` answered), the digest and size of the
arguments (computed by records; the content is never stored), call result, receipt, the first error code, duration and the
admin note (the real reason behind a neutral answer, an output-schema violation or an internal error). Every refusal at
the transport after authentication is one line with `call_result: transport_failure` and the reason in the admin note:
a method other than POST and GET (405), a media type other than JSON (415), a body over the cap (413), over the body
budget (503), not complete (aborted), not UTF-8, not JSON, a JSON value the transport refuses (400, also when it holds no
request), a transport refusal of a request (406, a protocol version); a refused batch gives one line per request in it
(at most 100, the rest share a line), under each request's tool. Not logged: a GET (the streamable HTTP client's probe for
the optional server stream, answered 405 as the specification prescribes for every session), notifications (202),
unauthenticated requests and Host/Origin refusals (no account to attribute; loopback only). Every admin note is clipped to
what records accepts (no NUL, no lone surrogate, cut between code points); should records still refuse a note, the line
is written once more without it and the operator's log says so. A call-log write that fails is reported to the operator's
log and does not change the answer. No argument preview is sent (B08 F[7], see Deviations). `serve` calls
`CallLog.repairFiles` for the last three days at start.

## Console

Decision 83, second round item 1: member status uses R01's generated `account_status` (enabled/disabled), including the Team
page and CLI account listings. In-use only describes an occupied runtime environment. Model 15 stays the revision.

Decision 83's remaining-page pass moves reading guidance on task details, neutral pages, operation results, forms,
background jobs and authorization to heading/label hover hints. Breadcrumbs, measured times, counts, commands, one-time
values, permission consequences and missing-evidence facts remain visible. Background jobs display the generated action
result: an outstanding result is unknown, rather than success or failure.

Decision 83 makes username/password the ordinary sign-in for administrators and members. Only administrators create
accounts; `user create` generates an initial password shown once and requires a first-login change. Team manages
resets; members change their own password there. Passwords travel through forms or stdin, never command arguments or logs.
Five failed attempts per account and 50 per peer in 15 minutes are bounded in process memory, including unknown accounts;
a restart clears these counters. Successful logins clear that account and peer. Two expensive derivations run at most.
The existing administrator token remains a backup; members cannot use a Circle token to sign in to the console.
Password-created sessions have independent, hidden, 12-hour credentials. Password reset ends browser sessions while
Circle tokens stay bound to their member account. Existing members without a password require an administrator reset
before console login. First-use restrictions also guard API reads/writes, live streams and authorization confirmations.


Decision 84 supersedes decision 83's personal/team knowledge draft (`docs/design/personal-team-knowledge.md`, retained
as a research record). Personal knowledge will live in both Circle and Hub with two-way sync and multiple clients; the
individual chooses the mode, sets personal-space permissions and may share with administrators or others. Shared
submissions require no review. The owner accepted all fourteen design recommendations; the implementation basis is
`docs/design/knowledge-workflows.md`. Decision 85 implements its first stage: 工作流 contains workflows with acceptance
and 通用技能 without acceptance; 产品知识来源 is under Knowledge and 业务系统接入 under Connections. The other stages
(personal/team spaces, authorization, sharing, search and two-way synchronization) remain future work; this rename changes
neither their models nor business code. Existing format skills remain globally installed parser providers, rather than
the future per-account synchronized skill storage. `docs/design/console-navigation.md` records the current navigation.

Decision 83 shows Circle connections as devices: the registered OAuth client name, or a direct token's label, the member,
last use and disconnect action. Team, Connections and member Settings omit token identifiers from their tables; exact
identifiers remain inside disconnect command dialogs only.

Decision 83 adds Team before Settings. Administrators manage member details, publish rights, workflow assignments and
Circle connections there using the existing commands. Members see only their own account. Settings retains system
secrets and Hub state; member Settings still contains My Circle. See `docs/design/console-navigation.md` for navigation.

Decision 83 keeps schedules and bots outside the pack page. Neither gains a placeholder, route or navigation entry here;
their future management belongs on separate pages with separate navigation entries.

Decision 83 groups knowledge intake by personal and team visibility, with the share/verification boundary between two
columns. Runtime explanations are hover hints. This diagram grants no new read rights; source archiving stays planned.

Decision 83 hides product browsing and version comparison until a readable product line exists. Comparison selects
produced versions of that product instead of asking for digests; import keeps its name and explains its scope on hover.

Decision 83 places knowledge intake pending items on the knowledge page. Empty queues are hidden and the same
principal-scoped feeding query remains the source; the tasks page no longer reads it.

Decision 83 combines pending and overdue requests in one shared list on the task and task-detail pages. It deduplicates
record identities, resolves member names, puts overdue requests first and hides an empty list. Labels use B07's generated
display axis; requests and their answer rules are unchanged.

Owner decision 83 (2026-11-02), walkthrough item 4: an empty, unfiltered task page hides the pack/result filters and
zero-page counts. An active filter remains visible even when empty. Nonempty lists keep factual page/filter counts;
the ordering explanation is a title hint. The walkthrough task page records each scoped check.

Server-rendered HTML, no external assets; `Content-Security-Policy: default-src 'none'; style-src 'sha256-…'; img-src
'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; script-src 'sha256-…'; connect-src 'self'`, the one
stylesheet and the one inline module script (`console/script.ts`, the live updates below; signed-in pages with a live
module only, never the login, setup or authorization pages) allowed by their hashes. The only image of this origin is
the console's icon, `GET /console/favicon.svg` (static, for anyone, `nosniff`, a day's cache). The mark of circle-hub
(decision 82: the Hub at the centre and the Circles on an orbit around it, in Circle's four colours) is inline SVG on
every page (`logo()` in `console/html.ts`, colours `--logo-1`…`--logo-4`), no longer Circle's ring. The pages work with scripts off.
Every dynamic value goes through an escaping template (element text or double-quoted attributes only; links are fixed
paths with encoded query parameters).

The pages follow the design canvas (version 25) and the owner's choices in the simplification proposal of 2026-10-31
(decision 77 in `docs/hub-r4-progress.md`):

- **Eight places** in a side navigation: 总览 `/console/overview` (the home `/console` and a sign-in lead to), 任务
  `/console/runs`, 知识库 `/console/knowledge`, 任务包 `/console/packs`, 连接 `/console/connections`, 记录
  `/console/records`, 团队 `/console/team`, 设置 `/console/settings`; the account and the sign-out button below them.
- **Interface terms** (display rule 20): every vocabulary value is shown by `uiLabelOf`, its `ui` term where the model
  gives one (引用校验 for the static layer, 未检查 for unchecked, 派发结果未确认 for quarantined, …), so the console
  never shows the model's internal words; the text models read keeps `labelOf` (`claims.ts` and the counts of `text.ts`
  take the labels as a parameter, `MODEL_LABELS` by default, `INTERFACE_LABELS` on the console). A task's result
  (`task_result`) is derived from the partition list and the requirement statuses of the authoritative result in
  `console/status.ts` only; an unknown terminal keeps a delivered task from 已通过.
- **The task page** (`/console/runs/<run>`) puts the head and the execution process above the run's full record: the
  call-log lines of the run (each bar the Hub's time on one call; the gap before a submission is Circle's time, which the
  Hub does not observe), the Hub's checks of the authoritative result per requirement, the requests with their audience,
  due time and whether they are answered, the dispatch jobs (administrators, through the optional `ServerDeps.dispatch`
  view the assembly wires from the executor registry and `readRunJobs`) and the result. Times the Hub did not record are
  not drawn. The list filters by task result and keeps the request and feeding sections.
- **Style**: `console/style.ts` is the canvas's `hub.css` with the dark theme and reduced motion following the system;
  the markup uses classes only (a `style` attribute would be refused by the CSP) and charts are SVG whose geometry is in
  attributes. The command dialogs open on their fragment (`:target`) without a script.
- **The read-only JSON interface** `/console/api/…` (`console/api.ts`, owner's choice of 2026-11-01 to build the read part
  of the interface doc first): `me`, `overview?days=7|14|30`, `tasks[?pack&result&cursor]`, `tasks/<run>` (the waterfall's
  steps, the requests and the calls), `knowledge/lines`, `knowledge/nodes?root&path&cursor`, `knowledge/diff?from&to`,
  `knowledge/imports[/<job>]`, `packs`, `packs/<id>`, `systems`, `system-packs`, `environments`, `circles`, `records[?…]`,
  `members`, `members/<id>` (with the invitations issued for the member: when, until when, used or open, by which client;
  never a code), `secrets`, `hub`. The pages' session and visibility, built from the same helpers; GET or HEAD only (405
  otherwise); 401 in JSON without a session (no redirect); absent and forbidden alike 404 `SOURCE_UNAVAILABLE`; an error is
  `{code, message, fix}` with `code` null where no code is registered (not signed in, a bad parameter); codes come with their
  interface terms (`*_label`); token values and credential contents never appear.
- **The write interfaces** (`console/api-write.ts`, decision 78): `POST /console/api/members`, `/systems`,
  `/knowledge/imports` (202, a background job read at `knowledge/imports/<job>`), `/packs/stage` (multipart, the zip in
  field `archive`) and `/packs/stage/<id>/publish|discard` run the very commands of the forms, built by the same builders
  of `manage.ts`, through the command bridge as the signed-in administrator; `/commands` (`{operation, object}`) answers
  the command of a dialog for an object that exists and runs nothing. A write needs an administrator's session, this
  console's Origin (required: every browser sends it on a POST), the session's CSRF token in `X-CSRF-Token` (`/me` gives it)
  and a JSON object of strings and booleans; a member gets the neutral 404 before any body is read, an upload included; 400 for a refused parameter or exit code 2, 409 for exit code 1 (with what the
  command said), 503 without a command bridge, the neutral 404 for members and unknown objects. Adding a member answers the
  invitation code (or the token) once, with the Circle entry.
- **Search** (`console/search.ts`, decision 79): `GET /console/api/search?q=` and the page `/console/search?q=`, reached
  from the sidebar's 搜索 box on every signed-in page. Each kind is searched only within what the reader may see:
  - tasks: run id, pack, title, product, version, build and runner, among the reader's latest 300 runs;
  - packs: id or title in the reader's catalog;
  - knowledge: readable product lines with their builds and version lines, and a tree path (a query starting with `/`) in
    the current roots, at most 20 lines and 20 roots;
  - records: call-log lines the reader may see, matched exactly by run id, tool name or label, or (administrators) a member,
    otherwise among the latest 300;
  - members: administrators only.

  The query keeps 100 characters and each kind at most 10 hits; `partial.{tasks,knowledge,records}` says when a bound
  stopped a scan, and the page says it in words. It is no full-text index: an older item may be missed, never silently.
- **A knowledge node's detail** (`console/citations.ts`): `GET /console/api/knowledge/node?root&path` answers the node's
  position, digest, children and entries with their provenance (the tree reader's grounds, at most 20 per entry for 50
  entries; the source text behind them is not resolved) and `citations`. Those are the accepted submissions of the last 30
  days citing the node in this root, or any of its entries from any root (hub/runs indexes them, see its README), with a
  count per entry, capped at 10,000. They are exact (`complete`) once the runs engine's backfill has indexed the older
  submissions (decision 80), or when the window starts after `indexed_since`, the oldest submission indexed as it was
  stored; otherwise they are a lower bound, and the page says from when it counts. The knowledge tree page shows
  被引用 for the node and 出处 and 近 30 天被引用 for its entries.
- **The connection attempt** (decision 79): `POST /console/api/systems/test`, a write interface for administrators, and the
  尝试连接 button on `/console/operations/system` (action `system-test`). They run the trial of hub/connectors (its README
  says what the trial does and never does) with the typed system pack, origins, environment and credential contents. The
  answer is `{report: {system_pack, environment, auth: {kind, sent, ok, reason, code, message, ms}, routes: [{route, role,
  method, path, tried, reason, ok, status, code, message, ms, bytes}], started_at, ended_at, saved: false}}`; 400 for a
  form error, RESOURCE_INVALID, PACK_UNAVAILABLE or PROFILE_INVALID; 503 without the port (`ServerDeps.systems`, wired by
  the assembly); the neutral 404 for members. The form comes back with the secret names, never their contents.
  Decision 81 records each completed trial as a `trial-report@1` action (`trial`, B05): actor, times, pack/version,
  environment, login and route outcomes only, without addresses, credential contents or source text. `saved: false`
  means no resource configuration or credential content was saved. A failed audit write is logged by connectors and
  does not change the report or repeat a request. The records page lists trial actions for administrators only, with the
  generated action label, member/time filters and its own pagination; tool/run filters select the MCP call log alone.
  Decision 81 adds `POST /console/api/systems/test/forget`, with the same form fields, administrator session, Origin and
  CSRF checks as the trial, returning only `{found, cleared}`. The blocked-login result offers 清除这组凭据的失败记录
  (`system-test-forget`); credential contents must be re-entered, and are never returned. Clearing uses the running
  connectors instance so its memory and vault agree, preserves other stops, sends no login and never retries. A failed
  clear returns 503 without private storage details; a newer concurrent failure stays stopped. There is no CLI command.
- **Runtime environments' state** (decision 79; vocabulary axis `environment_state` of D07): `GET
  /console/api/environments` gives each executor its derived `status` (`available`, `in_use`, `frozen`, `deactivated`,
  `unknown`) with `status_label` and `status_detail` (why, line by line), beside the facts it comes from (`state`, from
  hub/dispatch's `environment`, null when not read): `deactivated` when the registration is disabled; `unknown` when the
  occupancy could not be read; `frozen` when a job holding the physical target waits for the disposition of an
  unconfirmed result, or a job left the environment unrestored (an open bed hold); `in_use` when a job holds the target;
  `available` otherwise. Jobs still in flight and jobs a crash left behind are both `in_use`: the records cannot tell them
  apart. The connections page shows the status with its reasons, the executor version the executor reported of itself in
  the newest kept MCP initialize (not verified; 未上报 when it reported none, 未知 when not found) and the latest dispatch
  with its outcome; two dialogs give `circle-hub bed hold clear <executor> --reason=…` (确认已恢复) and `circle-hub job
  status <job>` (处置派发结果). The task page's dispatch step names the environment and its current status; a job waiting
  for its result with no disposition request open reads 等待派发结果中，不可重发.
  Decision 81 adds `calls_24h: {executor, since, until, calls, results, results_label, median_ms, slowest_ms, last_at,
  partial} | null` to each environment. The assembly reads hub/dispatch's existing timed exchange records; null is
  unreadable, not zero. The connections page adds 响应时间 (median and slowest), or 近 24 小时无调用 when complete and
  empty. A capped scan says 至少 for the count and the durations cover the scanned calls only. No new measurement request
  or record is made, and duplicate read/transport records of one exchange count once.
- **Backups and the database** (decision 79): `GET /console/api/hub` adds `backups: {count, latest_at} | null` (the
  complete backups under the data root that `circle-hub backup` wrote, through hub/platform's `listBackups`, the newest by
  its manifest's `created_at`; a partial one does not count) and `database_bytes: number | null` (the records store's
  `databaseSize`, PostgreSQL's `pg_database_size`); null is unreadable, never none. The settings page's Hub state and the
  overview's health row show them.
- **Reads of the last day**: each system in `GET /console/api/systems` carries `reads_24h: {since, until, reads,
  results, results_label, median_ms, slowest_ms, last_at, partial} | null`, from hub/connectors' read manifests. The
  connections page (column 近 24 小时读取) and the overview's systems card show it, naming the window; `partial` reads
  “至少 N 次”, and null 暂不可用.
- **Live updates** (`console/live.ts`, decision 78; owner-confirmed item 7: no build step, so the script is an inline
  JavaScript module allowed by its hash): `GET /console/api/stream[?events=a,b]` is a server-sent event stream on the
  pages' session (401 in JSON without one, 400 for an unknown event name; `retry: 5000`; a heartbeat every 25 s that
  re-authenticates the session's token, so a revoked token, a disabled account or a closed session ends the stream; at
  most 4 streams per session and 200 in all, the excess 429; `close()` ends every stream before the app drains its
  requests). Events carry ids only and reach only an account that may see the object: `task.updated {run}` and
  `request.updated {run, request}` (the run's owner, administrators and those it is shared with), `pack.published {pack,
  version}`, `knowledge.published {product, line}` (readable lines), `system.added {system}` (held 6 s, past the resource
  catalog's cache), `member.connected {user}` (a token used for the first time; administrators and that member) and
  `import.progress {job}` (administrators). One poller reads the records and call logs every 2 s while a stream is open,
  so commands of other processes are seen too. The state the records hold of a business system or a runtime environment
  is its configuration: a later `resource_config` decision on a system (enabled, disabled, changed) is `system.status
  {system}`, held 6 s like `system.added`, and any decision on an executor (`executor.<id>`) is `environment.status
  {environment}`, both for administrators. A read of a business system that ended (its read manifest, decision 80) is
  `system.status {system}` too, since its reads and times of the last day changed; the held events of one system are
  sent once. Occupancy and freezing come from the dispatch journal: a record that can change
  them (a reservation, an intent, an end, a request left uncertain or answered, a disposition, a bed hold opened or
  cleared, an unknown outcome) is `environment.status` for the executor its job reserved (the last 2,000 jobs are kept in
  mind). An explicitly timed executor response changes its call statistics and sends `environment.status` too (decision
  81), resolved through the job's reservation. Events of one environment are held for 6 s and sent once during that period.
  A live module carries `data-live="<events>"` and a stable id; on an
  event the script fetches its own page (`circle-hub-refresh: live`, which does not count as session activity, so an
  unattended page still reaches the idle limit) and swaps those modules, keeping the scroll position and leaving a module
  alone while it holds an open dialog or a focused field; when the stream breaks the page says 连接中断 with the time of
  its data, keeps it, and polls every 15 s until the stream is back.
- **The neutral page** says “该内容不存在或无权查看” on the console (the MCP tools keep their own neutral text), the same
  words whatever the path. A session that ended (revoked token, disabled account, expiry) returns to the login page with
  a two-minute `circle_hub_ended` cookie scoped to `/console/login`, so the page says the sign-in ended, once.

- **The authorization page** (`/console/authorize/<request>`, `console/authorize.ts`, decision 78): the request the
  authorization endpoint accepted, for its 10 minutes, on the channel it was opened on, only for the browser holding the
  request's cookie (any other gets the 410 page that says the request does not exist). Without a console session the page
  asks for an invitation code (no password, owner-confirmed item 1); a signed-in browser confirms for its own account and
  may still switch to an invitation; the page always names the account, the client (its self-chosen name and id), the
  redirect URI and the resource, and says where the code goes when that is not a loopback address of this machine (a
  warning for an https host, which can then connect as the account; for a private-use scheme, the app that handles it
  here). Five wrong codes end the request. The approval names the account the page showed and is refused when another
  one is signed in by then; a request is decided once, and a second submit (a double click) gets the same answer, so the
  browser never drops the redirect that carries the code. Its forms carry the request's own CSRF token and must
  come from this server's origin; the confirm page's CSP allows its form to lead to the redirect URI's origin
  (`form-action 'self' <origin>`). Approving takes the invitation (if one named the account), issues the code and sends the
  browser to the redirect URI with `code`, `state` and `iss`; refusing sends `access_denied`. Back on the page, the browser
  sees that the request ended.
- **One-time login links** (decisions 78 and 83): the existing Bearer endpoint and five-minute lifetime remain.
  An administrator can confirm a link as a backup sign-in, still subject to a forced password change. A member's link
  leads to username/password sign-in at the requested console path and never opens a token-authenticated browser session.
  Spent and expired links disclose no account. Return paths remain local to this console.

- **Sign-in**: `GET /console/login` issues a one-time nonce (server-side, 15 minutes) in the form and in a cookie
  scoped to `/console/login`; `POST /console/login` (form encoding, at most 8 KiB, from this server's own origin) needs
  the nonce in both and a username and password. Every account, administrators included, signs in this way; the console
  never accepts a token (owner, 2026-11-02), and a one-time link from Circle only leads to this form at its page. The session cookie `circle_hub_session` is a random id,
  `Path=/console; HttpOnly; SameSite=Strict` (no `Secure`: plain HTTP on loopback); the token stays in server memory and
  every page re-authenticates it, so a revoked token or a disabled account ends the session at the next page. Sessions
  end after 2 hours idle or 12 hours. Password changes/resets revoke password sessions; Circle disconnects do not.
  `POST /console/password` changes the current account's password; `POST /console/password/reset` is administrator-only
  and returns a random initial password once. Both require the session CSRF token and own origin.
  `POST /console/logout` needs the session's CSRF token.
  `Origin: null` is never taken for this console's own origin (the pages' `same-origin` referrer policy makes a browser
  send the real one).
- **Pages**: runs (`RunsService.listRuns`, pack filter, paging); one run, the authoritative view (display rule 17):
  summary, version basis claims, sources, requirements, items, the partition list in the three groups of display rule 13
  (adopted: delivered; still to handle: rejected, quarantined, incomplete; requests for you to decide: none in milestone
  1), every partition with its count (an empty one too), each item's two cells by the conjunction of hub/runs `itemCell`
  (V03 R[3], display rule 4: the strongest terminal and the counts of the non-pass values, an unknown never hidden), every
  (item, requirement, layer) terminal with code, tier, reason and attribution, `本层不适用` for an undeclared layer,
  `？` and its own colour for unknown terminals (never ✓ or ✗, display rule 5), claims in `DISPLAY_ORDER`, cross-item
  claims apart, errors with fixes and rounds left, submissions with receipts and errors next to the submitted content
  as stored, marked `未经平台验证` (display rule 3; at most 256 Ki characters shown), locks, the run's call-log lines as
  the viewer may see them; knowledge (product lines with all their names, version lines with builds, aliases and roots,
  root compositions, a tree browser over `getNodes`, a version diff over `diffRoots`; a user sees the lines bound by a pack
  assigned to them, the server checks this before `builds` and `diffRoots`, which take no principal); packs
  (`PackCatalogPort`); admin (users, tokens without values, assignments and their decisions, resources with addresses,
  call logs with user/tool/run/time filters and admin notes; a member sees their own calls on `/console/records`). Non-admins
  get the neutral page for admin pages, and absent or forbidden runs and roots give the same 404.

- **Production results**: `/console/results` lists the visible runs whose requirements all accept fact producers,
  newest first, with `pack` and exact `build` filters. It retains the service's next cursor even when filtering leaves
  the page empty. A paginated scan is marked 部分; filtering a complete scan reports how many runs were examined and
  listed without a partial marker. A complete empty match says 没有符合筛选的生产运行; a partial empty page states its examined range;
  it never claims global absence from a partial scan (display rule 7). `/console/results/<run>` reads `getRun.production`, the start_run result whose submission is the run
  record digest, labelled 生产结果记录（start_run 计算）. Later accepted commentary cannot replace its record, counts or claims.
  The authoritative run page uses that same production result as its partition list and displays the latest later accepted
  result separately as 模型评论（判断）; its counts are labelled 判断，未采用, with per-item judgment claims, the original model handling declarations and cross-item claims. Commentary never reuses the adopted/open/request group titles. The results page identifies that commentary record when present.
  If the production record is absent, both pages name the missing start_run result explicitly, distinguish any accepted
  commentary, show the run start time, and ask the reader to refresh the same page first: run storage may precede production-result storage. Only if the refreshed page still lacks the result does it suggest a new run with the same inputs and a new client_key; replaying the old key
  would return the old run. Neither page starts or repairs a run. It shows partition counts via
  `countsLine`, coverage and cross-item claims, then one row per item (id, label, projection summary and each requirement's
  status, both layer terminals and claims). An undeclared layer is labelled 本层不适用. Display rules 4 and 16 require
  both layers and the satisfaction reason even though the task brief requested static terminals only. The table also
  preserves each item's partition and its code or reason: V05 and display rule 6 require this additional column even
  though the task brief omitted it. `terminal` uses the generated union of static and dynamic terminals and matches
  either layer; `offset` pages 500 filtered
  items at a time. Counts are computed before filtering or paging. Bookkeeping delivery is not an overall pass;
  unknown terminals keep their own symbol and colour, with the stored claims' missing evidence and next actions shown
  as recorded. This page does not initiate work or generate missing content. The run link opens the authoritative view.
  Only the runner and admins can read results; a missing, hidden, malformed or non-production run gives the same neutral
  404. All existing authentication, Host/Origin checks, read-only methods, CSP and escaping apply unchanged.

- **Integrator probe**: `node scripts/real/console-page.ts --username <name> --password-file <file> --path <console path> [--url <Hub origin>]`
  signs in through the CSRF form, reads one page and signs out in a `finally` block. It only accepts a loopback HTTP
  origin and console paths, and follows no redirects. Output contains only status codes, CSP presence,
  script/external-address counts, table body row counts and the first 12 hex characters of the body hash. CSRF input
  values are replaced by a fixed marker for this hash, so independent sessions can compare the same page; other content
  remains covered. External-address counts parse HTML attributes by local name: href/src/srcset/imagesrcset/action/formaction/poster/data,
  ping/background/cite/manifest/icon, CSS url(), @import and image-set() image strings in styles, SVG presentation url() attributes, meta refresh targets (bare or URL= targets after a semicolon, comma or whitespace),
  and recursively parsed srcdoc and noscript content. Values with a scheme or protocol-relative address (including slash/backslash spellings) count. SVG set/animate targeting URL attributes also inspect to/from/by and each semicolon-separated values entry; numeric attributes remain plain values. This includes srcset
  and ping candidates. Displayed text, comments, CSS content/type strings and raw-text bodies such as textarea and script are not resource references. HTML and nested srcdoc are scanned with scripting both enabled and disabled; the larger resource count is reported, so noscript raw-text parsing cannot hide a reference. The CSP field reports header presence, as required by the task, and does not validate directive values. Page content,
  paths, tokens and raw exception messages are never printed. A non-200 page, absent CSP, a script other than the inline
  one its CSP allows by hash, or external addresses makes the command fail. Synthetic tests are in `console-results.test.ts` and `console-page.test.ts`; actual deployment
  and real-data checks belong to the integrator.

The refresh target reader follows the [HTML shared declarative refresh steps](https://html.spec.whatwg.org/multipage/semantics.html#shared-declarative-refresh-steps); image-set string handling follows [CSS Images Level 4](https://drafts.csswg.org/css-images-4/#image-set-notation). These are syntax scans only: the probe does not follow any discovered resource URL.

## Management in the console (decision 75)

Owner decision 75 (2026-10-31): administrators manage the Hub from the browser. Decision 77 keeps four of the operations
as console pages under `/console/operations/`: adding a member (`member-add`: `user create`, then `user invite`, the
initial password and invitation code shown once with this Hub's Circle entry for the standard authorization; or `token issue` for a client
without it), connecting a business system (`system-add`: `resource add`, then `secret set` for the credentials typed with
it), publishing a task pack (`pack-stage`, then `pack-publish` or `pack-discard`, below) and importing knowledge
(`knowledge-sync`). Every
other operation (disabling a member, disconnecting a Circle, a spare login token, changing or withdrawing a credential,
switching a system or a product pack, use and maintenance of a pack, retiring a version, an environment, the stopping
platform commands) is a button that opens a dialog with its `circle-hub` command and the real ids, for the administrator's
Circle on the Hub's host (`console/commands.ts`). The actions of decision 75 stay as they were; `/console/admin` shows the
settings page, `/console/admin/calls` the records, and `/packs`, `/resources`, `/secrets` and `/knowledge` the task packs,
connections, settings and the import page. Every action is a POST form
to `/console/admin/do/<action>` (`console/manage.ts` `ACTIONS`): this server's own origin, the session's CSRF token and
an administrator's session, else 403 or the neutral 404. It runs the matching `circle-hub` command through the command
bridge (`command-bridge.ts`): the CLI's `main()` in this process with serve's own `CIRCLE_HUB_*` environment and the
session's token as `CIRCLE_HUB_TOKEN`, so the command acts as that administrator with the same checks, records and
messages as `CIRCLE_HUB_TOKEN="$T" circle-hub …`, and its output is the result page. Only `user`, `token`, `pack`,
`resource`, `secret` and `knowledge` are bridged; backup, restore, deploy, rollback and every other platform command
stop the server and stay on the command line. A positional from a form never starts with `-`, flag values go as
`--flag=value`, and a secret value reaches `secret set` through the command's `readSecret`, never argv or the
environment. A pack is uploaded as a zip (`console/upload.ts`: a multipart body read within the upload limit, then a
zip reader over node:zlib that inflates each entry within its declared size and checks its CRC-32, refusing traversal,
symlinks, ZIP64 and encryption) and unpacked into a private temporary directory. Publishing is two steps (owner-confirmed
item 5): `pack-stage` runs `pack publish <dir> --stage --dry-run` (every check of publish, nothing written) and keeps a
passing upload as a stage (`console/staging.ts`: in memory, 30 minutes, at most 10, removed on expiry, after publishing or
discarding, and when the app closes); its page lists every check and the difference from the pack's highest version not
withdrawn (files added, removed and modified by digest). `pack-publish` with the stage id runs `pack publish <dir>
--stage` if pack.json still has the digest that passed, and `pack-discard` drops the stage; only the administrator who
staged it may do either, and an unknown, expired or foreign stage id gets the neutral page. The private directory never
appears on a page.
Knowledge sync runs as a background job of this process (`JobStore`, the last 50, listed with their output; they end
with the process, their records stay). A token issued here is shown once on the result page.

The first administrator: `circle-hub setup-code` (refused once an administrator exists) prints a one-time code and
keeps its SHA-256 in `<data dir>/config/setup-code.json` (0600, 24 hours). `/console/setup` takes the code, a username and an optional password
while no administrator exists (its own nonce cookie, own origin), creates the administrator with `bootstrapAdmin`,
removes the code and shows the administrator's access token once; that token only connects a Circle. No session is
opened: the administrator signs in with the username and password like every account. A generated initial password is
also shown once and requires a password change before any data page, management action or stream can be used. The sign-in
page links there while no administrator exists.

## CLI

`hub/server/cli.ts` exports `main(argv, overrides?): Promise<number>` and never runs on import (bin/circle-hub calls it
after `hub/config/guard.ts`). A retired `CIRCLE_SERVER_*` variable refuses every command (names only, never values).

```
circle-hub serve [--migrate-only] [--migrate]
circle-hub user create <name> [--role <permission_role>]              # no admin yet: bootstraps the first admin, its token shown once
circle-hub user list | user disable <user> | user enable <user>
circle-hub token issue <user> [--label <l>] [--raw] | token revoke <tok_…> | token list [<user>]
circle-hub logs export [--from <time>] [--to <time>] [--user <u>] [--tool <t>] [--run <r>] [--out <file>] [--as <account>]
circle-hub run list [--pack <id>] [--user <user>] [--state 受理|未受理|进行中] [--since <ISO time>] [--unknown] [--limit <N>] [--cursor <cursor>] [--json] [--as <admin>]
circle-hub run show <run> [--json] [--as <account>]                   # the assembly module's assembleCommand
circle-hub setup-code                                                 # no admin yet: a one-time code for /console/setup, shown once
circle-hub <platform command>                                         # init, db, key, service, backup, restore, deploy, rollback, rehearse, status, tls
circle-hub pack|resource|secret|knowledge|init-admin|operator-token … # registered by the assembly module
circle-hub knowledge retract (--entry <记录摘要> | --run <运行> | --object <对象摘要>)… --reason <一行原因>
```

`knowledge retract` is an administrator command (the operator token, same as `knowledge sync`). It appends one `retraction@1` per target kind through `FeedingLayer.retract`. A retraction does not delete or rewrite the original record; the read side then shows the grounds as withdrawn. A target that already has a retraction record is not appended again.

Records commands open the records as the runtime role without migrating. **State-changing built-ins** (`user create`
once an admin exists, `user disable|enable`, `token issue|revoke`) act as the enabled admin of the **operator token**,
exactly as the assembly's commands do (`operatorAdmin(ctx)` and `operatorAct(ctx)` of `cli-admin.ts`, loaded only when a
command needs them): `CIRCLE_HUB_TOKEN` for one command (`CIRCLE_HUB_TOKEN="$T" circle-hub …`), else the deployment's
keychain item (account `operator-token`, written by `init-admin`, `operator-token set` or `operator-token reissue`). No
token, an invalid one or a user's is refused before anything is read or written, with a fix that works without the
token: a lost or dead item is replaced by `operator-token reissue` (assembly README). `--as` is a usage error for them
(who acts is the token's account). Revocation is never refused (it is how a leaked token is stopped); when `token revoke`
or `user disable` cuts off the very token the command acted with, the command says so on stderr with the way back.
**Read-only built-ins** that read as an account (`logs export`, `run show`) follow the assembly's listings
(`operatorViewer`): they read as the operator token's account when there is one (`--as` must then name it) and take it
out of the environment; without a token as `--as <name or id>`, or the only enabled admin. `run list` is also read-only,
but only an administrator may run it: a non-admin token is refused before any run is read. It lists stored runs through
the existing run and validation-result indexes (no new storage) and does not print submission bodies, quotes or
credentials. Each line is the run id, `pack@version`, the initiating user (the runner, or 未声明 when the run has none),
the start time, the verification state of the newest validation result (受理, 未受理, or 进行中 when there is no result),
terminal counts per requirement, and the unknown count. Those counts come from the newest accepted result; without one
they are 无 and 0. `--limit` defaults to 50 and stops at 500. Rows are newest first. When more rows match, the text ends
with the next-page cursor and `--json` returns it as `next`; the command does not drop the rest quietly. `--pack` is the
pack id (`@version` is ignored). `--user` is a name or id. `--since` is an ISO time on `started_at`. `--unknown` keeps
rows whose unknown count is at least 1. `--cursor` continues the same filters. `user list` and `token list`
show every account. A token is printed exactly once, when it is issued (or bootstrapped); `token issue --raw` prints the
token and a newline on stdout and nothing else there (the confirmation goes to stderr), so `TOKEN=$(circle-hub token issue
alice --raw)` captures it without it reaching a log; listings never show token values. `logs export` writes the viewer's
view as JSON Lines (an admin's: every call with its admin note; a user's: their own calls, records' rule) to stdout, or to a
new file with mode 0600 (never overwritten). `run show` builds its dependencies with the assembly module's
`assembleCommand` (no vault master key, no sandbox probe, its log lines on the CLI's stderr), never serve's `assemble`; a
module without it refuses with `AssemblyMissingError`. Stored text the built-ins print (item ids and labels from users'
documents, build and pack names, user names, token labels) passes `terminalSafe`, and their JSON (`run show --json`, `run list --json`, `logs
export`) `jsonSafe`, which writes the DEL, C1, line-separator and bidirectional characters JSON.stringify leaves raw as
`\u` escapes (the same JSON values). `registerCommand(command)` (or `registerCommands(register)` of the assembly module)
adds commands; built-in and platform names cannot be replaced. Exit codes: 0 ok, 1 failure, 2 usage (platform status
commands may give 3).

**`CIRCLE_HUB_TOKEN`.** CLI commands accept the name (`loadServerConfig(env, {command: true})`, hub/config's
`allowUnknown`), and the value is read only for the operator token. Platform commands get the name in `allowVariables`
and an environment without it: the token is taken out of the CLI's environment first, so neither the platform nor what
it starts (a deploy's git and npm, whose install scripts would see it) gets it. `serve` (with `--migrate-only` too)
**refuses** to start while the name is set, empty or not, with a message that names it and never its value. Refusing
rather than removing it: a server never acts as an admin, so a token in its environment can only be a shell export
leaking into a long-lived process; removing it silently would leave it exported for every other program that shell
starts, and a process started with it may keep the initial environment in its memory (unsetenv does not erase it). The
LaunchAgent's environment never has it.

`serve`: configuration through `loadConfig` (hub/config) with the platform's own names accepted and `CIRCLE_HUB_TOKEN`
refused; when the database is the platform's cluster (its socket directory is `<data dir>/run`) `ensureHubDatabase(env)`
starts it (never initialises it); the vault key provider is `hubKeyProvider(env)`; records open as the runtime role with
`migrate: false`; then `repairFiles`, `sweepOrphans()`, the assembly module's `assemble`, `listen()`. While serving, an `unhandledRejection` anywhere in the process
is reported to the operator's log instead of ending the process (defence in depth; the request path never leaves one);
the listener is removed when serving ends. Every line of serve's operator log (the app's and these) passes
`terminalSafe`, one line each: a line may quote what a caller sent, which must neither fake a log line nor steer the
terminal of an operator reading the log (the assembly's own lines are escaped in `CallNotes.log`). SIGTERM or SIGINT closes the app (requests in flight end, then the cut-off
handlers, bounded), then `stopAll()` of the sandbox and the records; the cluster keeps running. `--migrate-only` applies
the migrations as the owner role and grants the runtime role (`CIRCLE_HUB_DATABASE_USER`) exactly `RUNTIME_GRANTS`
(records decision 16), then exits 0; the owner role is the operating-system account's own role (the cluster's role under
hub/platform's peer map). When the owner and the runtime role are the same, it migrates without granting and warns.
`--migrate` migrates with the connecting role before serving (a single-role development setup).

## Decisions

1. `submit_result` is never refused by the server on its schema: the arguments as received go to
   `RunsService.submitResult`, which stores them and answers `SUBMISSION_SCHEMA_VIOLATION` with paths (W07, B05 R[3],
   contracts README).
2. Invalid arguments of the five other tools are tool results (`isError`, `SUBMISSION_SCHEMA_VIOLATION`, empty shape),
   not JSON-RPC -32602, as the brief asks; unknown tool names are -32602.
3. An answer that would violate its output schema, and an untyped exception, are JSON-RPC -32603: an internal failure is
   not a tool result, and no registered code exists for it.
4. The content is one plain-text block (D05 R[0] and display rule 11 outrank the MCP specification's SHOULD of a second
   block with the serialized JSON for clients that ignore structuredContent); the text is written to be enough on its
   own. Open question for the owner below.
5. One SDK `Server` per request and one JSON-RPC message per POST: stateless mode, no session state, no batches, no
   server-initiated notifications (`listChanged: false`); a client re-lists tools to see assignment changes.
6. Console sessions live in memory: a restart signs everyone out. The token is kept server-side, the cookie is a random id.
7. The run of a call-log line is taken only when it is a well-formed run id (the `run` argument, or the `start_run`
   answer).
8. A `release.json` that exists but is not a release record refuses to start (a broken release must not look healthy).
9. The tools read the arguments from the server's own parse of the body, never the SDK's validated copy, so the call log,
   the schema check and the runs service see the same object.
10. Contribution schema identifiers come from contracts. Every revision passes the product/source gate; an unsupported
    revision fails closed rather than falling through to generic administrator access.
11. **The server pages content by cursor.** Every text gets `paging: true`; a page cursor is bound to the canonical
    reference the content names and checked once the reference resolves (so a reference that does not resolve answers
    as it would without a cursor). The ranges and text@1 lines of a text without paging stay valid references.
12. **start_run's text uses the engine's detail** (`ServerDeps.runsDetail`, an optional extra filled by the assembly)
    rather than a port change: the production result is passed to the text only when it is the one the answer's
    `result` names; a submit's stored record is looked up after the answer (a failed lookup changes nothing but the way
    to read the rest).
13. **Items are located by one rule** (the text says once how a location follows from the item id) instead of a
    location per item: the ItemProjection.summary contract (id, label and summary only for a long list).
14. **serve refuses `CIRCLE_HUB_TOKEN`**, CLI commands accept it, platform commands never get it (see CLI).
15. **State-changing built-ins act as the operator token's admin** (no `--as`), as the assembly's commands do; `run show`
    uses the module's `assembleCommand` only.
16. **Read-only built-ins read as the operator token's account** (`logs export`, `run show`), as the assembly's listings
    do, so one shell has one identity whatever the command; without a token, `--as` or the only enabled admin.
17. **Revocation is never refused** (`token revoke` of the operator token itself included: a leaked token must be
    stoppable at once); the command then says the operator token no longer works and how to get a new one
    (`operator-token reissue`). Asking before is not possible without the token id of an authenticated token (see Needs).
18. **The knowledge views do not make start_run open-world**: the server names their system (`KNOWLEDGE_VIEW_SYSTEM`,
    pinned by a test to hub/knowledge's `VIEW_SYSTEM`) instead of importing hub/knowledge, as decision 10.
19. **A valid answer is never lost to its text** (`fallbackText`, the reason in the admin note).

## Limits

- No per-user rate limit or concurrency cap; the process-wide body budget bounds the memory request bodies take. An
  explicitly configured internal listener needs network restrictions and, if required, a TLS proxy.
- `handler` used without `listen()` checks Host against `config.port` (0 accepts nothing).
- The upload's structure summary parses on the event loop (up to 16 MiB); media type sniffing is heuristic.
- `tools/list` asks `WorkflowStore.summaries` once per call and, when no input slot is external, `forUser` once per
  assigned pack to see `expected_sources` (see Needs).
- The content of a large source read by reference is in the text and in structuredContent, as MCP gives both; the JSON of
  the whole answer is no longer sent a third time.
- The knowledge page asks `builds` and `currentRoot` per version line (fine for tens of lines).
- The run page shows each submission up to 256 Ki characters; the rest stays in its record.

- **Circle 技能主目录的边界**（`scripts/real/circle-home.ts --profile skills`）：glob 守卫在执行前核对路径；判定与实际 glob 之间仍有时间窗口，只有能够创建软链接或改名目录的进程才能利用它。这个主目录的信任前提是：只安装集成者按包清单摘要核过、并通过下述检查的技能代码。模型的直接写文件、改名工具均被拒；execute 仅放行这些已安装脚本的路径和限定参数，不是通用命令入口。脚本的摘要核对及安装由集成者负责。
  安装前须对发布目录运行 `node scripts/real/skill-script-safety.ts <发布目录>…` 的清单扫描；它核对原始文件摘要，覆盖脚本、辅助模块和内联技能钩子，拒绝建链接、目录改名、保留链接的复制，以及无法静态核对的代码入口。`scripts/real/skill-script-safety.test.ts` 测试这个门禁。新增调用须由集成者显式复核；登记绑定文件路径、具体调用及整个所在方法的源码片段摘要，片段变化即失效，不按函数名整体放行。
  Jev 的普通临时文件原子替换由集成者在 2026-10-24 单独复核：它不能创建软链接，目标是目录时 rename 失败。外部进程不在这个专用主目录的威胁模型里。仓库测试自动发现包清单中带客户端 tools 的包，并扫描清单里的全部脚本和辅助模块、内联技能钩子；必须包含 case-compile 的客户端工具和 Jev 所在的 knowledge-contribution 包，缺包或空覆盖都会失败。每条调用点登记也必须在扫描范围内恰好用到一次。运行 `node --test --test-concurrency=1 scripts/real/circle-home.test.ts scripts/real/skill-script-safety.test.ts` 核对这条边界。

## Tests

```sh
node --test "hub/server/**/*.test.ts"
npx tsc --noEmit
```

Every test uses a temporary PostgreSQL from `hub/testing/postgres.ts` (one cluster per file, a fresh database per server),
temporary directories, synthetic packs and fakes (`hub/server/fakes.ts`: an invented product line, invented commands,
192.0.2.0/24 addresses), operator tokens in memory (never the owner's keychain) and loopback only. `mcp.test.ts` (SDK
client over streamable HTTP, raw POSTs where the SDK would not send the body): every tool's happy and error paths;
initialize; schemas and annotations equal to `tools.json`, `start_run` closed-world without an external input and for a
pack whose inputs take only the knowledge views, open-world for one that also takes an external type and for a pack with
upload-only inputs and expected sources; the isError matrix with every answer checked against
its zod output schema (the SDK client checks the published schema) and one plain-text block; absent equals forbidden for
every tool (byte for byte apart from the trace); the admin note; call-log lines with trace, session, run and receipt and no
argument content (records and JSONL files); traceparent and session handling; token revocation and account disabling; 24
concurrent calls; service answers that violate their output schema and thrown errors; `__proto__` reaching
`submit_result` and the same digest in the call log; the content text (source text, 60 items as id | label | summary with
the location rule said once, the compact slot schema and where the whole one is, claims under their requirement, the
stored result named); paging through the server: a 4,000-line source read on with the `下一页` cursor every note gives
(every line once; a cursor of another reference or a text that is none refused at `/cursor`, root, paths and depth beside a
reference refused, an absent reference with a cursor still neutral), 3,000 start_run items read from the run record with
the note's cursor (every item once, in order), the item details of a 1,200-item receipt read from its stored result by
cursor, a receipt that is not accepted naming its record; the empty partitions of a stored result read by reference and
an empty cursor read as none (reference and subtree); a stored-result lookup that throws or finds nothing (the receipt
stands, no record named, the reason in the admin note); a production run's text (counts, per-requirement counts,
problems, the whole result readable by reference), a production result the text cannot lay out (the minimal text, the
reason in the admin note, the call logged as answered) and the evidence gaps of the engine's detail; a server without
`runsDetail`; records by reference (admins and `admins: false`, the `received` submission shape, the contribution layer);
a refused batch with a duplicate id and a cancellation (nothing ingested, one line per request); notes cut in a
surrogate pair or quoting NUL, and a note records refuse. `text.test.ts` and `budget.test.ts`: the texts of 5 to 3,000
items through the real text functions (budget, facts first, the note, cursors, ranges, example calls), empty partitions,
item lists and arrays read by reference, a cursor offset inside a surrogate pair (first page, said; the offsets around it
are positions), the fallback text, and through the server the cursors it offers and the ranges a text without paging
gives, both read to the end. `http.test.ts`: `/healthz` and release.json; raw request targets (`//`, `///`, `//?x`, `//:80`, `//a:b`,
`//x/healthz`, `POST //x/mcp`, `http://a:b/`, `http://%zz/`, `*`, absolute form of this server, of another host and with
user information) with no unhandled rejection; Host, missing Host, Origin and DNS-rebinding refusals; the same 401 for
five kinds of bad credentials; 405, 415, 400, 406; one transport_failure line per refused request (and none for a GET or
a notification); a body that is not UTF-8; bodies over the cap (declared and chunked); the body budget (503, Retry-After,
freed again); close with a request in flight and with a handler slower than the deadline (its line is written before
close() resolves). `console.test.ts`: CSP, cookie flags, CSRF (missing, mismatched, forged, reused nonce, other origin,
`Origin: null`, other media type), sign-in and sign-out with the Origin a browser derives under the pages'
Referrer-Policy, bad tokens, sign-out, revocation ending a session, the run page (partitions, item cells, the three
groups, not applicable, unknown symbol and colour, display order, submissions marked unverified, call log), XSS payloads
in case labels, finding text, session ids and user names, neutral pages, knowledge pages and visibility, packs, admin
pages. `cli.test.ts`: retired names in-process and through `bin/circle-hub`, configuration errors, migrate-only as the
owner role with the runtime role granted (it cannot DELETE or disable triggers), serve with a placeholder module and
with an assembly (and its unhandled-rejection listener while serving, its operator log one escaped line even for an error
quoting a line break and control sequences; the server stops in a `finally`, so a failed check fails the test instead of
keeping the process alive), serve refusing `CIRCLE_HUB_TOKEN` (empty too, never printing it), users and tokens as the
operator token's admin (refused without a token, with a user's or an invalid one, nothing changed; `CIRCLE_HUB_TOKEN` for
one command and taken out of the environment; `--as` a usage error), `token issue --raw` (in-process, and in a child
process given the admin token as `CIRCLE_HUB_TOKEN`, never on its command line: stdout is the new token and one newline),
log export, `logs export` and `run show` as the operator token's account (`CIRCLE_HUB_TOKEN` or the item; a user's token
reads their own calls without notes; `--as` of another account refused; without a token `--as`), stored text with control
sequences, a line separator and a bidirectional control in item ids and labels, build and pack names, user names and
token labels shown as escapes by `run show`, `user list` and `token list`, and `run show --json` and `logs export` (stdout
and file) escaping what JSON.stringify leaves raw with the same JSON values, run show through `assembleCommand` (never
serve's `assemble`), reserved and registered commands, platform delegation with `CIRCLE_HUB_TOKEN` accepted and removed.
`units.test.ts`: traceparent, sessions, base64, media types, escaping, the CSP hash, origins, request targets, admin
notes, the body budget, session expiry, claim display order, terminal symbols, item cells, the run of a record, pointers,
the knowledge views as types bound like external objects but read inside the Hub (the system name pinned to
hub/knowledge's). The assembly's own tests are listed in `assemble/README.md`; the engine's answers that the start_run text
uses are tested by the engine (`hub/runs/engine/start-result.test.ts`).

## Deviations from the brief

- **submit_result** is not parsed by the server (decision 1); the brief says every handler parses its input.
- **serve migrates only with `--migrate`**: the task text says main.ts migrates unless disabled, but records decision 16
  and the platform contract run the Hub as the runtime role with `migrate: false` and migrate in `serve --migrate-only`.
- **ensureHubDatabase** is called only when the database is the platform's own socket (`<data dir>/run`); a server
  configured with another database (tests, development) never touches a cluster.
- **Call log**: protocol methods are logged too (B08: every MCP call), and transport refusals of authenticated callers;
  a GET is not (it is the client's probe the specification answers 405, in every session); no `argsPreview` is produced
  (brief: digest and size only; records' open question on B08 F[7]).
- **Batches** are refused (decision 5). A client that negotiated protocol 2025-03-26, which still had batching, must send
  one request per POST; the SDK clients do.
- **Console form posts** must come from this server's own origin (stricter than "a loopback origin"): SameSite does not
  separate ports, so another local web page could otherwise post the login form.
- **CLI**: `user enable` was added; `logs export` is the viewer's view (an admin's has the admin notes). The
  state-changing built-ins take no `--as` (they act as the operator token's admin); the read-only ones keep it, and with
  a token it may only name the token's account.
- **`token revoke` of the operator token itself** is carried out and then said (decision 17), where a reviewer asked to
  refuse it or ask first: refusing would block stopping a leaked operator token, and asking first needs records to say
  which token authenticated (Needs).
- **`serve` refuses `CIRCLE_HUB_TOKEN`** instead of removing it (the task allowed either; reasons in the CLI section).

## Needs from other packages

- **runs**: export the record visibility rule of the engine (its `recordReader`, or a "run of record" predicate) from
  `hub/runs/api.ts`, so the server uses one rule instead of restating it in `readers.ts` (`runOfRecord`); until then the
  server follows the engine's kinds and shapes (the engine's `readers.ts runOfRecord` takes `run` first, as the server
  does). `canSeeRun` is exported already.
- **records**: `checkVaultKey(vault)` was added to `hub/records/api.ts` as a function over `Vault.get` (this package may
  edit only `api.ts`, not `vault.ts`); a `Vault.checkKey()` method in `vault.ts`, if records prefer it, would replace it.
- **contracts / runs**: a `reads_external` flag on `PackSummary` (an external input slot or `expected_sources`), so
  `tools/list` does not load every assigned pack to derive `start_run`'s open-world annotation; the engine knows which
  of a pack's sources are the Hub's own knowledge views and which reach an external system (an `expected_sources`
  function that returns only knowledge views still counts as reading outside here).
- **contracts / knowledge**: the system name of the knowledge views (`knowledge`) as a constant of `contracts/src/views.ts`,
  so hub/knowledge (`VIEW_SYSTEM`) and the server (`KNOWLEDGE_VIEW_SYSTEM`, pinned by `units.test.ts`) use one.
- **records**: optionally, the token id of an authenticated token (for example `authenticate` answering it beside the
  Principal), so that `token revoke` could ask before revoking the operator token itself instead of saying so after
  (decision 17).
- **knowledge**: (1) `builds` and `diffRoots` take no principal, so the server checks the reader's lines first; a
  principal-aware variant (like `getNodes`) would keep the check in one place. Contribution readers use the schema id
  exported by contracts and filter through the knowledge layer.
- **platform**: confirm the owner role of `serve --migrate-only`: the server uses the operating-system account's own role
  and grants `CIRCLE_HUB_DATABASE_USER`.
- **records/contracts**: a protocol code for an upload over the size limit (already requested by records); the server
  answers `SUBMISSION_SCHEMA_VIOLATION` at `/file_path` until then.
- **owner**: confirm decision 4 (content is plain text only, no second block with the JSON of the answer) against the MCP
  specification's backwards-compatibility SHOULD; if clients that ignore structuredContent must be served, a size-capped
  JSON block can be added back. Measured on the real Circle client: only the text reaches the model.

## 包内本地工具的原字节下载

`/local-tools/<包>@<版本>` 返回发布清单的规范 JSON 字节，包号是其 SHA-256；后接清单路径时返回该文件的原字节，连同 Content-Digest 和 ETag。每次请求先核 Bearer 令牌，再经 WorkflowStore.forUser 核对版本分配和下架状态；版本必须带 tools/。无权、不存在、下架、没有工具、清单外路径、穿越路径和编码斜杠的回答字节相同。真实原因只写在管理员日志：版本不存在、未分配、已下架、账号停用、没有本地工具、清单外路径、路径含 `..`、编码或保留字符、版本引用格式不对，各记各的。同一进程里，一个用户和一个版本在一分钟内复用已经核对过的解包，避免按文件把整包再哈希一遍；这一分钟里每次请求仍问分配和下架，发出去的那个文件仍重算 SHA-256。共享 Host/Origin 检查先行，出口只收 GET/HEAD，不经过 MCP、不增加工具。

发送前重新核对摘要和大小，存储被改动时不给文件字节并记管理员日志；调用日志只留包号、引用及路径的摘要与长度，不留令牌、文件内容或原路径。下发不改写、不重新打包；客户端运行结果仅为“客户端预览”，Hub 沙箱中的重算核验算数。Circle 没有为此新增界面。

客户端用 `circle-hub local-tools install <包>@<版本> --digest <包号> --into <目录> [--hub <地址>]` 安装。令牌仅从标准输入读取，不接受令牌参数或环境令牌，不打开数据库或钥匙串；没有部署锁时只允许回环，已有数据根的部署设置可锁定内网 IP 和端口，环境冲突或指定不同地址在读令牌之前拒绝。下载直连该字面 IP，不走环境代理、不跟随重定向；内网 HTTP 明文令牌可能被网络观察者看到。先钉住规范清单的包号，再按清单下载全部原文件并重算大小、摘要及响应完整性头；同级私有临时目录全部通过后才改名，任一失败清理临时产物。SIGINT 和 SIGTERM 会删掉这份临时目录。上次安装留下的锁目录，以及所属进程已经不在的临时目录，由下一次安装清掉；所属进程还在的临时目录留着。已有目标相同时答“已安装”，不同时拒绝，不覆盖。改名撞上已有目录时，按那份目录再核对一次。连不上 Hub、令牌无效、版本不可用、完整性不符和本地写失败，各有自己的下一步，不都说成 pack.json。

`circle-hub local-tools verify <目录> --digest <包号>` 必须带包号。先比目录里 pack.json 的 SHA-256 和这个包号，不等就失败；再按 pack.json 重算每个文件，指出第一处不符的路径并列出多出的文件。只读，不联网，拒绝链接。清单里某个文件的摘要或大小不符时，报的是这个文件的路径。它也能核对集成者手工安装的完整清单目录。同步修改清单和文件会得到另一个包号，用发布时的包号核，这一份过不了。输出只含包号、版本、文件数、字节数及不符路径，不含文件正文或令牌。没有运行任何下载代码。

读取说明收尾（hub-read-absence）：管理员备注上限 2,000 字，MCP 当前只写理由条数和管理员详情入口，不拼接理由原文。MCP 把每条完整理由分别交给 CallLog，迁移 4 的 call_reasons 在同一调用事务中一次批量写入；管理员查询与控制台“完整理由”展示它们，普通读者、调用记录正文和 JSONL 均不带完整理由。理由按序、只追加，重复 span 不重写；NUL 与不成对代理项先规范化。结果记录引用重查两次仍缺时，给出的是缺少引用这一事实，不改已经算出的校验结果；同一提交再交可恢复引用而不多算修复轮。缺陷计数的持久口径是上述 metric=1 理由行数，按追踪／运行归属查询，不另向模型回显内部异常。

结构摘要超过文字预算时，get_nodes 按实际结构行与行内偏移分页，用同一引用的 cursor 续读，不伪造原文件字节区间，也不把摘要称为原文；通用预算的回退说明仍带可读入口。旧适配器不声明 cursor 能力时不能凭空承诺分页，需要提供可公开的结构摘录入口。

Needs：登录停止的具名管理员请求、处置后的自动重读等 hub-unknown-exits 的请求记录接口；未接入前不声称已发出请求。按运行开始时授权读取冻结输入的第 9 条仍等整合者通知相关依赖合并，本分支没有改成绕过当前查看权限。

首轮复核补充：管理员理由只在数据库私有字段查询；calls JSONL 和重建路径均不序列化私有摘要或完整理由，短理由也不例外。

可重试读取的下一次时刻统一由本次调用的 Hub 时钟计算；get_nodes 按引用读取也向解析器传入同一时钟，不另取 Date.now。

喂入清单、冻结序号与未知出口也受同一个 30,000 字符回答预算约束；它们在正文渲染和降级渲染后统一布局，保留回执、原有补读说明与追踪尾行。超长说明明确标记省略，完整结构仍在 structuredContent。

Independent integration review: Antigravity reviewed fixed merge `2967a45b` without executing tests or contacting a
system. The reviewer found no static blocker in the procfs header fix, service ownership checks, or integration of the
Linux unavailable-memory path. Synthetic Mac/Linux test results remain separate from this source review and do not
establish target-server, real-user or production-network behavior.

个人知识的目录或整个空间授权不包含版本审计历史；本人可以列出历史，被授权者页面明确说明历史仅本人可见。个人引用统计同样只给本人，HTML 与 `/console/api/knowledge/node` 共用所有者检查和个人索引；授权读取内容不授予读取统计的权限。

第三阶段以全部实际读者检查替代第二阶段的临时个人依据拒收：个人条目和原文可按当前授权读取，结果的每个依据及底层来源须对全部结果读者可读，否则返回 `RESULT_GROUNDS_UNREADABLE`。仅事实工作流与缓存回执同样检查；撤回使用读取包装中的 `grounds_withdrawn`，旧结果保持原字节。共享目录仍拒收无法完整检查的原文，使用 `SPACE_CONTENT_UNINSPECTABLE`，不误报为命中凭据。团队产品目录由 Hub 登记，版本记录不署为随机读取成员。

决定 88 的页面重做已取代第三阶段临时界面，移除“知识入库流程”卡片。空间栏与知识／记忆切换沿用当前权限，目录以名称层级显示；个人原文与条目分开列出。来源：所有者确认的决定 88 及任务页 `kw-console.md`。

第二阶段第二轮索引修正：`get_nodes` 搜索可返回 `warnings`（注册错误码、未检索范围、说明与处理办法），正文和控制台同时显示；可用匹配继续返回，不宣称全部范围已检索。单条索引及当前版本限额由 Hub 配置，产品与团队条目分别计量。超限或索引未完成不会让 `/console/search` 整页返回 500。团队页容量提示区分个人原文／历史容量、当前版本索引额度与仍保留的历史磁盘占用。


决定 88 第三阶段：“记录”页增加按授权人／接收人索引读取的个人知识与个人包授权历史。普通成员只看本人参与的授权；管理员仅看全体管理员授权，看不到成员间的授权。每次还核对记录正文的受众，错误索引不构成披露依据。提交共享只呈现安全元数据，管理员可见全部，成员只见本人；成员／时间过滤和各来源分页沿用当前页面，工具／运行过滤时不混入无关事件。团队目录显示为层级名称，拒收回执也显示目标；不展示提交原文、个人文件字节或未经处理的参数。
Run source information identifies uploader declarations: binding an own ordinary upload makes it readable to the run's
current actual readers in that run only. The console and MCP text show this scope; a bare source read gains no permission.
References the submitter could not read remain absent diagnostics. Reader checks do not rerun fragment parsers, and an
unreadable-reference observation in a stored result never authorizes reading the referenced body or a raw submission.

知识条目、节点、运行及结果的撤回提示仅列当前可读的引用；其他上级依据只给数量。控制台和 MCP 的文本、结构化返回均保留这项提示，不暴露其他目录或摘要。

The knowledge page switches between knowledge and memory while retaining the eight global navigation places. Memory
uses password sessions, the existing same-origin/CSRF form boundary and independent directory grants. Its plain-text
editor and history never execute Markdown; sharing previews write nothing and confirmation rechecks limits and
administrator changes. MCP memory modes stay within get_nodes and upload_file and return no evidence reference.
Personal workflows offer no named-document, business-system, lease or dispatch actions; team management is separate.
Memory audit views disclose only participant/all-administrator grants and safe share receipts, never private text.
Administrators also retain participant visibility for their own sent/received member grants, without seeing unrelated
member grants. Memory refusal actions and unchanged-write receipts are unavailable through generic rec: reads for every
role. The records page alone shows an ordinary owner's refusal code and generated field/line labels, never free-form
messages or payload/intent digests. Administrators see only bounded counts, filtered by record creation time and actor;
the count queries read index metadata rather than refusal bodies. Older refusal rows use the same existing actor index.
Client automatic loading and synchronization remain outside this Hub-side task.

Owners select only verified personal entries for batch sharing. Each entry has a read-only ordered preview and is checked
again independently at confirmation; a failure stops later checks and duplicate entries link to their actual team address.
Team rows show submitter, source and merge time. Administrator member metadata contains personal historical bytes and
current all-administrator grant counts only, without titles, content counts or personal version activity. Workflow cards
show assigned enabled member names to administrators, or the generated unassigned label when none remain. Members see
the team scope. Personal grant templates apply only to personal packs; administrator authority is unchanged.
Credential refusals disclose field names and line numbers without matched values.

Layout review of decision 88: received workflow/skill cards have their own group, and share history resolves readable
statements with team links or refusal reasons. Personal and team trees omit repeated namespace roots; counts derive
only from visible space rows or memory documents. Knowledge and memory use generated state chips, readable capacities,
grouped byte counts and minute-level local times. Version history is collapsed by default and uses descriptive names;
an ordinal appears only when the available history determines it. Source addresses remain unchanged.
Directory actions sit beside the title. Each grant dialog has one POST form for preview and confirmation, preserving its
selected audience and exact username through a same-origin/CSRF-protected redirect; confirmation rechecks authority.
Revocation uses a secondary or danger control. Narrow tables scroll within their own boxes, while state/time/count and
scope labels stay on one line. Synthetic layout captures are evidence for presentation only, not permission checks.

Decision 89 review item 5 masks cleared personal source directories in sharing receipts, team-entry provenance and
source links. Public team destinations, statements and safe receipt facts remain visible; immutable receipt bytes are
not rewritten. The marker comes from model 26 display metadata. Console contexts cache only the metadata flag for one
request, and both members and administrators retain the normal raw-record refusals. The real-Hub regression uses
synthetic console passwords through testConsoleCredentials and verifies team content remains available after purge.

Decision 89 step-2 review item 9 displays the generated local synchronization status in personal/all knowledge and memory views, with a CSRF-protected own-account return-to-Hub form. Local personal node/search/memory reads are empty, including a run started without a personal root. Team content and workflow execution remain available. The password-session form checks epoch and current state and starts a new empty epoch; it cannot target another member. Old forms and explicit private references never restore purged content. No sync HTTP route or extra MCP tool is exposed here.
