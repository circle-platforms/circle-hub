# hub/server

The MCP server, the read-only console, the HTTP surface and the server CLI of the Hub. Model elements: D05 (uniform
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
| `console/` | sign-in, sessions, CSRF, CSP, the pages (runs, run, knowledge, packs, admin, call logs) |
| `main.ts` | `serve [--migrate-only] [--migrate]`, `loadServerConfig` (serve refuses the operator token, commands accept it) |
| `cli.ts` | `main(argv)`: user, token, logs, run, platform delegation, `registerCommand` |
| `assemble.ts`, `assemble/`, `cli-admin.ts`, `testing-real.ts` | the assembly module (`assemble` for serve, `assembleCommand` for one command, `registerCommands`), the administrator commands and `operatorAdmin`, the real Hub for acceptance tests: see `assemble/README.md` |
| `docs.ts` | named documents (C4 of the device-pack core): `doc put/list/show` and the `doc:doc:` external ids answered by the Hub's own reader for runs of packs that declare them; see the module's header |
| `errors.ts` | `AssemblyMissingError` (a placeholder module, or one without the part a command needs), `UsageError`, `CliError` |
| `fakes.ts`, `testing.ts` | in-memory fakes of the ports and of the engine's extras, `createTestServer()` / `fakeDeps()` for tests |

## The HTTP surface

Only loopback: `createApp` refuses a non-loopback `config.host`; the default is `127.0.0.1` and the port comes from
`CIRCLE_HUB_PORT`. The request target is parsed once and never throws (`parseTarget`): an origin-form target is always a
path on this server, so `//x/mcp` is the path `//x/mcp` (404), never an authority `x` with the path `/mcp`; an absolute
`http://` target without user information is served by its path; anything else (`*`, a URL the parser refuses such as
`http://a:b/`) is 400 with `connection: close`. A request whose handling fails anyway is logged and answered 500; no
request can leave a rejection nobody handles. Every request then passes two checks, on every route:

- **Host** must be `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive; `[::1]:<port>` when listening on `::1`);
  the authority of an absolute-form target must be one of these too. A missing Host, another port, `localhost.`,
  `0.0.0.0` or any other name is 403 (DNS rebinding).
- **Origin**, when present, must be a loopback origin in canonical form (`http(s)://127.0.0.0/8|localhost|[::1][:port]`);
  `null`, paths and other hosts are 403. Console form posts must additionally come from this server's own origin.

Routes: `POST /mcp`; `GET|HEAD /healthz` (no token, `{"status":"ok","release":<id or null>}` with the id of
`release.json` in the code root, so a deploy tells the new process from the old one; a `release.json` that is not a
`circle-hub-release@1` record refuses to start); `/console/**`; anything else 404. Responses carry `nosniff`,
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
   result's run and submission digest (an answer stands when the lookup fails; the reason goes to the admin note).
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
  `declared`, visibility `{readers: [caller], admins: true, packs: [], shareable: true}` (B02 R[3]). A credential hit is a
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

Absent and forbidden give the same `SOURCE_UNAVAILABLE` ("对你不可用") answer with the same empty shape everywhere; the
tests compare the two answers byte for byte apart from the trace.

**Record visibility by reference (R02).** Records decides `source_artifact` records for everyone, admins included
(`Artifacts.canRead`: a read with a person's own credential, `visibility.admins: false`, is theirs alone, B02 R[3]). A
`claim` of the knowledge candidate layer (schema `knowledge-candidate@1`, named in hub/knowledge's README) is its owner's
alone, admins included (R02, K03 R[4]). Admins read every other record. A user reads the `run`, `submission`,
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

Server-rendered HTML, no JavaScript, no external assets; `Content-Security-Policy: default-src 'none'; style-src
'sha256-…'; img-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, the one stylesheet allowed
by its hash. Every dynamic value goes through an escaping template (element text or double-quoted attributes only;
links are fixed paths with encoded query parameters).

- **Sign-in**: `GET /console/login` issues a one-time nonce (server-side, 15 minutes) in the form and in a cookie
  scoped to `/console/login`; `POST /console/login` (form encoding, at most 8 KiB, from this server's own origin) needs
  the nonce in both and a token that authenticates. The session cookie `circle_hub_session` is a random id,
  `Path=/console; HttpOnly; SameSite=Strict` (no `Secure`: plain HTTP on loopback); the token stays in server memory and
  every page re-authenticates it, so a revoked token or a disabled account ends the session at the next page. Sessions
  end after 2 hours idle or 12 hours. `POST /console/logout` needs the session's CSRF token. Everything else is GET.
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
  call logs with user/tool/run/time filters and admin notes). Non-admins get the neutral page for admin pages, and absent
  or forbidden runs and roots give the same 404 "对你不可用".

## CLI

`hub/server/cli.ts` exports `main(argv, overrides?): Promise<number>` and never runs on import (bin/circle-hub calls it
after `hub/config/guard.ts`). A retired `CIRCLE_SERVER_*` variable refuses every command (names only, never values).

```
circle-hub serve [--migrate-only] [--migrate]
circle-hub user create <name> [--role <permission_role>]              # no admin yet: bootstraps the first admin, its token shown once
circle-hub user list | user disable <user> | user enable <user>
circle-hub token issue <user> [--label <l>] [--raw] | token revoke <tok_…> | token list [<user>]
circle-hub logs export [--from <time>] [--to <time>] [--user <u>] [--tool <t>] [--run <r>] [--out <file>] [--as <account>]
circle-hub run show <run> [--json] [--as <account>]                   # the assembly module's assembleCommand
circle-hub <platform command>                                         # init, db, key, service, backup, restore, deploy, rollback, rehearse, status
circle-hub pack|resource|secret|knowledge|init-admin|operator-token … # registered by the assembly module
```

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
out of the environment; without a token as `--as <name or id>`, or the only enabled admin. `user list` and `token list`
show every account. A token is printed exactly once, when it is issued (or bootstrapped); `token issue --raw` prints the
token and a newline on stdout and nothing else there (the confirmation goes to stderr), so `TOKEN=$(circle-hub token issue
alice --raw)` captures it without it reaching a log; listings never show token values. `logs export` writes the viewer's
view as JSON Lines (an admin's: every call with its admin note; a user's: their own calls, records' rule) to stdout, or to a
new file with mode 0600 (never overwritten). `run show` builds its dependencies with the assembly module's
`assembleCommand` (no vault master key, no sandbox probe, its log lines on the CLI's stderr), never serve's `assemble`; a
module without it refuses with `AssemblyMissingError`. Stored text the built-ins print (item ids and labels from users'
documents, build and pack names, user names, token labels) passes `terminalSafe`, and their JSON (`run show --json`, `logs
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
10. The candidate layer is recognised by its schema id `knowledge-candidate@1` (named in hub/knowledge's README) rather
    than by importing hub/knowledge, so that loading the server does not load the knowledge package.
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

- No per-user rate limit or concurrency cap; the process-wide body budget bounds the memory request bodies take, and the
  server is reachable from loopback only.
- `handler` used without `listen()` checks Host against `config.port` (0 accepts nothing).
- The upload's structure summary parses on the event loop (up to 16 MiB); media type sniffing is heuristic.
- `tools/list` asks `WorkflowStore.summaries` once per call and, when no input slot is external, `forUser` once per
  assigned pack to see `expected_sources` (see Needs).
- The content of a large source read by reference is in the text and in structuredContent, as MCP gives both; the JSON of
  the whole answer is no longer sent a third time.
- The knowledge page asks `builds` and `currentRoot` per version line (fine for tens of lines).
- The run page shows each submission up to 256 Ki characters; the rest stays in its record.

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
`runsDetail`; records by reference (admins and `admins: false`, the `received` submission shape, the candidate layer);
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
  principal-aware variant (like `getNodes`) would keep the check in one place. (2) The server keeps `knowledge-candidate@1`
  claims private to their owner, admins included, by that schema id (your README's request); tell the server if it
  changes, or export it from a module that does not load the whole package.
- **platform**: confirm the owner role of `serve --migrate-only`: the server uses the operating-system account's own role
  and grants `CIRCLE_HUB_DATABASE_USER`.
- **records/contracts**: a protocol code for an upload over the size limit (already requested by records); the server
  answers `SUBMISSION_SCHEMA_VIOLATION` at `/file_path` until then.
- **owner**: confirm decision 4 (content is plain text only, no second block with the JSON of the answer) against the MCP
  specification's backwards-compatibility SHOULD; if clients that ignore structuredContent must be served, a size-capped
  JSON block can be added back. Measured on the real Circle client: only the text reaches the model.

## 包内本地工具的原字节下载

`/local-tools/<包>@<版本>` 返回发布清单的规范 JSON 字节，包号是其 SHA-256；后接清单路径时返回该文件的原字节，连同 Content-Digest 和 ETag。每次请求先核 Bearer 令牌，再经 WorkflowStore.forUser 核对版本分配和下架状态；版本必须带 tools/。无权、不存在、下架、没有工具、清单外路径、穿越路径和编码斜杠同形返回。共享 Host/Origin 检查先行，出口只收 GET/HEAD，不经过 MCP、不增加工具。

发送前重新核对摘要和大小，存储被改动时不给文件字节并记管理员日志；调用日志只留包号、引用及路径的摘要与长度，不留令牌、文件内容或原路径。下发不改写、不重新打包；客户端运行结果仅为“客户端预览”，Hub 沙箱中的重算核验算数。Circle 没有为此新增界面。
