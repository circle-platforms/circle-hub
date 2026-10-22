# packs/system/plm

The system pack of the PLM query service (brief section 8): reads only. The service answers HTTP 200 with an envelope
`{code, msg, data}` (code 1000 ok) and shares its `/plmquery/` prefix with a write route, so the profile lists every read
route one by one (method and path template) and has no write route.

| Read | Gives |
| --- | --- |
| `plm:bug:<id>`, `plm:story:<id>` | the original answer, content `{id, kind, title, fields, html_fields}` (every HTML field as plain text, empty lines dropped) and meta `{id, kind, title: "缺陷 <id> <title>" or "需求 <id> <title>", status}`; an id the service does not know is a failed read (unavailable to callers) |
| `plm:bugs:<id>+<id>+...` | the original answer, content `{bugs: [{id, status, title}], unread: [<ids>]}` (up to 50 ids, sorted numerically, deduplicated); unreturned ids listed in unread |
| `plm:products:<any>` | the product list (`GET /plmquery/product/all/`) |
| `plm:builds:<product id>` | the build list of a product (`GET /plmquery/build/?product=<id>`, a plain array) |

Profile: roles `plm-oauth` (the same login as the agile platform: the token works for both) and `plm-api`; auth
`login_token` (password `sha512_base64`, envelope code 1000 ok); routes `products`, `builds`, `bug-detail`
(`POST /plmquery/bug/detail/`), `story-detail` (`POST /plmquery/story/detail/`), all read.

Functions: `functions/plm.ts` (`detailPlan`, `detailProject`, `htmlText`). Not published: `api.ts`, this README,
`plm.test.ts`.

Test: `node --test packs/system/plm/plm.test.ts` (the profile is read-only by construction: no route outside the four reads,
the write path of `tests/fixtures/plm` unreachable; bugs and stories with numbers and strings as ids, HTML fields, an unknown
id). The end-to-end test binds `plm:story` and `plm:bug` as expected sources of a review.

Needs: none.
