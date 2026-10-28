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
| `scan.ts`, `artifacts.ts`, `text.ts` | B02, B04, R02 | `source_artifact@1` records, credential scan and refusal, accepting the findings of a document (`acceptFindings`, `scanDigest`), read tiers, `canRead`, tier-aware `source()` (optionally pinned to one record) |
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
   A **connector read or generated artifact with a hit** is stored with read tier `retain_only`, unless an admin accepted
   exactly these findings of exactly these bytes and the Hub read or made them (decision 18; a record with a person as
   author, such as hub/runs' copy of a value from a user's own record, stays `retain_only`). A hit belongs to the bytes:
   when the newest scanner version among the records of some bytes found a credential, every record of them reads as
   `retain_only` unless an acceptance in force covers it (a re-scan with a newer scanner takes effect by writing a new
   record). An upload that is **not
   inspected** is accepted with the tier asked for and `scan.inspected: false`; consumers decide what that means for them
   (see Needs, knowledge and connectors).
6. **Visibility and reads** (B02 R[3], F[5], R02). Visibility is `{readers, admins, packs, shareable}`: uploads during a run
   are `{[uploader], true, [], true}`; session excerpts for personal candidates `{[uploader], false, [], false}`; reads with
   a personal credential `{[reader], false, [], false}` (I read "只对读的人可见" as excluding admins); reads with a shared
   credential `{[], true, [packs bound to the resource], false}`. At most 64 readers and 64 packs. Connector reads are never
   shareable and only what admins may read can be shareable (B04 R[3]). **A share names one record**:
   `artifactShareKey(record)` = `rec:<record digest>`, so another user's upload of identical bytes stays private and the
   audience never sees its name, session or author. Every read re-reads the account (a disabled or demoted admin loses
   access at once; the role in a kept `Principal` is not trusted). **The newest record of some bytes a reader may read
   decides**, the same for `readable()`, `text()` and `source()`, **except that a record another person supplied never
   outranks the rest**: an upload, or a record with a person as author (`author.user`, B02 F[2]), by someone other than
   the reader decides only when the reader may read no record the Hub read or made and none of their own. So no user can
   change which record, media type or provenance governs someone else's reads by uploading the same bytes (an upload is
   declared, its media type is the uploader's word, and a connector re-read returns its first record, so the upload would
   otherwise stay the newest for good). `records()` still lists every record, oldest first, and `canRead()` answers for
   the one record it is given. **A read can be pinned to one record**: `source(principal, sha256, { record })` and
   `text(..., { record })` take the digest of a source_artifact record of these bytes (for example the record a connector
   read returned); that record decides, or the answer is `null` when it is no record of these bytes or the reader may not
   read it, and the credential rule below applies to it the same way. (Until 2026-10-22 the record whose tier let the most
   through decided, the oldest on a tie; the integrator changed it with the findings acceptance, so the accepted record,
   which is newer than the retain_only one, decides; the exception for other people's records came with the review of
   that change. Consequence: a newer record with a narrower tier, for example a connector read at function_bytes_only of
   bytes someone uploaded earlier, narrows what a reader who may read both gets.) Its tier is the effective tier, except
   that a credential hit no acceptance in force lifts makes it retain_only (decision 18).
   **Bytes go to readers only through `source(principal, sha256, {consumer})`**: model_readable to anyone,
   function_bytes_only to `consumer: 'function'` only, retain_only to no one
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
    (B05 R[4]); so every move is its own action record. `list(prefix)` is a read-only listing by name prefix, added for
    the named documents (`doc:`) of hub/server.
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
    `hub/config/names.ts`. The keychain item of the vault master key defaults to service `circle-hub`, account
    `vault-master-key` (the platform's and the brief's name; it was `vault` before 2026-10-22). The Hub calls no model
    (decision 15 of `docs/hub-r4-progress.md`): `CIRCLE_HUB_JEV_MODEL`, which named the typed-judgment model, was removed
    on 2026-10-22 and is refused as unknown, like every other name the Hub does not read. **Names only platform commands read** (`PLATFORM_ONLY_ENVIRONMENT`,
    today `CIRCLE_HUB_LIBPQ_BIN`) are tolerated and never read, so an operator shell that sets them can run
    `circle-hub serve`; the list is the values of hub/platform `PLATFORM_VARIABLES` that hub/config does not read, and a
    test keeps the two equal. `CIRCLE_HUB_HOME` is not one of them: the platform reads the data root from
    `CIRCLE_HUB_DATA_DIR` and refuses `CIRCLE_HUB_HOME` as unknown, so tolerating it here would let `serve` ignore a
    directory the operator meant (see Deviations). Tests also keep the retired-name guard of hub/config and the copy in
    hub/platform equal, and the keychain defaults.
13. **The pool never reads secrets from the environment or files**: every connection parameter is explicit and the password
    is a function, so pg never falls back to `PG*` variables or `~/.pgpass`. A password, when TCP needs one, comes from the
    caller (the platform reads it from the vault).
14. **Migrations** run in one transaction under an advisory lock. Refusals (`MigrationError`): an applied version this program
    does not know, a checksum or name mismatch, or a pending version below an applied one. Migration 1 must not change once it
    has been applied anywhere: append migration 2 instead. (Migration 1 changed in the review round of 2026-10-22, before
    the package was ever committed or applied to any database other than the tests' temporary ones: schema ids as contracts
    `SchemaId`, index values limited in bytes, `call_logs.span_id` and `args_preview`, `call_notes`.) **Schema ids**: the
    table's CHECK (`^[a-z][a-z0-9_-]*@[0-9]+$`) is a shape backstop, like those on kind and provenance, and lets a
    leading-zero major through; the exact rule is contracts `SchemaId` (lowercase letters, digits, `_` and `-`, a major
    without leading zero), applied by `put()` before the query and again on every read (a stored record that does not
    satisfy it is `IntegrityError`). Migration 1 keeps its applied text; no migration was added for this. Component and
    generator ids (`name@major`) use contracts `Versioned` the same way.
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
18. **Accepting the findings of a document** (integrator's decision of 2026-10-22). A product manual read through a
    connector can contain example URLs with a user name and a password (`ftp://user:<password>@<host>/<path>`), which
    the scanner reports as `basic_credential`; under decision 5 such a manual would stay `retain_only` and never enter the
    knowledge tree. An admin may therefore decide, explicitly and auditably, that the findings of exactly those bytes are
    no credentials. The scanner itself is unchanged and no hit is ignored by a rule of thumb.
    - `scanDigest(scan)` = SHA-256 of the RFC 8785 canonical JSON of `{scanner, findings: [{detector, offset}]}` (findings in
      scan order: offset, then detector). Positions and detector ids only; line, column, `inspected`, `truncated` and an
      earlier acceptance take no part, so another scanner version or another finding set gives another digest.
    - `artifacts.acceptFindings(admin, sha256, note?)`: only an enabled admin (the account is re-read; `AccessError`
      otherwise). The stored bytes are scanned again with the current scanner (never a finding list handed in). Refused
      with `ConflictError`: bytes that are not stored (a refused upload keeps none); bytes whose every record is an upload
      or has a person as author (there is nothing an acceptance could lift); a scan without findings; and a
      **truncated** scan (more than 100 findings): `scanDigest` binds only the 100 positions kept, the
      admin was never shown the rest, and past a pattern's cap of 101 hits the rest were never looked for, so accepting it
      would lift text nobody examined (B04 R[1]: a permission covers exactly the bound content). The decision is the
      existing B04 resource configuration, no new permission kind: `authorizations.configureResource(admin,
      scanAcceptanceKey(sha256) = 'scan:<sha256>', scanDigest(scan), note)`, one append-only record in the chain of
      decisions of that object (connectors and anyone else listing `resource_config` decisions must expect these
      objects; see Needs). `revokeFindings(admin, sha256, note?)` appends the withdrawal; the chain stays. These are admin
      actions, not MCP tools: their refusals carry Chinese messages for the admin and `code: null`.
    - **Notes** (on an acceptance and on a withdrawal) are refused (`RecordsError`, nothing recorded) when the credential
      scanner flags the note itself, or when the note shares a run of 6 consecutive characters without white space with
      the text around a finding: the line of the hit and the next one (for a key header, the key material after it), in
      the decoded and unescaped form the scanner found it in. That catches a pasted password, a pasted
      `user:<password>@host` and a sentence that quotes either; the comparison runs on the fly and keeps nothing. It is a
      guard against copying, not a proof: a password shorter than 6 characters quoted alone, or one described in other
      words, is not caught, and a note that quotes harmless text from those lines (an address, a command word) is refused
      too. Write notes in your own words.
    - Ingest of a **read or generated** artifact with hits that the Hub read or made (`author.user` null): when the
      configuration `scan:<sha256>` is in force and its bound digest equals `scanDigest` of the fresh scan, which is not
      truncated, the record keeps the requested tier (default model_readable) and `scan.accepted = {by, at,
      authorization}` names the decision (`authorization` is the digest of the configuration record); the findings stay as
      found. Otherwise nothing changes (`retain_only`). The acceptance's digest is part of the dedupe key (only when there
      is one), so repeating the ingest under the same decision returns the accepted record, and a later decision gets a
      record of its own. **What a person supplied is never lifted** (B02 R[4]: acceptance is for what the Hub reads from
      configured sources or makes): an upload with a hit is refused whatever was accepted, a record with a person as author
      (for example hub/runs' `runs.record@1` copy of a value from the user's own record) stays `retain_only`, and neither
      an upload record nor such a record whose bytes a newer scan flags is lifted at read time. Whether bytes are the
      Hub's is decided by the record: not an upload and `author.user` null (connectors and knowledge set no person;
      `upload_file` and hub/runs' `rec:` inputs set one).
    - Reads check the acceptance again at every use (B04 R[1]): a hit is lifted only for a record the Hub read or made,
      only while the configuration is in force, and only when its digest equals `scanDigest` of every scan of the newest
      scanner version that found something and none of those scans is truncated. A withdrawal makes the bytes
      `retain_only` again at once, also through records written while the acceptance held; so does the first record of a
      newer scanner version whose findings differ (or any newer version: its scanner id is part of the digest), until an
      admin accepts that scan. Other bytes (an edited manual) have another SHA-256 and are never covered.
    - Records are never changed: their stored tier describes admission time. Decision 20 now computes the effective
      tier from current acceptance and the requested policy; a historical scan-imposed hold is not a reason to skip a
      currently accepted source. Explicit requested retention remains in force.

19. **Carrying findings acceptance to derived bytes** (task `derived-acceptance`, 2026-10-23; extends decision 18).
    `IngestInput.derivedSources` offers source byte digests for a Hub-generated artifact. Records verifies the links,
    the source records and their entire Hub-owned ancestry, current administrative acceptance and complete scans. Each
    finding of the derived bytes must match an accepted source finding exactly, in memory. The internal scanner returns
    the detected credential value for assignments/authentication forms, the token for token-shaped forms and the complete
    observed private-key material (not a shared header). Existing decoding/unescaping applies; key JSON escapes are decoded.
    Alternative decoded hits collapsed to one reported position all need coverage; extraction beyond its bound fails closed.
    - This is not an automatic administrative decision. The stored scan has `derived.sources`: source byte SHA-256,
      the exact source-artifact record and its covering administrative decisions (`by`, `at`, `authorization`). No
      matched text, substring, context, password fingerprint or matched-text digest is stored, logged or returned.
      Source bytes and authorized document reads still use the ordinary artifact pipeline. `scan.accepted` remains
      the separate, direct acceptance of these exact bytes; `ArtifactSource.acceptance` reports effective `direct` or
      `derived` coverage, or is absent when there is no effective acceptance. The stored record is never rewritten.
      `source held` lists scan-hit byte sequences, including those now accepted, with current tier and one of
      “直接受理 / 由派生覆盖 / 没有受理”; `source findings` shows the same current state and safe source/decision references.
      This includes revoked derived receipts whose historical record still says model-readable.
    - Only actual inputs qualify. `src:` names source bytes and `rec:` can pin a source-artifact record. A knowledge
      view names `tree:<root>/` and pins the exact `tree_root@1` composition with a `rec:` reference; records verifies
      its inline sources and `tree_root-sources@1` parts. A different composition or an accepted document elsewhere
      in the Hub cannot provide coverage. Unknown input links fail closed. Every input, including clean inputs, must
      have a Hub-owned ancestry: an upload or human author anywhere in the chain prevents inherited acceptance.
      Cycles and chains beyond 32 records fail closed; explicit retain-only source records cannot provide coverage.
    - At every artifact read, all newest scan evidence and all recorded dependencies are checked again. Revoking any
      source acceptance immediately withholds derived bytes, including through a multi-stage chain and a pinned read.
      No acceptance result is cached across reads. Stored scans and coverage are immutable facts, so reads check
      their scanner/digest and current dependency decisions without re-scanning bytes (decision 20). A replacement
      administrative decision needs a new ingest to refresh an
      existing derived receipt; a historical receipt cannot silently substitute another source record or decision.
      Truncated or uninspected scans, and incomplete exact-match extraction, cannot provide or receive coverage.
    - `Artifacts.prepareDerived` builds one operation-scoped matcher for a Hub-generated artifact. It returns only an
      opaque assessment function and safe source/decision metadata; `coverDerived` remains the single-input convenience
      wrapper. Knowledge shares one matcher across all entries/rows and final ingestion. Whole-answer scanning and
      coverage remain mandatory: part assessments do not establish whole-answer admission.
    - **Model-owner handoff:** this extends the administrative exception described in decision 18, not the set of
      automatically trusted credential content. B02 R[4] must describe inheritance from explicitly accepted Hub sources,
      while uploads and human ancestry remain excluded. B04 F[0] must include that derived use of a scan acceptance;
      B04 R[1] still requires current decisions on every read. No model or contracts bytes were changed here.

20. **Batch coverage and metadata-only reads** (scale follow-up to decision 19, 2026-10-23).
    - `RecordStore.getMany` and `findMany` verify every record digest in bulk; `Authorizations.resourceConfigs` selects
      the newest active decision per requested key in one query, preserving withdrawals and expiry. A coverage context
      loads actual source/composition records by graph frontier, memoizes ancestry and effective acceptance for this
      operation, and obtains all candidate scan/decision metadata in batches. It scans only currently accepted source
      bytes once, building an in-memory exact-value-to-source map. Each entry then performs lookups in that map.
      The map never leaves records and is not persisted; no matched-text fingerprint is computed or stored.
    - `prepareDerived` handles are bound to their origin/author by a package-private WeakMap. Ingest uses the private
      assessment function (public method replacement cannot forge a result) and revalidates current source scan metadata
      and authorizations in batches before storing coverage. Returned evidence is copied, so mutating a preview cannot
      alter the matcher. Ingest snapshots caller-owned bytes before any asynchronous preparation so the stored bytes,
      scan and coverage fact always refer to the same content. The context dies with the operation; no live authorization
      cache spans separate reads.
    - Reads do not load source bytes or run the credential scanner. They compare current scanner identity and stored
      scan metadata digests, validate each recorded source/decision and the Hub-owned ancestry, then apply the requested
      read policy. New derived receipts explicitly carry `scanner` and `scan_digest` (a positions/detectors digest, not
      a digest of matched text); older receipts already bind the scan through their immutable record. A newer scan or
      revoked/expired/replaced dependency holds the bytes immediately. Reading the requested object's bytes still
      verifies its content-addressed identity through ObjectStore.
    - New artifact records store `requested_read_tier`, separate from historical `read_tier`. Current acceptance can
      remove a scanner-imposed hold, while an explicit requested retain-only tier is preserved. No stored record is
      rewritten. Legacy records without `requested_read_tier` use a compatibility default: current acceptance restores
      model-readable unless an accepted/derived annotation on a still-retained record proves an explicit retain request.
      This is a policy default, not evidence of an unrecorded historical request; an explicit request on an old,
      unaccepted record cannot be reconstructed. The synthetic scale guard includes held source-record pins under a
      current acceptance.
    - Whole-file truncation remains a refusal of inherited coverage; the scanner still keeps at most 100 findings.
      Knowledge reserves a deterministic budget for retained parts and index keys, reports coverage and budget omissions,
      and checks the final complete byte sequence. **Follow-up:** admitting an answer as separately checked parts is
      not implemented; this would need an explicit format/policy decision rather than bypassing the scanner cap.

## Limits

- The scanner is heuristic: it misses credentials written as free prose ("the default password of the bed is ..."), BOM-less
  UTF-16 text with no ASCII characters, and content inside containers it cannot read (recorded as not inspected); it may
  flag unusual strings. A literal example password in a document (a manual's `user add … password Test@1234`, an example
  URL `ftp://user:Test1234@192.0.2.10/`) is a hit: such a manual read through a connector is `retain_only` until an admin
  accepts the findings of exactly those bytes (decision 18), or their findings are covered by their actual accepted inputs (decision 19). Placeholder passwords are no hit (`ftp://user:secret@host/path`
  is not one: `secret` is a placeholder word). Rules are versioned (`credential-scan@2`); changing them means a new
  scanner version, and a new version's findings need a new acceptance.
- An acceptance is per byte sequence: every edited release of a manual needs its own decision. A scan with more than 100
  findings keeps the first 100 (`truncated`) and cannot be accepted at all: such a document stays `retain_only` (see Open
  questions). The note check of decision 18 is a guard against copying, not a proof that a note holds no secret.
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
configuration and the retired-name guard (also as a child process), the upload cap, the keychain defaults,
tolerated platform-only names, the removed `CIRCLE_HUB_JEV_MODEL` refused as unknown; drift against hub/platform (retired
names, platform-only names, keychain defaults) in
`hub/config/drift.test.ts`; append-only enforcement on every history
table; idempotent put; exact round trip of NUL and other characters; every contracts schema id accepted and leading-zero,
upper-case and empty ones refused, on put and on read; `Versioned` component and generator ids; index values by bytes;
cursor and year bounds; the verbatim path for a lone surrogate; tamper detection behind the triggers; paging and order;
transaction rollback; concurrent migrators, checksum, unknown-version and gap refusals; no password-file fallback; owner and
runtime roles (every kit operation as the runtime role, every tampering statement refused); objects (layout, modes, corruption
detected, never overwritten, size cap, missing file); vault (missing key, explicit init, tamper, renamed entry, wrong key,
truncated tag, IV length, missing key-check, names only, masked display); scanner positives (also inside JSON strings at
several depths, UTF-16 without BOM, GBK, lossy UTF-8, NUL-split keys, the new key forms), negatives on prose and look-alikes,
not-inspected bytes, offsets in every view, truncation, 32 MiB adversarial inputs per pattern with bounded memory; upload
refusal storing digest and scan only; retain_only for connector reads and across scanner versions; findings acceptance in
`findings.test.ts` (scanDigest formula and what it ignores; a synthetic manual with an example FTP URL retained before and
readable after acceptance; admin only, stale principals; nothing stored, refused uploads and clean bytes; edited bytes and
other finding sets not covered; uploads refused under an acceptance and never lifted; withdrawal at once and for new
reads; a newer scanner version not covered, also for the records the acceptance covered; no matched text anywhere in
the database; the newest readable record decides, while another person's upload never outranks the Hub's read or the
reader's own (record, media type, provenance); reads pinned to one record; a truncated scan refused and never lifted by a
configuration, at ingest or at read; records with a person as author refused, never lifted, also when an older scanner
passed them; notes that copy text around a finding refused for a URL line, a YAML value on the next line, a hit two
escape levels down in a double-encoded answer and key material over several lines); `scanWithContexts` gives the same
scan as `scanForCredentials`; derived coverage in `derived.test.ts` (offset/JSON transformations, every hit covered,
unrelated sources, withdrawals through chains, human ancestry, truncation, no matched text or matched-text digest in
records/metadata, full private-key material and multiple escaped hits at a shared position); tier-aware `source()`;
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
- **Findings acceptance versus B02 R[4] and B04 F[0]** (decision 18, the integrator's decision of 2026-10-22). B02 R[4]
  has no exception for a credential hit, and B04 F[0] lists the uses of a resource configuration as deployment instance,
  environment class, source-to-tree mapping and freeze release. Accepting the findings of one byte sequence is a fifth
  use of the same kind; the model owner should record it in B02 R[4] and B04 F[0]. Uploads keep B02 R[4] unchanged.
- **API additions of 2026-10-22** (nothing renamed or removed): `Artifacts.acceptFindings`, `revokeFindings`,
  `FindingsAcceptance`, `ScanAcceptance`, optional `CredentialScan.accepted`, `scanDigest`, `scanAcceptanceKey`;
  `PLATFORM_ONLY_ENVIRONMENT`, `isPlatformOnlyName`, `DEFAULT_KEYCHAIN_SERVICE`, `DEFAULT_KEYCHAIN_ACCOUNT`.
  (`HubConfig.jev` and `DEFAULT_JEV_MODEL`, added that day, were removed the same day when the Hub stopped calling any
  model, decision 15; `CIRCLE_HUB_JEV_MODEL` is refused as unknown now.) Changed behaviour: the newest readable record
  decides `readable()`, `text()` and `source()`
  (decision 6); the default keychain account is `vault-master-key`; schema ids are checked on read too; **generator ids**
  (`origin.generated.generator`) and **pointer components** (`MoveInput.component`) are checked as contracts `Versioned`
  instead of `^[a-z][a-z0-9_.-]*@[0-9]+$`, so a leading-zero major (`name@01`, `name@00`) that was accepted before is now
  a `TypeError` (contracts refuses it so that `x@01` and `x@1` cannot both exist; see Needs, connectors).
- **Changes of the review of the follow-ups (2026-10-22)**, nothing renamed or removed. Added: the optional `record`
  option of `Artifacts.source()` and `text()` (a read pinned to one record). Changed behaviour: another person's upload
  or record no longer outranks the Hub's records or the reader's own (decision 6); `acceptFindings` refuses a truncated
  scan and bytes no record of which the Hub read or made, and an acceptance never lifts a truncated scan or a record with
  a person as author, at ingest or at read (decision 18); a note on `acceptFindings` or `revokeFindings` that copies text
  from the lines carrying a finding is refused.
- **`CIRCLE_HUB_HOME` is not registered** although the follow-up asked for it: the follow-up also named hub/platform
  `PLATFORM_VARIABLES` as the source of truth, and it has no such name (the platform reads `CIRCLE_HUB_DATA_DIR` and its
  own tests refuse `CIRCLE_HUB_HOME`). If the platform adds it, `drift.test.ts` fails until it is added here.

## Open questions

- **B08 F[7]**: does the server send a redacted preview (and which fields does its redaction keep)?
- **Real manuals not sampled here**: which detectors and how many findings the real manuals give is not known to this
  package. A manual with more than 100 findings cannot be accepted (decision 18). If real manuals have that many example
  URLs, the owner decides between a new scanner version that keeps more findings per scan (an admin must still be able to
  check each one) and leaving such manuals out of the knowledge tree.

## Needs from other packages

- **contracts**: (1) **a vocabulary axis for credential kinds** (B02 R[4] "凭据种类") with the codes of `CREDENTIAL_DETECTORS`
  (or the owner's own; records then maps to them): the detector ids are written into append-only records (scan conclusions,
  refusal actions), so the axis must exist before the first deployment, and the console needs its Chinese labels. Until then
  `CredentialFinding.detector` is a local id list. (2) A protocol code for an upload over the size limit (D01 R[2]
  "超大报错不截断"); `LimitError` carries `code: null` until one exists. (3) zod schemas for `source_artifact@1`, `action@1`,
  `authorization@1` and `call_log@1` in `SCHEMA_REGISTRY`; the shapes are the types in `hub/records/api.ts`. (4) A decision
  on recording role assignment: B04 has no permission kind for it (role changes are `user_history` snapshots for now).
  (5) `PackVersion` accepts leading zeros (`01.0.0`), unlike semantic versioning and unlike `Versioned` and `SchemaId`,
  which refuse a leading-zero major; a version without leading zeros keeps ids derived from it (connectors' generator
  ids) valid.
- **platform**: (1) two roles (decision 16): run `migrateRecords({ database: <owner> }, { runtimeRole: 'circle_hub' })` as
  an owner role (for example `circle_hub_owner`, owning the database) for `serve --migrate-only`, and run the Hub as the
  runtime role with `openRecords(..., { migrate: false })`; restore as the owner (`--role=<owner>`) and run `migrateRecords`
  with the runtime role again afterwards (it applies nothing and grants again).
  (2) A Keychain `KeyProvider` (`getKey`, `initKey`; service and account from `config.keychain`); the database password
  from the vault when the database is reached over TCP; `import 'hub/config/guard.ts'` first in every bin entry point;
  backups of the database, `objects/` and `vault/`. (3) `HUB_CONFIG_VARIABLES` in `hub/platform/environment.ts` mirrors
  `HUB_ENVIRONMENT`; a test keeps the two equal. (The keychain default is now
  `vault-master-key` on both sides, and hub/config tolerates `CIRCLE_HUB_LIBPQ_BIN`.)
- **server**: map `RecordsError.code` into `errors` (null means an internal failure); call `callLog.append` once per MCP call
  with the raw arguments (only digest and size are kept), the `Circle-Session-Id` header and the Hub's span id for the call
  (retry a failed append with the same span id); call `callLog.repairFiles` for the last days at start; never show
  `call_log` record bodies, `call_notes` or `admin_note` to users; a `RecordReader` (hub/refs) must refuse `call_log` and
  `authorization` records to non-admins; adapt `artifacts.source()` to hub/refs' `SourceReader` (consumer `function` for
  Hub parsers and pack functions, `model` otherwise). Admin actions for `artifacts.acceptFindings` and `revokeFindings`
  (decision 18): show the admin the line, column and detector of each finding of the `retain_only` record so they can be
  checked in the original system, and never ask for or echo the matched text; ask for a note in the admin's own words (a
  note that copies text around a finding is refused) and pass the refusal messages on as they are (a truncated scan, or
  bytes only a person supplied, cannot be accepted).
- **refs**: accept a source read whose bytes are withheld by its tier (`ArtifactSource.bytes === null` for retain_only, and
  for function_bytes_only read by a model) and answer with its note without hashing or parsing; today `SourceRead.bytes` is
  required.
- **runs**: refuse assigning or using system packs (authorizations does not know pack kinds) and check at `start_run` that the
  bound version is published with that exact content (`isPublished(pack@version, packDigest)`, B04 R[2]); keep a submission
  that cannot be canonicalized as an object (decision 3). A `rec:` input copy (`runs.record@1`) names the starting user as
  author, so with a credential hit it stays `retain_only` and no acceptance lifts it (decision 18); that is right for a
  copy of the user's own record (a submission). If a copy of a record the Hub wrote (a validation result handed to a
  verification run) should be treated as the Hub's output, give it no person as author.
- **knowledge, connectors**: an artifact read with a personal credential, with a credential hit (`retain_only`) or not
  inspected (`scan.inspected === false`) never enters the knowledge tree as readable text (B02 R[3], R[4]); read bytes
  through `source()`, never `trustedBytes()`; set `visibility` from the credential method when ingesting. Decide by the
  effective tier `source()` and `text()` return, not by `scan.findings.length` (an accepted scan keeps its findings).
  After an admin accepts the findings of some bytes, ingest them again: a sync that skips unchanged source digests must
  not skip a source whose stored record is `retain_only` while `authorizations.resourceConfig(scanAcceptanceKey(sha256))`
  is in force. Keep `author.user` null for what the Hub reads or makes: a record with a person as author is never lifted
  by an acceptance and ranks below the Hub's records for other readers (decisions 6, 18).
- **knowledge**: read a source by the record the connector returned: `artifacts.source(admin, sha256, { consumer,
  record: load.artifact.digest })` in `SourceLoader.readable`. Unpinned, the admin's own later upload of the same bytes
  (which ranks with the Hub's records for that admin) would decide the media type and the record the root cites as its
  source; another person's upload no longer can (decision 6).
- **connectors**: (1) `resource_config` decisions whose object is `scan:<sha256>` are findings acceptances, not
  resources: `ResourceRegistry.#read()` (hub/connectors/resources.ts) should skip every object that is not a contracts
  `ResourceId` (`res_…`); today it looks up the acceptance's bound (a `scanDigest`, which names no stored object) on every
  refresh and logs `resource_unreadable` for `scan:…`, also after a withdrawal. (2) Generator ids are checked as contracts
  `Versioned` (`name@major`, no leading-zero major): `${pack}.${read}@${majorOf(version)}` gives `name@01` for a pack
  versioned `01.0.0`, which contracts `PackVersion` accepts, and records refuses it (`TypeError`, so every derived artifact
  of such a pack would fail with PROJECTION_FAILED); derive the major as `String(Number(major))`. No pack in the tree has
  such a version today.
- **acceptance**: to run the server as a child process, start the cluster with `startPostgres({ socket: true, passwordless:
  true })` and pass `CIRCLE_HUB_DATABASE_SOCKET_DIR` = `postgres.socketDir`; `CIRCLE_HUB_*` variables never carry a password.

## Unique business keys

`RecordInput.unique_key` atomically binds `(kind, unique_key)` to one immutable record. The key is 1–1000 UTF-8 bytes, well-formed and without NUL. Concurrent duplicates return the first verified record with `created: false`, including its original body, schema and time; a losing candidate contributes no index entries. Callers must compare that record's binding before using it. `RecordStore.getByKey` reads the binding through the public API. A caller-owned transaction rolls back the record, its index and key together. When acquiring multiple keys in an outer transaction, callers use one global key order.

Migration 3 adds append-only `record_keys` with primary key `(kind,key)` and a foreign key to `records`; the runtime receives SELECT and INSERT only. Migrations 1 and 2 are unchanged. Tests: `node --test --test-concurrency=1 hub/records/*.test.ts`.

`createRecordStore(database, StoreOptions)` exposes the shared writer for a component that already owns a database transaction (for example leases). Its `put` joins the same transaction; it does not open an independent commit. Prefer passing the deployment's configured RecordStore when available so its record limits and instrumentation remain authoritative.

## Noncanonical stored representations

The digest is defined over canonical content. Reads first verify the stored body text without reparsing for the hash. If that fast check fails, they strictly parse JSON (rejecting duplicate member names), canonicalize it, and recompute the same canonical envelope digest. Only an exact digest match is accepted. Different content, malformed JSON or noncanonicalizable values still raise IntegrityError. Historical body bytes, digests and migrations are never rewritten.

Every accepted fallback is disclosed through `recordIntegrityNotes()` in the public API: the process-local total read count and per-record id/digest/read counts with the explanation “正文不是规范写法、内容与摘要一致”. Snapshots are detached, contain no body text, retain up to 1000 distinct examples and explicitly mark truncation; the total count continues beyond that cap. This is maintenance telemetry, not a new authorization or a rewritten historical fact. An operator examining old data queries it in the same process that performed the reads. Fast-path reads do not increment it.

### 已应用迁移的字节基线

`migrations.snapshot.test.ts` 固定三条迁移的版本、名称和 SQL 字节 SHA-256（新增 record_keys，原来两条保持原值），另固定包含它们的
`migrations.ts` 文件摘要。新增迁移仍只能追加：复核时更新文件摘要，已有版本的 SQL 摘要保持原值。
这是仓库内已应用迁移的防改检查，不是对持久部署数据库的检查；本任务没有接触持久服务。

`RecordStore.lock(key, tx)` 为调用方给定事务持有业务键锁，提交或回滚释放；它不新开事务，不改历史。键先加 record-store.business 类型前缀再取 PostgreSQL 哈希，采用独立具名常量 BUSINESS_LOCK_SPACE，与记录库其他 advisory 锁命名空间均不同；lock-namespaces.test.ts 静态检查全部调用点的具名常量和值互不冲突。多键调用方必须排序取锁。本次合并同时保留唯一业务键与事务锁接口；回注去重继续使用事务锁，是否改用唯一业务键由集成者另定，不改写已有迁移。

唯一业务键锁使用独立的 `UNIQUE_KEY_LOCK_SPACE`，与来源去重和普通业务事务锁的命名空间均不同；合并保留三种用途，不让它们互相占用同一个锁空间。

完整管理员理由（hub-read-absence）：新增迁移 6 call_reasons，只追加每条理由的序号、完整正文和时刻；原 call_notes 的 2,000 字摘要与已应用迁移 1–5 的 SQL 均保留。CallLogInput.adminReasons 不参与调用记录及其摘要，在同一事务中批量写入；当前管理员查询才有 admin_reasons，普通读者无该字段。追加回执可带私有摘要；JSONL 的新写、重试与 repairFiles 重建只带调用回执字段，不带 admin_note 或 admin_reasons。部署迁移由整合者另行执行；本分支只在临时 PostgreSQL 验证。

日志理由不是源文件：完整理由和摘要均拒绝保存触发凭据扫描的原文，不写命中文字或其摘要；只保留已触发日志保护这一确定说明。管理员仍可在原系统或受限原件中重现并私审，不能靠日志旁路读凭据。

首轮复核修正：MCP 的管理员摘要只记理由条数，不拼接理由原文；旧调用方单独提供的 adminNote 仍只在数据库管理员查询里可见，文件序列化统一剔除所有私有备注字段。

## Named deployment versions

`RecordsKit.variables` persists `variable@1` and metadata-only `secret@1` objects through ordinary append-only resource-configuration decisions (`var:<name>` / `secret:<name>`). Every write requires the current administrator and a scanned, nonempty reason. Both kinds share the sorted `variable-name:<name>` transaction locks; a name retains its kind after withdrawal. Ordinary canonical same-values reuse the version; every secret setting makes a fresh random vault entry and decision. Batch settings commit all decisions in one transaction; transport reads select the current decisions together and refresh the whole batch once if any vault entry has disappeared.

The snapshot for ordinary variables is one verified database query. Values are loaded by those immutable decisions when used, so later settings cannot alter an existing snapshot. Cross-object validation joins the caller's transaction through `configureResourceInTransaction`; validators must use that transaction and avoid opening a second database connection while holding name locks.

Secret bytes never enter these objects, records or their hashes. Current and previous vault versions remain available across one rotation; older entries and unbound entries older than an hour are collected on the next setting. `Vault.stat` exposes only the entry write time, without decryption or a master-key read. Revocation removes every entry for that name. Missing bytes, length mismatches and consumer/address changes refuse before transport, with the setting command as the next action. Listing and history remain administrator-only. If a secret was mistakenly persisted as an ordinary variable, the only remedy is to rotate it at its issuer; immutable history cannot be erased.

Synthetic regressions include fifty concurrent writers, cross-kind races, coherent two-secret reads, rotation and exact consumer binding, orphan age, missing/altered vault entries and caller-transaction rollback. No schema migration or deployed history is changed.

Secret withdrawal deletes only entries named by grant decisions preceding its revocation. A concurrently prepared or later committed version is not removed. A post-commit cleanup failure explicitly reports that revocation is effective and instructs the administrator to repair storage and repeat the withdrawal. Reversible spellings can be requested from `secretForms(value, {hashes:false})`; general reason redaction also includes digest spellings.

短密钥的理由检查先排除每种写法的完整值，再检查长度至少 8 的连续片段；`--short` 的脱敏提示不豁免完整值检查。拒绝不写决定或密钥条目，也不引用原始理由。

Ordinary JSON token screening checks both object keys and values recursively, including objects inside arrays. A key meeting the strict token rule requires the same explicit `--not-secret` confirmation; refusal never quotes that key.

Every successful scan acceptance also appends an immutable read-action receipt
(`records.scan-accept@1`) with `automatic`, the selected detector ids, the source
hash, the linked authorization and the deciding administrator. Query indexes are
`authz.scan-accept.receipt` (authorization digest), `authz.scan-accept.source` (source
hash) and `authz.scan-accept.automatic` (the serialized boolean). Explicit/API
acceptance records false; deployment-policy acceptance records true. This identifies
the decision mechanism, not whether a human inspected every match. A later withdrawal
does not rewrite the receipt or imply that the old decision is still effective.
`authorizations.grant(by, input, tx?)` 可以加入调用方事务，许可核对不变；事务回滚时决定一起回滚。产品包声明变量时，在同一事务取名字锁、核对归属并写发布决定。

## Sharing audiences and objects (B04, decision 35 item 22)

`share` retains the user-array API and also accepts `{kind: 'pack_users', pack}`. User decisions use the user id as
`subject`; a pack audience uses `pack_users:<pack>` and one record. New decisions carry generated `share_audience`;
legacy shares without it are user decisions only. The newest decision of each permission/subject/object wins, including
withdrawals. `shares(admin, object?)` lists only currently active decisions. Pack membership is re-read through the latest
assignment when an object is read, so unassignment revokes the audience immediately without rewriting the share.

A run share uses its immutable run id as the object. The policy object `production:<pack>` binds
`{pack, accepted_producer: 'fact'}` by canonical content digest and applies only to frozen fact-only requirements of that
pack, including future and Hub-side runs. A pack audience of a run must name that run's pack. Records expose a read-only
sharing query for consumers that have a record store; it grants no decision capability. Sharing grants viewing, never
submission or lineage continuation; it never overrides connector-source visibility, credential holding or knowledge-tree
permissions. No package-specific policy is built into these keys.

`artifacts.sourceForRun(viewer, sha, run, {consumer})` is a read-only capability for generated evidence. It reads and
validates the immutable run, checks owner/admin or current sharing access, and requires an exact `src:` digest in its
frozen source bindings or verified projected locations. Only a generated-origin artifact record can decide this read; a recorded user author does not turn Hub rendering into a connector read. Uploads and connector
originals gain no visibility from a run share. The ordinary scanner/acceptance and consumer-tier calculation is reused;
there is no trusted-bytes fallback and no source ACL rewrite. Missing/corrupt stored bytes retain the ordinary integrity
error. A source reference without the authorized run continues to use the reader's original source visibility.

### 视图性能支持：hub-view-perf

`ingest` 仍在异步工作前复制输入。新增的内部 SDK 方法 `ingestTransferred` 明确消费完整可转移缓冲区：调用方及其全部别名会被分离；池化切片等不可转移输入仍复制快照。其余来源、权限、凭据扫描、受理与入库规则共用原路径。调用方不可再次使用被消费的输入。

`getTexts` 按有界窗口批量读取并核对每个记录摘要，返回的是文本而非已校验业务对象，消费者仍须核对 JSON 和对应业务合约。`findFirstMany` 保留逐值查询的最早记录选择，单次 SQL 内按索引查询；规范编码和摘要以固定块避免整份中间字符串。当前改进由集成者接收，合成冷读 RSS 回归护栏为实测 494,448 KiB 加 15%；原三分之一目标保留为后续项。这里只证明合成路径，不代表持久部署或发布验证。

合成测量、预算和后续项见[视图性能任务页](../../docs/hub-r4-tasks/hub-view-perf.md)。

## 大体积扫描测试数据（2026-10-28）

`scan.test.ts` 的 1,500,000 字节图片使用固定公开种子的 SHAKE256 合成数据，避免每轮随机 base64 偶合凭据形状使 clean 断言不稳定。保留原性能、命中上限及 clean 断言，并检查输入大小和低可压缩性；另用同规模数据构造 base64 内的合成凭据形状，检查仍有 cloud_key 命中。生产扫描器没有改变。

来源及允许修改范围见任务页 `docs/hub-r4-tasks/stable-scan-fixture.md`。按集成者指令，本轮没有运行测试或类型检查；固定输入的 clean 结论和新增断言均待集成者验证，不计通过。
