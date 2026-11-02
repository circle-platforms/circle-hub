# packs/system/wecom-robot

The system pack of the WeCom (企业微信) intelligent robot: the **read side** of a robot deployment — address-book
members and appchat groups. A robot host (R03, Circle side) is where the long-lived connection, the model calls and the
drafting live; this pack is what makes its claims verifiable. An event on the connection is only a hint (D01 R[3]):
after it, the facts a run relies on are these reads, re-executed at the Hub boundary and kept as sources. The member
read is what an identity mapping (a WeCom userid to a named Hub account) is checked against; the chat read names a
group's owner and members, which is what a delivery audience is checked against.

The robot's outward speech is deliberately **not** in this profile. `system@1` lists reads only; a message leaving the
Hub is a notification effect made through an `executor@1` write declaration at deployment (D07), so no pack route can
reach a send endpoint and the transport refuses anything not on the list.

| Read | Gives |
| --- | --- |
| `wecom:user:<userid>` | the original answer, content `{userid, name, department, status, mobile, email}` (fields the answer does not carry are null, never guessed) and meta `{userid, name}` |
| `wecom:chat:<chatid>` | the original answer, content `{chatid, name, owner, users, department}` and meta `{chatid, name, owner}` |

Profile: role `wecom-api`; auth `static_header` (`Authorization: Bearer`, credential `access_token` from the vault);
envelope `{errcode, errmsg}` with errcode 0 ok under HTTP 200; routes `member-get` (`GET /cgi-bin/user/get`) and
`chat-get` (`POST /cgi-bin/appchat/get`), both reads. The send path of the fixtures and `GET /cgi-bin/gettoken` match
no route: a read-only client cannot reach them.

**Unverified by design.** Brief section 8 does not cover WeCom, so nothing here was sampled against a real tenant: the
paths mirror the documented shape and every value in fixtures and tests is synthetic. Before a deployment instance
enables anything, the owner's read-only `scripts/real/` pass re-checks each route, the envelope codes, and how the real
service answers an unknown member or chat (the fixtures answer errcode 0 without the record, which lets the projection
record absence as a fact; the real service is expected to answer a nonzero errcode, which the transport would report as
an envelope error instead — the check must settle which spelling the pack ships with). An unsampled route stays
declared and unverified, enabled one by one after the administrator's read-only check (D01 R[11]).

Functions: `functions/wecom.ts` (`isMemberKey`, `isChatKey`, `memberProject`, `chatProject`). Not published: `api.ts`,
this README, `wecom.test.ts`.

Test: `node --test "packs/system/wecom-robot/wecom.test.ts"` — the route list refuses the send path and the token
exchange; the projections keep what was answered and leave the rest null; an unknown member or chat is a recorded
absence, never a failure and never a success. No database and no stub server are needed.

Signing: `node packs/system/wecom-robot/api.ts sign | check` (the shared pack tooling); re-sign after editing
`system.json` or `functions/`, and only after the real-route check above.

## What the owner's deployed robot actually uses (read-only code review, 2026-11-02)

The existing robot (the owner's InfoTest engine project, reviewed without executing it; its env file was not opened)
reshapes this pack. Three channels, not one:

1. **Smart-bot WebSocket channel** (official `wecom-aibot-sdk`): Bot ID + Secret + gateway URL; the SDK owns auth,
   heartbeat and reconnect. Inbound: `message.text`, `message.mixed` (text items plus file/image/voice/video),
   standalone `file/image/voice/video` frames whose media carries `url + aeskey` and is AES-decrypted client-side
   (512 KB chunks, 5 B to 100 MB validated). Outbound: in-session `reply` (markdown), `reply_stream` (appends under a
   `stream_id`; a stream expires after 10 minutes, error 846608, and the host retries with a **new stream id** — that
   is a disclosed resend of a notification-class effect), `reply_media` after `upload_media` -> `media_id`, and
   `reply_welcome` on `event.enter_chat`.
2. **Classic app HTTP channel** for identity only: `GET /cgi-bin/gettoken` (corpid + corpsecret as query) and
   `GET /cgi-bin/user/get` (`access_token` **in the query**, not a header) to resolve external encrypted userids
   (`wm|wo|wp` prefixes) to display names. This is Need 1, verbatim; a transitional deployment keeps a vault token the
   host refreshes.
3. **WeCom docs as a streamable-HTTP MCP endpoint** (administrator-granted "可使用权限" URL): create/update/list/
   search/read document tools, deduplicated by content hash, with a SQLite document registry. List/search/read are
   reads; **create/update are outbound sync writes** and belong to a second system profile (`wecom-docs`), passing the
   effect gate like any write.

Two facts the current profile must own honestly: `POST /cgi-bin/appchat/get` (declared here) is **not used** by the
deployed robot — it stays declared-unverified in case group delivery is chosen later (decision D2). And the robot has
**no active-push path**: everything replies inside a session frame, so a Hub-initiated B07 delivery needs a channel the
robot does not have today (app push or group webhook) — the central item of decision D2 on the task page.
## Needs from other packages

1. **connectors (transport).** A login the real service actually has: `GET /cgi-bin/gettoken` with corpid and
   corpsecret as query parameters, a token that later requests carry in the query, not a header. `LoginDeclaration`
   is POST with a JSON body and `AuthDeclaration` carries the token in a header, so until this exists a deployment
   keeps a current `access_token` vault entry and the robot host refreshes it (a disclosed host-managed lifecycle,
   not a Hub login exchange). Requested: an auth variant naming the query parameter of the cached token.
2. **contracts + dispatch (notification effects).** D2=a (group robot webhook, owner 2026-11-02) chose the channel;
   the block is deeper than a missing dispatch branch — **the contract itself refuses a notification executor**:
   `ExecutorDefinition` locks `calls.submit.write` to `effect_class: job`, `audience: null`, `writes_hub_records: true`
   (contracts/src/resources.ts, the `calls` shape and its superRefine "执行器只能声明作业"). `testing/webhook-notify.draft.json`
   is the intended webhook shape; `webhook-notify.test.ts` pins that `ExecutorSource.safeParse` refuses it with exactly
   those three fields and nothing else, while the same object parses alone as `write-declaration@1` — so the vocabulary
   is ready and only the executor slot is closed. Requested: from the **contracts owner**, a notification variant of
   the executor write slot (effect class `notification`, a non-null audience, the job-only machinery lease/receipt/
   status/result/proof made optional or a separate resource kind — the draft carries those placeholders precisely to
   show they do not belong here); from **dispatch**, the notification effect-class branch (intent, 已发出/已生效 via
   B06, one resend marked 可能重复 per D03 R[3], the boundary content check that `hub/dispatch/boundary.ts` already
   runs). When the schema opens, `webhook-notify.test.ts` breaks loudly and is updated deliberately.
3. **owner (two decisions).** Real systems are read-only under the current authorization: enabling a real outbound
   send (webhook or appchat) is a separate decision. The robot host itself — long-lived connection, local model,
   per-session ids that make A04 R[5] independence checkable — is Circle-side work (decision 8 covers the platform;
   the milestone-1 server package keeps bot out of scope).

## What a deployment registers (checklist, no committed definition)

Deployment instances stay out of Git (D01 R[0] R[6]). When the notification path above exists, the administrator
registers: endpoints and fixed CA per environment class; the `credential` as `${secret:...}` names only; the allowed
tools and the submit call with its write declaration (effect class, retry safety, parameter roles per D01 R[11]);
JSON pointers into the answer; the premise certifications; and what happens outside the Hub, disclosed. The values
are deployment data; nothing of them belongs in this repository.

## Candidate write declarations for the delivery channel (D2)

Each block is a `write-declaration@1` for the submit call of the option; every one parses against
`WriteDeclaration.safeParse` (`node --experimental-strip-types` on the contracts schema, 2026-11-02). They are shape
examples with synthetic keys, not registrable resources: the endpoints, tools and calls around them stay deployment
data (executor@1), and the retry-safety values below are declarations of intent — every premise behind them is false
until certified on the target and its version (D02 R[0]) and is treated at its weakest before that.

A. group robot webhook (simplest active push; a sent message cannot be recalled or read back):

```json
{ "interaction": "submit_then_read", "effect_class": "notification", "retry_safety": "duplicate_tolerant",
  "signing": "service_on_behalf", "reversible": false,
  "target_key": { "group": "syn_review_group", "request": "rec:<64hex>" },
  "audience": "group:syn_review_group",
  "evidence": { "call": "send", "pointer": "/errcode" },
  "refusal": { "stage": "/errcode", "reached_device": "/errmsg" }, "writes_hub_records": false }
```

`retry_safety: duplicate_tolerant` matches the current protocol (the webhook accepts no client dedup key): a lost
reply is resent once and marked 可能重复 (D03 R[3]); satisfaction is 已生效 because a notification cannot be read
back (B06). `target_key` binds the Hub request digest so the resend is the same intent.

Registration of this shape is refused by today's contract (see Need 2): `testing/webhook-notify.draft.json` plus
`webhook-notify.test.ts` pin the exact three-field refusal until the contracts owner opens the notification slot.

B. app message push (reaches private chat; the answer carries a msgid, and recall exists, so a pre-send check and a
possible compensation become expressible):

```json
{ "interaction": "submit_then_read", "effect_class": "notification", "retry_safety": "unsafe",
  "signing": "service_on_behalf", "reversible": true,
  "target_key": { "msgid_template": "/msgid", "request": "rec:<64hex>" },
  "audience": "user:syn_u_001",
  "evidence": { "call": "send", "pointer": "/msgid" },
  "before_state": { "call": { "tool": "recall_check", "arguments": { "msgid": "{msgid}" }, "timeout_ms": 15000 },
                    "pointer": "/list", "expected": "unknown", "conditional_write": false },
  "refusal": { "stage": "/errcode", "reached_device": "/invaliduser" }, "writes_hub_records": false }
```

Declared `unsafe` on purpose: resend without a server-side key duplicates the message, so a lost reply goes to the
six dispositions (核对 first: read the target's own request records / `invaliduser`, per B07 R[3]). `reversible: true`
only if the recall route is certified; `/invaliduser` is where a partial audience refusal appears.

C. in-session reply only (no Hub-initiated push at all; the host answers within the frame it was asked in):

```json
{ "interaction": "submit_then_read", "effect_class": "notification", "retry_safety": "same_key_safe",
  "signing": "service_on_behalf", "reversible": false,
  "target_key": { "req_id": "frame.headers.req_id", "stream_id": "uuid-v4" },
  "audience": "user:syn_u_001",
  "evidence": { "call": "reply_stream", "pointer": "/errcode" },
  "refusal": { "stage": "/errcode", "reached_device": "/errcode" }, "writes_hub_records": false }
```

Under C nothing is registered at all today: the stream retry (846608 -> new stream_id) stays a disclosed host-side
resend and B07 delivery remains console + tool results. Recording C as an effect would require the deployed Hub to
call back into the host (the executor would be the bot itself); that is the honest meaning of "reply only" — the
review loop can then never be Hub-initiated.
