# packs/system/agile-platform

The system pack of the agile test platform (brief section 8): reads only, through the Hub's connectors. Version 1.2.0 is
the case-index finish of `agile:tree:roots` (brief section 6a, capability 4): cumulative folder lists, empty folders
marked `listed: false`, and listing pages up to the round budget.

| Read | Gives |
| --- | --- |
| `agile:tree:<root id>` | the whole subtree of a root (`{label, id, cases, children}`) and the root's title from the paged root listing (10 per page with a total; pages past the end repeat page 1, so only the announced pages are read); the revision is the SHA-256 of the subtree answer |
| `agile:tree:roots` | every configured root at once (`settings.roots`, the first 10): content `{roots: [{id, title}], documents: [{id, title, ancestors, root, listed}], complete, repeated, unread?}`, every document of the trees once with the labels of the folders above it from the root title down (the same ancestors the mind-map meta gives), `root` its root's id, `listed: false` for an empty folder; the original is the first listing page; see below |
| `agile:mindmap:<document id>` | three artifacts: `original` (the answer as received), `content` (the inner KityMinder JSON, decoded once more, `application/json`) and `meta` (`{id, title, ancestors, root: {id, title}}`: the labels of the folders above the document from the root down), found in the trees of the configured roots (`settings.roots`), read as nested reads the Hub caches; a document in none of them refreshes the cached trees once. A document no read tree places while a configured root was not read is marked incomplete (`complete: false`, a note naming the roots): its title and folders are unknown, not absent |
| `agile:search:<terms joined by +>[+!<document id>]` | the documents of the configured roots as a listing (`id`, `title`, `ancestors`, `root`), at most 200 of them with the rest counted in `content.total`: a hint for what exists (the workflow binds it with role hint, never a ground for product behaviour, never a basis of recall). Keyword retrieval is retired (owner ruling U19/U20, 2026-10-24): no title is scored, no document is chosen by a term and none is read here, and the terms are disclosed as unused (`content.terms`, `content.terms_used: false`, `meta.selection: "retired"`). A part written with a raw `!` names a document to leave out by its exact id (the workflows exclude the reviewed document); an encoded `%21` stays a term. The next step is an explicit `agile:mindmap:<id>` or `agile:case:<id>` read, or a candidate a model proposes with a verbatim quote the Hub verifies. Roots that were not read make the search incomplete and are listed in `content.unread` |

Profile (`system.json`, `system@1`): roles `agile-oauth` (the login) and `agile-api`; auth `login_token`: `POST /oauth/login/`
with `{username, password}`, the password stored and sent as Base64(SHA-512(plain text)) (`sha512_base64`), envelope
`{code, msg, data}` with code 1000 ok (any other code, 1005 wrong password among them, is a failed login, which the connectors
never retry), the token from `/data/token` with its expiry `/data/expire` (epoch seconds) in `Authorization` without a prefix;
envelope of the reads with the expired code of the platform. Three POST read routes on literal paths
(`/agile/get_root_node/`, `/agile/get_child_node_task/`, `/agile/get_case_data/`), every one marked read; no write route.
Settings: `roots` (the root ids of the product; deployment data, never in Git).

**Configured roots**: no first-ten truncation. Mindmap and search use one aggregate agile:tree:roots read, with at most one cached refresh; the nested-read cap is preserved. The aggregate schedules every configured root and every still-needed announced listing page before done. Request/byte/global round caps remain enforced; an over-budget read refuses rather than claiming complete. Partial aggregate results remain explicitly partial and are not cached as full successes.

## agile:tree:roots

- **Requests.** Round 1 schedules one subtree per configured root and the first listing page. After the responses, the planner schedules all still-needed announced pages (up to ROOTS_PAGES) before declaring done. Each plan declares concurrency=4; the Hub enforces that lower cap alongside the resource limiter. The five-round cap and the profile's max_requests=51 remain unchanged. More roots are not silently excluded to fit a round; limits produce a bounded failure and the manifest records its actual coverage.
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

Functions: `functions/agile.ts` (plans and projections; `documentsOf`, `locate`, `listedDocuments`, `searchKeyOf`,
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

## hub-read-absence coverage

Version 1.2.2 retires the keyword ranking of `agile:search`: the read lists the documents of the configured roots and reads
no document, so titles are never scored and terms never select a source (owner ruling U19/U20, 2026-10-24); the old records
stay as they are and a new run reads the new derived content. Version 1.2.1 uses aggregate nested trees for mindmap/search. Failed HTTP tree and file reads receive the connectors' bounded transient retry policy within the read budgets, and partial results carry coverage through nested reads. A document absent from every fully read configured root is described as 在本产品配置的根之外; an incomplete range never makes that conclusion. SOURCE_ABSENT public mapping and login request records remain for their model/exit dependencies.
