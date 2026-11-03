# Knowledge and memory sync protocol, version 1

Status: normative. This page specifies version 1 of the personal knowledge and memory sync protocol so that any
client and any server can implement it without reading Hub code. circle-hub is one server implementation; it serves
the protocol under `/api/sync/v1`. A short overview in Chinese is in [knowledge-sync-v1.zh-CN.md](knowledge-sync-v1.zh-CN.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only
when, they appear in capitals.

Machine-readable shapes are generated from the contracts and are part of this specification: every request and answer
body named below has a JSON Schema (draft 2020-12) in
[`contracts/generated/schemas/`](https://github.com/circle-platforms/circle-hub/tree/main/contracts/generated/schemas)
named `<schema>.v1.schema.json` (for example `personal-sync-commit.v1.schema.json`), generated from
[`contracts/src/sync.ts`](https://github.com/circle-platforms/circle-hub/blob/main/contracts/src/sync.ts). Where the
prose and a schema disagree, the schema wins. The frozen shared vectors in
[`contracts/test-fixtures/sync/v1/`](https://github.com/circle-platforms/circle-hub/tree/main/contracts/test-fixtures/sync/v1)
fix exact canonical bytes, object identities and expected outcomes; an implementation that reproduces them is
interoperable on encoding. A portable reference of the encoding is
[`contracts/src/sync-canonical.ts`](https://github.com/circle-platforms/circle-hub/blob/main/contracts/src/sync-canonical.ts)
and of the ancestry merge [`contracts/src/sync-merge.ts`](https://github.com/circle-platforms/circle-hub/blob/main/contracts/src/sync-merge.ts);
both depend only on JSON, UTF-8 and SHA-256.

## 1. Scope and roles

The protocol moves one account's own knowledge, originals, folders, memory and pack manifests between that account's
clients and a server, and keeps a revision history with explicit conflicts. It does not publish anything to a team,
grant access, install or execute packs, or read business systems. Team content and content shared by others are not
exported through it.

- A **client** is any program the account holder runs (a desktop or terminal client, a script). Several clients of one
  account sync the same personal space.
- A **server** keeps the account's sync state per account and **epoch** (section 8) and re-verifies everything it
  receives before it becomes native knowledge or memory.
- The sync API is an ordinary HTTP API. It is not an MCP tool and a server MUST NOT expose it to models as one.

## 2. Transport and endpoints

All routes are relative to the **sync base URL**. On circle-hub the base is `<issuer>/api/sync/v1`, where `<issuer>`
is the origin the client reached the server on (scheme, host and port, no path). Route templates are fixed relative to
the base: a client MUST NOT rewrite them, and a server MUST serve exactly these paths. `{id}` is a session UUID for the
`/sessions/{id}/…` routes and an operation key for `/operations/{id}`.

| Route | Method | Request body | Answer body (200) |
|---|---|---|---|
| `/state` | GET | none | `personal-sync-state@1` |
| `/clients` | POST | `personal-sync-client@1` | `personal-sync-client@1` |
| `/sessions` | POST | `personal-sync-session@1` | `personal-sync-session-reply@1` |
| `/sessions/{id}/inventory?epoch=…[&cursor=…]` | GET | none | `personal-sync-inventory@1` |
| `/sessions/{id}/missing` | POST | `personal-sync-missing@1` | `{"missing": [id…]}` |
| `/sessions/{id}/upload` | POST | `personal-sync-upload@1` | `personal-sync-receipt@1` |
| `/sessions/{id}/download` | POST | `personal-sync-download@1` | `personal-sync-transfer@1` |
| `/sessions/{id}/commit` | POST | `personal-sync-commit@1` | `personal-sync-result@1` |
| `/sessions/{id}/abort` | POST | `personal-sync-abort@1` | `personal-sync-receipt@1` |
| `/operations/{id}?epoch=…[&cursor=…]` | GET | none | `personal-sync-mode-result@1`, `personal-sync-result@1` or `personal-sync-receipt@1` |
| `/mode/check` | POST | `personal-sync-mode-check@1` | `personal-sync-mode-impact@1` |
| `/mode` | POST | `personal-sync-mode-change@1` | `personal-sync-mode-result@1` |

The same table is published as data in `contracts/test-fixtures/sync/v1/http.json` (`personal-sync-http@1`).

Message rules:

- Request bodies MUST be `Content-Type: application/json` in UTF-8 without a byte order mark, without
  `Content-Encoding` other than `identity`, and MUST be one JSON object. Duplicate object members are refused
  (I-JSON, RFC 7493). A POST carries no query string.
- Every request and answer shape is closed: a server MUST refuse a request member or query parameter it does not know
  with `SYNC_OBJECT_INVALID`. Clients MUST ignore answer members they do not know (section 13).
- Answers are `application/json; charset=utf-8` with `Cache-Control: no-store`.
- Browser-style cross-origin use is not supported: a request carrying an `Origin` header that is not the server's own
  origin is refused with 403. There is no CORS.
- The sync API never takes a source URL, a local path or an arbitrary record address; all scope comes from the
  authenticated account.

## 3. Object kinds

Every synchronized thing is an immutable **object**: a JSON value with the envelope

```json
{"schema": "personal-sync-object@1", "kind": "<kind>", "body": { … }}
```

and a closed body per kind (`personal-sync-object.v1.schema.json`). The kinds are the `sync_object_kind` vocabulary:

| Kind | Body | Meaning |
|---|---|---|
| `bytes` | `bytes_base64` | Verbatim bytes (at most 1 MiB decoded): a chunk of an original, or a verbatim quotation. Never normalized. |
| `source_revision` | `item_id`, `parents`, `directory_id`, `name`, `media_type`, `raw_sha256`, `size`, `chunks` | An original document: its `bytes` chunks in order, the SHA-256 of the raw bytes and their size. |
| `entry_revision` | `item_id`, `parents`, `directory_id`, `content`, `grounds` | A knowledge entry and its grounds; each ground names a quotation `bytes` object and either a source revision with a parser and selector, an existing reference, or another entry revision. |
| `directory_revision` | `item_id`, `parents`, `parent_directory`, `name` | A folder. The root has `parent_directory: null` and an empty name. Empty folders sync too. |
| `memory_revision` | `item_id`, `parents`, `directory_id`, `title`, `markdown`, `state` | A memory document (`enabled` or `disabled`). Memory is never an input or a ground. |
| `pack_manifest` | `item_id`, `parents`, `manifest` | A personal workflow or skill manifest. Holding a manifest does not install, publish or run anything. |
| `deletion` | `item_id`, `parents` (non-empty), `target_kind` | An explicit deletion of an item. A missing item is never read as a deletion. |
| `inventory_page` | `items` | Up to 500 index rows `{kind, item_id, heads}`, sorted by `kind + ":" + item_id`, unique. |
| `snapshot` | `parents`, `pages` | One state of the whole personal space: the sorted set of its inventory pages and its parent snapshots. |

A client's verification flags are not part of any object: the server computes verification (section 7).

## 4. Identity and revisions

- The **object ID** is the lowercase hexadecimal SHA-256 of the object's canonical bytes (section 5). Two objects with
  equal canonical bytes are one object. The object ID of a `source_revision` and its `raw_sha256` are different values
  and MUST NOT be substituted for each other.
- An **item** is a folder, entry, original, memory document or pack with a stable random `item_id` (a UUID). Renaming,
  moving or editing an item keeps its `item_id`; every change is a new revision whose `parents` lists the revisions it
  replaces. An item has exactly one kind.
- The **heads** of an item are its revisions that no other listed revision of the same item descends from
  (`mergePersonalSyncHeads`). One head is the normal case; more than one head is a **conflict**.
- A **snapshot** names the heads of every item through its pages. Its `parents` are the snapshots it continues.
- Sets are sorted and unique: `parents`, `heads`, `pages` and the hashes in a batch are sorted by their hexadecimal
  text (which equals byte order); `items` is sorted by `kind:item_id`. Ordered lists (`chunks`, `grounds`, Markdown
  text) keep their order. The caller supplies sorted sets; the server does not sort them.

## 5. Canonical form

The canonical bytes of an object are the UTF-8 encoding of the JSON Canonicalization Scheme (JCS,
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)) applied to the object **after every string, member names
included, has been normalized as editable text**:

1. The string MUST be well-formed Unicode (no lone surrogates); otherwise the object is invalid.
2. One leading U+FEFF (byte order mark) is removed. A BOM elsewhere is kept.
3. CR LF and lone CR become LF.
4. The result is put in Unicode Normalization Form C (NFC). No other change: other whitespace, trailing spaces,
   case and final newlines are kept; NFKC is not applied.

Further rules:

- Member names are compared after normalization; two names that become equal make the object invalid.
- Numbers are finite (no NaN or infinity); JSON nesting is at most 64 levels.
- An object MUST match its closed schema both before and after normalization.
- Verbatim bytes (original chunks and quotations) travel only as canonical padded standard base64 (RFC 4648 section 4)
  in a `bytes` object, so normalization never touches them. A source with a BOM or CR LF keeps it.
- A canonical object is at most 8 MiB (the server may announce less in `limits.object_bytes`).

A server MUST decode uploaded bytes strictly (fatal UTF-8, no BOM, no duplicate members), re-encode them and refuse
bytes that are not already canonical with `SYNC_OBJECT_INVALID`, and refuse bytes whose SHA-256 is not the claimed ID
with `SYNC_OBJECT_HASH_MISMATCH`. The server never guesses a client's hash from non-canonical input. The vectors in
`encoding.json` and `native-links.json` pin exact bytes for these rules.

## 6. The sync flow

A complete exchange is: state → client → session → inventory → missing → upload → download → commit.

1. **State.** `GET /state` returns the account's `epoch`, `mode`, `status` (`sync_status`: `idle`, `syncing`,
   `complete`, `conflicted`), `state_version` (an opaque hash of the current personal content, used for CAS),
   `snapshot` (the current snapshot ID or null), `last_synced_at`, `used_bytes`, `capacity_bytes` and the effective
   `limits` (section 11). Reading state never creates content.
2. **Client.** `POST /clients` registers the client's random `client_id` (UUID) and a display `name` (1–100 characters).
   It is idempotent; the same ID with another name is `IDEMPOTENCY_MISMATCH`. The client ID is a device declaration,
   not an identity: it does not authenticate anything.
3. **Session.** `POST /sessions` with `client_id`, `epoch`, `known_state` (the last `state_version` the client saw, or
   null) and `base_snapshot` (the last snapshot it committed or downloaded in this epoch, or null) opens a resumable
   session. The answer has `session_id`, `expires_at` (at most `limits.session_seconds` later), the current `state`
   and `inventory_cursor`. The session freezes the server's inventory at that moment.
4. **Inventory.** `GET /sessions/{id}/inventory?epoch=…` pages through the frozen inventory as descriptors
   `{id, kind, bytes}`, ordered by ID; follow `next` as `cursor` until it is null. A cursor is opaque and bound to the
   account, epoch, session and snapshot.
5. **Missing.** `POST /sessions/{id}/missing` with up to `limits.batch_objects` object IDs returns the subset the
   server does not hold for this account and epoch. Found IDs are leased to the session so they stay downloadable and
   committable. The answer never reveals whether another account holds equal bytes.
6. **Upload.** `POST /sessions/{id}/upload` sends a batch `{schema: "personal-sync-upload@1", epoch, operation_id,
   objects: [{id, bytes_base64}]}`. The batch is all-or-nothing: every object is decoded, checked for shape, size,
   identity and credentials before any is stored. Uploaded objects are staged only: no model, search, memory session
   or grant can read them before a commit. The receipt counts `accepted`, `existing` and decoded `bytes`.
7. **Download.** `POST /sessions/{id}/download` with object IDs returns `{objects: [{id, bytes_base64}], missing}`.
   Only objects in the session's frozen inventory or leased to it are returned; anything else is listed in `missing`.
8. **Commit.** `POST /sessions/{id}/commit` with `{schema: "personal-sync-commit@1", epoch, operation_id,
   expected_state, base_snapshot, snapshot}` asks the server to make `snapshot` current (section 7). On success the
   answer `personal-sync-result@1` carries the new `state`, the `receipt`, per-object `verification`, `conflicts`,
   optional `projections` (where accepted objects landed natively) and `next`; when `next` is not null the client
   reads the remaining pages with `GET /operations/{operation_id}?epoch=…&cursor=<next>`.
9. **Abort.** `POST /sessions/{id}/abort` ends a session and releases objects only it leased. Sessions also expire;
   an expired session answers `SYNC_SESSION_EXPIRED` and the client keeps its local revisions and opens a new one.

A client builds a candidate snapshot locally: new revisions continuing the current heads, inventory pages listing
every item, and a snapshot whose `parents` include the current snapshot. It uploads whatever `missing` reports,
then commits. On an empty personal space a client uploads the root directory, its revisions, the page and the
snapshot and commits with the state the server returned.

## 7. Commit, CAS and conflicts

A commit is a compare-and-swap on the whole personal space, inside one server transaction:

- `epoch` MUST be the current epoch (`SYNC_EPOCH_CHANGED`) and the mode MUST be `hub` (`SYNC_MODE_LOCAL`).
- `expected_state` MUST equal the current `state_version`; otherwise the server answers 409 `SYNC_VERSION_CONFLICT`
  with the current `state` in the error body and changes nothing. Native edits made in the server's console or through
  MCP tools change `state_version` too, so they take part in the same CAS. A client MUST NOT retry by substituting the
  new state blindly: it downloads, merges and commits a new candidate.
- `base_snapshot` is null or a snapshot this account committed earlier in this epoch (`SOURCE_UNAVAILABLE` otherwise).
- The candidate graph MUST be closed (every referenced object present: `SYNC_OBJECT_MISSING`), acyclic, typed
  (a revision's parents are revisions of the same item and kind; chunks and quotations are `bytes`; pages hold
  revisions whose kind and item match the row) and bounded (`SYNC_BATCH_LIMIT` beyond 10,000 items or 4,096 levels).
- The candidate MUST advance every current item: each current item appears in the candidate, and each current head is
  equal to or an ancestor of a candidate head of that item. Dropping a competing head is `SYNC_VERSION_CONFLICT`.
  Heads listed for one item MUST NOT descend from each other.

Merging is deterministic and the same on both sides: changes on one side are taken; changes to different items are
united; identical revisions are one. When both sides changed one item, the candidate keeps **both heads** and the
item is conflicted. No clock, arrival order or semantic merge chooses a winner. A conflict is resolved by a new
revision that lists all competing heads as its parents. Conflicted memory is not loaded into new client sessions, and
conflicted knowledge is not used as a current entry, until it is resolved. The server may also report a structural
conflict with a single head (`structural: true`), for example a folder cycle or two siblings whose names collide after
normalization.

The server re-verifies every entry revision against what the account may read now: folder resolution, ground
readability, parser eligibility, selector position and the verbatim quotation. A client's claim is never evidence.
`verification[]` reports per object `status` (`verified` or `unverified`), the rule version, scanner, parser locks,
bounded positions and registered codes. A wrong or missing quotation leaves the revision stored as `unverified`; it is
not an error of the commit. `last_synced_at` changes only on a successful commit without conflicts.

## 8. Epochs, modes and purge

The `sync_mode` of an account is `hub` (sync to the server, the default for every account) or `local` (keep personal
content on the client only). The wire value `hub` names the mode, not a product; clients choose their own display text.

- Every return from `local` to `hub` starts a new opaque `epoch`. Sessions, objects, heads, cursors and operation
  keys are scoped to account and epoch; an old epoch's requests are refused with `SYNC_EPOCH_CHANGED`. A new epoch
  never restores grants or content from before a purge; the client uploads its local copy again as new content.
- `POST /mode/check` with `{mode}` returns the impact of a change without writing anything: `check` (an opaque hash of
  the impact and its inputs), `expected_state`, `personal_bytes`, `directory_grants` that would end, `pending_shares`
  (null when the server cannot count them) and `team_copies_preserved`.
- `POST /mode` with `{epoch, operation_id, mode, expected_state, check, confirm_purge}` changes the mode. Switching to
  `local` **purges** the server's copy of the epoch: personal knowledge, originals, folders, memory, staged objects and
  their projections are removed and the account's folder grants end. It requires `confirm_purge: true` and the `check`
  of a fresh `/mode/check`; a stale `expected_state` or `check` is `SYNC_VERSION_CONFLICT`. Team copies made by
  sharing stay, local copies are untouched, and a server backup taken before the purge still holds the old content.
- Switching from `local` to `hub` creates the new epoch; `check` is null and `confirm_purge` false.
- Requesting the current mode is a no-op with a receipt.

## 9. Receipts and idempotency

Upload, commit, abort and mode change carry an `operation_id` (1–128 characters of `A–Z a–z 0–9 _ -`), chosen by the
client and unique per account and epoch. The server binds the key to a hash of the route template, the session (for
session routes) and the complete request. Sending the same key with the same request again returns the original
receipt (or commit result) instead of performing the write again, also after a server restart; the same key with a
different request is `IDEMPOTENCY_MISMATCH`.

A receipt `personal-sync-receipt@1` has `operation_id`, `epoch`, `request` (the request hash), `previous_state`,
`state_version`, `counts` and `at`. When an answer is lost, the client either repeats the identical request or reads
`GET /operations/{operation_id}?epoch=…`, which returns the mode result, the first page of the commit result, or the
receipt of an upload or abort; an unknown or foreign key is `SOURCE_UNAVAILABLE`. Mode receipts stay readable after
the epoch they ended.

## 10. Authentication and authorization

- Every request carries `Authorization: Bearer <access token>`. A missing, expired, revoked or otherwise unusable
  token, or one of a disabled account, is answered with 401, the header `WWW-Authenticate: Bearer` and the body
  `{"code": "SOURCE_UNAVAILABLE"}`, before any body is read.
- Access tokens are the server's ordinary member access tokens. On circle-hub a client obtains one with the MCP
  authorization flow, OAuth 2.1 with PKCE (RFC 7636), dynamic client registration (RFC 7591) and a resource indicator
  (RFC 8707) naming the protected resource `<issuer>/mcp`; the resource and its authorization server are discovered
  from `<issuer>/.well-known/oauth-protected-resource/mcp` (RFC 9728) and
  `<issuer>/.well-known/oauth-authorization-server` (RFC 8414). The same token authenticates the sync API. Access
  tokens an administrator issues for an account are accepted too. Console sign-in sessions, cookies and setup or
  invitation codes are not.
- Version 1 tokens carry no per-route scopes: whoever holds an account's access token may sync that account.
- The scope is always the authenticated account. There is no owner or space parameter; administrators have no right
  to sync another account. Another account's sessions, operations and objects answer exactly like absent ones.
- The server rechecks the token and the epoch before it sends a private answer; a token revoked or an epoch purged
  while a request ran gets no private bytes.

## 11. Limits

`GET /state` and every session answer report the limits actually in force; a client MUST NOT exceed them and MUST NOT
assume larger values.

| Limit | Field | circle-hub default |
|---|---|---|
| Canonical object | `limits.object_bytes` | 8 MiB, never above `batch_bytes` |
| Decoded bytes per batch | `limits.batch_bytes` | 8 MiB (`CIRCLE_HUB_SYNC_MAX_BATCH_BYTES`), bounded by the request size limit |
| Objects per batch | `limits.batch_objects` | 64 |
| Inventory and result page | `limits.page_items` | 500 |
| Session lifetime | `limits.session_seconds` | 86,400 |
| Byte object | fixed | 1 MiB decoded |
| Requests per account | not reported | 120 per minute (`CIRCLE_HUB_SYNC_REQUESTS_PER_MINUTE`), shared by all tokens and clients; at most 2 concurrent writes |

Personal capacity (`capacity_bytes`, 1 GiB by default) counts committed and staged objects, all history and conflict
candidates and memory, by original bytes rather than base64 length; exceeding it is `SPACE_CAPACITY_EXCEEDED`.
Memory documents keep their own limits (`MEMORY_DOCUMENT_LIMIT`). A request over the request size limit is 413
`SYNC_BATCH_LIMIT`. Over the rate limit the answer is 429 `SYNC_RATE_LIMITED` with `Retry-After` and
`retry_after_seconds`.

## 12. Errors

An error answer is `personal-sync-error@1`: `{"code": "<registered code>"}`, plus the current `state` when a CAS or
epoch refusal can tell it and `retry_after_seconds` on 429. Codes are the protocol codes registered in the generic
model (`contracts/model.json`, generated into `contracts/generated/protocol.ts`); the registered texts are the server's
Chinese user-facing texts.

Transport statuses: 401 is the Bearer challenge above; 403 is a refused `Origin`; 404 `SOURCE_UNAVAILABLE` is an
unknown route, session, operation or object (indistinguishable from a foreign one); 405 `SYNC_OBJECT_INVALID` (with
`Allow`) is a wrong method; 415 `SYNC_OBJECT_INVALID` is a wrong media type or content encoding; 503
`SOURCE_RETRYABLE` with `Retry-After` is a temporary condition and the request may be repeated with the same
`operation_id`. Every other registered code a route returns answers 422. The table lists the codes the sync routes
return and their status:

<!-- BEGIN sync-error-table: generated by `node tools/gen-sync-error-table.ts`; do not edit -->

| Code | HTTP status | Registered text (`when`) | Registered next step (`fix`) |
|---|---|---|---|
| `SOURCE_UNAVAILABLE` | 404 | 无权或权限未定的读者面前，缺失与无权同形（D05 R[3]） | 核对引用；需要读权时请管理员分享或分配工作流；真实原因只进管理员记录 |
| `SOURCE_RETRYABLE` | 503 | 有界重试仍未读到来源，附缺失事实与下次重读时刻 | 按给出的下次时刻重读同一来源；仍失败时由资源管理员恢复读取 |
| `SYNC_RATE_LIMITED` | 429 | 同步请求过于频繁 | 等待答复中的重试时间后重试 |
| `SYNC_BATCH_LIMIT` | 413 | 同步批量超过上限 | 按服务器给出的大小分批重试 |
| `SYNC_VERSION_CONFLICT` | 409 | 同步期间内容已变化 | 取得最新内容并合并后重试 |
| `SYNC_EPOCH_CHANGED` | 409 | 同步方式已变化 | 重新读取同步设置，不自动上传旧内容 |
| `SYNC_MODE_LOCAL` | 409 | 当前仅保存在本机 | 在客户端设置同步方式后重试 |
| `SYNC_OBJECT_INVALID` | 422 | 同步对象不符合结构 | 核对对象格式后重试 |
| `SYNC_OBJECT_HASH_MISMATCH` | 422 | 同步对象摘要不符 | 按规范形式重新计算并上传 |
| `SYNC_OBJECT_MISSING` | 422 | 同步对象尚未齐全 | 补齐本人缺少的对象后重试 |
| `SYNC_SESSION_EXPIRED` | 422 | 同步会话已到期 | 保留本机修改并重新开始同步 |
| `IDEMPOTENCY_MISMATCH` | 422 | 同一步骤键或意图键内容不同（D05、B06） | 改了内容就不要带原键 |
| `SPACE_CAPACITY_EXCEEDED` | 422 | 本次写入计入版本记录后超过空间容量上限 | 请管理员调整容量后重试；撤回或停用内容不会释放版本记录占用 |
| `SPACE_CREDENTIALS_DETECTED` | 422 | 个人条目或授权内容命中凭据扫描 | 移除凭据后重试；原文不向其他账户开放 |
| `SPACE_CONTENT_UNINSPECTABLE` | 422 | 来源不是可完整检查的文本，当前不能开放给其他账户 | 改用可完整检查的文本原文；ZIP、PDF、图片等文件仍可仅保存在个人空间 |
| `MEMORY_CREDENTIALS_DETECTED` | 422 | 记忆含有疑似凭据 | 移除命中位置的凭据后重新提交 |
| `MEMORY_DOCUMENT_LIMIT` | 422 | 记忆正文超过单篇上限 | 缩短正文或由管理员调整单篇限额 |

<!-- END sync-error-table -->

## 13. Versioning and compatibility

- The protocol version is the `v1` path segment and the `@1` suffix of every schema name. Version 1 changes only
  **additively**: existing routes, members, values (including the mode value `hub`), canonical bytes and the frozen
  vectors stay as they are; no member is renamed or removed and no new required request member is added to an
  existing operation. An incompatible change is a new version under a new path with new schema names and a new
  vector directory.
- Clients MUST ignore answer members they do not know, and MUST treat an error code they do not know as a generic
  failure of that request, showing the error's `detail` text when one is present (a later addition) and otherwise
  their own generic message.
- Servers keep refusing request members and query parameters they do not know (`SYNC_OBJECT_INVALID`), so a client
  learns early when it sends something a server does not support.
- New behaviour is offered only behind a named **capability** that a server advertises; a client uses a capability
  only when the server advertises it and keeps working without it. Version 1 as specified here defines no
  capabilities.

## 14. Security considerations

The sync API carries an account's private content. Servers keep personal payloads per account and epoch and purge them
physically; equal bytes are never deduplicated across accounts. Uploaded text and bytes are scanned for credentials
before they are stored (`SPACE_CREDENTIALS_DETECTED`, `MEMORY_CREDENTIALS_DETECTED`; content that cannot be inspected
is `SPACE_CONTENT_UNINSPECTABLE`). Audit metadata records actor, token, the verified OAuth client, the declared
client ID, route template, times, counts, state hashes and the status, never titles, paths, device names or content.
Bytes already sent to a client cannot be recalled by a purge, and a purge does not erase offline backups.
