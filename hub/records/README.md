# records

Persistence layer and identity primitives of the Hub: model elements B01 B02 B04 B05 B08, R01 and R02 (visibility).
The package owns `hub/records/**`, `hub/config/**` and `hub/testing/**`. Other packages code against
`hub/records/api.ts` (types and pure helpers) and open the kit through `hub/records/index.ts`.

```ts
import '../config/guard.ts';                      // first import of every entry point: refuses CIRCLE_SERVER_*
import { loadConfig } from '../config/index.ts';
import { migrateRecords, openRecords } from '../records/index.ts';

await migrateRecords({ database: ownerDatabase }, { runtimeRole: 'circle_hub' });          // as the owner role (decision 16)
const kit = await openRecords(loadConfig(process.env), { keyProvider, migrate: false });  // as the runtime role
```

`openRecords(config)` without `migrate: false` still migrates with the connection's own role (one role owns everything).

| Module | Elements | What it does |
| --- | --- | --- |
| `canonical.ts`, `digest.ts` | B01, B03 | RFC 8785 canonical JSON; SHA-256 helpers; record digest = SHA-256 of the canonical `{kind, schema, provenance, created_at, body}` |
| `ids.ts` | | `prefix_ULID`, lowercase Crockford base-32, monotonic within a process |
| `migrations.ts`, `store.ts`, `db.ts` | B01 | forward-only checksummed migrator, owner and runtime roles; append-only `records` + `record_index`; `RecordStore` |
| `objects.ts` | B02 | content-addressed bytes under `<data>/objects/ab/<sha256>` |
| `scan.ts`, `artifacts.ts`, `text.ts` | B02, R02 | `source_artifact@1` records, credential scan and refusal, read tiers, `canRead`, tier-aware `source()` |
| `vault.ts` | | AES-256-GCM sealed entries under `<data>/vault`, `KeyProvider`, `FileKeyProvider`, `maskedForDisplay` |
| `principals.ts` | R01 | users, revocable tokens, `authenticate`, first-admin bootstrap, role history |
| `authorizations.ts` | B04, R01, R02 | `authorization@1` records in one chain per decision; `packsFor`, `canUse`, `canPublish`, `ownerOf`, `publication`, `isPublished`, `usersOf`, shares, resource configuration |
| `pointers.ts` | B05 R[4] | compare-and-set pointers; every move is a `move_root` action in the same transaction |
| `calllog.ts` | B08 | one line per MCP call: `call_log@1` record, `call_logs` row, `<log dir>/calls-YYYY-MM-DD.jsonl`; admin notes apart |
| `../config` | | `loadConfig(env)`, `assertNoRetiredEnvironment`, `guard.ts` |
| `../testing` | | `startPostgres()` (temporary cluster from the embedded binaries), `openTestRecords()` |

## Storage

Tables (migration 1, `records`): `records` (seq, id, digest, kind, schema, provenance, created_at, body, size),
`record_index` (key, value, digest, record_seq), `objects` (sha256, size, media_type, created_at), `users`,
`user_history`, `tokens`, `pointers`, `call_logs`, `call_notes` (digest, note, at), plus the journal `schema_migrations`.
Triggers reject UPDATE, DELETE and TRUNCATE on `records`, `record_index`, `objects`, `user_history`, `call_logs` and
`call_notes` (SQLSTATE `HU001`). Mutable state is only `users`, `tokens` (hashed), `pointers` and the vault files, as the
brief says.

Data directory (all directories 0700): `objects/ab/<sha256>` (files 0400), `vault/<name>.sealed` and `vault/key-check`
(0600), `logs/calls-YYYY-MM-DD.jsonl` (0600; `CIRCLE_HUB_LOG_DIR` can move it). A backup needs the database, `objects/`,
`vault/` and the vault key (which lives in the Keychain, not in the data directory).

Record kinds and schemas this package writes: `source_artifact@1`, `action@1` (validate refusals, `move_root`),
`authorization@1`, `call_log@1`. Their body shapes are the TypeScript types in `api.ts` (`SourceArtifactBody`,
`ActionBody`, `AuthorizationBody`, `CallLogEntry`). Index keys this package uses: `artifact.*`, `authz.*`, `pointer.name`,
`action.kind`, `action.run`, `action.user`. Other packages choose their own namespaced keys.

## Decisions

1. **Bodies are stored as their RFC 8785 text, not as jsonb.** jsonb and text both reject a raw U+0000, while a submission
   must be stored verbatim (B05 R[3]); the canonical text escapes it. Every read recomputes the digest from the stored row and
   throws `IntegrityError` when it differs.
2. **`created_at` is the exact `toISOString()` form** (UTC, milliseconds, years 0001-9999: timestamptz refuses the extended
   forms). It is part of the digest, so a put is idempotent only when the caller passes the same `created_at`; without one
   the Hub clock is used. An identical digest returns the existing record (`created: false`) and still adds any new index
   entries. Records that stand for a decision or an event therefore carry something that makes them unique (decisions
   7, 10, 11), so two equal events in one millisecond are never merged.
3. **Canonicalization** follows JSON.stringify for numbers and strings and sorts members by UTF-16 code units. Object members
   whose value is `undefined` are omitted; lone surrogates, NaN and infinities, `undefined` or holes in arrays, bigint,
   functions, symbols, cycles and non-plain objects (Date, Map, Buffer, class instances) are refused with a JSON Pointer
   (`CanonicalizationError.path`). Unicode noncharacters are accepted. **Input that cannot be canonicalized is kept as an
   object instead** (B05 R[3] "未受理的提交照样原样保存"): JSON text containing a lone-surrogate escape is valid JSON, and
   JSON.parse turns it into a lone surrogate, so the submission cannot be a record body. The caller stores
   `JSON.stringify(received)` (which writes the lone surrogate as `\udXXX` and round-trips exactly) with
   `objects.put(bytes, 'application/json')` and puts a record whose body names that object and the refused path; the test
   "a submission canonicalize refuses ..." shows the path. No new protocol code is needed by records; which code the
   submission answer carries (for example `SUBMISSION_SCHEMA_VIOLATION`) is the runs package's choice.
4. **Credential scan (`credential-scan@2`)**: detectors `private_key`, `bearer_credential`, `basic_credential`, `jwt`,
   `password_assignment`, `cloud_key`. Findings keep detector, byte offset, line and column, never the matched text, at most
   100 (`truncated`). The bytes are scanned in every form a reader could be served: UTF-8 (and, for bytes that are not valid
   UTF-8, the lossy UTF-8 decode `text()` serves, GB 18030 when valid, and windows-1252, the WHATWG reading of ISO-8859-1
   labels); UTF-16 with a byte order mark, or without one when the zero high bytes of ASCII characters show it; the same
   bytes without NUL (the text a reader gets); and every double-quoted string that holds an escape, with the escapes undone,
   up to four levels deep (a note in a KityMinder JSON export, the double-encoded agile answer, `\uXXXX`-escaped Chinese).
   A hit inside such a string is reported at the string's opening quote. Key forms: `key = value` with `= : => := ： ＝ |`,
   quoted (also escaped or typographic quotes) or not; `password VALUE` (command lines, `.netrc`); `<password>VALUE</…>`;
   YAML with the value on the next line; `host:port:db:user:password` lines; Chinese labels with `：=是为` or a space.
   Values must look like a secret (6 to 200 printable ASCII characters with a digit or symbol; the forms without a sign
   also need a letter and a digit and no hyphenated English word); placeholders, plain and dotted words, paths and the
   exact reference syntaxes `${…}`, `$VAR`, `%VAR%`, YAML tags (`!vault`), anchors and aliases, and `@/path` are not
   secrets, while a value that merely starts with `@` or `!` is. `token` keys: a credential prefix (`auth_token`) takes
   any secret-looking value, another identifier (`PLM_TOKEN`, `userToken`, `X-Token`) a token-shaped one (16 or more
   characters with letters and digits), pagination keys (`nextPageToken`) none. `pass`/`pwd` count only as a word of
   their own or a camelCase part (not `bypass`). Every pattern stops after 101 accepted hits and every look-ahead is
   bounded by the next header, so a scan is linear and its memory does not grow with the number of hits. **Bytes that are
   not text** (a compressed, archive, PDF or image container by its signature, or more than 5% C0 control bytes) are
   recorded as `inspected: false`, never as clean; any hit in them still counts.
5. **Upload with a credential hit** (B02 R[4], B05 R[3]): no object, no `source_artifact` record. A `validate` action is kept
   with `acceptance: not_accepted`, `codes: [CREDENTIAL_IN_UPLOAD]`, the subject `{sha256, size, media_type}`, the scan
   conclusion, the upload session/message ids and the uploader; the file name is not kept. `ingest` then throws
   `RecordsError` with code `CREDENTIAL_IN_UPLOAD`, the registered fix and the findings in `detail`.
   A **connector read or generated artifact with a hit** is stored with read tier `retain_only`. A hit belongs to the
   bytes: when the newest scanner version among the records of some bytes found a credential, every record of them reads
   as `retain_only` (a re-scan with a newer scanner takes effect by writing a new record). An upload that is **not
   inspected** is accepted with the tier asked for and `scan.inspected: false`; consumers decide what that means for them
   (see Needs, knowledge and connectors).
6. **Visibility and reads** (B02 R[3], F[5], R02). Visibility is `{readers, admins, packs, shareable}`: uploads during a run
   are `{[uploader], true, [], true}`; session excerpts for personal candidates `{[uploader], false, [], false}`; reads with
   a personal credential `{[reader], false, [], false}` (I read "只对读的人可见" as excluding admins); reads with a shared
   credential `{[], true, [packs bound to the resource], false}`. At most 64 readers and 64 packs. Connector reads are never
   shareable and only what admins may read can be shareable (B04 R[3]). **A share names one record**:
   `artifactShareKey(record)` = `rec:<record digest>`, so another user's upload of identical bytes stays private and the
   audience never sees its name, session or author. Every read re-reads the account (a disabled or demoted admin loses
   access at once; the role in a kept `Principal` is not trusted). Of the records of some bytes a reader may read, the one
   whose tier lets the most through decides (model_readable, then function_bytes_only, then retain_only; the oldest on a
   tie), the same for `readable()`, `text()` and `source()`. **Bytes go to readers only through `source(principal, sha256,
   {consumer})`**: model_readable to anyone, function_bytes_only to `consumer: 'function'` only, retain_only to no one
   (`bytes: null` with the note `含凭据，原文不可读` or the tier's label). `trustedBytes(sha256)` ignores the tier and is for
   backup verification and re-scanning only, never for pack functions, parsers or projections. Absent and forbidden give
   the same `null`. A recorded object whose file is missing is `IntegrityError`, not absence.
7. **Authorizations**: one record per decision, and every decision names the one it follows for the same (permission,
   subject, object) (`supersedes`), under a per-triple advisory lock; so a decision is always its own record, even when it
   repeats an earlier one in the same millisecond, and the decisions form one chain. The latest wins; expiry is checked at
   read time against the kit clock. Admins decide assignments, publish rights, resource configurations and shares. **A
   publication** (`publish`, object `pack-id@x.y.z`) needs: the decider as its subject, an active publish right, a SHA-256
   `bound` of the exact pack content (B04 R[1]), and ownership: the subject of the first publication of a pack id owns it
   (R01 R[0] "新版本只能由包的所有者发布"; first publications are serialized per pack); a version once published keeps its
   content (another bound is `ConflictError`; withdrawn versions may be listed again with the same content). Withdrawal is
   the owner or an admin. Ownership outlives a revoked publish right; there is no ownership transfer (B04 has no kind for
   it). Use `publication(packVersion)` or `isPublished(packVersion, bound)` to ask whether a version is published instead
   of reading publish records. The decider is re-read from `users` on every decision. `assign` does not know pack kinds:
   refusing system packs is the caller's check. Publish rights use the object `WHOLE_HUB` (`*`), resource configurations
   the subject `WHOLE_HUB`.
8. **Role changes** have no permission kind in B04, so they are recorded as append-only snapshots in `user_history`
   (user, name, role, disabled, changed_by, changed_at), one per change. The last enabled admin cannot be demoted or disabled;
   admin-set changes are serialized by an advisory lock.
9. **Tokens** are 32 random bytes in base64url (43 characters), shown once; only the SHA-256 is stored. `authenticate`
   accepts `Bearer <token>` (scheme case-insensitive) and refreshes `last_used_at` at most once a minute. A user may issue and
   revoke their own tokens; revoking someone else's token looks exactly like revoking an absent one (`false`).
10. **Pointers**: a per-name advisory lock, then compare; a refused move writes nothing and returns the current state;
    `next` must differ from `expected`. The `move_root` action records expected, next, the new version, the previous
    move's action digest (`previous_action`, chaining the moves), the triggering run, the component and the person, if any
    (B05 R[4]); so every move is its own action record.
11. **Call log**: arguments are reduced to the SHA-256 and byte size of their canonical JSON before anything is written
    (`JSON.stringify` text when they are not canonical JSON). Each call has a W3C span id (`spanId`, generated when the
    server gives none), so two calls with equal fields are two lines; retrying an append with the same span id is
    idempotent. A client session header outside printable ASCII is kept as `sha256:<digest>`. **`adminNote`** (the real
    reason behind a neutral answer, scenario 6) is kept outside the `call_log` record, in `call_notes`: the digest a user
    sees covers exactly what the user sees, so no note can be tested against it. `query()` adds notes for admins only and
    re-reads the account each time; a user sees only their own calls. The database is authoritative; the JSONL line (which
    carries the note, the files are the admin's) is written after the commit; when that write fails, `append` throws
    `RecordsError` and a retry with the same span id writes the missing line; `repairFiles({from, to})` appends every line
    a file misses (after a crash), leaving a line cut by a crash as it is. **B08 F[7]** (first 1 KB of the arguments after
    schema-based redaction): records accepts an optional `argsPreview` (at most 1024 bytes) and does not keep one the
    credential scanner flags; producing it, or not, is the server's decision (see Deviations).
12. **Configuration**: `CIRCLE_HUB_DATA_DIR`, `CIRCLE_HUB_PORT` and one of `CIRCLE_HUB_DATABASE_SOCKET_DIR` /
    `CIRCLE_HUB_DATABASE_HOST` are required; there is no default database and no default port (the earlier verification
    stack still runs on its port on the same Mac). Hosts are loopback IP literals only (`localhost` is refused). Any unknown
    `CIRCLE_HUB_*` name refuses to start (typo protection, same reasoning as the retired-name guard); secret-looking names are
    pointed at the vault. `allowUnknown` lets a client program (an admin shell with a client token) declare names it reads
    itself. Uploads are capped at 256 MiB (the scanner decodes an upload into strings; V8 strings end near 512 Mi
    characters) and requests at 512 MiB. The full list with Chinese descriptions is `HUB_ENVIRONMENT` in
    `hub/config/names.ts`.
13. **The pool never reads secrets from the environment or files**: every connection parameter is explicit and the password
    is a function, so pg never falls back to `PG*` variables or `~/.pgpass`. A password, when TCP needs one, comes from the
    caller (the platform reads it from the vault).
14. **Migrations** run in one transaction under an advisory lock. Refusals (`MigrationError`): an applied version this program
    does not know, a checksum or name mismatch, or a pending version below an applied one. Migration 1 must not change once it
    has been applied anywhere: append migration 2 instead. (Migration 1 changed in the review round of 2026-10-22, before
    the package was ever committed or applied to any database other than the tests' temporary ones: schema ids as contracts
    `SchemaId`, index values limited in bytes, `call_logs.span_id` and `args_preview`, `call_notes`.)
15. **Errors**: `RecordsError` and its subclasses (`IntegrityError`, `LimitError`, `AccessError`, `ConflictError`,
    `MigrationError`, `VaultError`) carry Chinese messages; `code` is a registered protocol code only when the failure belongs
    to the caller (today only `CREDENTIAL_IN_UPLOAD`), otherwise `null`. `TypeError` means the calling code passed a malformed
    value; validate tool input (zod) before calling, its messages are for developers. Every value that PostgreSQL would
    refuse (cursors beyond the bigint range, extended years, index values over 1000 bytes of UTF-8, schema ids) is refused
    before the query, so callers never see a raw driver error for their input.
16. **Two database roles** (append-only must hold against the running Hub itself): the owner role applies migrations
    (`migrateRecords`) and grants the runtime role exactly `RUNTIME_GRANTS`: SELECT and INSERT on the history tables, the
    column UPDATEs the mutable tables need (users: role, disabled, updated_at; tokens: last_used_at, revoked_at, revoked_by;
    pointers: target, version, moved_at, action_digest), SELECT on `schema_migrations`; no DELETE, TRUNCATE or DDL, and
    not the owner, so it cannot `DISABLE TRIGGER` either (all refused with 42501). `grantRuntime` refuses a runtime role
    that owns the tables. The runtime role opens the kit with `migrate: false`, which only verifies that exactly this
    program's migrations are applied.
17. **Vault**: AES-256-GCM with a 12-byte IV and the full 16-byte tag (`authTagLength: 16`); any other IV or tag length is
    refused. When entries exist but `key-check` is missing, the key must open an existing entry before the check is
    written; otherwise every operation is refused, so a second key never seals entries next to those of the first.

## Limits

- The scanner is heuristic: it misses credentials written as free prose ("the default password of the bed is ..."), BOM-less
  UTF-16 text with no ASCII characters, and content inside containers it cannot read (recorded as not inspected); it may
  flag unusual strings. A literal example password in a document (a manual's `user add … password Test@1234`) is a hit:
  such a manual read through a connector becomes `retain_only` and stays out of the knowledge tree (see Open questions).
  Rules are versioned (`credential-scan@2`); changing them means a new scanner version.
- The scan runs on the event loop: measured on the development machine, 32 MiB takes 0.1 to 0.5 s for text and up to about
  1 s for binary, so a 256 MiB upload may block other calls for several seconds. Moving the scan to a worker thread is a
  later option.
- Defaults: 32 MiB per upload or object (at most 256 MiB), 16 MiB per record body, request limit at least the base64 size of
  an upload. Over-limit input is refused whole (`LimitError`), never truncated.
- Vault values are at most 64 KiB; entry names `^[a-z0-9][a-z0-9._-]{0,99}$`.
- No leases or fencing tokens yet (`ActionBody.lease` is always null in milestone 1); effect and request records are out of
  scope.
- `startPostgres` cannot run as root (PostgreSQL refuses); the CI runner must be an ordinary user. A test process killed with
  SIGKILL leaves its cluster running (SIGTERM, SIGINT and SIGHUP clean up).

## Tests

All tests use a temporary PostgreSQL started by `hub/testing/postgres.ts` (one cluster per test file, one fresh database per
test) and temporary directories; nothing outside the temp directory is touched, and no network except loopback.

```sh
node --test "hub/records/**/*.test.ts" "hub/config/**/*.test.ts" "hub/testing/**/*.test.ts"
npx tsc --noEmit
```

Covered: RFC 8785 vectors (sections 3.2.2-3.2.4, appendix B numbers) and independently computed digest vectors; ids;
configuration and the retired-name guard (also as a child process), the upload cap; append-only enforcement on every history
table; idempotent put; exact round trip of NUL and other characters; every contracts schema id; index values by bytes;
cursor and year bounds; the verbatim path for a lone surrogate; tamper detection behind the triggers; paging and order;
transaction rollback; concurrent migrators, checksum, unknown-version and gap refusals; no password-file fallback; owner and
runtime roles (every kit operation as the runtime role, every tampering statement refused); objects (layout, modes, corruption
detected, never overwritten, size cap, missing file); vault (missing key, explicit init, tamper, renamed entry, wrong key,
truncated tag, IV length, missing key-check, names only, masked display); scanner positives (also inside JSON strings at
several depths, UTF-16 without BOM, GBK, lossy UTF-8, NUL-split keys, the new key forms), negatives on prose and look-alikes,
not-inspected bytes, offsets in every view, truncation, 32 MiB adversarial inputs per pattern with bounded memory; upload
refusal storing digest and scan only; retain_only for connector reads and across scanner versions; tier-aware `source()`;
the visibility matrix with record shares and assignments; stale principals; NUL-stripped previews over intact bytes; token
lifecycle; role history and last-admin protection; authorization chains under a frozen clock and under concurrency, expiry,
deciders, publication rules and the first-publication race; pointer compare-and-set race, transactional rollback and
repeated moves under a frozen clock; call log without argument content, span ids, notes outside the digest, JSONL retry and
repair, previews, admin and user views, tamper detection; cluster cleanup on SIGTERM.

## Deviations and disagreements

- **B08 F[7] versus the brief.** B08 lists "参数前 1 KB（按 schema 脱敏后）"; the brief says digest and size only, and
  scenario 7 checks that. By the brief's own rule the model wins, so records keeps an optional redacted preview when the
  server gives one, and nothing otherwise; scenario 7 holds as long as the preview carries no case text. The owner should
  confirm which way the server goes (Open questions).
- **API changes made for the review findings** (no other package imported them yet): `Artifacts.bytes()` is gone, replaced
  by `source()` (tier-aware) and `trustedBytes()`; `artifactShareKey` takes the source artifact record, not a sha256;
  `CredentialScan` gained `inspected` and the scanner is `credential-scan@2`; `CallLogEntry` gained `span_id` and
  `args_preview` and lost `admin_note` (it is on `CallLogLine` for admins); `CallLog.repairFiles`; `AuthorizationBody.supersedes`;
  `Authorizations.ownerOf`, `publication`, `isPublished`; a publication now requires a bound; `ObjectStore.get` throws for
  a registered object whose file is missing; `OpenRecordsOptions.migrate`, `migrateRecords`, `RUNTIME_GRANTS`.

## Open questions

- **Example passwords in product documents.** A connector read with any credential hit is `retain_only` (B02 R[4]), so a CLI
  manual whose examples contain literal passwords becomes unreadable and stays out of the knowledge tree; the real manuals
  have not been sampled for this. If that happens, the owner has to decide on a mechanism (for example a resource
  configuration that accepts named findings of one digest); B02 and B04 have none today.
- **B08 F[7]**: does the server send a redacted preview (and which fields does its redaction keep)?

## Needs from other packages

- **contracts**: (1) **a vocabulary axis for credential kinds** (B02 R[4] "凭据种类") with the codes of `CREDENTIAL_DETECTORS`
  (or the owner's own; records then maps to them): the detector ids are written into append-only records (scan conclusions,
  refusal actions), so the axis must exist before the first deployment, and the console needs its Chinese labels. Until then
  `CredentialFinding.detector` is a local id list. (2) A protocol code for an upload over the size limit (D01 R[2]
  "超大报错不截断"); `LimitError` carries `code: null` until one exists. (3) zod schemas for `source_artifact@1`, `action@1`,
  `authorization@1` and `call_log@1` in `SCHEMA_REGISTRY`; the shapes are the types in `hub/records/api.ts`. (4) A decision
  on recording role assignment: B04 has no permission kind for it (role changes are `user_history` snapshots for now).
- **platform**: (1) two roles (decision 16): run `migrateRecords({ database: <owner> }, { runtimeRole: 'circle_hub' })` as
  an owner role (for example `circle_hub_owner`, owning the database) for `serve --migrate-only`, and run the Hub as the
  runtime role with `openRecords(..., { migrate: false })`; restore as the owner (`--role=<owner>`) and run `migrateRecords`
  with the runtime role again afterwards (it applies nothing and grants again).
  (2) A Keychain `KeyProvider` (`getKey`, `initKey`; service and account from `config.keychain`); the database password
  from the vault when the database is reached over TCP; `import 'hub/config/guard.ts'` first in every bin entry point;
  backups of the database, `objects/` and `vault/`. (3) The keychain account default: hub/config says `vault`, the brief
  `vault-master-key`; the platform always sets it explicitly, so the owner should pick one and records will follow.
- **server**: map `RecordsError.code` into `errors` (null means an internal failure); call `callLog.append` once per MCP call
  with the raw arguments (only digest and size are kept), the `Circle-Session-Id` header and the Hub's span id for the call
  (retry a failed append with the same span id); call `callLog.repairFiles` for the last days at start; never show
  `call_log` record bodies, `call_notes` or `admin_note` to users; a `RecordReader` (hub/refs) must refuse `call_log` and
  `authorization` records to non-admins; adapt `artifacts.source()` to hub/refs' `SourceReader` (consumer `function` for
  Hub parsers and pack functions, `model` otherwise).
- **refs**: accept a source read whose bytes are withheld by its tier (`ArtifactSource.bytes === null` for retain_only, and
  for function_bytes_only read by a model) and answer with its note without hashing or parsing; today `SourceRead.bytes` is
  required.
- **runs**: refuse assigning or using system packs (authorizations does not know pack kinds) and check at `start_run` that the
  bound version is published with that exact content (`isPublished(pack@version, packDigest)`, B04 R[2]); keep a submission
  that cannot be canonicalized as an object (decision 3).
- **knowledge, connectors**: an artifact read with a personal credential, with a credential hit (`retain_only`) or not
  inspected (`scan.inspected === false`) never enters the knowledge tree as readable text (B02 R[3], R[4]); read bytes
  through `source()`, never `trustedBytes()`; set `visibility` from the credential method when ingesting.
- **acceptance**: to run the server as a child process, start the cluster with `startPostgres({ socket: true, passwordless:
  true })` and pass `CIRCLE_HUB_DATABASE_SOCKET_DIR` = `postgres.socketDir`; `CIRCLE_HUB_*` variables never carry a password.
