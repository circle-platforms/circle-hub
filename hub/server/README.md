# hub/server

The MCP server, the read-only console, the HTTP surface and the server CLI of the Hub. Model elements: D05 (uniform
response), D06 (the six tools), B08 (call log), R01 and R02 (roles, visibility); brief sections 3, 6 and 9. The server is
built against the ports of `hub/ports.ts` (RunsService, KnowledgePort, WorkflowStore, PackCatalogPort,
ResourceCatalogPort) and the real phase 1 packages (records, refs, rules, config, platform); the console uses the pure
`itemCell` of `hub/runs/api.ts`. The assembly step of the next phase plugs in the real runs, knowledge and connectors
packages; until then `hub/server/assemble.ts` is a stub.

| File | Content |
| --- | --- |
| `api.ts` | `ServerDeps`, `HubApp`, `AppOptions`, `AssembleFunction`, `AssemblyModule`, `CliCommand`/`registerCommand`, `ServerCallContext`; re-exports `createApp`, `main`, `serve` |
| `app.ts` | `createApp(deps, options)` → `{ handler, listen(), close(), release }`: the request target parsed once, routes, Host and Origin checks, `/healthz`, the body budget, graceful close |
| `mcp.ts` | `POST /mcp`: bearer token per request, bounded body, one JSON-RPC request per POST, one SDK `Server` + stateless JSON transport per request, call-log lines |
| `tools.ts` | the six tools: input parsing, server-owned semantics, delegation, output validation, isError, annotations per caller |
| `text.ts`, `claims.ts` | the Chinese content text (first line: receipt, partition counts, unknown count), claims in `DISPLAY_ORDER`, terminal symbols and kinds, item cells |
| `readers.ts` | the refs `SourceReader` on `Artifacts.source` and the `RecordReader` with R02 visibility |
| `notes.ts` | admin notes and operator log text that records accept (no NUL, no lone surrogate, cut between code points) |
| `upload.ts` | strict base64, media types (given, by name, sniffed), the parser structure summary |
| `trace.ts`, `http.ts`, `release.ts` | W3C traceparent, Circle-Session-Id, loopback rules, body limits and the body budget, release.json |
| `console/` | sign-in, sessions, CSRF, CSP, the pages (runs, run, knowledge, packs, admin, call logs) |
| `main.ts` | `serve [--migrate-only] [--migrate]` |
| `cli.ts` | `main(argv)`: user, token, logs, run, platform delegation, `registerCommand` |
| `assemble.ts` | placeholder of the assembly (throws `AssemblyMissingError`) |
| `fakes.ts`, `testing.ts` | in-memory fakes of the ports and `createTestServer()` / `fakeDeps()` for tests |

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
input slot accepting `system:type` (no slash), or its workflow binds expected sources at start_run (`expected_sources`,
loaded with `WorkflowStore.forUser`); a pack that cannot be loaded counts as reading outside. For such a caller the
annotations equal `tools.json`.

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
   plain text (D05 R[0], display rule 11: content is plain text, the JSON is structuredContent). Its first line for
   `submit_result` is the receipt, the partition counts and the unknown count; the text alone carries what a model needs:
   every item of the partition list with its requirements, terminals, status and the fields of their claims in
   `DISPLAY_ORDER` (D05 R[6]); every run item as id, label and summary (with its location while there are at most 50,
   the contracts' rule for long lists); the slot schema; the text of a model-readable source read by reference, the
   structure summary of a function-only one; node children and entry data.

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
  the run's), `KnowledgePort.getNodes` (paths default `/`, depth 1; paging and coverage from the service); with
  `reference` (not combined with root, paths, depth or cursor; an optional `run` must be visible and scopes the reader),
  `resolveReference` of hub/refs with a `SourceReader` on `Artifacts.source(..., {consumer: 'function'})`, the
  `KnowledgePort.treeReader()` and a `RecordReader` with visibility, as consumer `model`: text only for
  `model_readable`, structure only for `function_bytes_only`, the note `含凭据，原文不可读` for `retain_only` (the reader
  gives refs `bytes: null` for a withheld source, and refs answers it without evaluating the selector). Neither run, root
  nor reference is a schema violation.
- `start_run`, `resolve_reference`, `submit_result`: `RunsService`.

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
circle-hub user create <name> [--role <permission_role>] [--as <admin>]   # no admin yet: bootstraps the first admin, its token shown once
circle-hub user list | user disable <user> | user enable <user>
circle-hub token issue <user> [--label <l>] | token revoke <tok_…> | token list [<user>]
circle-hub logs export [--from <time>] [--to <time>] [--user <u>] [--tool <t>] [--run <r>] [--out <file>]
circle-hub run show <run> [--json]                                    # needs the assembly
circle-hub <platform command>                                         # init, db, key, service, backup, restore, deploy, rollback, rehearse, status
circle-hub pack|resource|secret|knowledge …                           # registered by the assembly step
```

Records commands open the records as the runtime role without migrating. `--as <name or id>` names the acting admin; it
may be left out when exactly one admin is enabled (records require an acting admin for every decision). A token is
printed exactly once, when it is issued (or bootstrapped); listings never show token values. `logs export` writes the
admin view as JSON Lines to stdout, or to a new file with mode 0600 (never overwritten). `registerCommand(command)` (or
`registerCommands(register)` of the assembly module) adds commands; built-in and platform names cannot be replaced.
Exit codes: 0 ok, 1 failure, 2 usage (platform status commands may give 3).

`serve`: configuration through `loadConfig` (hub/config) with the platform's own names accepted; when the database is
the platform's cluster (its socket directory is `<data dir>/run`) `ensureHubDatabase(env)` starts it (never initialises
it); the vault key provider is `hubKeyProvider(env)`; records open as the runtime role with `migrate: false`; then
`repairFiles`, `sweepOrphans()`, the assembly, `listen()`. While serving, an `unhandledRejection` anywhere in the process
is reported to the operator's log instead of ending the process (defence in depth; the request path never leaves one);
the listener is removed when serving ends. SIGTERM or SIGINT closes the app (requests in flight end, then the cut-off
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
192.0.2.0/24 addresses), and loopback only. `mcp.test.ts` (SDK client over streamable HTTP, raw POSTs where the SDK
would not send the body): every tool's happy and error paths; initialize; schemas and annotations equal to `tools.json`,
`start_run` closed-world without an external input and open-world for a pack with upload-only inputs and expected
sources; the isError matrix with every answer checked against its zod output schema (the SDK client checks the published
schema) and one plain-text block; absent equals forbidden for every tool (byte for byte apart from the trace); the admin
note; call-log lines with trace, session, run and receipt and no argument content (records and JSONL files); traceparent
and session handling; token revocation and account disabling; 24 concurrent calls; service answers that violate their
output schema and thrown errors; `__proto__` reaching `submit_result` and the same digest in the call log; the content
text (source text, 60 items with summaries, the slot schema, claims under their requirement); records by reference
(admins and `admins: false`, the `received` submission shape, the candidate layer); a refused batch with a duplicate id
and a cancellation (nothing ingested, one line per request); notes cut in a surrogate pair or quoting NUL, and a note
records refuse. `http.test.ts`: `/healthz` and release.json; raw request targets (`//`, `///`, `//?x`, `//:80`, `//a:b`,
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
owner role with the runtime role granted (it cannot DELETE or disable triggers), serve without and with an assembly (and
its unhandled-rejection listener while serving), users and tokens (printed once), log export, reserved and registered
commands, platform delegation. `units.test.ts`: traceparent, sessions, base64, media types, escaping, the CSP hash,
origins, request targets, admin notes, the body budget, session expiry, claim display order, terminal symbols, item
cells, the run of a record, pointers.

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
- **CLI**: `user enable` and `--as` were added; `logs export` is the admin view (with admin notes).

## Needs from other packages

- **ports (hub/ports.ts)**: `CallContext` could gain `adminNote?(reason: string): void`, so a service can put the real
  reason behind a neutral answer in the admin note. The server already passes it (type `ServerCallContext` in
  `hub/server/api.ts`); the fake runs service uses it.
- **runs**: (1) parse, store and answer raw `submit_result` arguments (decision 1); throw errors with a registered `code`
  (Chinese `message`, optional `fix`) for caller failures. (2) Export the record visibility rule of the engine (its
  `recordReader`, or a "run of record" predicate) from `hub/runs/api.ts`, so the server uses one rule instead of
  restating it in `readers.ts` (`runOfRecord`); until then the server follows the engine's kinds and shapes. The engine's
  `runOfBody` takes `received.run` before `run` for a submission: a canonical submission's own arguments may carry a
  member named `received`, so `run` should come first (the server does so). (3) Pass the `PacksPort` (`products`,
  `readableProducts`) as `ServerDeps.products` in the assembly, for the knowledge page.
- **contracts / runs**: a `reads_external` flag on `PackSummary` (an external input slot or `expected_sources`), so
  `tools/list` does not load every assigned pack to derive `start_run`'s open-world annotation.
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
  JSON block can be added back.
- **assembly (next phase)**: replace `hub/server/assemble.ts` with a module exporting `assemble(config, records)` and,
  optionally, `registerCommands(register)` for `pack`, `resource`, `secret` and `knowledge`.
