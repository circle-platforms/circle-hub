# tests/fixtures

Synthetic fixtures that mirror the structure of the real systems (brief section 8), never their content: names, commands
and texts are invented, addresses are in 192.0.2.0/24 (and 2001:db8::/32), and the invented product of the shared
fixtures is ORBIT / COMET (one product, two names). The case-index corpus uses the dotted version lines of the product
pack's default `min_line` scenario; inclusion is by the release-train month in the train label, and those months follow
the dotted order in this corpus, which is not a lineage claim. Product-specific fixtures live in their product pack
(`packs/product/*/testing/`). Owned by the packs package; any package may read them.

| Directory | Mirrors | Entry point |
| --- | --- | --- |
| `mindmaps/` | KityMinder test mind maps: a ~170-node review map with case and group nodes (plain, double-encoded, inside an agile answer), small maps, an untagged map, an outline, the template map; a 3,000-node document built at test time | `index.ts` (`fixtureBytes`, `MINDMAP_FIXTURES`, `largeDocument`, `compactText`); `write.ts` regenerates the files |
| `agile/` | the agile platform: 23 roots listed 10 per page, the product's two roots, the versioned tree `030：<names>测试项目` -> version line -> release train -> module -> document, the documents of `mindmaps/` | `index.ts` (`agileOptions()` for `startAgileStub`, `DOCUMENTS`, `ROOTS`, `REVIEW_ANCESTORS`, `REVIEW_TITLE`, `AGILE_ACCOUNT`) |
| `plm/` | the PLM query service: envelope with HTTP 200, ids as numbers and strings, three date spellings, HTML steps and specs, a plain build array, a write route under the read prefix | `index.ts` (`plmReply` for a loopback stub, `BUGS`, `STORIES`, `PRODUCTS`, `BUILDS`, `WRITE_PATH`) |
| `build-site/` | the build site: an index page, hub pages, listing pages of both name families with unquoted links and released entries in a red font, an FAMY alias "based on" an FAMX build, ISO-8859-1 command trees with stray attributes and overloads, a fixed-bug list | `index.ts` (`buildSiteFiles()` for `startBuildSiteStub`, `BASE_PATH`); `write.ts` writes `files/` |
| `case-index/` | the case index of brief section 6a: a hand-written table of case titles and labels with the commands that must resolve and must not (`table.ts`, written before the resolver ran, plus the folding and second-command probes), two command trees of invented commands whose version difference is known (`catalog.ts`), an agile platform with a 23-root listing (total beside `data`), three configured roots whose trees list cases cumulatively and start with the root node, empty folders, 300 KityMinder test mind maps and the truth of every document (line, train, module, why unlisted) and case, built while the corpus is built (`corpus.ts`) | `index.ts` (`caseCorpus({ names })`, `listedFor`, `CASE_COMMAND_TABLE`, `CATALOG_A`, `CATALOG_B`, `commandTreeXml`, `caseIndexAgileOptions()` for `startAgileStub`, `listingAnswer`, `subtreeAnswer`) |
| `manual-store/` | the document store: specs converted from Word (an invented feature, beacon groups with a TTL and weight inheritance, whose two spec files a search must rank first among distractors), CLI manuals with NUL bytes per version line of both names, an application manual, product and qa documents (a test strategy of the same feature) | `index.ts` (`manualStoreFiles()` for `startWebDavStub`, `SPEC_SEARCH_TERMS`, `SPEC_SEARCH_FILES`, `SPEC_SEARCH_TEXT`, `QA_SEARCH_FILE`); `write.ts` writes `files/` |

The account in `agile/` is invented and only works against the loopback stub. After changing a writer, run it
(`node tests/fixtures/<dir>/write.ts`); the tests that read the files fail while they differ.
