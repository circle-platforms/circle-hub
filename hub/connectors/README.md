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
connectors.admin;    // addResource, updateResource, listResources, describe, setCredential(s), disable, enable, loginStatus, resetLogin
connectors.executeRead(resourceId, readName, { id }, { principal, run, purpose });
```

| Module | What it does |
| --- | --- |
| `contracts/src/resources.ts` | `system@1` (system.json), `resource@1`, `read-manifest@1`, `read-plan-input@1`, `read-plan-output@1`, `read-projection-input@1`, `read-projection-output@1`; path templates, the shape subset, linear patterns, reserved headers |
| `http.ts` | `HttpSource`: allow-list, same origin, plaintext rule, the login URL kept out of reads, limits, timeouts, no redirects, byte caps, typed answers and envelope modes, the login exchange and whether a failed one reached the source |
| `routes.ts`, `shape.ts` | route matching (method AND path template AND segment shapes AND query AND body), `;` segments, path building, the JSON Schema subset check |
| `login.ts` | `LoginManager` and `StaticCredential`: the session in memory and in the vault (bound to the configuration), one login per expiry, token confirmation, the stop until an admin acts, the cool-down for undelivered logins, the mark of a login in flight that other processes wait for; `SessionStore`: the vault entry shared between processes (a generation per write, read again where a decision is taken) |
| `read.ts` | `ReadEngine`: planner rounds, storing every response, read tiers of what functions see, nested reads with a bounded cache, projection, the read manifest |
| `resources.ts` | the resource registry and administration (exact pack binding, credential rules, `describe`, reset) |
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
   stored at read tier `retain_only` and logged as `secret_echoed` (private source-record reference only): a debug page that lists the
   request's `Authorization` header, for example. An admin acceptance of scan findings does not lift that tier.
5. **Interpreting.** 3xx, 401, 403, 404/410, other statuses, invalid JSON, envelope codes. Refusals (route, origin,
   plaintext), login failures, a second "expired", limits and storage failures stop the read; other failures are handed to
   the planner as `ok: false` responses (a dead link in a walk, for example). **Read tier (B02 R[4]):** an answer stored at
   `retain_only` (a credential-scan hit no acceptance covers, or an echo as above) reaches no function: its view keeps
   status, media type, size and ETag but has no `json`, `text` or `model`, `ok: false` and the code
   `SOURCE_CREDENTIAL` (or the transport code when the answer was an error). Echoed credentials make the original administrator-only; the manifest request has null digest and artifact, and the function sees no received-byte digest. Other scan hits retain their existing digest diagnostics. As
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

Credentials are complete `${secret:NAME}` references. At each read the registry loads the current resource decision and the current named secret decisions as one credential batch, checks the exact consumer/item/destination enrollment, and captures material for the operation. A legacy `connector.<resource>.<item>` credential refuses before any request, with the migration command in the administrator log. Missing or revoked names likewise refuse with `secret set --name <NAME>`.

The sealed `connector.<resource>.session` binds origins, plaintext declarations, pack, credential rules, secret decisions and a reset epoch. A rotation invalidates old sessions at the next read without a restart. Current and previous secret values prime the redactor at server startup and on reads; actual digests, headers and both Basic components are registered before sending. In-flight reads retain their captured versions.

A credential-version gate uses a sorted set of decision digests, a vault entry and a transaction-scoped advisory lock. Network I/O never holds that database transaction. Resources and processes sharing those versions serialize login decisions and static-credential requests; ordinary requests with an acquired token retain their declared concurrency. One refused login or static credential stops all of them before another request. An abandoned in-flight claim freezes rather than automatically reusing credentials. `resource reset-login` changes the shared epoch and clears the resource session. A new secret decision has a new gate.

A usable confirmed token is reused. An explicit expiry can renew once; a token refused immediately after login stops. Login failures and unknown delivered outcomes never retry. A provably undelivered login retains its existing cooldown. `LoginManager` and `StaticCredential` keep their per-resource generation and in-flight checks as an additional guard within the captured version.

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
- **Updates:** named material is never deleted when a consumer or digest rule changes; another consumer may need it. Legacy entries removed from a definition are deleted after the new decision commits. Migration cannot change destinations in the same operation and commits secret decisions with the resource definition in one transaction. Comparison uses the credential wire rule; a matching legacy digest preserves an existing plain named value for other consumers. Migration also enforces current/previous retention. A post-commit cleanup failure is reported as committed, with the exact repeat-update action; repeating it clears the unused legacy entry without creating another secret version.
- `resetLogin(by,id)` resets the shared credential-version stop and the per-resource session; failure to remove a session is reported to the administrator without a path.
- The retired `setCredential(s)` API is removed. Synthetic fixtures use `testing/credentials.ts`, which explicitly creates names and writes them through records' named-secret API. Production callers configure references first, then use the administrator named-secret commands.
- Settings allow only whole-value ordinary-variable references. Configuration takes sorted name locks, checks the referenced current decisions again inside the configuration transaction, and bounds resolved settings at 64 KiB. Origins and other fields cannot reference variables. Updates merge settings by key; removals are explicit. Each read carries its caller's ordinary-variable snapshot into nested reads. Manifests and nested-cache keys include configuration, variable and secret decisions; `variables` records each use.
- `describe(by, id)` (admins): one resource, enabled or not, read anew: the admins' listing row and, for every credential the
  definition declares (sorted by name), its name, vault entry, digest rule and whether a value is set (presence only;
  never a value or its digest; version, length and enrollment are metadata). It needs neither the system pack nor the vault key. Null for an id that is not a
  resource. This is what the CLI's `secret set` needs to check a credential and name its rule before asking for a value.
- `listResources` gives admins origins and plaintext declarations and other accounts the rows without them; the catalog port
  gives admins the same listing and everyone else an empty list.

## Visibility (B02 R[3], D01 R[4], R02)

Milestone 1 has shared service credentials only (configured by admins). Everything a read stores is visible to the reader
and to admins, never shareable, and not opened to pack users: `{readers: [reader], admins: true, packs: [], shareable: false}`.
Personal credentials (whose reads are visible to the reader only and never enter the tree) are not implemented.

## Errors

Internal adapter codes (`CONNECTOR_ERRORS`) retain their D01 R[5] layer. Authorized, determined read outcomes map to registered protocol codes below; private causes remain separate:

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

The named-variable sections above supersede older review notes below that mention retired credential setters, entry removal on rotation, or per-resource-only stops. Those notes describe the earlier implementation.

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
7. **Bounded automatic read retry.** Transient transport failures retry within the shared attempt and wait budget.
   Exhaustion exposes the missing read and its next eligible retry time; no successful read is invented. Login failures
   retain their existing stop boundary pending the administrator-request integration listed under Needs.
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
14. **The session entry is the state processes share; a generation per write is how a change is seen.** The vault has no
    compare-and-swap, and the CLI's `resource reset-login` must work without the master key (it only removes the entry), so
    the two signals are a removal and a generation this process did not write. Generations are random, not counters: two
    processes never write the same one, and a fresh process cannot repeat an old one. A process keeps the generations it
    wrote, so its own write is never taken for another's, even when the vault reported a failure after the write landed.
    The entry is read again only where a decision is taken (refuse, log in, record a stop, a failure or a confirmation,
    status; for a static credential every request, whose value is read anyway), never on the path of a read that has a
    usable token. What is adopted is what a restart would load, so a running Hub and a restarted one agree, except that an
    entry of another binding or one that does not parse takes nothing away. A reset made here wins over a read of the entry
    that was asked for before it (that read comes before the reset's removal).
15. **A failure is recorded only over the state it judged, and an admin's decision wins over it.** A login whose answer is
    judged after a reset (here or elsewhere) or after its credential changed, a refused token after the session moved on,
    and a refused static value after the value or the session changed do not stop anything; the next read makes the
    attempt with what is stored then. Without this, a password the CLI sets while a login with the old one is out would be
    stopped before it is ever tried. What another process stored meanwhile is not a decision of an admin: its usable token
    is used, its stop stands, and its cool-down gives way to the stop, because a cool-down ends by time and the refused
    password would then be sent again with no admin action in between (D01 R[9], Decision 10). Each of these is decided
    after the last read it depends on (check, then act, with no await between).
16. **A login in flight is marked in the entry, from its decision.** Without the mark a second process that needs a login
    during the first one's round trip (up to the login timeout) sends the same, possibly refused, credentials: two failures
    for one admin action, where repeated failures may lock the account. The mark is written when the login is decided, not
    when it is sent, because the credential reads and the wait for a request slot come in between; so two processes both
    log in only when the second decides within one vault write of the first. A decision that a reset or an adopted change
    overtakes before the login is sent sends nothing (a reset allows one attempt, and that is the next read's). The cost is
    one vault write per login (two after a long wait for a slot), and a wait of at most the mark's time when the process
    that wrote it died. Waiting, rather than refusing the read, keeps a read that coincides with another process's login
    from failing.
17. **The credentials of one login are set together.** `setCredentials` stores every value and then forgets the session
    once, so a running Hub that holds a stop makes its one attempt with the complete new set.

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
- The one-request-at-a-time gate of a static credential is per process and has no mark: after a restart the first request
  carrying it is again the only one in flight until it is answered, and two processes whose first requests with a new
  value overlap may each send it once. A value one process was refused for is not sent by the other once the stop is in
  the vault; its requests already in flight still carry it.
- Processes coordinate through the session entry only at decisions, without compare-and-swap. Two processes both log in
  (once each) only when the second decides before the mark the first wrote at its decision has reached the vault (within
  one vault write), or when the mark could not be written (`session_store_failed`). A write another process had decided
  before a stop or a reset reached the vault can replace it (the last writer wins): a login already under way, or a
  confirmation whose read came first. A reset replaced so is run again; a stop is replaced so only by a token another
  process obtained or confirmed, and the next login then follows an "expired" answer to a confirmed token.
- A mark whose process died stands until its time is up: reads of other processes that need a login wait that long (at
  most the login timeout plus 5 s; 35 s with the default timeout), then log in once.
- Setting related names separately can expose a mixed pair. Use one `secret set --name <A> --name <B>` batch; credential decisions then change atomically.
- A read in flight across an update that changes the binding keeps the runtime it started with; when that old session is
  stopped and an admin resets the login meanwhile, that read may make its one attempt with the old configuration (the next
  read uses the new one).
- The credential scanner (records) does not flag every form a secret takes; for example a JSON row `{"key": "password",
  "value": "…"}` or a hex token after a label. Such bytes stay model readable unless they carry a value the Hub sent.
- Login bodies are JSON only; form-encoded logins and Basic authentication other than a static header value are not
  supported.

## Tests

```
npx tsc --noEmit
node --test "hub/connectors/**/*.test.ts"
```

Ten files, 128 tests, 16 to 25 s on the development Mac (the files run in parallel): `redact.test.ts` (values the Hub sent
as credentials found in answers in their encodings and charsets, masked in structures), `contracts.test.ts` (shapes and
refinements: literal POST paths, segment shapes, reserved headers and method-override members, the login path, envelope
modes, exact pack binding and credential rules, JSON Schema generation of every registered shape), `shape.test.ts` (every
keyword, adversarial sizes and depths), `routes.test.ts` (the allow-list matrix: methods, paths, queries, bodies, the write
route under the read prefix, dot segments, `;` segments and encodings, segment shapes), `http.test.ts` (loopback stubs:
refusals before I/O, plaintext, redirects, byte caps declared and streamed, timeouts, concurrency and interval, 401 and
envelope codes in every mode, the login URL refused as a read, the login exchange and whether a failed one was delivered,
the login's sending hook (after its slot, nothing sent before it returns, its own error kept), redaction, injected fetch),
`session.test.ts` (the login manager alone with an in-memory vault that can fail its writes,
reads and removals: stops, cool-down, token confirmation, a slow vault write, a reset during a login, unusable expiries,
bindings; and the entry between processes: a generation per write and entries without one, a stop ended only by a
removal or another process's generation and never by time or re-reads, callers after a removal sharing one login, another
process's token and stop adopted, an entry of another binding, an unparsable one and a failing read changing nothing, a
stop whose write failed kept, `status()` showing a stop or a cool-down ended elsewhere, a login in flight dropped after a
new credential or a removal elsewhere and stopping otherwise, two managers over one vault sharing one renewal and one stop,
the store's own writes including one that failed but landed, a refresh asked for after another one began reading getting a
read of its own, removals that fail reaching the caller; what a failure is recorded over: another process's cool-down that
landed while a refused login was out gets the stop and the password is not sent when it ends, a process whose logins
cannot reach the source waiting for the refused login instead of cooling down, another process's token is
used, a removal adopted while the credentials are compared wins, a confirmation does not overwrite another process's
stop, a reset wins over a read of the entry it overtook, a static refusal compared while a removal is adopted stops
nothing; the mark: written when a login is decided, a login a reset overtakes before it is sent not sent, no mark left by
a login that is not sent, the mark written again after a long wait for a request slot, another process waiting for a
login in flight and keeping its refusal or using its token (one attempt), a mark whose process is gone waited for until
its time, a reset ending a wait, a mark too far away ignored; a refresh asked for after a reset not joining one queued
before it),
`processes.test.ts` (two connector instances over one records kit and vault, as the running Hub and the CLI: a stop held
through time and the other process's reads and status, ended by the CLI's reset with one login on the next read and only
one; a reset through the CLI's own runtime; two reads after a reset sharing one login, successful or refused again; a
renewal and a stop shared by both processes and a new password from a third ending both; a login in flight when the CLI
sets the new password keeping no result; reads of both processes overlapping one refused login, one attempt in total; two
credentials set in one call, the one login carrying both; a static credential stopped in both processes, one attempt after
a reset, a changed value ending the stop, a new value after an accepted one sent once, a refusal in flight after the CLI
set the right value not stopping, a value both processes had accepted and a value refused in a process that loaded its
state before, each sent once in total after the refusal), `resources.test.ts` (with `describe`: admins only, names,
entries, rules and presence, disabled resources, no pack and no key needed, never a value; a reset or a new credential
whose session entry cannot be removed failing with the system code and no path; `setCredentials`: every value checked
before any is stored, the definition's order, one session reset, a value that cannot be stored after another keeping the
session), `login.test.ts` and `read.test.ts` (a temporary PostgreSQL from `hub/testing/postgres.ts`, the real
sandbox; where `sandbox-exec` is unavailable the kit passes `requireOsIsolation: false`, which synthetic tests may). Nothing
outside the test process is reached; every server is a loopback stub (a closed loopback port stands for an unreachable
source).

## Deviations from the brief

- The brief's `executeRead(resource, readName, args, reader)`: `args` is `{id, revision?, args?}` (the key of the object, an
  optional revision, extra arguments for the functions); `reader` is the `ExternalReadContext`.
- The ResourceAdmin has `updateResource`, `enable`, `describe`, `setCredentials`, `loginStatus` and `resetLogin` besides
  the four asked for.
- **The session entry is read again in more places than asked.** The request (assembly README, Needs → connectors) was to
  read it before refusing on a stop or a cool-down and in `status()`. It is also read before a login, before a stop, a
  failed login or a confirmation is recorded, and before every request with a static credential: another process's
  renewal is then used instead of a second login, its stop is kept instead of a second attempt with a refused password or
  static value (the brief warns that repeated failures may lock the account), a reset made while a login was out is not
  undone by that login's failure, and a confirmation does not erase another process's stop. Before a failure is recorded
  the stored credential values are also compared with the ones used, because a removal is invisible when the entry was
  absent already (a first login, or one right after a reset).
- **A login writes the entry when it is decided** (the mark, Decision 16), and another process that needs a login waits for
  its result. Not asked for; it narrows the window in which two processes send the same refused password from a login's
  round trip (up to its timeout) to one vault write. `HttpSource.login` takes a `sending` hook (called once the login has
  its slot, before anything is sent), where an overtaken decision stops the login and a long wait renews the mark.
- **A reset whose vault removal fails is an error** for the admin (`resetLogin`, `setCredential`, `setCredentials`:
  STORE_FAILED with the system error code); it was only logged (`session_store_failed`) when the process held the resource's runtime, and reached
  the caller as a raw file-system error when it did not. Otherwise the CLI would report a reset that a running Hub cannot
  see.
- **The static credential's one-request gate is per value.** It held a flag: once any value had been accepted, a new value
  set by the CLI went out with every request in flight. It now remembers the accepted value, so a new one is again sent
  by one request at a time until it is answered.
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
- Credential digest rules now come from the generated `digest_rule` axis; the vault still keeps only the declared stored form.
- The closed sets of `resources.ts` (HTTP methods, response kinds, authentication kinds, header schemes,
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
- **server (assembly: `hub/server/cli-admin.ts`)**:
  1. `secret set <资源> <凭据项> [<凭据项> …]`: read each value from standard input in turn and store them with one
     `connectors.admin.setCredentials(admin, resource, {name: value, …})`, so that a login taking two credentials (the
     agile platform's user name and password) has both changed before a running Hub ends its stop. Set one per call
     (today), a read of the running Hub between the two calls logs in with the new user name and the old password: a
     refused attempt against the new account, then a stop the second call ends. Until the command takes several names,
     its notice could give the safe order (Limits): `resource disable`, wait 5 s, `secret set` each credential, `resource
     enable`. `setCredentials` checks every name and value before it stores any (RESOURCE_INVALID), and a value that
     cannot be stored after others were is STORE_FAILED naming what was stored, with the session kept.
  2. Note only, no change needed: `resetLogin`, `setCredential` and `setCredentials` reject with `ConnectorError`
     `STORE_FAILED` when the session entry cannot be removed; `decided()` turns that into the command's error, so the
     success line is not printed (`cli-admin.ts` already behaves so).
  3. Done and verified (read, not run, since it is the assembly's test): the earlier items of this list are in the shared
     worktree. `RUNNING_HUB_LOGIN` (`cli-admin.ts`) and the stopped text of `loginText` say that no restart is needed; the
     test "… a running Hub ends its stop at its next read, without a restart, and both commands say so"
     (`hub/server/assemble/cli-admin.test.ts`) asserts 2 logins after `secret set` and 3 after a restart; `secret set`
     checks the credential through `describe`; `hub/server/assemble/README.md` (login state, Limits) describes the new
     behaviour. A running Hub that is waiting for another process's login mark (Login) logs `login_waiting`, which is not a
     failure event and needs no call note.
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
  Projections that restructure text (Markdown tables to JSON rows) produce the first form. (5) Optional: a
  compare-and-swap write of a vault entry (`replace(name, expectedDigest | null, value)`) would close what remains of the
  window in which two processes decide on one session together (one vault write, Limits) and let a stop never be replaced by
  a write decided before it; the session entry works without it.

## Open questions

- Should the read-only premise (D02 R[4] "只读由传输层强制") be recorded as certified per target and version (D02 R[1])
  now that the transport enforces it? Without a record the annotations stay those of an uncertified read (D03 R[6]).
- Should a resource of a shared system (for example one account for two systems) be able to share one token cache with
  another resource, so that a wrong password is tried once in total rather than once per resource?
- Should a running Hub that holds a usable token also drop it when the CLI resets the login (it would read the vault on
  every request)? Now a reset ends stops and cool-downs only; a new credential is used at the next login.
- Should the first request carrying a new static value also be marked in the session entry, as a login is, so that two
  processes never both send a new (possibly wrong) value? Now each process sends it once at most (Limits).

Pack sandbox error messages reach only the internal administrator-note reason channel after redaction, never persisted read-manifest reasons, nested pack inputs or public tool output (nested diagnostics stay in the administrator log); a terminal plan with no requests or nested reads may use its existing projection error to explain the refusal (the original sentinel is `unavailable`, and no projected success or artifact is accepted).

## Counted external identity failures

A single MAX_EXTERNAL_ID_BYTES budget is used by external parsing and entry refusals. Strict parseExternal still refuses
oversized values. Routing accepts a shape-valid oversized identity only when its type has an enabled resource, so run
inputs reach read() and preserve the byte count in the administrator note. executeRead uses the same counted reason
before any plan, login or request; malformed identities and unknown types do not become accepted reads. Synthetic tests
cover the real createTestHub start_run path, executeRead, and absence of request/key echoes.

External-id size advice in core is deliberately generic (缩短读取键后重读). Product-specific name-set or product-id advice remains in the system pack. The non-PLM oversized-key regression checks the actual reader entry.

Counted identity refusals carry a typed inputError only for an active Hub reader. The engine exposes this deterministic
caller-input fact only after workflow access checks, using its existing input-schema code and a shortening instruction.
Other read failures stay neutral; neither the supplied key nor resource existence/permission is disclosed by this field.

## 有界读重试（hub-read-absence 第 4 条）

仅重试 SOURCE_TIMEOUT、SOURCE_UNREACHABLE 和 HTTP 429/5xx。每个已规划请求共享两次传输重试，退避从 100 ms 起；有效 Retry-After（秒或 HTTP-date）是不得提前的时刻，累计等待至多 30 秒，超过预算便返回 retry 的原码、最早时间与实际尝试数，不缩短服务器要求。非法或不可表示的 Retry-After 是确定的格式故障。每次完整应答先存为原件；读清单逐次记录 attempt 和 retry_at，逻辑覆盖数不因重试重复累计，所有完整应答仍共用原字节预算。

max_requests 继续约束规划请求槽位。每槽位最多三次传输尝试；原有的明确登录失效再发一次沿用同一传输重试预算，物理读尝试最多四次。路由许可与原有登录停止规则保留：登录交换本身不重试，401/403/404/410、格式、凭据或本地存储故障不进入传输重试。ExternalRead 保留 retry 元数据；对外读取耗尽使用已登记的 SOURCE_RETRYABLE，带下次重读时间；登录请求记录仍等 hub-unknown-exits。

## 读取覆盖（hub-read-absence 第 3 条）

成功的 ReadOutcome、ExternalRead 与运行 SourceBinding 保留同一 coverage。计数单位是这次读声明的请求槽位和嵌套对象，不是业务条目；重试不会重复累计，尚未发出的已规划目标也进入 total。嵌套对象不完整时父对象同样不完整，其名称和补读动作进入 note。部分结果不进入成功缓存；新的读会重新取得它，不把曾经的部分当成完整缓存。

ReadPlanOutput.concurrency 可为一个计划指定更低的在途上限，实际发送仍受资源限流。敏捷包不再用五轮乘每轮四条的切片丢掉剩余根或页；所有配置根、所需页都列进计划后才答 done，同时声明 concurrency=4。请求、字节与轮数上限仍会拒绝超预算的读取。缺席/中性码、登录请求和第 9 条按运行授权读取器仍按任务依赖后接。

读取出口接口 Needs：登录停止需要 hub-unknown-exits 的具名资源管理员请求记录（请求号、缺失事实、期限、处置后重读入口）。接口合并前保持登录停止，不虚构已发出的请求。

缺席观察（hub-read-absence）：HTTP 404/410 的原件仍先保存；仅当它是本次对象的原件请求，才形成 SOURCE_ABSENT。系统包可在读取声明的 absent_codes 中列出表示整份对象缺席的投影错误码；代码不在声明里则仍是投影错误。ReadProjectionOutput.absent 也会核对系统、对象和应答键。支持应答必须本次已存且可读，401/403、凭据保留、超时或其他失败不能作缺席根据。Hub 以自己的读取时刻写规范 JSON 观察为 content，生成血缘指向支持应答，ReadOutcome/ExternalRead 同时带 absent；这类观察不进入嵌套缓存。必填输入直接答 SOURCE_ABSENT，期望来源则绑定该可读观察，供声明 reads 的检查读取。缺席不等同于对被测行为的通过或驳回。

资源启用的唯一性：同一环境类别内，每个外部类型至多一个启用资源，跨系统包也一样。新增、修改和启用在记录库业务锁下核对当前已提交的配置，与配置授权在同一事务里写入；同一连接池的其他配置调用在取数据库连接前排队。默认配置调用的行为保留，可选事务只用于这条核对。绑定包损坏或丢失时，缺少可核验的读取类型，拒绝新的冲突核对并说明恢复原包或停用旧资源的动作。读取的绑定错误进入私有诊断与管理员资源列表，普通读者列表不带这些原因。

分页与重定向：路由的 pagination.max_pages 约束该路由在一次对象读取中的显式分页请求数，仍受整份 max_requests、字节预算和规划轮数约束，超限拒绝，不能截断后答完成。重定向由 HttpSource 以 manual 接收并先存应答，安全的 Location 作为观察写入读清单和规划输入。只有源路由声明 redirects.same_origin、未超过 max_hops，且下一条规划请求以 against 指向该应答、href 逐字采用 Location，才跟随；同源、角色根路径、目标路由、参数和凭据规则逐项重验，不自动复用请求或跟随网络跳转。已跟随到成功应答的跳转计入完整覆盖。未声明、越源或超限的跳转给 SOURCE_REDIRECT_REFUSED，保留状态、可公开的 Location 和管理员核对动作；含凭据或不可安全公开的值不回显、不另存其摘要。

分页或整次读取预算用完，对有权读者由内部 READ_LIMIT 映射为 SOURCE_READ_LIMIT，说明页数、请求数或字节预算和管理员调整声明／缩小范围后重读的动作。未取得读权的调用仍不带这些诊断。

确定的非重试故障（来源状态／格式、规划、投影、存储、锁定修订）向已验证读取身份的调用者映射 SOURCE_READ_FAILED，给安全的核心错误说明与对应管理员／系统包负责人的修复动作；不回显仅管理员可见的附加诊断。无权、身份未定、来源拒绝凭据与凭据保留不借这个码透露内容；有界传输重试仍用 SOURCE_RETRYABLE，预算仍用 SOURCE_READ_LIMIT。旧内部原因前缀在管理员记录中保留，便于逐层核对。

保留原件的非重试故障不升为公开诊断。真实回显还隐藏原始 sha256、源记录身份和 ETag：函数视图与读清单不带这些值，派生来源不把回显原件的引用带出去，原件记录号仅写管理员事件。派生出件含实际 Hub 凭据回显或试图原样引用该原件时整次读取拒绝；普通来源的凭据受理与现有作用域规则保留。

环境边界 Needs：唯一性以“环境类别 + 外部类型”为键。两个不同环境仍可各启用一个同类型资源；外部读端口未声明环境时保留原来的歧义拒绝，不暗选生产或测试。管理员可使当前 Hub 的读取类型只采用一个资源；若要并用，后续需明确声明环境选择接口与绑定规则。

Shared-stop repair messages retain the actual secret names and the resource id supplied by the caller. Both stop paths emit the named `secret set --name …` and complete `resource reset-login <resource>` actions; the stop key still depends only on the shared decision digests.
