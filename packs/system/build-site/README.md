# packs/system/build-site

The system pack of the build site (brief section 8): anonymous, plain HTTP, pages mostly ISO-8859-1; reads only.

| Read | Gives |
| --- | --- |
| `buildsite:listing:<page>` | one page of the site as `GET <base>/<page>.html`, parsed with html@1 by the Hub; the name `index` stands for the index page the resource names in `settings.index_page` (default `index.html`) |
| `buildsite:file:<link>` | a file a listing page links (a command tree `.xml`, a fixed-bug list `.html`): the key is the link as written without scheme and authority, with `%`, `@`, white space, controls and format characters percent-encoded; the Hub resolves it against the base (a relative link) or the origin (a link starting with `/`) and refuses anything outside the role's base path |

Profile: role `build-site` (the directory of the listing pages), auth `none`, routes `page` (`GET /{page}`, html@1),
`tree-file` (`GET /{tree*}`, XML up to 64 MiB) and `page-file` (`GET /{doc*}`, HTML), all read; no write route. The product
pack writes the same ids (`packs/product/famx/functions/sources.ts`, a test keeps both rules equal).

Functions: `functions/reads.ts` (`listingPlan`, `filePlan`, `pageFile`, `linkOf`, `routeOfLink`, `fileKey`). Not
published: `api.ts`, this README, `reads.test.ts`.

Test: `node --test packs/system/build-site/reads.test.ts` (the profile, the keys of hostile links, reads through the real
connectors against `startBuildSiteStub` with `tests/fixtures/build-site`). The end-to-end test syncs the FAMX product
through this pack.

Needs: none.
