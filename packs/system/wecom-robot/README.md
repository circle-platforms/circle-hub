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

## Needs from other packages

1. **connectors (transport).** A login the real service actually has: `GET /cgi-bin/gettoken` with corpid and
   corpsecret as query parameters, a token that later requests carry in the query, not a header. `LoginDeclaration`
   is POST with a JSON body and `AuthDeclaration` carries the token in a header, so until this exists a deployment
   keeps a current `access_token` vault entry and the robot host refreshes it (a disclosed host-managed lifecycle,
   not a Hub login exchange). Requested: an auth variant naming the query parameter of the cached token.
2. **dispatch (notification effects).** The executor services dispatch **jobs** today; the `notification` effect class
   has no executor path yet. Delivering a B07 request through the robot would be its first user: an `executor@1`
   source definition whose submit carries a `write-declaration@1` with `effect_class: notification`, a retry-safety
   class and the dedup premise (D03 R[1]–R[3]: one resend marked 可能重复), satisfied at 已生效 because a sent message
   cannot be read back (B06), and passing the outbound content check that `hub/dispatch/boundary.ts` already runs.
   This pack asks for the dispatch branch, not for any route of its own.
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
