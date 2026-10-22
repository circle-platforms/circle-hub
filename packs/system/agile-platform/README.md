# packs/system/agile-platform

The system pack of the agile test platform (brief section 8): reads only, through the Hub's connectors.

| Read | Gives |
| --- | --- |
| `agile:tree:<root id>` | the whole subtree of a root (`{label, id, cases, children}`) and the root's title from the paged root listing (10 per page with a total; pages past the end repeat page 1, so only the announced pages are read); the revision is the SHA-256 of the subtree answer |
| `agile:mindmap:<document id>` | three artifacts: `original` (the answer as received), `content` (the inner KityMinder JSON, decoded once more, `application/json`) and `meta` (`{id, title, ancestors, root: {id, title}}`: the labels of the folders above the document from the root down), found in the trees of the configured roots (`settings.roots`), read as nested reads the Hub caches; a document in none of them refreshes the cached trees once. A document no read tree places while a configured root was not read is marked incomplete (`complete: false`, a note naming the roots): its title and folders are unknown, not absent |
| `agile:search:<terms joined by +>[+!<document id>]` | the documents of the configured roots whose titles contain the most terms (the best five) with an outline of the best three: a hint for similar test lists (the workflow binds it with role hint, never a ground for product behaviour). A part written with a raw `!` names a document to leave out (the workflows exclude the reviewed document, which matches its own title's terms); an encoded `%21` stays a term. Roots that were not read make the search incomplete and are listed in `content.unread` |

Profile (`system.json`, `system@1`): roles `agile-oauth` (the login) and `agile-api`; auth `login_token`: `POST /oauth/login/`
with `{username, password}`, the password stored and sent as Base64(SHA-512(plain text)) (`sha512_base64`), envelope
`{code, msg, data}` with code 1000 ok (any other code, 1005 wrong password among them, is a failed login, which the connectors
never retry), the token from `/data/token` with its expiry `/data/expire` (epoch seconds) in `Authorization` without a prefix;
envelope of the reads with the expired code of the platform. Three POST read routes on literal paths
(`/agile/get_root_node/`, `/agile/get_child_node_task/`, `/agile/get_case_data/`), every one marked read; no write route.
Settings: `roots` (the root ids of the product; deployment data, never in Git).

**Limit of `settings.roots`**: a read reads the trees of the first 10 configured roots (`MAX_ROOTS`). The connectors allow 20
nested reads over all rounds of one read (`MAX_NESTED_READS`), and the mind-map read may refresh every tree it read once, so
10 roots is the most that always fits. Further roots are not read; a read that needed them is incomplete and its note names
them. The real product has two roots. `system@1` has no settings schema, so the limit cannot be refused when the resource
is configured (see Needs).

Functions: `functions/agile.ts` (plans and projections; `documentsOf`, `locate`, `outlineOf`, `rankDocuments`, `searchKeyOf`,
`termsOf`). Not published: `api.ts`, this README, `agile.test.ts`.

Test: `node --test packs/system/agile-platform/agile.test.ts` (the profile, the pure functions, the root limit against the
read-plan shape of the contracts, unknown meta and incomplete searches when roots were not read, the excluded document, and
reads through the real connectors against `startAgileStub` with `tests/fixtures/agile`: the three artifacts of a mind map, the
root trees read once and served from the cache, a document in no configured tree, a tree with its root title, the search with
and without the excluded document, a wrong password tried once and never again until an admin acts). The end-to-end test
reads the review mind map through this pack.

## Needs from other packages

- **contracts / connectors**: a settings schema in `system@1` that the connectors check when a resource is added or updated,
  so that `roots` with more than 10 entries (or a malformed entry) is refused at configuration instead of being reported per
  read.
