# packs/system/agile-platform

The system pack of the agile test platform (brief section 8): reads only, through the Hub's connectors. Version 1.2.0 is
the case-index finish of `agile:tree:roots` (brief section 6a, capability 4): cumulative folder lists, empty folders
marked `listed: false`, and listing pages up to the round budget.

| Read | Gives |
| --- | --- |
| `agile:tree:<root id>` | the whole subtree of a root (`{label, id, cases, children}`) and the root's title from the paged root listing (10 per page with a total; pages past the end repeat page 1, so only the announced pages are read); the revision is the SHA-256 of the subtree answer |
| `agile:tree:roots` | every configured root at once (`settings.roots`, the first 10): content `{roots: [{id, title}], documents: [{id, title, ancestors, root, listed}], complete, repeated, unread?}`, every document of the trees once with the labels of the folders above it from the root title down (the same ancestors the mind-map meta gives), `root` its root's id, `listed: false` for an empty folder; the original is the first listing page; see below |
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

## agile:tree:roots

- **Requests.** One subtree request per configured root (`subtree-<k>`, k the root's place in `settings.roots`) and the
  listing pages that name the roots (`page-<n>`). Round 1 asks for the first listing page and the first three subtrees;
  later rounds for the subtrees left and, while a configured root has no title yet (neither its own node in the subtree
  nor a listing page names it), the further pages the listing's total announces, up to `ROOTS_PAGES` (50, the same cap as
  one root's tree read). The five rounds stop earlier: about 17 pages when round 1 also sent subtrees, which still covers
  a root listed at position 120. **At most 4 requests per round** (`ROOTS_IN_FLIGHT`): the connectors send the requests of a
  round together (within the resource's own `concurrency`) and the next round only after them, so never more than 4 are
  in flight, whatever the resource allows (tested against a slow stub with a resource limit of 16). Ten roots and ten
  pages fit the connectors' five rounds; the read declares no other limits than the profile format offers (route timeouts
  and byte caps, the read's `max_requests` of 51).
- **Original and content.** The first listing page is the original (a read without the listing fails: no root title
  could be known). The content lists each document once (a document filed in two folders at its first place, in tree
  order; at most 50,000 documents). Folder `cases` lists are cumulative, so a document belongs to the deepest folder that
  lists it. A leaf no folder lists is an empty folder (`listed: false`) and is not a document a consumer should read.
  Ids are listed as the tree gives them; a reader decides which it can read.
- **Complete** is false (and the read's coverage incomplete, with a note) when a configured root was not read (its
  subtree failed, or it is beyond the first 10: `unread`), a root's title is not on the listing pages read, no root is
  configured, or the document limit cut the list. A consumer that needs every root (the product pack's sync) refuses an
  incomplete tree.
- **Revision**: the SHA-256 of the content's JSON text (`node:crypto`, a pure builtin the sandbox admits). Equal trees give
  one revision and byte-equal content, which the records store once (content-addressed): the derived content is cached per
  revision, and a reader may pin `agile:tree:roots@<revision>`.
- A configured root id `roots` is skipped (`rootsOf`): `roots` names this read, never a root.

Functions: `functions/agile.ts` (plans and projections; `documentsOf`, `locate`, `outlineOf`, `rankDocuments`, `searchKeyOf`,
`termsOf`, `rootsPlan`, `rootsProject`, `rootsContent`). Not published: `api.ts`, this README, the tests.

## Tests

```
node --test "packs/system/agile-platform/**/*.test.ts"
```

`agile.test.ts`: the profile, the pure functions, the root limit against the read-plan shape of the contracts, unknown meta
and incomplete searches when roots were not read, the excluded document, and reads through the real connectors against
`startAgileStub` with `tests/fixtures/agile` (the three artifacts of a mind map, the root trees read once and served from the
cache, a document in no configured tree, a tree with its root title, the search with and without the excluded document, a
wrong password tried once and never again until an admin acts). The end-to-end test reads the review mind map through this
pack. `roots.test.ts`: `agile:tree:roots` planned round by round against the answers of the case-index corpus
(`tests/fixtures/case-index`: three configured roots on page 2 of 3; ten roots on pages 9 and 10 of a 95-root listing),
every round within 4 requests and the five rounds, the documents and their folders equal to the corpus truth, the repeated
document once, the revision (equal trees, a renamed folder), incomplete content (a failed subtree, a root the listing does
not name, roots beyond the limit, none configured), the single-root read unchanged; through the real connectors: the three
artifacts, the same revision and stored content on a second read, one subtree request per root, and at most 4 requests in
flight against a slow stub with resource concurrency 16.

## Needs from other packages

- **contracts / connectors**: a settings schema in `system@1` that the connectors check when a resource is added or updated,
  so that `roots` with more than 10 entries (or a malformed entry) is refused at configuration instead of being reported per
  read.
