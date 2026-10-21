# hub/connectors

Read-only access to external systems. Model elements: **D01** (all rules, including R[9] login and envelope codes and R[10]
the route list), **D02** (the read-only premise enforced by the transport), **D03** (read part), **D07** (resources only),
**B02** provenance, **B05** read actions, **R02**. The package owns `hub/connectors/**` and `contracts/src/resources.ts`.
Other packages import `hub/connectors/api.ts` (and tests `hub/connectors/testing/api.ts`); it imports only `contracts`,
`hub/records/api.ts`, `hub/refs/api.ts`, `hub/rules/api.ts` and `hub/ports.ts`.

```ts
import { createConnectors } from '../connectors/api.ts';
const connectors = createConnectors({ records: kit, packs, log: adminLog, sandbox: { requireOsIsolation: true } });
connectors.reader;   // ExternalReaderPort (hub/ports.ts) for runs and knowledge
connectors.catalog;  // ResourceCatalogPort (hub/ports.ts) for the console
connectors.admin;    // addResource, updateResource, listResources, setCredential, disable, enable, loginStatus, resetLogin
connectors.executeRead(resourceId, readName, { id }, { principal, run, purpose });
```

| Module | What it does |
| --- | --- |
| `contracts/src/resources.ts` | `system@1` (system.json), `resource@1`, `read-manifest@1`, `read-plan-input@1`, `read-plan-output@1`, `read-projection-input@1`, `read-projection-output@1`; path templates, the shape subset, linear patterns, reserved headers |
| `http.ts` | `HttpSource`: allow-list, same origin, plaintext rule, the login URL kept out of reads, limits, timeouts, no redirects, byte caps, typed answers and envelope modes, the login exchange and whether a failed one reached the source |
| `routes.ts`, `shape.ts` | route matching (method AND path template AND segment shapes AND query AND body), `;` segments, path building, the JSON Schema subset check |
| `login.ts` | `LoginManager` and `StaticCredential`: the session in memory and in the vault (bound to the configuration), one login per expiry, token confirmation, the stop until an admin acts, the cool-down for undelivered logins |
| `read.ts` | `ReadEngine`: planner rounds, storing every response, read tiers of what functions see, nested reads with a bounded cache, projection, the read manifest |
| `resources.ts` | the resource registry and administration (exact pack binding, credential rules, reset) |
| `profiles.ts` | loading and validating system.json through `PacksPort` |
| `connectors.ts` | wiring, `ExternalReaderPort`, `ResourceCatalogPort`, `executeRead` |
| `redact.ts`, `errors.ts` | redaction of every secret the process handled and the values it sent as credentials; internal error codes with their D01 R[5] layer |
| `testing/` | loopback stubs (agile-like, PLM-like, build-site-like, WebDAV-like), recorders, synthetic system packs, a test kit |

## A system pack (system.json, `system@1`)

`roles` (base URLs come from the resource), `auth` (`none`, `static_header` with one vault credential, or `login_token`:
credentials with a digest rule `plain` or `sha512_base64`, the header name and scheme `raw` or `bearer`, the roles that carry
it, and the login exchange: role, POST path, JSON body template with `{credential}` placeholders, token and expiry pointers,
its envelope), the system `envelope` (`code` pointer, `ok` and `expired` codes, `message` pointer), `routes` and `reads`.

A **route** is `{id, role, method GET|POST|PROPFIND, path template, params?, query?, body?, headers?, response
json|text|xml|html|bytes, max_bytes, timeout_ms?, envelope?, parse?, read: true}`. Every route is a read (`read: true` is a
literal); a write route is simply never listed. Path templates: literal RFC 3986 segments, `{name}` (one segment), a last
`{name*}` (one or more), an optional trailing `/`. Routes are allow-listed one by one, never by prefix (brief section 8,
D01 R[10]):

- a **POST route has a literal path**: a read that uses POST is allowed on its exact path only, so it can never match a write
  under the same prefix; parameters exist on GET and PROPFIND routes only;
- `params` gives a template parameter a string shape (`{type: 'string', maxLength, pattern?}`) checked on every decoded
  segment it fills; a `{name*}` of a role that carries the credential must have one with a `pattern`;
- no route of the login's role may reach the login path (compared decoded, case-insensitive, with or without the trailing
  slash), and the transport refuses any read request whose URL is the login URL, whatever its role (two roles may share a
  base URL in a deployment): the login is sent by the login handling only.

Query and body shapes are a subset of JSON Schema 2020-12 in which every object is closed (`additionalProperties: false`),
every array and string has a maximum, and a `pattern` is one anchored bracket class with one quantifier (optionally after a
literal prefix), so matching is linear (`SIMPLE_PATTERN`); a top-level member `_method`, `X-HTTP-Method-Override`,
`X-HTTP-Method` or `X-Method-Override` is refused (frameworks turn such requests into other methods). Fixed headers (for
example `Depth: 1`) may not be credential, framing, hop-by-hop, cross-site, content-coding or range headers, method overrides
(`X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`, `X-Original-Method`), URL rewrites (`X-Original-URL`,
`X-Rewrite-URL`), forwarding headers (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, ...) or WebDAV write headers
(`Destination`, `Overwrite`, `Lock-Token`, `If`); `proxy-*` and `sec-*` are reserved too (`RESERVED_HEADERS`,
`RESERVED_HEADER_PREFIXES`). `parse` names a core parser whose model the functions get.

**Envelope modes** of a JSON route (`envelope`): `true` every answer is an envelope (ok, expired and other codes checked);
`when_present` an answer whose code member exists is an envelope and is checked, any other answer is accepted bare (a list
the system answers plainly while its errors come in the envelope, like the PLM build list); `false` never. Without a
declaration, a JSON answer to a request that carried the credential is still read for the `expired` codes, and only for
them: the login layer of a system answers every route with its envelope, and "login expired" is never taken for data.

A **read** serves one external type `system:type` with a planner function (`plan`) or one declared request (`request`,
string values may contain `{id}`, the key of the object; D01 R[7]: a declarative profile drives the transport), and an optional
projection (`project`); `max_requests` (default 50, at most 1000) and `max_bytes` (default 256 MiB) bound one read.

## How a read works

1. **Resolution.** `reader.read('system:type:key[@revision]', ctx)` finds the enabled resources whose system pack (the exact
   version and digest the configuration binds, loaded through `PacksPort`, kind `system`, validated) declares the type: none
   or several is a failure; one is used.
2. **Planning.** The planner gets `{round, external, args, settings, responses, reads}` (`settings` are the resource's
   non-secret deployment values; responses carry status, media type, size, digest, ETag, `json` or `text`, the parser model,
   and the route-space path, never a URL, a header or a credential). It answers `{requests, reads?, done, original?}`; a
   request names its route and gives `params` (filling the template), a `path`, or an `href` found in a response, which the
   Hub resolves against that response's URL (`against`) or the base, refusing anything outside the role's origin and base
   path. Rounds go on until `done` (requests of a `done` round are still executed), at most five. Inputs arrive in plan
   order, never completion order, so the functions stay deterministic.
3. **Sending.** Before any credential is fetched the request passes the allow-list, the URL check, the login-URL check and
   the plaintext rule (a refused request never causes a login). A planned request whose path, query or body carries a value
   the Hub sent as a credential (a token, a static credential; the functions never see one) is refused (`PLAN_INVALID`)
   and recorded masked. Requests of one round run concurrently within the resource's limits.
4. **Storing.** Every complete answer is stored as a source artifact the moment it arrives, before anything interprets it
   (status, envelope, JSON): bytes by SHA-256 in the object store, a `source_artifact@1` record with origin
   `{read: {object: system:type:key, resource}}`, provenance type `observed`, capture time. An answer over a cap is an
   error and is never stored truncated. An answer that carries a value the Hub sent as a credential (in its bytes, in its
   text decoded by its charset, or that text without NUL; the forms as given, URI-encoded, JSON-escaped and Base64) is
   stored at read tier `retain_only` and logged as `secret_echoed` (route and status only): a debug page that lists the
   request's `Authorization` header, for example. An admin acceptance of scan findings does not lift that tier.
5. **Interpreting.** 3xx, 401, 403, 404/410, other statuses, invalid JSON, envelope codes. Refusals (route, origin,
   plaintext), login failures, a second "expired", limits and storage failures stop the read; other failures are handed to
   the planner as `ok: false` responses (a dead link in a walk, for example). **Read tier (B02 R[4]):** an answer stored at
   `retain_only` (a credential-scan hit no acceptance covers, or an echo as above) reaches no function: its view keeps
   status, media type, size, digest and ETag but has no `json`, `text` or `model`, `ok: false` and the code
   `SOURCE_CREDENTIAL` (or the transport code when the answer was an error), with a message naming the digest and why. As
   the original it fails the read before any projection runs; elsewhere it lowers the coverage.
6. **Nested reads.** A planner may ask for other external objects (`reads`); they are read through the resource that
   declares them, at most one level deep, and served from a cache per (resource, configuration decision, pack digest,
   reader, object) for an hour unless the planner asks for a refresh, which happens at most once per object per read. Only
   nested reads add entries; a top-level read refreshes an entry that exists. The cache holds at most 500 entries and
   64 MiB of stored artifacts (`nestedCacheBytes`), oldest out first; an update, enable or disable of a resource clears
   it. This is how a mind-map read finds the title and folders of its document: the configured root trees are read once
   and cached. A derived artifact stored at `retain_only` gives nested readers `content` or `meta` null.
7. **Projection.** The projection gets the same input plus the original's key and returns derived artifacts (`text` stored
   as UTF-8, `json` as RFC 8785 canonical JSON, or `response` naming a stored answer itself), an optional revision, a
   completeness flag that can only lower coverage, and warnings; or `{error}`. Derived artifacts are `source_artifact@1`
   records with origin `{generated: {generator: <pack>.<read>@<major>, inputs: [src:<digest> of the answers]}}` and
   provenance type `projected`.
8. **Manifest.** Every read that reached planning writes a `read-manifest@1` record (kind `action`, the B05 read action):
   run, inputs (`rec:` of the resource configuration decision and of nested read manifests), component `connectors@1`,
   start and end, result and error code, the external object and revision, the resource, its environment class, the system
   pack id, version and digest, the read, the reader, the purpose, every request (round, route, method, path, query, body,
   status, digest, size, media type, ETag, the artifact record, whether it was repeated after a login), the nested reads,
   the original, the artifacts, the coverage the Hub computed (examined answers over requested ones; complete only when the
   plan finished and every answer was good) and the reason of a failure. Index keys: `action.kind` = `read`, `action.run`,
   `action.user`, `connectors.external`, `connectors.resource`. A refused request's path longer than 4096 characters is
   recorded as its start and `…sha256:<digest of the whole path>`. A manifest that does not parse as `read-manifest@1` is a
   programming error: it is never stored under that schema, the read fails with `STORE_FAILED` and `manifest_shape` is
   logged.

`ExternalRead` on success: `{ok, id, revision, artifacts: [{name: 'original', ...}, ...derived], manifest}`; on failure
`{ok: false, id, reason}` with the internal code and an admin-facing Chinese reason. The reader never throws.

**Mind maps.** The engine needs three artifacts from `agile:mindmap:<id>`: `original` (the answer as received), `content`
(the decoded inner document, `application/json`, parsed with `kityminder@1`) and `meta` (JSON with the document title and
the labels of the folders above it, from the root down). The synthetic agile pack (`testing/functions/agile-*.ts`) shows the
pattern a real system pack follows: `meta` is `{title, folders, found}`.

## Login (D01 R[9])

- Credentials live in the vault entries the resource names (`connector.<resource>.<name>`), each under the digest rule the
  definition records; a credential with the rule `sha512_base64` is kept only as Base64(SHA-512(UTF-8 value)), computed when
  the admin sets it.
- The session (token, expiry, confirmation, stop and cool-down) is kept in memory and sealed in
  `connector.<resource>.session`, so a restart reuses the token and keeps a stop. It is bound to what it depends on: the
  origins, plaintext declarations, system pack version and digest, credentials and their rules; a session stored under
  another binding is not used, so a token never goes to new origins and a stop never carries over to another configuration.
  One `LoginManager` (or `StaticCredential`) serves a resource while its binding stays the same.
- A login happens when there is no token, when the token's known expiry is less than a minute away (see Deviations), or
  after an explicit "expired" answer (HTTP 401, an envelope `expired` code, or the expired code on a route without a
  declared envelope) to a request that carried a **confirmed** token; then the request is sent once more. A token is
  unconfirmed from the login that produced it until a request carrying it, by any caller, gets an answer that is not
  "expired" (2xx, or 4xx other than 401); an "expired" answer to an unconfirmed token is a refusal. Concurrent callers share
  one login, and the decision is made without waiting on the vault, so a slow vault write cannot let a second one through.
- An expiry the login answer states is used only when it lies beyond the margin when stated; one that is already due (a
  lifetime under a minute, a skewed clock, a misdeclared unit giving a date in the past) is unknown, logged as
  `login_expiry_unusable`, and renewal waits for an "expired" answer.
- **A failed login is never retried.** When the source answered (an envelope code, an HTTP status, no JSON, no usable token),
  when the outcome is unknown (a timeout, a connection lost after the request left) or when a fresh token is refused, logins
  **stop**: LOGIN_FAILED, `login_stopped`, `loginStatus().stopped`, and every read that needs the token fails without
  sending anything, however long it waits. A stop ends only when an admin sets a credential, calls `resetLogin` (one
  attempt then, with the stored credential) or changes what the binding covers.
- Only a login that provably never reached the source (connection refused, no route or name, connect timeout, TLS handshake
  failure: `detail.delivered === false`) starts a timed cool-down (default 30 minutes, kept in the vault), after which one
  attempt is made again: the source judged nothing.
- A login in flight when its session is reset or stopped does not record its result.
- **Static credentials** (`static_header`) stop the same way: a 401 or an envelope `expired` code to a request carrying the
  value gives CREDENTIAL_REFUSED and the value is not sent again until an admin sets it or calls `resetLogin`. Until a
  request carrying it has been answered otherwise (in this process), one request at a time carries it, so a wrong value is
  refused once, not once per request in flight. A 403 is not a refusal of the credential (RFC 9110: understood but not
  sufficient for that object); it stays SOURCE_FORBIDDEN for that request.
- The login exchange is never stored and never logged: log events say `login_attempt`, `login_ok` (with the expiry),
  `login_failed` (with the envelope code and whether the request was delivered), `login_stopped`, `login_reset`,
  `credential_refused`, `login_expiry_unusable`.

## Resources (D01 R[6], D07, B04)

`resource@1`: id `res_<ULID>`, the system pack as one exact version `id@x.y.z` with its content digest, name, environment
class (vocabulary `environment`), the base URL of every role of the system pack (normalized, no credentials, query or
fragment), the origins that may carry credentials over plain HTTP, the vault entry and digest rule of every declared
credential, non-secret `settings` (at most 64 KiB, refused when the credential scanner finds anything), optional limits
(`concurrency` default 2, `interval_ms` default 0, `timeout_ms` default 30 s), creator and creation time. The definition is
stored as canonical JSON in the object store and put in force by a `resource_config` authorization bound to its digest
(`configureResource`); an update is a new definition and a new decision under the same id; disabling is the revocation;
enabling grants the last definition again. Only admins decide (the account is re-read on every call).

- **Exact pack binding (B04 R[1]).** `addResource` resolves `system_pack: 'id'` to the version published now and records
  that version and its digest; reads use exactly that content (another digest under that version is not used:
  PACK_UNAVAILABLE). A newer version takes effect only through `updateResource` (`system_pack: 'id'` binds the latest then).
- **Updates.** A credential no longer declared, or whose digest rule changed, loses its stored value (`credential_dropped`)
  and is set again with `setCredential`; the session is rebound (see Login); cached nested reads are cleared.
- `resetLogin(by, id)` (admins) ends a stop or cool-down without changing the credential.
- `listResources` gives admins origins and plaintext declarations and other accounts the rows without them; the catalog port
  gives admins the same listing and everyone else an empty list.

## Visibility (B02 R[3], D01 R[4], R02)

Milestone 1 has shared service credentials only (configured by admins). Everything a read stores is visible to the reader
and to admins, never shareable, and not opened to pack users: `{readers: [reader], admins: true, packs: [], shareable: false}`.
Personal credentials (whose reads are visible to the reader only and never enter the tree) are not implemented.

## Errors

Internal codes (`CONNECTOR_ERRORS`), never protocol codes; each read error carries its D01 R[5] layer:

| Layer | Codes |
| --- | --- |
| transport | `ROUTE_REFUSED`, `ORIGIN_REFUSED`, `PLAINTEXT_REFUSED`, `SOURCE_REDIRECT_REFUSED`, `RESPONSE_TOO_LARGE`, `SOURCE_TIMEOUT`, `SOURCE_UNREACHABLE`, `SOURCE_ABSENT`, `SOURCE_FORBIDDEN`, `SOURCE_HTTP_STATUS`, `SOURCE_LOGIN_EXPIRED` (401), `CREDENTIAL_REFUSED` |
| envelope | `SOURCE_LOGIN_EXPIRED` (envelope code), `SOURCE_ENVELOPE_ERROR`, `LOGIN_FAILED` |
| plugin | `SOURCE_MALFORMED`, `PLAN_INVALID`, `PROJECTION_FAILED`, `FUNCTION_FAILED`, `READ_LIMIT` |
| (read tier, B02 R[4]) | `SOURCE_CREDENTIAL` (an answer stored `retain_only`: its view carries no content) |
| (configuration) | `CREDENTIAL_MISSING`, `STORE_FAILED`, `RESOURCE_UNAVAILABLE`, `READ_UNDECLARED`, `PACK_UNAVAILABLE`, `PROFILE_INVALID`, `RESOURCE_INVALID`, `ACCESS_DENIED`, `READER_INVALID` |

Messages are Chinese and carry route ids, codes, sizes and limits, never a header value, a host, a URL or a body. Every text
that reaches a log, an error or a reason passes the redactor, which masks every credential, digest and token the process
has handled (and their URI, JSON and Base64 forms). Manifest request entries record path, query and body as the planner
gave them: a request carrying a value the Hub sent as a credential is refused before it goes out, and its entry is recorded
with those values masked. Entries are not run through the full redactor, because it also masks login account names, which
may be ordinary words in a path (`/spec/card-reader.md` would be recorded as `/spec/card-***.md`).

## Test toolkit (`testing/`)

`startStub(handler)` (loopback, ephemeral port, every request recorded as received, requests in flight counted),
`startAgileStub` (login envelope 1000/1005 with HTTP 200, Base64(SHA-512) passwords, a stale-token code, root listing 10 per
page with a total and pages past the end repeating page 1, subtrees, double-encoded mind maps, token expiry, switches to
expire tokens, change the password, refuse new tokens), `startPlmStub` (envelope, a plain-array answer, POST reads, numbers
and strings as ids, three date spellings, HTML fields, and a write route under the read prefix that counts every hit),
`startBuildSiteStub` (ISO-8859-1 pages, unquoted links, hub and listing pages, a dead link, command trees),
`startWebDavStub` (PROPFIND Depth 1 with `D:` names, trailing-slash collections redirected otherwise, Markdown with NUL
bytes), synthetic system packs written to a temp directory (`writePack`, `agileSystem`, `plmSystem`, `buildSiteSystem`,
`docStoreSystem`), `fakePacks`, and `openConnectorKit` (records in a temporary PostgreSQL, an admin and a user, the packs,
a captured log, an adjustable clock). All content is invented; addresses are loopback or 192.0.2.0/24.

## Decisions

1. **Original before interpretation.** The `received` hook of `HttpSource.request` stores the complete answer before status,
   envelope or JSON are looked at; the planner and the projection only ever see stored answers (tested by wrapping the
   sandbox call and checking the object store).
2. **Allow-list per route.** A request is checked against the route it names and must match its method, template, query
   and body; the URL built from the base and the path must parse to exactly that path (no dot segment, encoded slash,
   backslash or NUL); links are resolved by the Hub and must stay under the role's origin and base path. All of this happens
   before a token is fetched.
3. **Manifest as the read action.** `read-manifest@1` is stored with kind `action`: it carries the B05 fields of a read (with
   the same names as `action@1`: action, run, item, inputs, component, lease, started_at, ended_at, result, error_code) and
   the manifest fields, instead of a separate `action@1` record plus a manifest.
4. **Revision.** A stored answer's origin names `system:type:key` without a revision: the revision is known only after the
   projection, which runs after storing. The revision is in the manifest and in `ExternalRead.revision`; a read asked for a
   revision fails when it observes another.
5. **Resource definitions in the object store.** B04 binds a resource configuration to a content digest; the definition is
   that content (canonical JSON), so it lives in the content-addressed store and the decision chain is the history.
6. **Nested reads** are one level deep and cached per reader (the artifacts they store are the reader's), not shared across
   readers.
7. **No automatic retry of a failed read** (D03 R[0] allows retries; the caller may read again). Nothing is recorded as
   unknown for a failed read.
8. **Concurrency** is limited per resource (one HttpSource per resource), the interval between request starts too.
9. **Determinism.** Responses, nested reads, manifest entries and generated inputs follow plan order.
10. **Stop, not cool-down, after a judged or unknown login.** D01 R[9] ("再失败就停下来报告，不重试") and the brief ("never a
    login retry after a failure") leave no timed retry with the same credential; the brief warns that repeated failures may
    lock the account. A timeout counts as unknown (the source may have judged the credential). Only a login that never
    reached the source cools down and is tried once again, since the source judged nothing.
11. **Withheld views, not blanket retain_only derivations.** The functions never receive the text, JSON or parser model of a
    `retain_only` answer (and a `retain_only` original fails the read before the projection runs), so a derived artifact
    can only hold what was readable; derived artifacts are stored at the default tier unless their own bytes are flagged or
    carry a sent value. Marking every derivation `retain_only` whenever some input was would hide readable results (a search
    listing because one listed file was flagged) without protecting anything more.
12. **Echo detection uses what the Hub sent in headers.** Tokens and static credential values (with the part after a scheme
    word, at least 8 characters, in their URI, JSON and Base64 forms) are looked for in every stored answer and every
    planned request. Login-body credentials (an account name, a password digest) are masked in texts but not looked for:
    an account name may occur in ordinary data (the reporter of a defect, a file name), and they never travel in a stored
    request.
13. **Exact pack versions in resource definitions.** B04 R[1]: a configuration covers only the content it binds; the pack
    registry never publishes one version with two contents, and the definition records the digest as well, checked at use.

## Limits

- Stored objects are capped by the records limit (default 32 MiB): a larger answer fails with STORE_FAILED even when its
  route allows more; it is never truncated.
- The sandbox input is bounded (96 MiB default for the functions here): a planner that keeps many large answers across
  rounds fails with FUNCTION_FAILED.
- At most 200 generated inputs are recorded on a derived artifact (the manifest lists every answer).
- An answer the credential scanner flags is stored at read tier `retain_only` by records (B02 R[4]): its text reaches no
  model and no pack function until an admin accepts those findings of those bytes (records' `acceptFindings`) and the
  object is read again. The registry ignores such `resource_config` decisions: only objects that are resource ids are
  resources.
- Envelope codes are compared by their text (`1000` and `"1000"` match).
- The profile cache keeps a pack reference for 5 s; call `connectors.refresh()` after a withdrawal to see it at once (a new
  publication changes nothing until an admin binds it). The resource list is cached for 5 s (`resourceCacheMs`).
- Two resources of different system packs log in separately even when they share an account (each keeps its own token and
  stop), so a wrong shared password is tried once per resource before both stop.
- A login timeout shorter than the connection timeout of the runtime (10 s) makes an unreachable host look like a lost
  answer, which stops the login instead of cooling down.
- The one-request-at-a-time gate of a static credential is per process: after a restart the first request carrying it is
  again the only one in flight until it is answered.
- The credential scanner (records) does not flag every form a secret takes; for example a JSON row `{"key": "password",
  "value": "…"}` or a hex token after a label. Such bytes stay model readable unless they carry a value the Hub sent.
- Login bodies are JSON only; form-encoded logins and Basic authentication other than a static header value are not
  supported.

## Tests

```
npx tsc --noEmit
node --test "hub/connectors/**/*.test.ts"
```

Nine files, 88 tests, about 15 s on the development Mac (the files run in parallel): `redact.test.ts` (values the Hub sent
as credentials found in answers in their encodings and charsets, masked in structures), `contracts.test.ts` (shapes and
refinements: literal POST paths, segment shapes, reserved headers and method-override members, the login path, envelope
modes, exact pack binding and credential rules, JSON Schema generation of every registered shape), `shape.test.ts` (every
keyword, adversarial sizes and depths), `routes.test.ts` (the allow-list matrix: methods, paths, queries, bodies, the write
route under the read prefix, dot segments, `;` segments and encodings, segment shapes), `http.test.ts` (loopback stubs:
refusals before I/O, plaintext, redirects, byte caps declared and streamed, timeouts, concurrency and interval, 401 and
envelope codes in every mode, the login URL refused as a read, the login exchange and whether a failed one was delivered,
redaction, injected fetch), `session.test.ts` (the login manager alone with an in-memory vault: stops, cool-down, token
confirmation, a slow vault write, a reset during a login, unusable expiries, bindings), `resources.test.ts`,
`login.test.ts` and `read.test.ts` (a temporary PostgreSQL from `hub/testing/postgres.ts`, the real sandbox; where
`sandbox-exec` is unavailable the kit passes `requireOsIsolation: false`, which synthetic tests may). Nothing outside the
test process is reached; every server is a loopback stub (a closed loopback port stands for an unreachable source).

## Deviations from the brief

- The brief's `executeRead(resource, readName, args, reader)`: `args` is `{id, revision?, args?}` (the key of the object, an
  optional revision, extra arguments for the functions); `reader` is the `ExternalReadContext`.
- The ResourceAdmin has `updateResource`, `enable`, `loginStatus` and `resetLogin` besides the four asked for.
- A login is also made when there is no token at all (first use or after a reset): the state is known, not guessed.
- **Renewal at a known expiry** (D01 R[9] says to log in only after an explicit "expired" answer): a token whose stated
  expiry is less than a minute away is renewed before use, once per token (an expiry is kept only when it lay beyond the
  margin when stated). It saves one refused request per token lifetime and keeps a profile whose `expired` codes are
  incomplete from failing forever; expiries that are due when stated are ignored (`login_expiry_unusable`).
- A stop also ends when an admin changes what the session is bound to (origins, plaintext declarations, system pack version,
  credentials): that is a person's decision about a new configuration, and the next login there is its first.
- A 403 to a static credential is not treated as a refusal of it (the finding asked for 401 and 403): the credential was
  understood and found insufficient for one object; stopping every read of the resource for it would be wrong.
- Reads may declare one `request` instead of a planner (D01 R[7]); routes may name a core parser (`parse`).
- The closed sets of `resources.ts` (HTTP methods, response kinds, authentication kinds, digest rules, header schemes,
  expiry units, envelope modes) and the error layers of D01 R[5] are not vocabulary axes; they are written in
  `resources.ts` and `errors.ts` (see Needs).
- Fixed route headers are a deny-list (with reserved prefixes), not an allow-list: D01 R[0] wants a new system type to need
  no core change, and a system may require a header of its own; the headers that change method, path or forwarding are
  reserved.
- `contracts/generated` is not this package's path, so this package did not run `npm run gen:contracts`. This round's change
  to `contracts/src/resources.ts` made five generated schemas out of date; they were regenerated by their owner during the
  round, and at its end `node tools/gen-contracts.ts --check` reports a match (57 files).

## Needs from other packages

- **contracts**: (1) regenerate after any later change to `contracts/src/resources.ts` (`npm run gen:contracts`); this
  round's change (route `params` and `envelope: 'when_present'`, resource `system_pack_digest`, `credential_digests` and
  the exact `system_pack` form, changed descriptions) touched `read-manifest.v1`, `read-plan-input.v1`,
  `read-projection-input.v1`, `resource.v1` and `system.v1`, which are regenerated now. (2) Vocabulary axes
  for the closed sets above and for the error layers of D01 R[5] (transport 传输, envelope 信封, plugin 插件), so labels
  come from `labelOf`. (3) An axis for the read credential method of D01 R[4] / B02 R[3] (shared service credential /
  personal credential) before personal credentials are added. (4) A protocol or core code for "the answer is over its byte
  cap" if it should ever reach a caller (records asked for one for uploads too).
- **runs (PacksPort)**: `pack(ref)` returns system packs (kind `system`) extracted with `system.json` and `functions/`;
  validate `system.json` with `SystemProfile` (contracts) at publication and check that the function modules exist; never
  assign system packs to users; keep publishing a version with one content only (the definitions bind `id@x.y.z` and its
  digest).
- **packs**: the real system packs (agile platform, PLM, build site, manual store, document library) as `system@1` with
  planner and projection functions in the shape of `testing/functions/*.ts`; the mind-map read must produce `content` (the
  inner data string as text, `application/json`) and `meta` (title and folders from the root down); root ids and other
  deployment values go into the resource's `settings`, never into the pack; route bodies and queries must use the shape
  subset (closed objects, bounded strings and arrays, linear patterns). POST read routes have literal paths; a `{path*}`
  route of a role that carries a credential (the document library behind Basic authentication) needs `params: {path:
  {type: 'string', maxLength: …, pattern: '^[^;]{1,…}$'}}`; a JSON route whose good answer is bare while its errors come in
  the envelope (the PLM build list) should declare `envelope: 'when_present'`.
- **server / platform**: wire `createConnectors` with the records kit and the runs `PacksPort`; pass
  `sandbox.requireOsIsolation` from configuration (true outside synthetic tests); send the `log` sink to the admin log;
  expose the admin commands, `resetLogin` included, and show `loginStatus().stopped`; show read manifests only to admins
  and to the reader; call `connectors.refresh()` after pack withdrawals (a publication changes nothing until an admin binds
  it with `updateResource`); map an `ExternalRead` failure to `SOURCE_UNAVAILABLE` with the reason as the admin note.
- **knowledge**: read through `reader.read` with an admin principal for the sync; parse `content` when present, else the
  original; the artifacts are visible to the reader and admins only, so read their bytes with
  `artifacts.source(admin, sha256, { consumer: 'function' })`.
- **records**: (1) resource definitions are objects without a `source_artifact` record (bound by `resource_config`
  decisions): backup verification or maintenance must not treat them as orphans. (2) Read manifests use your index keys
  `action.kind`, `action.run` and `action.user` so that a run's reads are found with its other actions; say if that
  namespace should stay yours alone. (3) A repeated read of unchanged bytes returns the first `source_artifact` record
  (same origin, name and visibility), so its `captured_at` is the first capture; each read's time is in its manifest.
  (4) The credential scanner does not detect a password in a JSON key/value row (`{"key": "password", "value": "Zq8-…"}`)
  or a hex token after a label (`HTTP_AUTHORIZATION 7f3c…`); both were confirmed with `scanForCredentials` this round.
  Projections that restructure text (Markdown tables to JSON rows) produce the first form.

## Open questions

- Should the read-only premise (D02 R[4] "只读由传输层强制") be recorded as certified per target and version (D02 R[1])
  now that the transport enforces it? Without a record the annotations stay those of an uncertified read (D03 R[6]).
- Should a resource of a shared system (for example one account for two systems) be able to share one token cache with
  another resource, so that a wrong password is tried once in total rather than once per resource?
