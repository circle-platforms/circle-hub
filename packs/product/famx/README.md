# packs/product/famx

FAMX and FAMY, the public package id `famx`, and the declared platform tokens are synthetic demonstration names. They do not identify a company, customer, OEM or deployment.

The product pack of FAMX/FAMY: one product line with two names, product line `famx`, names `FAMX` and `FAMY` (`PRODUCT_LINE`
in `functions/naming.ts`). Model elements: K01 R[10], K02, K04, C03, C07, D01 R[8], W03 R[0] R[5], T01 F[8]. Product facts
live only here. Other packages use `api.ts` (types, named functions, and `FUNCTIONS`, the sandbox entry points).

## The pack

| File | Content |
| --- | --- |
| `product.json` | `product@1`: names `[FAMX, FAMY]`; deployment variables below; sync start `buildsite:listing:index`, plan `functions/sync.ts`, up to 10 rounds; producers `command-tree`, independent `manual-famx` and `manual-famy` (the `release-notes`, `cases`, `specifications` and `unversioned-cases` producers were removed from the declaration on the owner's 10-24 revision: cases, defects and specifications are fed by Circle, not batch-produced; the functions stay for the per-use projection); each family manual has its own `root`, `main`, `attributes.<family>` references, directory metadata slot and one bounded complete chapter-list slot |
| `functions/sync.ts` | the plan (SyncPlanInput -> SyncPlanOutput): every round recomputed from the pages read so far, index -> hub pages -> listing pages (depth 2, dead links tolerated, both name families, platform and customer pages only when `include` opts them in), then the builds; with `case_index`, `agile:tree:roots` and every own-tree build's case documents (`cases-sync.ts`) |
| `functions/cases.ts` and `cases-*.ts` | the case index: the producer `cases` (`cases.ts`), case nodes (`cases-nodes.ts`), the command catalog, phrase extraction and resolution (`cases-commands.ts`), the sync plan's part (`cases-sync.ts`), shared pack data (`cases-rules.ts`) |
| `functions/select.ts` | the build choice (SelectBuildInput -> SelectBuildOutput) over `select-build.ts`: the latest released build of the line across both families on the main platform, the other candidates as alternatives |
| `functions/producers.ts` | the producers (ProducerInput -> ProducerOutput) over `command-tree.ts`, `manual.ts`, `release-notes.ts` and `fixed-bugs.ts` (the build site's fixed-bug page, html@1) || `functions/sources.ts` | the build-site external ids (`buildsite:listing:<page>`, `buildsite:file:<link>`, the same rule as the build-site system pack; a test keeps them equal) and the source roles `tree`, `fixed_bugs` |
| `functions/documents.ts` | the version lines of documents: manual folders `rel_famx_<line>` / `rel_famy_<line>`, version tokens in spec, product and qa names (an FAMY-named document has the same line as the FAMX-named one) |
| `functions/adoc/` | the adoc producer (K4): the restricted expansion and intermediate model of step one (`index.ts` over `includes.ts`, `origins.ts`, `input.ts`, `engine.ts`, `types.ts`), the K1 mapping and the per-family runs of step two (`k1-model.ts`, `families.ts`), and the pinned third-party engine in `vendor/` (the bundle, its license, and the declarations of the API this adapter uses) |
| `functions/locate.ts`, `ids.ts`, `commands.ts` | the agile location rule (ancestor labels -> line, train, module), the story and bug ids of titles, the command extractor (phrases whose first word is a catalog head) |
| other `functions/*.ts` | the building blocks below (listing parser, naming, builds, sync-plan, select-build, command-tree, manual, release-notes, util, types) |

Not published: `api.ts` (`node packs/product/famx/api.ts check|sign|stage <directory>`), this README, the tests and
`testing/` (`test-support.ts`, the synthetic fixtures in `testing/fixtures/` and `testing/site.ts`, the small build site of the
end-to-end test).

The plan lists every released build of a mainline page on the main platform, every released build of an opted-in page, the
newest build of every version line and name family even when it is not released (released_at null: a line under test may
have no release yet, and a review may target one), and the base of every listed alias. Every other mainline build of the
read pages is listed too, as a name-only build: name, family, line, the built time the page lists, the release mark only
when there is one, the base the page's “based on” names (itself when the page names none), sources empty — the knowledge
base then knows every build of the line by name (the case-location candidates read them), while the sync registers such a
build without producing a root and without counting it a failure (a separate `只登记名字` count in the sync report). A build with its own
command tree (an FAMX name, or an FAMY name of the newest lines) is its own base and carries the sources `tree` (and
`fixed_bugs` when linked); an FAMY name without a tree is an alias of the build its "based on" chain ends in and carries no
sources. Every planned build carries family, line, base, platform and both dates. The knowledge sync produces roots of
released builds only (unreleased own-tree builds need `includeUnreleased`), moves the line's current root and records the
aliases: a run started with an FAMY name locks the root of its FAMX base (end-to-end test).

Entry kinds follow K02 R[3]: the command tree gives `definition` entries, the manual `definition` for signature paragraphs
and `behaviour` for the text under a command and for the prose at the section nodes (`/manual/<手册>/...`), the fixed-bug
list and release notes `defect`; the finer form stays in
`data.form` and `data.status`.

## Functions

| Module | Function | Input → output |
| --- | --- | --- |
| `listing.ts` | `parseListing` | html@1 model of a build-site listing page (or `{ model, context: { platform } }`) → `{ builds, hub, warnings }` |
| `select-build.ts` | `selectBuild` | `{ candidates, line, declared?, includePlatforms? }` → `{ build, base, basis, alternatives, notes }` |
| `sync-plan.ts` | `planSync`, `syncBuilds` | index page model(s) and hub pages read → listing pages, hub pages to read; builds → base builds to produce, aliases |
| `command-tree.ts` | `produceCommandEntries` | xml@1 model of `command_tree-<build>.xml` (or `{ model, params }`) → definition entries at `/commands/<words>` |
| `manual.ts` | `produceManualEntries` | markdown@1 model of a manual (`{ model, heads?, name? }`; `produceManualEntries(model, heads, { name, catalog })`) → signatures (at /commands only when the build's tree has the command), behaviours, section-placed prose; nothing unplaced from markdown. The transitional `ist.manual-command-catalog` JSON → definition entries, unplaced spans |
| `release-notes.ts` | `produceReleaseEntries` | markdown@1 model of a release note → defect entries (fixed or known) with build and date |
| `fixed-bugs.ts` | `fixedBugEntries` | html@1 model of `Bugs_Fixed_with_<build>.html` → defect entries (status fixed). The real page is one body block of br-separated anchors: the anchor text is the bug number, the href names the system (`m=bug&f=view&id=` query → `plm`, trailing `show_bug.cgi?id=` → `bugzilla`, else `unknown`, in `data.system`); bare numbers after a `======ID from PLM=======` line are read as `plm` with `after_plm_marker: true`; the older table-cell and leading-number shapes stay |
| `commands.ts` | `extractCommands` | `{ text, heads }` → command phrases with offsets |
| `locate.ts` | `locateFromAncestors` | agile tree labels, root first → `{ line, train, module, notes }` |
| `ids.ts` | `idsFromTitle` | document title → `{ stories, bugs, plm, unclassified }` |
| `cases.ts` | `cases` (product.json) | ProducerInput (documents batch, tree, folders) → ProducerOutput: one `case` entry per (case, resolved command) |
| `cases-nodes.ts` | `caseNodes` | kityminder@1 model → the case nodes with title, labels above, tags, priority, expected count, steps, vague, autoid |
| `cases-commands.ts` | `commandCatalog`, `textCommands`, `resolvePhrase` | xml@1 command tree → catalog; a text → the catalog paths of its whole command statements |
| `cases-sync.ts` | `caseTree`, `caseDocumentsFor`, `caseIndexOptions` | the read agile tree → the located documents; a build line → its `case_documents` |
| `adoc/index.ts` | `compileAdoc` | `{ main, revision, files, attributes? }` of one manual group on one SVN revision → `{ ok: true, composition, model, report }` (the expanded intermediate model) or `{ ok: false, error }` for the whole group |
| `adoc/k1-model.ts` | `toK1Model`, `citationFor` | the expanded model, its composition and the family's manual name → the markdown@1-shaped model K1's `produceManualEntries` reads, each block with its own citation, plus the report lines and the blocks that could not be cited |
| `adoc/entries.ts` | `produceAdocEntries` | the mapped model → K1's entries with every fragment rewritten to `{slot, source, parser: text@1, selector}`, or one typed group refusal |
| `adoc/families.ts` | `compileFamilies`, `familyManualName` | `{ main, revision, families, familyAttributes }` and the product's names → one expanded model, composition and report per name family, or one group failure |

## Walking the build site (brief section 8)

Index → hub pages → listing pages, depth 2, tolerant of dead links:

1. `planSync({ index })` → `pages` (listing pages the index links), `hubs` (hub pages to read).
2. Read every hub page; one that cannot be read is given with `model: null`. `planSync({ index, hubs: [{ page, model }] })`
   → `pages` now also holds the listing pages the hubs link (`from` names the hub; resolve `href` against that page's URL),
   and `hubs` is empty. A page `parseListing` flags `hub: true` (no build entry, page links) may be given in `hubs` too.
3. Read every page in `pages`: `parseListing({ model, context: { platform } })`.
4. `syncBuilds({ builds, existingRoots })` → `produce`, `aliases`, `skipped`, `unreleased`.

## The device display spelling (C07 R[9] identity rule of this pack)

A device's version display shows a build with every `_` of the build-site spelling replaced by `.` (synthetic example:
`Beta_FAMX-ZX-U_10_8_0_901` displays as `Beta.FAMX-ZX-U.10.8.0.901`; the vendor prefix is removed by the executor's
extraction pattern, not here). `naming.ts deviceSpelling` is that one declared replacement and nothing else — no case
folding, no other separator handling. The sync lists the spelling of every build with its own tree as its verified alias:
name-only, the build as its base, no sources of its own; the provenance is this naming declaration alone. A device
version probe then recognises the extracted value by exact comparison against the locked build and its verified aliases;
the Hub core never normalises, folds or strips separators. The build choice never selects the alias over the build.

## Decisions

Builds and lines
- Build name: `[prefix-]Rel|Beta <sep> family[-PLATFORM-TOKENS] <sep> n <sep> n ...[suffix]`, `<sep>` `_` or `.`. The first
  three numbers are the line, the rest the build number (`Rel_FAMX_10_6_1_57`: line `10.6.1`, number `57`;
  `Rel_FAMX-SY-K_10_6_1_3_1_9`: platform `sy-k`, number `3.1.9`). Prefix and suffix are kept as `variant`
  (`BrandOS-*.click`). Family tokens other than FAMX and FAMY are `other`.
- Lines compare by `lineKey`: leading zeros and trailing `.0` beyond the second part dropped, so `10.6`, `10.6.0` and the
  agile tree's `10.6` are one line.

Listing pages
- An entry is a line `<build> (build on <date> <time> ): [based on <base>] [Released on <date>]`, read line by line from the
  html@1 runs; the links up to the next entry are its files, classified by file name (`command_tree-*.xml`,
  `Bugs_Fixed_with_*`, `*MIB*.txt`, image extensions). The image link text gives size and SHA-256 (or MD5 on older entries).
- `released` comes from the "Released on" date, read only when complete: `YYYY-MM-DD` (or `/`), two-digit month and day,
  then no letter or digit. `YYYY-MM-xx` is kept as `YYYY-MM` with a warning; anything else (`2026-03-1`, `2026-3-1x`,
  `2026-03-`) is a warning, `released` null and the text stays in `note`. The red font is a cross-check (a disagreement is
  a warning; red without a date stays unreleased).
- `built` is ISO 8601 without a zone, because the page states none.
- A build listed twice keeps one copy by content: the later build time, then a release (the later first), then a command
  tree, then canonical JSON (`compareCopies` in `builds.ts`), with a warning. The same order merges copies across pages.
- A command tree counts only as a record with a non-empty `href` (`hasCommandTree`).
- A page without build entries that links other pages is `hub: true`, with a warning.
- A name without a platform token takes the page platform from `context.platform` (the planSync page).

Selection (K01 R[10], W03 R[0], W06 F[6])
- A declared name wins (exact, else a unique case-insensitive match), either family; notes say when it is unreleased, of
  another line, platform or a variant.
- The rule: released builds of the line, both families, platform null (or `includePlatforms`), no variant; order by release
  date, build time, FAMX before FAMY, build number, name; the first one whose root can be determined is chosen, better-ranked
  ones without a root are named in a note and stay in `alternatives`. When none has a root the best one is returned with
  `base` null. The result does not depend on the order of the candidates, duplicate names included.
- `base`: an FAMX name is its own base; an FAMY name with its own command tree is its own base (the newest lines 10.6.145,
  10.6.146: their trees equal the FAMX twin's, so the content-addressed roots coincide); an FAMY name without a tree follows
  its `based on` chain to the first FAMX build or FAMY build with a tree. Cycles, missing bases, a base of another family
  and an FAMY build with neither tree nor base give `base` null with a note. The base is never guessed from equal numbers.
- `basis` is the provenance type: `declared` or `projected`.

Sync plan
- Hub pages by name: a product name without `rel_` followed only by a version (`famx_10_7`, `famx_10_6_4`) or by no version
  (`famx_trunk`, `famx_10_x_patch`). Their content decides: a hub page read that lists builds is a listing page (warning).
  Hub pages linked from hub pages are beyond depth 2 and skipped with a reason.
- Listing pages by name: `[rel_]<family>[_<platform>]_<n>_<n>[...]_<tokens>`. Mainline: only the version or a mainline
  token (`demoqualifier`). Platform: version and a platform token (`sy_demoos12`, `sy_k`, `sz_demoos10`, `zx_demoos11`, `demoarch`, ...
  in `PAGE_PLATFORMS`). Patch: any `patch` token. Customer: anything else (customer, POC, feature, special branches, extra
  build numbers). No customer names are in the code.
- Default: mainline listing pages of FAMX and FAMY. `include` / `exclude` are case-insensitive globs (`*`, `?`) over page
  names; exclude wins and also applies to hub pages. The result does not depend on the order of the hub pages given.
  `include` itself is the pack-declared variable `FAMX_INCLUDE_PAGES` (`${var:FAMX_INCLUDE_PAGES}`, D01 R[12]; synthetic
  default `[]` selects only the mainline pages).
- An opted-in page also lists its newest build per version line, name family and platform, released or not (a Beta build
  under test: `released_at` null, so an `includeUnreleased` sync can produce its root when the page links its command
  tree; without a tree link the build is listed by name only, as the page states).
- A build named by the pack-declared variable `FAMX_PINNED_BUILDS` (`${var:FAMX_PINNED_BUILDS}`, D01 R[12]; synthetic
  default `[]`) is listed as a build of its own tree on the read opted-in page it appears on, released or not, carrying
  the command-tree source the page declares for it. The equality with an entry's build name is exact: no transformation
  of any kind, not even case folding; no keywords, prefixes or patterns. A pinned name the read pages do not list is
  reported in the plan note item by item, never guessed.
- `syncBuilds` produces each base build that is released or the base of a released alias, has a command tree and is not
  in `existingRoots`; it lists every resolved alias (`{ alias, base, released, platform }`, `released` null for an
  unreleased alias) for the knowledge package to record, even when the base root exists, and why other released builds
  are skipped (sorted by name).

Producers (K02, K04, C07)
- `ProducedEntry`: `kind`, `path` (canonical tree path, or null when code cannot place it), `statement` (canonical),
  `data`, `fragments` (`{ parser, selector, range? }`, the source fragments for the composition record) and
  `applicability` (null means 未声明). Entries never carry a source digest, so unchanged commands of two builds give equal
  entries; the knowledge package adds references.
- Kinds are the model's (K02 R[3]: 定义、行为、用例、缺陷、观察; the source genre is not a kind, K01 R[0]): command tree
  entries and manual signatures are `definition`, the manual text under a command `behaviour`, release-note items `defect`. The finer form is data: `data.form` `signature` or
  `text` on manual entries (examples also `data.example`), `data.status` `fixed` or `known` on defects. An unplaced span's
  `kind` is the kind its entry will have.
- Producer placement: only `manual` declares `placement: "judgment_allowed"`. Its markdown path now places every block
  (section nodes under `/manual/<手册>`, existence-checked signatures at /commands). The transitional catalog JSON is
  reachable only through direct calls of `produceManualEntries` or the default export: the producer reads markdown@1
  slots only, so no catalog span reaches a production. The release-note defects keep `path: null` under the default
  `code_only`: they stay unplaced at the root and nothing leaves the Hub; offering them to the bot's verified placement
  proposals (K04 R[6]) is an owner decision. `command-tree` keeps default `code_only` to prevent internal defects from leaving the Hub.
- Command tree: one entry per full command; every `arguments` list is one overload (`id` `k`, fragment `fragments[k-1]`).
  `data` is catalog-entry@1 without `reference`. STRING/XSTRING map to string, U16/U32 retain their unsigned
  numeric bounds, DOTTEDIP to IPv4, IPADDR to either address family, IPMASK to a mask or prefix length. Explicit
  HOSTNAME and IP_OR_HOSTNAME map to the corresponding generic catalog types. Hostname-only address help narrows to
  hostname; explicit IPv4/hostname alternatives retain IPv4 plus hostname overloads, while either-family IPADDR with
  hostname uses ip_or_hostname. URL/list/empty-value help retains the documented string fallback and warning.
  Address roles come only from address_role in the source or an origin-bearing params.argumentTypes declaration;
  argument names never infer roles. A declaration may specify type, address_role or both.

  Owner's read-only survey of 12 command trees across both name families and several lines found only inclusive
  bracket ranges [N - N] among nonempty limit values, and no nonempty length. Only that bracket-range grammar is
  interpreted: numeric ranges intersect native numeric bounds, string-like ranges bound length. Every other nonempty
  limit and every nonempty length creates unchecked_constraints on that parameter, with the XML attribute path relative to its overload fragment (the warning carries the full path),
  source value, reason, missing="这种 limit 写法的含义" and the action "包作者在 README 声明这种 limit 写法的含义后重产".
  Empty attributes imply no constraint. The production warning and statement disclose the unchecked constraint;
  catalog checks return unknown with top-level missing and optional exit left to the Hub. Native type failures remain
  independently checkable. Optional values, documented defaults and overloads retain their existing source semantics.
- Manual (markdown): only a complete marked signature that matches the locked command tree becomes a command
  definition. Both word paths and all parameter positions/optional flags are checked. Missing or incomplete grammar keeps
  source text at its section with a recovery action. A rejected signature ends the previous command's body.
- Command tables use the explicit column role `command_signature@2`, compared exactly; other column headers do not
  classify commands. Under `famx-manual-cell@1`, a command cell starts with a bold head and optional emphasized parameters.
  Between signatures, top-level plain runs composed only of the declared separators 与/和/及/或、顿号、ASCII/fullwidth
  comma or slash (and whitespace) delimit a list. Whitespace alone joins spans of one signature. Emphasis and matching
  parameter delimiters `<…>`, `[…]`, `{…}` are parsed first; separators inside them never split. A prose prefix makes
  the entire cell a mention; a prose tail ends the signature list. These are cell syntax, never prose classification.
  A single signature is checked against the tree and placed at its complete path or section; multi-signature rows use
  the exact common ancestor only if all signatures check. The row's other cells remain verbatim mentions. Current
  parameter names and variant values are value rows, matched by exact equality. Each split row cites its own byte range;
  remaining rows retain the header and current placement. Grid, multiline and simple tables stay whole.
- Literal relations follow decision 60: whole code-block lines and explicit command columns claim commands; valid lines
  use the fully parsed canonical path, unmatched structural lines are drift candidates. Prose bold/inline-code spans
  are verbatim `command_mentions`, with `unmatched: mention`; only exact matches to locked `/commands` definitions link.
  Unmatched mentions never establish drift. Signatures retain `signature_literals` and positive alternatives. No
  spelling, case, NFC, prefix or synonym normalization occurs. Production and reading share one pinned evaluator.
- Applicability is declared only by `famx-applicability@1` JSON blocks and the configured exact closed sets. Prose headings,
  paragraphs and table cells declare nothing, including conflicts or inheritance. Missing declarations retain
  `declaration_status=undeclared` and `judgment_status=unjudged`; model claims require quoted evidence verified by Hub.
- Manual (catalog JSON): the `ist.manual-command-catalog` JSON keeps being read (signatures, value domains, worked
  examples) as a transition, until the adoc producer replaces it. It is reachable only through direct calls of
  `produceManualEntries` or the default export: the production's manual producer reads markdown@1 slots only, so no
  catalog span reaches a production. Each signature is a signature entry (fragment
  `p/signatures/<k>/signature_verbatim`). A "signature" whose head holds a quoted value or a number after a known head is
  a worked example: a text entry (`example: true`) at the longest known head, else unplaced; never a synthetic path. A
  number with no known head before it stays a command word. Value domains and worked examples become text entries at the
  matching head, else `unplaced`.
- Release notes: a section or a block is a defect list only when it declares `status` as exactly `fixed` or `known`.
  The value is inherited from the nearest ancestor section that declares it. A heading's words are not a status, and a
  value other than those two is not a status. With no declaration the producer emits no defect entry and names the
  missing fact and the next step (the release-page author writes `status` before the next production). The module is
  the child heading under that section, or the cell at a declared `columns.module` index. Items are list items, table
  rows (pipe, grid, HTML) or paragraphs. A bug id is the whole cell at a declared `columns.bug` index when that cell
  is the 2–9 digit token from `ids.ts` (`normalizeId`), or a bug marker `idsFromTitle` still reads in list and
  paragraph text. Header words do not choose a column, and a headerless first cell is not a bug id. `columns.text`
  and `columns.sequence` are the other declared indexes. The id is stored as `data.bug` (the same id a case lists in
  `data.defects`). `data.status` is the declared `fixed` or `known`. The names `bug`, `status` and `defects` are
  legal index keys; `bugId` is not, because a data field name is a lower-case word. `path` is null (the module is the hint
  for placement), so these defect entries stay unplaced under the root (K01 R[4]). `knowledge:facets` and
  `knowledge:index` count them with the entries hung on the tree, once each, and cite an unplaced entry at the root
  (`tree:<root>/@<digest>`). The facet total includes them and says how many are unplaced; the index says the same in its
  notes. Impact keeps the entries on a changed path. A case is listed under `key=defects`, once per id, hung on a command
  or left unplaced. `applicability` is `{ builds: [build] }`; a part of a
  block is cited with a byte range. Table scanning
  is linear (grid cells joined once per row, tags stripped without backtracking, ASCII-only lower-casing so offsets hold).

Text functions
- `extractCommands`: a phrase starts at a word that begins a catalog head, follows the head words the catalog knows, then
  argument tokens up to Chinese text, sentence punctuation, a line end or a closing quote or bracket; inside backticks or
  quotes it runs to the closing mark. Never prose: an English stop word or a placeholder (`xxx`) cuts back to the head;
  after an English word only the head is kept; a lone word counts only when quoted, or when it is a complete head in
  Chinese text not named as a command (`show命令`). Offsets are UTF-16 indices; `text === input.slice(start, end)`.
- `locateFromAncestors`: prefix codes are three letters or digits with a digit, optionally grouped, before an ASCII or
  full-width colon (NFKC). The first `<version>-<suffix>` label is the train, the nearest line label above it the line
  (else the line comes from the train); the label right under the train is the module when it is a plain name (no ids, no
  version, not a test activity). Input labels are truncated at 1000 characters before normalization; a module name
  is at most 40 characters, and a name containing four or more consecutive digits is not a module name.
- `idsFromTitle`: bug, story (`需求`, `Story#`) and PLM markers, misspellings seen in real titles included; lists after a
  marker; ids the title does not classify (a leading number, after 回归 or Test-) go to `unclassified`. Versions, dates,
  years, numbers glued to short words and alarm-like numbers in running text are never ids. Preserve the original
  spelling of every identifier; for identity comparisons, remove leading zeros only from nonzero identifiers. A digit
  run consisting entirely of zeros is not an identifier. Length bounds are checked before removing leading zeros:
  2–9 digits after a marker, 4–7 digits for an unclassified leading identifier. These rules follow the current mainline
  `packs/product/famx/functions/ids.ts` implementation (the module-name limits are enforced by `functions/locate.ts`).

## The case index (brief section 6a, capabilities 4 and 6)

Sync (`cases-sync.ts`, called by `sync.ts` when the sync option `case_index` is true; product.json sets it)
- Round 1 fetches `agile:tree:roots` (the agile system pack's read of every configured root) besides the hub and listing
  pages; it is read once per sync and parsed as json@1. Documents are taken from the roots titled with a product name
  (`FAMX`, `FAMY`, NFKC, case-insensitive, alone or before a non-word mark): both name families, so the first name's root
  (no versions) is read too; its documents have no line and are counted. Other roots of the resource are counted, not read.
- Each document is located with `locate.ts` (its ancestors from the root title down, as the mind-map meta has them). A
  build whose own command tree is listed (`tree`) gets `case_documents`: the `agile:mindmap:<id>` of the documents with a
  line not later than the build's and not earlier than `min_line` (default null; explicit null imposes no lower bound; only a dotted version line supplies a floor;
  other values withhold case-bearing builds for this sync and name `circle-hub var set FAMX_MIN_LINE --file`), at most 20,000 (product@1 `MAX_LIST_SOURCES`; more are noted, not listed), ordered by id (numbers by
  value): new documents come last, so the Hub's consecutive batches of an earlier list stay where they were. It also gets
  `case_tree: agile:tree:roots`. Aliases (no tree of their own) list nothing. Ids the agile pack cannot read (outside
  `[0-9A-Za-z_-]{1,64}`) are not listed. The plan note counts the documents read, listed, and not listed by reason: no
  version line or train above the document, earlier than `min_line`, unreadable id, filed twice (once), other roots.
- **No build is listed while the tree is not read yet, cannot be read, is not the expected content or is incomplete** (a
  configured root not read, a root title unknown): a root produced without the case list would lose every case it had,
  and the views would read the loss as absence. The note says why and how to switch the index off (`case_index: false`).
  A plan the Hub cuts at a limit before the tree was read lists no build either.

Producer `cases` (`cases.ts`, entry kind `case`; the product pack declares no catalog over case entries)
- **Case nodes** (`cases-nodes.ts`): the case-review projection's rule, tagged OR marked (`CASE_RULE`: case priority 2,
  group priority 1, precondition priority 3; a test compares with `packs/workflow/case-review` project.ts under
  `caseRule: marked` on every fixture map and the corpus): a tagged node is a case unless it is a group (outside every
  case, group priority, holds tagged or case-priority nodes); an untagged node outside every case with the case priority,
  children and none of those below is a case too; a node either rule names is one case. Inside a case, leaves are expected
  results (precondition-priority leaves not), children with children are steps, a case below a case is its own.
- **Commands** (`cases-commands.ts`): the catalog is the build's command tree. Each distinct text of a call (the case
  title, every label above the case, and the case body) is read as newline-delimited statements. A statement is one
  command only when its words are exactly the locked tree's words, in order and in the tree's spelling, and the tokens
  that follow satisfy that command's declared argument list (`type`, `limit`, `length`, `optional`). Quotes delimit an
  argument literal. A statement that matches two commands, or that is not a complete command, is not a command: no
  abbreviation, no unique prefix, no case folding, no leading `no` that undoes another command, and no command lifted
  out of a sentence. The table is `tests/fixtures/case-index/table.ts`.
- **Entries**: ONE entry per resolved command, at the command's path, and, when no command resolves, ONE entry with
  `path: null` (the contract's unplaced form; brief 6a.4). The statement is `caseStatement`: every data field, several
  lines, so the entry digest covers what `data` says (K02 R[4]). Data is
  `{document, node, title, path_labels, priority, tags, negative, expected_count, has_expected, vague_expected,
  steps_count, commands, stories, defects, line, train, module, autoid}` (scalars and lists of scalars). One fragment
  `{slot: documents, source: <element digest>, parser: kityminder@1, selector}` (the parser's selector of the case node);
  applicability null. `node` is the case-review key: `data.id` when that id is unique among the document's case nodes
  (a copy of the id on an expected-result leaf does not take it), otherwise `@<index>` or `#k` the way case-review writes
  them, so a raw id `i/1` does not collide with an id-less case at selector `i/1`. `negative` is the case-review tag rule
  (null without a tag); `has_expected`: some expected text is not blank; `vague_expected`: there is one and every one that
  is not blank is a phrase of `VAGUE_EXPECTED`, folded (NFKC, lower case, no white space, no edge punctuation); `line` in
  `lineKey` form; `stories`, `defects` (`ids.ts` stories and bugs, sorted by value) from the case title, the labels above
  it, the document's title and folders in the agile tree; `line`, `train`, `module` by `locate.ts` from the document's
  folders. Each call ends its warnings with one line counting documents, cases, cases filed under a command and cases
  left with an empty path, by reason, with at most 20 examples. An entry depends on its own document only.
- **Which document an element is.** The list element carries `external` (product@1, filled by the Hub from the object it
  read). An `agile:case` read also names the document in `model.meta.agile.id`. Either one is taken, and only when the
  build lists that id. An element with neither is unknown (document, line, train and module null), with a warning. Nothing
  is inferred from the element's position in the batch. Equal bytes with different ids stay different documents.
  `folders` (`agile:tree:roots`) still supplies each document's title and the folders above it: the slot does not carry
  the read's `meta` artifact, and the mind map itself does not.
- Scale: one sandboxed call of 40 documents of 60 cases against a 4,000-command tree and a 3,000-document agile tree
  took about 0.2 s here (direct call 0.13 s; 6.3 MB in, 1.3 MB out), about 15 s of producer time for a build of 3,000
  documents (75 calls).

## The adoc producer (K4)

`functions/adoc/index.ts` exports `compileAdoc(input)` (also the default export). Step one is the restricted expansion:
the file table, conditions and attributes, source-line verification, the composition identity and the whole-group
refusal. It registers no knowledge producer, changes no sync plan and does not read signatures, value domains or
`catalog.json`. Step two maps that intermediate model onto K1's document model and runs it once per name family; the
placement code in `manual.ts` is not changed by it.

A whole-group refusal reads the engine's own structured observations only: a message severity of `ERROR` or `FATAL`
(`famx.adoc.engine_parse`), except the precisely observed incomplete-table-row recovery described below. The reader's
`unterminated` flag records a recoverable missing delimiter and no longer refuses the group. The words of a
message are quoted back to the author as evidence and name no cause, so a warning whose text happens to say “unterminated
… block” refuses nothing on its own (owner rule 2026-10-24, sweep A80). `report.engine_messages` keeps every message with
its severity as before.

### Input and composition identity

The input is `{main, revision, files, attributes?}`, where `files` maps a relative path to `{text, revision, sha256}`:

- `text` is the UTF-8 original decoded, keeping NUL bytes and CRLF; a text whose NUL bytes are already gone while the
  original digest is declared is refused, and so is a lone surrogate. `revision` is the SVN revision the whole group was
  read at and every file must carry it (not each file's last-changed revision). The bytes of every declared file,
  including the ones nothing includes, are digest-checked first.
- `attributes` defaults to empty, that is "all unset" like today's markdown reading; a value is a single-line string or
  a boolean. Whether an external attribute overrides a definition in the source follows the engine's own precedence.
  Names are lower-cased as the engine does; a case-folded duplicate, a clock attribute, an execution-policy attribute and
  a value that could inject a preprocessor directive are refused.
- The composition record holds the main file, the revision, the sorted file/digest table, the declared attributes, the
  engine version and digest, the expansion policy and the budgets; its `sha256` is the canonical-JSON digest of that
  identity object. A real composition record still has to bind this intermediate product and the pack version when the
  producer is wired into a production.

Success returns `{ok: true, composition, model, report}`; failure returns only `{ok: false, error}`, with no applicable
partial model and no digest, and the error names the gap and the next action. The same input gives the same JSON bytes;
the insertion order of the file and attribute objects does not change the output, and a different attribute set changes
the identity. `compileAdoc` is pure and never writes a knowledge root; a step-two caller must treat a failure as the
failure of the whole group, keep the old root and never commit the remaining chapters after skipping a bad one.

The budgets are fixed: 128 files, 16 MiB of originals, 8 MiB expanded, 16 include levels, 512 includes, 250000 lines,
1024 conditional branches, 250000 engine nodes. A test may tighten them through the second argument; the production
default entry takes no budget override from the input. The producer sandbox's own time, memory and JSON size limits still
apply outside.

### Includes, conditions and attributes

Only `include::relative[]` of a file in the table is expanded, recursively and in order of appearance — never by the
digits in a file name. An include path may be composed of the source attributes actually in effect: the engine reads the
prefix and the adapter replays the state through the public playback API, without rewriting the engine's attribute
rules. No paragraph separator is invented; an author who wants a paragraph or a chapter break keeps the blank line.

A missing file, a URI, an absolute, parent or backslash path, any include option, an include inside a condition (even an
unselected branch), a cycle and every budget overrun refuse the whole group. An include that is not alone on its line and
an unsupported conditional syntax are refused too, so the engine's built-in include I/O is never reached. Files the main
file does not include are listed in `unused_files` only and do not enter the book.

The pinned engine evaluates ifdef and ifndef, including their OR/AND and single-line forms; ifeval is not supported. The
report gives, per branch, the directive text, the source file and line, whether the branch is retained, the parent branch
and the removed source ranges with their line counts. Nested branches are reported separately, never as one whole-book
difference, and no paragraph is dropped quietly. To observe the engine's attribute state at the same moment, the condition
check uses a small predicate probe with a fixed marker and counts toward the parent branch's state; the original document
is still parsed by the main engine, so there is no second implementation of ifdef.

Body attribute changes are replayed during the AST walk with the public `document.playbackAttributes(node.attributes)`;
`raw` and `expanded` are kept apart. Any use, definition or conditional reference of docdate, doctime, docdatetime,
docyear, localdate, localtime, localdatetime or localyear is refused, including inside an unselected branch; no engine
clock, object identity or environment metadata is emitted.

Logging uses the public LoggerManager in a serialized session that is restored at the end; the `load.logger` option, which
would trigger a `node:async_hooks` dynamic import, is not passed. Concurrent calls in one process are serialized too. The
third-party engine bytes and the sandbox import allowlist are unmodified.

### The intermediate model and the source lines

`model.expanded_text` is the include-expanded text with NUL removed and line endings normalized to LF, keeping the
conditional directives; `line_map` keeps each line's original file and line number. `blocks` come only from the AST after
condition evaluation and carry the engine kind, the section level, the title, the author id and role, the section path
(each element with the index of that section's own block, so two sections with the same title stay two sections), the
heading text as written in the verified source line (`heading`, attributes expanded), `raw`/`expanded` and, for the
contexts that keep their source text and carry inline content of their own (a paragraph, an admonition, a simple quote, a
verse), the engine's own inline output of that text (`converted`, empty when the engine rendered child blocks instead); a
block that is an example or sits inside one is marked (`example`), and a table keeps its head, body and foot cells with the
line the engine reported for each. Nothing here promotes a listing, a bold run, a title
or a role into a command rule.

Every sourcemap line number is only a candidate. The locator tries a verbatim match in a fixed neighbourhood and then
re-reads the original file's lines independently; only a single match emits `src:<digest>/text@1/l/<a>-<b>` (`l/a` for one
line), and the verbatim text that text@1 would return is kept with it. Source lines that are not contiguous, or lines of
another file, become separate origins: no continuous range is invented. NUL removal and CR/LF splitting follow text@1,
while the file digest stays over the original bytes.

A match is tried in two passes and both are collected before anything is decided. The exact pass compares the source line
as written, or that line with the narrow marker of the context taken off (a heading's equals signs, a `*`/`-`/`.`/`1.`
list bullet, an admonition label, a table row's cell separators). The folded pass runs too, and compares words instead of
spelling: `text.ts plainText` decodes character references, reduces an inline macro to its text, resolves escapes, drops
inline markup marks, folds the engine's typographic replacements back to ASCII and collapses white space, while the engine
itself expands the candidate line's attribute references; it strips every structural marker the source can carry (any list
bullet, a description list's `term::` separator, an admonition label, a heading's equals signs, a table row's cell
separators and the `ifdef::name[...]` wrapper of a retained single-line branch, in any order). The engine's own text of a
list item, a description-list item or a table cell is converted, so the fold is what lets those blocks be cited at all; it
locates a line and never becomes a citation or a statement, and a block whose inline conversion the fold cannot invert (a
menu path, a key cap, a footnote number, a checkbox mark) stays uncited and is reported. Both passes' candidates are kept,
because a neighbouring line that literally holds the engine's words — an admonition whose label the engine dropped, an
item whose attribute expands to what the next item says — is an exact match for the wrong line, and had the exact pass
alone decided, the folded pass that finds the block's own line would never have run. The one exception is the exact pass
finding the cursor's own line: that line holds this block's text as written where the engine says the block is, and
nothing stronger exists, so the folded pass is not run (on a table-dense book it would cost more than the rest of the
expansion together). For the same reason the engine's attribute substitution is asked only of a candidate line that
carries a `{`.

The window is counted in visible lines: the cursor's own line, three visible lines before it and two after, so a block the
engine reports at the `endif` of a removed branch still reaches the line it was read from. A candidate is used only when
the engine's cursor can belong to it, which takes two things: the cursor's own line is one no block's text stands on (a line
a condition removed, one the reader consumes without producing a block, or a blank one), and every line between the cursor
and the candidate is one the reader consumes (a conditional control, a block delimiter, a block attribute or title line, a
heading, an attribute entry, an include) or a line a condition removed. A blank line between them is not one of those,
because a blank line ends a paragraph: a candidate on the other side of one is another block's line. Neither is a cursor on
another block's own text a recovery — that is the engine pointing at the block it means, and a neighbour that happens to
hold the same words (the item before a checkbox item, a paragraph above an admonition) is not this block's line, however
equal the text is. So a listing is still found one line under its delimiter and a paragraph one line before a removed
branch, while a block whose own line folds to nothing is reported and cites nothing.

When several candidates are left, the one at the cursor is the block's line — the text is proven on every candidate, so
only the position is chosen. How many lines hold the text is disclosed whenever it is more than one (`disambiguated`,
`disambiguated_count`, `disambiguated_examples_truncated`, the same 100-example cap as `unverified`), also when the
reachability rule and not the cursor left one line; when none of the candidates is at the cursor and more than one
reaches it, nothing is cited. A cursor that reaches no candidate leaves the block uncited too.

A single-line comment (`// …`) is not content: the reader drops it, so the walk steps over one when a block's lines sit on
either side of it, and such a block cites two ranges and is mapped as two blocks. A `////` block-comment delimiter is not
stepped over, and a comment line inside a verbatim listing is content and is matched like any other line.

A block or cell that cannot be verified uniquely has no reference. `unverified_count` gives the total, `unverified` keeps
the first 100 diagnostics and `unverified_examples_truncated` is true past that. The model keeps the empty `origins`
explicitly, with the line the engine reported (`reportedLine`) and the reason (`unverifiedReason`): having a sourcemap is
never taken for a proven position. A container with no text of its own (a list, an example, an open, sidebar or table
container) is not reported at all — there is nothing to verify, its content is the blocks the engine gives for its
children, each verified on its own — and it gets no invented range.

Per file the report counts NUL, CRLF, LF and CR; a UTF-8 BOM is reported as 3 extra bytes and is dropped when lines are
re-read, while the digest still covers it. A line with more equals signs than a legal heading is listed in
`invalid_headings` and not promoted to a section; engine messages stay in the report. Unrelated ERROR/FATAL messages
still refuse the group; recovered missing delimiters are reported with their actual engine extent below.

### The third-party engine

- Upstream `@asciidoctor/core@4.1.1`, taken outside the repository with `npm pack --ignore-scripts`;
  `package/build/browser/index.js` was copied byte for byte to `vendor/core.mjs`, 990496 bytes.
- SHA-256 `5a8785bf8dc39a216170b836bb274957f079f77e5f40b33453c988f85de9203d`, equal to the digest pinned in
  `docs/hub-r4-research/adoc-sandbox.md`.
- `vendor/LICENSE.txt` is the LICENSE of the upstream tag v4.1.1 byte for byte, SHA-256
  `5dc8600d56eb0cae83dcdecde260d5b5568e7a5431fb9a9cf7906d02818bac7e`, with the MIT copyright and permission notice kept
  complete.
- `core.d.mts` declares only the API this adapter uses. There is no npm runtime dependency, no install script, no patch
  of the library and no new sandbox permission.

### Synthetic scale

2026-10-24, macOS arm64, Node v24.17.0, single concurrency, one cold sandbox process. The profile quoted is the public
`DEFAULT_SANDBOX.producer` of `hub/knowledge/api.ts`: 120000 ms, memoryMb 1024, 128 MiB of JSON input, 64 MiB of output.
The RSS watchdog's own 192 MiB of overhead was not raised and no configuration was changed.

One group of 12 table-dense chapters, 3146572 bytes: wall clock 953 ms, parse and extract plus one serialization of the
result 712.7 ms, peak process RSS 680928 KiB (664.8 MiB), heap at the end 247139008 bytes, output JSON 44145472 bytes.
The RSS was sampled after the first serialization of the result, so it is not the kernel peak of the later transfer stage;
the transfer stays under the original watchdog. This is one round of synthetic capacity evidence, not an SLA, and it does
not show that real adoc of any syntax or size works.

Step two added one engine call per paragraph, admonition, quote and verse (its own inline output, which the mapping reads
instead of re-implementing AsciiDoc inline semantics), so a paragraph-dense group was measured as well, outside the
sandbox: 12 chapters of 1200 short paragraphs each with an attribute reference and inline marks, 1527895 bytes and 14400
paragraphs, 358 ms in one warm host process, 19575674 bytes of output JSON. Both runs stay far inside the producer
profile; neither is an SLA.

The tests run with `node --test --test-concurrency=2 "packs/product/famx/functions/adoc/*.test.ts"`; concurrency is capped at 2 on this host. A cold process gives
the same bytes under a different Date and Math.random, and the same sandbox still refuses the network, file writes and
child processes. Where the environment gives no OS network isolation the sandbox evidence is skipped explicitly instead of
being weakened into a pass. Every check so far uses synthetic originals: no real manual and no knowledge root has been
accepted.

### Step two history: the K1 document model and name families

The signature-admission details in this historical subsection are superseded by **Current adoc source structure** below. Chapter/citation mapping remains in use; mapped Markdown never admits a current adoc definition.

- `k1-model.ts` maps the expanded model to the markdown@1 shape: the `=` levels become sections (a `[discrete]` heading is
  a block, not a section; a `=======` line is reported by step one and stays an ordinary block), blocks carry their section
  path, and every block carries its citation: the chapter file's digest and the plain text@1 `l/<a>-<b>` line selector of
  the range step one verified, as two fields (a table block's citation covers every line of its verified cells). K1's
  placement code (`produceManualEntries` in `manual.ts`) applies to the result unchanged: signatures hang at /commands,
  table rows split, text entries hang at their section node.
- K1 copies a block's `selector` verbatim into the fragments of the entries it makes and stamps its own parser key on them
  (`markdown@1`), so the mapped model puts a citation key of its own in that field (`cite/<index of the block>`) and
  `entries.ts` (`produceAdocEntries`) turns every fragment back into the shape the Hub verifies: the chapter file's digest
  in `source`, `text@1` as the parser, the plain line selector and the producer's slot. A byte range inside a mapped
  table's text is only how K1 names a row; the fragment of a row is that row's own source line, with no range. A fragment
  this rewrite cannot resolve (`famx.adoc.fragment_not_cited`) refuses the whole group: no entry goes out citing a
  reference to nothing, and the old root does not move.
- Section paths follow K1 and have the same shape as markdown@1's. A section is keyed by the node the engine gave for it
  (the index of its own block, carried by every path element), never by its title text, so two sections with the same title
  stay two sections and `IPv4/IPv6` is not the parent of `IPv4` and `IPv6`. The segment is the heading's own source text:
  the attribute references of this family expanded, character references decoded, and the inline marks paired by
  AsciiDoc's constrained rule off (no white space inside them) — never the engine's converted title, which would carry
  `<code>` and `&#8217;` into the path. Every other character of the title stays, because a `_`, `+` or `#` inside a word
  is part of the word, not markup, and a spaced mark is no markup either: `health_check`, `C++`, `C#` and `步骤 #1` keep
  their paths, and two titles that differ only by such a character are told apart by their own text rather than by an
  ordinal. Repeated sibling keys are numbered
  `[k]` from 1, as markdown@1 numbers them (also when a key is empty or already ends in `[digits]`), and the selector is
  the encoded `h/` path, null past 4096 characters: such a section cannot be cited and its blocks hang at the manual
  namespace root, which K1 counts in its own warning. Every section of the expanded model is created before any block is
  placed, in document order, so an empty section — or one whose content is all uncited — still takes its ordinal among its
  siblings, a later sibling never inherits an earlier sibling's path, and the numbering does not move when an unrelated
  block starts or stops verifying. The document title (`=`, level 0) is not a chapter: the manual's name comes from the
  producer, and the engine puts the `==` sections beside it rather than under it, so a section path never carries the book
  title. A heading that verified on no source line falls back to the engine's own title, plain, cites nothing, and the
  mapping says so in a warning. Because a segment carries no marks, a title is
  never read as a signature (task item 6: K1 reads one only from a title that opens with `**`).
- Nothing is placed that cannot be cited. A container with no text of its own is not mapped (the engine gives a block for
  each of its children, and each carries and cites its own text); a list item is mapped as its own block on its own line,
  and a description-list entry becomes one block for the term and the value of one source line, used only when the two
  items really are that line. A block whose verified lines are not one contiguous range — a conditional branch inside it,
  an include boundary, a line the reader dropped — becomes one mapped block per range, each part with its own lines and
  its own citation, because a fragment has to hold the words its entry claims; when the text's lines do not map one to one
  onto the ranges, the block is reported instead of being cited on its first range alone. A part of a paragraph is mapped
  as `paragraph_part`, a kind K1 places like any other text block but reads no anchor from: the author wrote one paragraph,
  whose text spans lines and is therefore no anchor of K1's single-line grammar, and a source boundary is not a semantic
  one, so a part whose first line happens to be a bold command must not become a definition the source does not have. A block whose text step one
  could not verify stays out of the model and is returned in
  `uncited` with its kind, reason, next action and its place — the chapter file and that file's own line, because the
  engine reports a line of the expanded text, which in an included chapter is no line a reader can open; the expanded line
  is kept beside it as `expanded_line`, for the line map and step one's report. The misaligned-table and unverified-heading
  warnings name the same place. One warning line for the production goes with it: a block is never
  handed to K1 without a selector, because K1 counts such a block as malformed and skips it, so the text would disappear
  from the knowledge with only a count left behind.
- A paragraph entry cites the source line step one verified verbatim, and a table is mapped as the engine's own rows, one
  line each, in the order head, body and foot give them: the head row is K1's header, a table the engine reads without a
  head row gets an empty header line (never a body row promoted into one, and that produced line cites the table's own
  source range), a cell that spans source lines stays on its row line, and every character reference in a cell is decoded,
  the numeric ones included. Nothing is regrouped by verified line number, so no row is merged, split, dropped or
  invented; a table whose rows the engine reads with unequal cell counts is mapped as the engine reports it and reported
  in the production warnings, with the delimiter row (`| --- | --- |`) K1's pipe-table reader needs under the header. The
  delimiter is a produced line and cites nothing; every row line carries that row's own citation: the range covering the
  row's verified cells, bridged over lines that re-read as blank (AsciiDoc's implicit header puts a blank line after the
  head row, and a table written one cell per line is often spaced out — neither costs a row). A table stands on its cited
  rows, not on one gap-free range over all of them: the range that covers the whole table is used for the fallback entry
  and for a produced empty header, and when it cannot be built the first cited row's own range is used instead. A row
  entry therefore cites the line the row is written on, never the header's line and never a byte range inside the mapped
  text. A row that cites nothing is left out of the mapped table and reported with the table's file and line, the row's own
  line, and which of three things happened: no cell verified, a cell that holds words verified on no line (so the row's
  text cannot be cited on the lines of its other cells — a line that does not hold what the entry says is no citation), or
  the row's own cells are separated by a line that holds something else. A table with no cited row at all is reported the
  same way, and the reasons are kept apart ("no cell verified" is not said of a table whose cells verified). Nothing
  borrows another row's source line.
- A statement carries what the source says under the family's own attribute set, in the reader's spelling: every block
  gives the engine's own inline output where there is one (a paragraph, an admonition, a simple quote, a verse — strong as
  `**…**`, em as `*…*`, code as backticks, character references decoded, a hard break as the line break the engine already
  puts after its `<br>`, so no tag reaches a statement), else its attribute-expanded text, except a listing or literal
  block, which the engine leaves verbatim and which stays verbatim here. A brand word written `{product}` therefore reaches
  each copy with that family's value, and an admonition or a quote gives K1 the same spelling a paragraph gives, so the
  command literal a read-time link resolves (K05 R[2]) is recorded for them too. The fragment always stays on the verified
  source line, which still holds the placeholder and the author's own marks (K02 R[4]: a statement need not be the source
  verbatim).
- Only an explicit structure gives a signature (task item 6): a command-table row (under a header that names commands, two
  bold runs joined by a slash also split), every line of a `[role=signature]` block, and a paragraph the author marked as
  one — bold and italic in AsciiDoc spelling (`*demo pool add* _<name>_ _[interval]_`), or one whole monospace line
  (`` `demo pool add <name>` ``, or the `+…+` spelling the engine renders as plain text). The paragraph's inline markup is
  read as the engine converts it, not re-implemented: step one keeps the engine's own inline output of a paragraph next to
  its source text, and the mapping spells strong as `**…**`, em as `*…*` and code as backticks, which is the one spelling
  K1's anchor grammar reads. A monospace line, whose parts the source does not mark, is read by an explicit rule instead:
  the words before the first parameter group are the command head and every group after it is a parameter, while an
  alternative group (`{add|del}`) and an optional group that words follow (`[no] demo pool add`) stay in the head because
  K1 reads them as alternatives of the command itself. A line that rule does not read, or that K1 would not accept, is not
  emitted with invented marks.
- Every line of a `[role=signature]` block is read on its own and cited on its own source line (the block's verified range,
  line by line), so a line never cites the whole block. A blank line makes no entry. A listing is verbatim, so the engine
  gives no conversion of its lines and the marks are read here — but only by AsciiDoc's constrained-markup rule: an
  opening mark at the start of a token with its text beginning immediately, and a closing run of the same length ending
  that text at the end, before white space or before punctuation (`*demo pool del* _<name>_` reads as
  `demo pool del <name>`, `\<name\>` as `<name>`). Never a character inside a word — `max_conn`, `health_check` and
  `aes128+sha` keep the command words the source has, so a signature block and a command table row of the same command land
  on the same node — and never a mark with white space inside it: `demo + pool + add <name>` is no markup, so such a line
  reads as no signature, is reported through `unparsed` and stays the text it is instead of becoming a command the source
  does not have. Nor is a mark escaped by an odd number of backslashes markup: `demo *pool\*_ add <name>` keeps its literal
  asterisk, reads as no signature and is reported the same way, because deleting an escaped character would invent a
  command word (`demo pool_ add`) that the source does not have — an even run of backslashes is a literal backslash and the
  mark after it is markup as usual. Since a listing is verbatim, a reported line keeps its escapes in the statement; the
  same pairing rule decides the marks of a heading segment. A line the rule does not
  read stays the ordinary text it is — placed as text on its own line, and reported with its file, line, reason and next
  action (`unparsed` of the mapping and one warning of the production). Nothing is wrapped in bold marks the source does
  not have, so no statement is fabricated and no head/parameter split is guessed.
- A title, ordinary bold prose and an example are never a signature. Step one marks every block that is an example or sits
  inside one (the `====` block, or a block whose role or style says example, and all their children), and the mapping hands
  K1 such a block as reference content: never as a paragraph, the one kind K1 reads anchors from, and never as a table,
  which K1 would split into row signatures. A listing stays code, which K1 never anchors either, so a `[role=signature]`
  block inside an example stays the reference text it is and the paragraph after the example follows no command from
  inside it. K1 still places that text where it places any other block — under the command before it, with that command's
  words in `data` — so `produceAdocEntries` marks every entry whose fragments all cite example content with
  `data.reference_only: true`. The source literals of an example are preserved under `data.reference.command_literals`
  and `data.reference.signature_literals` when present; the top-level fields of those names are absent. The product's
  declared relation rules read only the top-level fields, so the shared relation evaluator includes the same literals
  from real prose while an example creates neither links nor drift candidates. K1's placement code is unchanged and
  runs once; it no longer supplies drift warnings. One production warning discloses the reference entries and literals.
  Consumers that judge or count the original prose still need to respect `data.reference_only`; moving the relation
  inputs does not claim that every other reader filters example text.
- A version line with an adoc source stops the transitional `catalog.json` reading (task item 6), and the adoc producer is
  where that is known: `catalogOnAdocLine(slot)` in `entries.ts` reads the slot's parser and schema, and `catalogRefusal()`
  is the typed failure (`famx.adoc.catalog_reading_off`) the wired producer returns for it, naming the family, how the
  line's manual source is changed into an adoc file table, and that the old root stays until then. It is a failure and
  never an empty `{entries: [], warnings: […]}`: `ProducerOutput` has no failure channel, so an empty output would be
  stored as a production that read this line's manual and found nothing in it. A line without an adoc source reads the
  catalog as before — K1's own code, unchanged by this package.
  An earlier revision of this branch had put that stop inside K1's `produceManualEntries` as an `adocSource` option. It is
  reverted, and `manual.ts` and `functions/types.ts` are byte for byte K1's again: no caller ever set the option, the
  catalog path cannot be reached from a production anyway (the manual producer reads markdown@1 slots only), and when it
  was set it returned an empty success — which the producer protocol stores as a production that read this line's manual
  and found nothing in it, the opposite of a refusal, with a next action that told a line which already has an adoc source
  to get one.
- `families.ts` (decision 35): every name family runs the expansion with its own attribute set and gets its own document
  model. The manual name carries the family, spelled `<manual>-<family lower-cased>` (`cli-famx`, `cli-famy`), and both
  copies hang under the manual namespace of the same version line. An attribute-set key must be one of the `names` in
  `product.json`, or the group is refused (`famx.adoc.family_not_a_name`). The conditional branches are reported per family,
  and any family's expansion failure fails the group and returns no partial result, so the old knowledge root does not
  move.
- The family helper records only what it was given: `attributes.declared`, `attributes.values` and a note. It does not infer deployment provenance. The published family producers receive resolved values; the Hub root composition's `variables` records each reference and its immutable configuration decision, not an invented producer claim about its origin. Real sync refuses missing variables before any read. Only direct synthetic samples and dry runs may exercise absent/default attributes. Real attribute names and values remain deployment data supplied explicitly by the integrator.

## Deviations from the brief and the task

- `basis` is `declared` / `projected` (provenance_type axis, A01 R[1]) instead of `declared` / `rule`: the task asked for
  `rule`, but enumerations come only from the generated vocabulary.
- Entry kinds follow K02 R[3] (`definition`, `behaviour`, `defect`), not the task's `command`, `manual_signature`,
  `manual_text`, `fix`, `known_issue`: the model wins over the task. The task's distinctions are kept in `data.form` and
  `data.status`.
- Catalog parameters use the contract's `minimum`, `maximum`, `minLength`, `maxLength` (contracts/src/tables.ts), not
  `min` / `max`.
- `idsFromTitle` adds `unclassified`: an unmarked number may be a story or a bug in this tracker, so it is not filed as
  either (the workflow pack decides how to read it).
- `Build` fields `line`, `number`, `built` and `files.image` may be null; `md5`, `variant` and `note` were added.
- `planSync` returns the link (`href`) and the linking hub (`from`) of each page, the hub pages to read and `warnings`, and
  accepts several index models. `syncBuilds` returns `{ produce, aliases, skipped, unreleased, warnings }`.
- `selectBuild` returns every qualifying build in `alternatives`, not a sample.
- The manual producer also emits text entries (descriptions, value domains, examples) besides signatures.
- Release note entries have `path: null`: their subject is a module or a defect, not a command node, and K01 R[3] forbids
  synthetic paths.
- The `cases` producer has a third input, `folders` (role `case_tree`, `agile:tree:roots`), besides `documents` and
  `tree`. List elements now carry `external`, so the document id no longer has to be guessed; titles and folders still
  come from the tree, because the slot has no `meta` artifact. There is no `params.batch`.
- The vague phrases: the task names "the vague phrases of the case-review tables", but those tables hold none. The list is
  this pack's (`VAGUE_EXPECTED` in `cases-rules.ts`, author-written, an open question for the owner) and is matched whole.
- `stories` and `defects` also take the ids of the document's agile title and folders (a `bug to case <id>` folder links
  its documents' cases to the defect); unmarked ids (`31057-...`) are neither (the `idsFromTitle` rule).
- The sync option `case_index` is off when the options do not set it (product.json sets it): a direct call with other
  options keeps the plan of milestone 1, and a deployment without the agile platform can switch the index off.

## Limits

- Manual text under a command is always `behaviour` (decided): code cannot tell a definitional sentence from a behavioural
  one; a later typed judgment could refine it.
- `OTHER_FORMS` was derived from one sampled command tree; a help text that says "or" between two addresses also reads
  the argument as a string (no false refutation, a lost type check). Declared `argumentTypes` are the authoritative path;
  none are authored here, because the samples may not be copied into the repository.
- No real hub page was sampled (the brief describes them); the hub fixture follows the index page's link style. What
  `famx_trunk` and the `famx_10_x_*` pages hold is unknown: their content decides when they are read.
- "Latest released" is by release date: a sub-build released after a newer build of the same line wins; the alternatives
  show the others.
- Markdown anchors with other source defects (a stray escaped underscore, text after the parameters) are not anchors.
- The command literals of a manual are a heuristic over the author's marks: a quoted English word that is no command is
  recorded too and then shows up in the drift candidates; what is a command is decided when a literal is resolved at
  read time.
- Only pipe tables split by row; a grid, multiline or simple table stays one block at its section node.
- Chapter-opening fields inherit independently. Same-section title/paragraph disagreement leaves that field undeclared,
  retains both values and verified source fragments, and marks conflict without adjudication or outer fallback.
  Inner scope takes priority over outer scope, with the difference reported. Provenance stays in composition metadata,
  outside entry content: heading edits alone do not change inherited entry digests.
- The producer is still tied to markdown@1: the fragment parser key, the anchor and literal inline syntax (`**…**`,
  backticks, `*\<param\>*`), the pipe-table row split, the `h/` selector decoding and the block kinds are Markdown's;
  only the section placement reads the neutral block path. The task asks for dependence on a document model with
  section paths alone, and that is what the options give: `fragmentParser` names the input model's parser key and
  `sectionSelector` renders a section path as that model's selector (defaults: markdown@1 and h/). A model whose
  sections are cited another way (text@1 l/<a>-<b> line ranges) can instead carry its own decoded `path` array per
  section: the producer uses it as-is and never decodes h/ then. `sectionSelector` cannot turn a section path into a
  line range — an adoc model supplies either its own `path` arrays or selectors it can build from a path. The adoc
  producer needs no change here for placement; only the markdown@1 h/ decoding stays the default.
  The adoc producer (K4 step two) still takes the other route its page allows: its mapping produces a markdown@1-shaped
  model and `adoc/entries.ts` rewrites K1's fragments into text@1 references of the chapter files; moving it onto these
  options is a follow-up for the wiring step.
- adoc: the locator's folded comparison (`text.ts plainText`) inverts what the engine does to inline markup, character
  references, inline macros and typographic replacements, and nothing else. A list item, description-list item or table
  cell whose inline conversion the fold cannot invert — a menu path, a key cap, a footnote number, a cell carrying a span
  marker (`2+|`) — is reported and cited on no line; the same words in a paragraph verify exactly, because a paragraph
  keeps its source text. How often real manuals hit this is unknown until the integrator's adoc-versus-markdown
  comparison runs.
- adoc: what cannot be cited is not placed. A block, a table row or a heading line with no verified source line stays out
  of the mapped model and is reported (`uncited`, `unparsed` and the production warnings) instead of reaching K1 without
  a citation, which K1 would skip as malformed: the words are then not in the knowledge, and the report is the only
  record. Nothing is placed on a line that was not read back.
- adoc: the mapped model's `line` and `lines` are the source line numbers of the file a block cites, not indices in one
  document-wide line list as in markdown@1: a group has many files. K1 reads neither field; the citations carry the file
  digest with the line selector.
- adoc: a table the engine reads without a head row gets an empty header line, which is a produced line and cites the
  table's own range (the merged range of its verified cells) — the only fragment of this producer that cites a range no
  single row was verified on.
- Release notes were not sampled: the structure is the one described in the task, so the heading and column patterns may
  need additions once real notes are read.
- Platform tokens of build names (`SY-K`) and of page names (`sy_k`, `sz_demoos10`) are kept as written; they are not
  mapped onto each other.
- The functions were also run, outside the repository, on the read-only samples of 2026-10-21 (the index and a listing
  page, a command tree, the CLI manual and its catalog, agile titles and labels); nothing from them is in Git. The case
  index functions were not run on real documents yet (the integrator's `scripts/real/`).
- Case index: a case with no resolvable command is still an entry, with an empty path. A command is a whole statement of
  the locked tree, exact words and declared arguments. An abbreviation or a prefix is not a command, and a statement
  whose first word is not a catalog word is not a command.
- Case index: facet and index views count entries hung on the tree and the unplaced rows of the root. An entry with an
  empty path stays under the root, marked unplaced, and is cited there (`tree:<root>/@<digest>`). An entry counts once;
  one that also hangs on a command keeps that path. The facet total includes the unplaced entries and says how many; the
  index notes say the same. A quality board and a traceability matrix built on those views see every case and every
  defect entry. Impact is unchanged: regression scope looks at entries under command nodes, and an unplaced entry is on
  no change path.
- Case index: the case-document list is optional. An optional list's skipped share is 1, so unreadable case documents are
  reported in `skipped` and do not drop the command tree. The required-list share stays 0.5. The gate lives in
  hub/knowledge/produce.ts; hub/knowledge/lists.ts does not decide it.
- Case index: which line is not later than a build's line is the earliest release-train month of that line in the agile
  tree (`YYYY/M` in the train label), not the numeric order of the dotted line. Brief section 8: 10.6.145 and 10.6.146 are
  newer lines than 10.6.150. A line with no dated train is listed only on a build of that same line. `min_line` is the same
  date floor when the tree dates that line. `compareLines` still sorts build names for display, and it is the comparison
  used only while the tree is unread (there is no train date then) to decide which builds wait. The synthetic corpus uses
  the dotted labels of that scenario so the default `min_line` is exercised; in that corpus the train months follow the
  dotted order, which is not a lineage claim.
- Case index: while `agile:tree:roots` is missing, unreadable or incomplete, builds that would list case documents are
  left off the plan. The plan note says so (`这次不列构建`). `SyncPlanOutput` has no error field, and the knowledge sync
  copies the note and leaves `report.error` null. A monitor that watches only `report.error` or `counts.failed` does not
  see the withhold. Putting it on the report needs a contracts field and a change in hub/knowledge/sync.ts, which this
  task does not include. Builds of a line before `min_line` (dotted, while the tree is unread) are still listed: their
  case list is empty whatever the tree says.
- Case index: sorting the case-document ids does not preserve the Hub's batches. A stored list call is keyed by the whole
  build, list included, so any list change re-runs every batch of that build. Keying those memos without the list roles
  is a knowledge change this task does not make. Over the cap, the oldest train dates are left out first.
- Case index: a renamed folder changes `module`/`line` of a build's cases only when the build is produced again (its list
  changed, or `knowledge sync --recheck`, which re-reads `agile:tree:roots` and produces every build whose tree digest
  changed).
- Case index: a build of a line before `min_line` lists an empty `case_documents` (the producer runs once and says so).
  The case index reads `agile:case:<id>` (the case document, no nested subtree). `agile:mindmap` stays for reviews; the
  case producer does not ask for it. The roots read asks for listing pages up to the round budget (about 17, cap 50), so
  a configured root listed after page 10 is titled when the budget reaches its page. Empty folders are `listed: false`
  and are not case documents. That behavior was already in `functions/agile.ts`. The saved 1.1.1 manifest did not match
  those bytes, so the integrated pack is signed as 1.3.0 and does not change the read.

## How to test

```
node --test "packs/product/famx/**/*.test.ts"
node --test packs/workflow/case-review-verify/end-to-end.test.ts   # the sync through the real connectors and knowledge
npx tsc --noEmit
```

Case index tests (fixtures in `tests/fixtures/case-index`: the hand-written command table, two invented command trees whose
difference is known, a synthetic agile platform with the product's two roots and another product's root, 300 mind maps and
the truth of every document and case, built while the corpus is built): `cases-commands.test.ts` (every table row against
both trees, whole-statement grammar, one scan equal to scans of each text, linear on long hostile text),
`cases-nodes.test.ts` (every case of the corpus with its contents; parity with the case-review projection under the marked
rule on the review, template, untagged, outline and tiny maps, the 3,000-node map and every corpus document; cycles,
shared children, invalid indices, depth), `cases-rules.test.ts` (negative tags equal to case-review's on 2,000 spellings,
the agile ids, the list limit, vague phrases), `cases-sync.test.ts` (options, product roots, the located documents and the
reasons, each build's list equal to the truth for the dated lines and another `min_line`, an added document keeps the
ids before it, pending, failed and incomplete trees, the plan reading the tree once in round 1 without an extra round,
own-tree builds listing their documents and aliases nothing, no build while the tree is unreadable or incomplete, lines
ordered by release-train date, a line no build covers, hostile input), `cases.test.ts` (every entry of a 10.6.1 and a
10.6.146 build equal to the truth in the Hub's own batches (`listBatches`), the later tree, counts by reason and at most 20
examples; another document id changes only the key, a renamed tree label changes nothing, reversed cases change nothing,
a document twice or listed twice doubles nothing, a document alone gives its entries of the batch; a short batch keeps
every document that carries `external` and does not guess the rest; a case with no command and a case with no command
tree still produce an empty-path entry; a case id copied onto an expected-result leaf; hostile input; one batch at scale;
the sandbox) and
`cases-integration.test.ts` was removed with the case-index declaration (the owner's 10-24 revision: cases are fed per
use by Circle, not batch-produced; see `docs/hub-r4-tasks/kb-seedling.md`).

`functions/adapters.test.ts` tests the product.json entry points against the product@1 shapes (good, malformed and hostile
input); `functions/sandbox.test.ts` and the adapters' sandbox suite run them in the Hub sandbox (skipped where sandbox-exec is
unavailable). Fixtures in `testing/fixtures/` are synthetic (invented names, numbers and texts; addresses in 192.0.2.0/24).
The end-to-end test publishes this pack in the real registry, syncs it from `testing/site.ts` through the build-site system
pack and reviews a mind map against the root it produced.

## Needs from other packages

- **adoc 接线已完成**：每族有独立的手册生产器与变量引用。同步先读根目录固定修订号，再用 `svn:directory-at` 按该修订号递归列子目录，绑定完整目录清单和全部章文件。每族属性的来历由 Hub 组成记录的 `variables` 写；生产器只接收解析后的属性。原件缺失、不同修订号、摘要不符、非 UTF-8 或展开失败均不能换成空手册，合成同步测试已核对失败时旧根不动。
- **K1 (adoc)**: chapter text, applicability and verified citations still reuse K1. Definition admission is now separate:
  the engine paragraph/inline tree is checked before placement, and opaque chapter/table content cannot create a K1
  anchor. Split paragraphs do not invent signature boundaries; a recognized whole paragraph keeps all of its verified source ranges,
  emits a definition once and never assigns a whole-paragraph mention to an uncited part; this package does not modify `manual.ts`.
- **integrator (adoc, examples)**: the shared relation interface is verified with the real evaluator: example literals
  remain in `data.reference` and are absent from the declared top-level relation fields, while the same-shaped literal
  in real prose still yields a link or drift result. This does not depend on a consumer recognizing the reference flag.
  Read-time views, reviews and regression checks that interpret original prose must still filter `data.reference_only`
  entries before judging behaviour or counting mentions. No general consumer filtering is claimed by this pack.
- **knowledge (adoc)**: the mapping's report must not stay an object only a test can see. When the producer is wired,
  `uncited` (a block or a table row that cites no source line), `unparsed` (a line declared a signature that reads as
  none), the misaligned-table lines and the unverified-heading lines have to reach the knowledge sync's result for the
  root they belong to: readable per root, with file, line, reason and next action, and counted with the unplaced entries
  (the counts a facet or index view already gives), so an operator sees how much of a manual did not become knowledge and
  why. Today `toK1Model` returns them and the producer copies them into `ProducerOutput.warnings`, which is capped and is
  a text line, not a count; carrying them as records needs a field in the production result (`contracts` and
  `hub/knowledge`), which this package cannot add.
- **contracts**: a parameter type for "IPv4 or IPv6 address" and one for "dotted mask or prefix length" (or a union of types
  in `CatalogParam`) would replace the overload expansion.
- **knowledge**: the Hub calls no model (decision 15): `path: null` entries and `unplaced` spans stay unplaced at the
  root (the fixed-bug entries of a build, for example). The manual producer's markdown path no longer emits unplaced
  spans; no output of the manual producer waits for placement proposals in production: the markdown path places
  every block, and catalog spans never reach a production (the catalog JSON is reachable only through direct calls).
  Read-time literal relations now use `product.json.links`, frozen in the selected composition. Production warnings and
  the read-time view call the same generic evaluator. Drift remains a fact, not a manual-erratum or defect judgment.
  Review and regression-scope consumption is the separately authorized second step.
- **integrator**: a review that targets an unreleased build (the newest build of a line still in development, under either
  name) needs the sync with `includeUnreleased` for that line, or a released build named at start_run.
- **knowledge (case index)**: `external` is on the list element and the producer matches documents by it. The slot still
  has no parsed `meta`, so `folders` stays. Facet and index views count entries with an empty path (unplaced, cited at
  the root, once) and say how many; impact still counts the entries on a path. List-call memos are still keyed by
  the whole build, so a changed case list re-runs every batch; keying them without the list roles would restore reuse
  now that the producer does not need the list to name a document. The composition still keeps the first 200 warnings.
- **case-review** (case index): a table of vague expected phrases (the task's "vague phrases of the case-review tables"
  do not exist); until then `VAGUE_EXPECTED` here is the list, and a test can compare both once the table exists.
- **knowledge** (case index): the per-batch disclosure lines of the cases producer are warnings of the composition, of
  which the first 200 are kept; a build of more than about 190 batches (7,600 documents) loses the later lines (the
  facet view still counts every indexed case). A per-producer sum of counts in the production result would keep them.
- **integrator**: the first sync with this version re-produces every own-tree build (their sources gain `case_documents`
  and `case_tree`) and needs the agile platform resource (`settings.roots` with the product's two roots); without it the
  sync lists no build until the resource is configured or `case_index` is set false. Run `packs/workflow/case-review-
  verify/end-to-end.test.ts` and `packs/workflow/case-review/packs.test.ts` (not run here, they belong to other owners):
  the bed's agile resource has no product root (its roots are the shared fixtures' ORBIT/COMET), so its famx builds get an
  empty case list and the review is unchanged.

Done since the earlier round: the adapters to the product@1 shapes, the build-site external ids and source roles, the
catalog producer selector (`CatalogDeclaration.producer`), the entry-kind axis (K02 R[3]).

## Literal links (1.3.0)

`product.json.links` freezes two rules in each composition. Both use `definition` targets in `/commands`,
`source_producers` set to [`manual`] and `target_producers` set to [`command-tree`]: only `manual` emits relation sources, and only
`command-tree` definitions establish eligible targets. Both normalize literal words and target path segments with
`lowercase`, `strip_nul` and `nfc` (NFC). White-space tokenization is fixed.

- `manual-literals` reads `command_literals` with `longest_prefix`: the longest eligible leading path is the target;
  the remaining words are parameters retained as written. Intermediate nodes without an eligible definition do not count.
- `manual-signatures` reads `signature_literals` via `alternatives_field` and `exact`: an exact primary definition wins;
  otherwise each positive expanded alternative is checked exactly. Leading optional no-forms are not positive variants.

A missing namespace or a namespace without any eligible target produces a rule diagnostic and unchecked candidate counts,
with the missing source and reproduction action; it produces no drift facts. With usable targets, an unresolved literal is
a drift fact in that composition, never a judgment about a manual correction or product defect. Production diagnostics and
read-time views invoke the same evaluator and frozen declarations.

All distinct literals are retained, including more than 100 in one block. The existing core statement/data byte limits still
reject an oversized entry. View paging limits detail only, retaining complete totals. The minor release changes the product
profile and producer bytes, so the pack is 1.3.0 and is re-signed, not published by this task.

`functions/manual-links.test.ts` covers ordinary trailing values and all 150 missing literals of one paragraph against real
synthetic production and the paged view. No live resource, client or model is used.


The model-10/K1 merge retains explicit section paths, bounded condition parsing, complete signature cells, command-column
classification and current-parameter/value-row state. K1's standalone drift accumulator and its 100-literal cap stay retired:
signature groups use the declared exact primary/alternatives rule, other cells retain prose mentions, and Hub production and
reading share one evaluator. The c3 row regressions now check that evaluator and all 105 retained signature groups instead
of depending on a truncated field or a producer-local warning.

View-scope: build timestamps also accept time followed by a slash date. A timestamp that cannot be parsed is a determined
listing failure, with its build name and a repair instruction; the sync plan excludes it from successful builds.
Catalog address roles, hostname types and unchecked constraints now use the merged contract. Unrecognized limit syntax is retained with missing semantics and an author recovery action; it never creates a guessed restriction.

未打有效标签的用例在 data.tags_note 和陈述中写明“正负向和测试类型未声明”；negative 仍是 null，
不能据此推断正向或任何测试类型。空白标签与未打标签相同。

用例命令归位把标题、上级节点、步骤、预期文本送进同一个命令解析器。没有任何目录命中时明确计数
“没引用目录里的任何命令”，保留可引用的未归位条目；bot 可经 placement_proposal 提议，Hub 核验。

The command-tree follow-up is signed as 1.3.2. Its limit policy follows the owner's read-only survey and does not assign
semantics to spellings absent from that evidence. Diagnostic parameters remain machine-readable through knowledge
production and catalog matching; the next action is for the pack author to document the grammar here and reproduce.

`manual-mentions` reads `command_mentions` with `exact`, `definition`, `unmatched: mention`.
It uses the same `source_producers` (`manual-famx`, `manual-famy`) and `target_producers` (`command-tree`);
`lowercase`, `strip_nul` and `nfc` are all false. Unequal mentions remain mentions and never drift.

## 适用条件闭集（kb-applicability）

`FAMX_COMPONENTS`、`FAMX_LICENSES`、`FAMX_DEPLOYMENT_FORMS` 是部署变量，三者均声明为字符串列表，
样例／试运行默认值均为空列表。真实生产前须分别 `circle-hub var set <名字> --file <JSON文件> --reason <理由>`；
确实没有值时显式设 `[]`。生产器只接解析后的 params，变量决定由核心冻结进组成记录；仓库不带真实闭集。

支持的窄写法：部件用“装有 X 时”“没有 X 时”（可带“部件”）；许可用“需要 X 许可”；
三个闭集均可用“适用于 X”“仅 X 支持”，可带对应字段名。名称逐字比较，不补同义词或大小写别名；
并列列表的每一项都须在同一闭集中，且只能确定一个字段。否定、例外、部分、可能、也等扩泛写法不抽，
整组留在原文；未知成员不截成已知前缀。单个条件组读取上限 200 字符，超出的不作猜测。
部件缺席只在明确“没有 X 时”中记录 without。空闭集不会为该字段产生条件。

内存只读紧挨“内存”的明写数值与关系：不少于／至少／以上含下端点，大于不含；不超过／以下含上端点，小于不含。
“N G 内存的设备”是两端相等且都包含端点。GB、G 按 1024³ 字节，MB、M 按 1024² 字节；
普通十进制小数只有在能精确换成安全整数个字节时才记录，不四舍五入。不读模糊大小、约数、指数、其他单位和不安全数值。
原文写法单独保存为 raw，不含无关的章节标题；读取字段不声称目标已经满足它。或分支、例外和不一致的多个范围不合成条件。

章节条件的来历按字段绑定到原片段和章节路径，存在组成记录的 `applicability_sources`，不参与条目摘要。
同章标题与首段矛盾时不裁决，也不回退外层；字段按未声明显示，双方声明与片段保留，并标记冲突。
显式但无法结构化的章节条件同样阻止该字段向外回退，原文仍可回读。

生产结果的 warnings 沿用知识同步报告通道：七个字段逐一报告直接抽取条目数和继承条目数（含零），
签名、正文、拆分表格行分别按实际条目计数。内外层不同和同章冲突逐处列出字段、章节、声明值及源选择器，
包内不截断这些明细；核心同步报告仍有保留条数和每条 1000 字符上限，完整字段来源及冲突双方以组成记录为准。冲突写明来源维护者在再次同步前核对原片段、修订或保留矛盾再生产。
这里的计数只证明合成输入下的规则行为，不证明目标上的部件、内存、许可或部署形态已满足条件。

适用条件扩展初版为 1.4.0，未发布。新变量启用前须显式设置三个闭集（允许 []）。

adoc 的条目适配器 `functions/adoc/entries.ts` 转交三个闭集选项及字段来历，并以合成展开模型核验。
名称族部署接线已合入；`familyManual` 传入解析后的闭集，不能以未传参的空集代替显式部署设置。
include 展开、AST 和源读取没有改动。

## 部署约定与变量（决定 44）

真实取值属于部署数据，不进包、不进 Git。由集成者在这一版发布以后、启用以前，用 `circle-hub var set <名字> --file <Git外暂存文件> --reason <理由>` 显式设置。变量默认值仅供发布样例和试运行；真实同步的任一引用未设置，会在读任何页之前确定拒绝，并给出逐名设置命令。即使决定不设下限或不用 adoc，也必须显式设置对应的 null。

| 名字 | 类型与合成默认值 | 部署含义 |
| --- | --- | --- |
| `FAMX_MIN_LINE` | 字符串或 null，默认 null | 用例清单的发布火车下限；不设下限就显式设 null |
| `FAMX_MAINLINE_PAGE_WORDS` | 字符串列表，默认 `[]` | 版本号后仍算主线页的附加词；真实词由集成者从源只读核对 |
| `FAMX_ADOC_ROOT` | 含 `{line}` 或 `{line_dir}` 的相对 SVN 目录模板或 null，默认 null | FAMX 的来源选择 |
| `FAMX_ADOC_MAIN` | 字符串，合成默认 `book.adoc` | CLI 主文件相对上述目录的路径 |
| `FAMX_ADOC_APP_MAIN` | 字符串，合成默认 `app.adoc` | APP 主文件相对上述目录的路径 |
| `FAMY_ADOC_ROOT` | 含 `{line}` 或 `{line_dir}` 的相对 SVN 目录模板或 null，默认 null | FAMY 的来源选择 |
| `FAMY_ADOC_MAIN` | 字符串，合成默认 `book.adoc` | CLI 主文件相对上述目录的路径 |
| `FAMY_ADOC_APP_MAIN` | 字符串，合成默认 `app.adoc` | APP 主文件相对上述目录的路径 |
| `FAMX_ADOC_ATTRIBUTES_FAMX` | 属性名到字符串或布尔的对象，默认 `{}` | FAMX 本族属性集；空集也要显式设置 |
| `FAMX_ADOC_ATTRIBUTES_FAMY` | 属性名到字符串或布尔的对象，默认 `{}` | FAMY 本族属性集；不从另一族借用 |

ROOT 的三种情形：

- 未设置：真实同步在读任何页之前拒绝；请管理员按回执运行 `circle-hub var set <族>_ADOC_ROOT --file <JSON文件> --reason <理由>` 后重跑。
- 显式 null：这一族继续现有 Markdown 读法；MAIN 和属性变量仍按声明显式设置，不把 null 当成“尚未设置”。
- 字符串模板：先固定 SVN 根目录修订号，所有子目录和章文件都用同一个版本根；任何读取、身份、完整性、UTF-8 或展开失败均保留旧根，绝不退回 Markdown 或当成没有 adoc。

同一组最多 5 层子目录、32 个目录、128 个 adoc 文件、512 个目录成员；生产器的一批容纳完整目录清单和文件（上限 200 个来源），不拆分一个文件组。超限整份拒绝，请管理员核对范围和预算后重跑，不截断。SVN 依赖 1.1.0 的 `svn:directory-at`；文本模型需保留可往返的 UTF-8 原件，包先核对字节摘要再展开，既有函数输入序列化预算照常执行。

每族独立生产器只引用本族 ROOT、CLI MAIN、APP MAIN 和属性变量。改一族属性时，Hub 重核组成记录，输入不变的另一族生产调用复用；合成测试核对了另一族条目摘要不变。ROOT 模板改变会改变传给函数的来源清单和构建输入，按完整输入重核，不猜函数内分支。

属性来源由 Hub 组成记录的 `variables` 固定；生产器不自己宣称“从部署取得”。试运行不写知识结果，读取仍留审计。合成默认值和上述测试都不构成真实手册验收，真实属性、目录、主文件和主线词由集成者核对并写部署数据。

1.4.1 把部署约定和按族 adoc 接线带入包声明（此后包版本以 `pack.json` 为准）。发布前运行 `node packs/product/famx/api.ts sign`，再运行 `node packs/product/famx/api.ts check` 核对清单。

在 Literal links 的生产器范围中，`source_producers` 为 `manual-famx` 与 `manual-famy`，`target_producers` 仍为 `command-tree`；两族共用同一套关系规则和规范化器。

被内层取代的外层声明也保留在组成记录的 `applicability_sources`，标 `superseded: true`。
它们仍带原值和核验后的片段；读时不把它们当作生效字段、继承路径或当前冲突。
因此同步 warning 被条数或长度预算截断后，内外层来源仍可经组成记录回查。

首轮复核合并主线的名称族部署接线后，包升至 1.4.2 并重签。`familyManual` 从解析后的 params
把 components、licenses、deployment_forms 透传给条目适配器，Markdown 和 adoc 两路使用同一组部署闭集；
两个名称族均有合成输入覆盖，没有改 include、AST 或源读取。

合并 view-scope 与主线后为 1.4.3：保留部署变量、按名称族 adoc、适用条件闭集，以及构建时间失败诊断和未打标签说明；按合并后的原字节重签。

1.4.4 起，发布说明的 `fixed` / `known` 只认章节或块上声明的 `status`，表的缺陷号、模块、正文和序号只认块上声明的列号。标题和表头文字不再决定状态或列。没有 `status` 时不产出缺陷条目，并写明缺的事实和下一步。清单和段落里的缺陷号仍经 `idsFromTitle` 读取，这一处不在本版范围内。


## Command grammar

关键词整改 R4（所有者 2026-10-24；模型 C07 R[7–8]、W05；模型前置 1cb6562d）。本包声明支持的命令树输入为 `famx-command-tree@2`，出处是本节和随本包发布的 `functions/command-tree.ts`。这是版本化的产品语法声明，不是声称所有历史原件都符合；不符合的原件须补证或修订，不容错当作完整目录。

- 容器是未经修复的 `xml@1`：根 `commands`，`scope` 重置菜单路径，`menu[name]` 与 `item[name]` 给出完整词；`item/arguments/arg` 给出按位置排列的重载参数。任何 `irregular` 或 NUL 修复拒绝。XML 属性已经解码，不再二次实体解码。
- 词以 ASCII SP/HT 分隔，字符及大小写完全相等；命令行以 CR/LF 分隔，节点之间不拼词。单/双引号只界定参数值，允许转义同一引号或反斜杠，不允许换行或 NUL 藏在引号中。散文、编号、提示符、全角写法不擦除、不折叠，不扫描最长匹配。`no`/`clear` 只有树中存在完整路径才成立。参数中的另一条命令只是参数。
- 类型只按原始 `type` 精确字段和本包的 `ARGUMENT_TYPES` 定义：STRING/XSTRING 为字符串；U16/U32 为对应无符号范围；DOTTEDIP 为 IPv4；IPADDR 为 IPv4/IPv6；IPMASK 为连续点分掩码或 0–128 前缀；HOSTNAME/IP_OR_HOSTNAME 为 contracts 的对应显式类型。help 只保留说明，不能改变类型。所有重载完整消费所有参数；展开或数量上限不转 STRING，给缺口与重产出口。
- `optional` 精确值为 `YES` 或 `NO`，省略按本语法的 `NO`；空串、大小写变体、yes/y/true/1 等不是别名。未知值是结构违规，不能默认必填。未声明或没有定义的 type 保留原参数位置，不填占位类型；状态取生成的 `type_declaration_status.undeclared`、`command_parse_status.parameters_unchecked`，补证约束交通用检查返回现有 unknown/missing_input。
- 类型覆盖只按精确 schema=`famx-command-argument-types@1`、origin=`product:famx/README.md#command-grammar` 的发布声明中的原样 command + position；字段不做 trim、大小写或同义归并，不能从 help 推。没有这种来源授权不得做覆盖。limit 只解释本语法声明的完整含端点 `[low - high]`，以及 STRING 上完整 `{value|value}` 的精确成员集（不许空项、重复、嵌套或隐式转义）；未声明约束语法保留未核对，不判已满足。
- 直接 commands 函数必须收到完整 definitions（words/signatures）；旧 heads 单独不足以证明命令。标题、祖先、步骤及期望用同一个完整解析器，结果路径去重并稳定排序。

手册结构语法为 `famx-manual-signature@2`：完整单行 `**head** *<required> [optional]*` 是候选结构；只有全部精确 head/variant 及参数位置和 optional 结构对上锁定树才产生命令定义。格式本身不证明命令。表的签名列必须是精确机器列标识 `command_signature@2`，不能凭“命令/Command”等自然语言表头或连接词猜列角色。普通代码块每行完整过树后可产生 canonical 命令引用，并保留原始 command_lines；散文强调/引号不抽命令。JSON 过渡输入目前只直接调用可达：head_tokens 是精确身份，params.required 必须是显式布尔；数字或非英文不使签名变示例，例子不找最长前缀。没有锁定树时只保留章节原文和补树出口。AsciiDoc AST 只映射候选结构，语言、粗体和单词外形不能决定命令身份。

新 FAMX 包 1.5.0 接续基线 1.4.3。旧包生产的根和运行保留，不改原字节；受影响字段为命令定义的 signatures、用例 commands/归位路径、手册 signature_literals/command_literals 及相应回归/巡检计数。旧结果须附生成词表的 `legacy_keyword_rules` 限定；这不是删改原结果。新规则须另产根和运行，并引用旧生产记录的血缘；真实重产和旧结果限定的管理员操作由集成者另行安排，本次仅合成验证，不执行真实迁移。1.5.0 的组成按新包摘要及 grammar 身份区分。

## Product-wide specifications

`spec_index: true` reads `manual:spec-list:configured`. Only files whose filename or WebDAV display title contains a declared product name (NFKC, case-insensitive, ASCII letter boundaries) enter `scope.spec_documents`; other members are counted as 不属于这条产品线 and remain addressable at their original reference. Missing/incomplete directory observations withhold the whole scope so an existing root cannot lose its specifications.

The `specifications` producer runs only with `unversioned: true`. Supported Markdown sections use the existing K1 producer, under `/spec/<resource-relative document path encoded as one segment>/<section path>`, without a command tree. It retains source literals and K02 applicability extraction/inheritance; `data.document_lines` preserves the written version tokens for information only and declares no build. `displayname` is the listing title when WebDAV supplies it; no title is guessed from a filename. Sources in other formats refuse with a conversion/reproduction action.

## Product-wide case documents (step 2)

The complete agile tree now retains every readable no-line identity, beyond the three examples named in a note. After the complete build listing is read, documents covered by no selected build with its own command tree enter `scope.unversioned_case_documents`, together with `case_tree`. A missing or failed build index/listing is not evidence of no coverage: the product-wide root is withheld until those sources are repaired and sync runs again. A failed specification listing or case tree also withholds the scope; existing pointers remain. Earlier-than-min_line documents, unreadable identifiers and empty folders remain excluded under the previous rules and are counted separately. Notes put scope/exclusion counts before detail that can be clipped.

The `unversioned-cases` and `specifications` declarations were removed from `product.json` on the owner's 10-24 revision (see `docs/hub-r4-tasks/kb-seedling.md`): cases, defects and specifications are no longer batch-produced into per-build or product-wide roots; Circle feeds them per use, and the functions (`cases.ts`, `specifications.ts`, `fixed-bugs.ts`) stay for that projection. Existing per-build roots are neither deleted nor extended by this change.

Needs: matching these preserved phrases against a reader version root requires a separately authorized kb-links declaration/consumer; this step does not claim command coverage from unresolved phrases. `product/` and `qa/` are not added to specification folders; the integrator supplies any later deployment list.

This step raises FAMX from 1.4.2 to 1.4.3, manual-store from 1.0.3 to 1.0.4 and OpenKM from 1.0.2 to 1.0.3, and re-signs all three manifests.

两条支线各自把 FAMX 记为 1.4.3 而内容不同（view-scope 一侧的构建时间失败诊断与未打标签说明，这一侧的产品级规格与未覆盖用例），合并后 FAMX 升为 1.4.4，按合并后的原字节重签（`node packs/product/famx/api.ts sign`）；manual-store 1.0.4 与 OpenKM 1.0.3 两侧不冲突，取较新的一版。

Complete zero selections emit source inventory proofs: specifications cite the bound directory files/complete fields; uncovered cases cite the bound tree documents/complete fields. The core independently verifies both before accepting an empty product-wide root. The composition stores each observed list total and selected=0; sync and reads say “不分版本的根为空（清单完整，规格 0 份、未覆盖用例 0 份）”. An empty selection can clear previously populated scope content; unread/incomplete inventories cannot do so. Specification filenames are percent-encoded when made into external references and decoded for document metadata, so an authored @ never becomes revision syntax.

标签按 resource-tags@1 的精确原文闭集读取，保留 resource 原值。闭集外是提示档结构违规“未声明的标签”；大小写、全半角与同义词不相等。非法声明不进入正反向比例分母。此版本替代旧关键词规则，历史结果不改写；应以新包重产新根与新运行。本次续接按所有者指令未运行验证。

R6（所有者 2026-10-24）：声明 famx-directory@1，产品根精确等于产品 names 成员；版本层为三位字母数字码（至少一位数字）、冒号、完整 dotted version，下一层为同版本加列车后缀，再下一层为非空单目录段模块（允许“测试/bug/回归”等字面内容）。不从正文版本或活动词推断层级。缺层、重名或语法外写明缺失身份，下一步由包作者补语法或作者调整目录后重产。famx-id-fields@1 只接受整字段 bug:编号列表 或 story:编号列表（逗号分隔非零十进制），不从标题散文抽取；未声明须作者补字段或模型逐字引用。famx-assets@1 只按整名认资产角色，出处是本 README 记下的列表页真实命名：`command_tree-<构建名>.xml`（命令树）、`Bugs_Fixed_with_<构建名>.html`（修复缺陷）、`<前缀>-MIB[_<语言>]-<构建名>.txt|mib|my`（MIB）、`<前缀>-<构建名>.array|click|img|iso|qcow2|ova|bin|tgz|tar.gz`（镜像）；`<构建名>` 是产品命名语法里的一个完整构建名（`Rel|Beta` + 统一分隔符 + 名称族 + 可选平台段 + 数字组），不必是本条目自己的名字——变体构建的条目本身就以其镜像文件名命名，链接不含本条目构建名时另按位置归类并警告。不按子串、词或单独的扩展名认角色；语法读不出的文件名保留原链接、记“资产角色未核对”并给出出口（包作者补资产语法或作者声明角色后重读）。版本线前导零与末尾 .0 按 U24 同线，构建 id 不变。页面只认完整声明的 mainline/platform、patch数字 或 customer_标识结构；无兜底客户类。旧关键词结果原样保留，新包重产新根并沿原运行建立血缘。本次未运行验证。

command_identities 绑定实际输入 XML 命令树的内容根摘要 tree_root 与 src:.../xml@1/... 签名原件；参数保留零基位置、结构化类型来源和解析值。data.commands 仅取这些完整身份的路径；没有输入树摘要、类型或唯一完整签名时不产身份，旧根须补类型后重产。标题、祖先或正文只按完整行作为候选，语法外不提取短语。本次续接未运行验证。

R3：含糊期望不再由词表或生产器布尔决定。case-review 逐用例提交全部期望叶子的逐字引文及判断，由 Hub 核验身份、路径和引文；不可读原件保持未知并补读。quality-board 仅接 Hub 绑定的同根、同原件、已受理且有效的 case-review 记录；重复回执去重，同原件相互冲突的判断单计冲突并留在未判断中，不挑最后一句。含糊率分母仅为已判断数；零分母显示未判断并补评审，不能显示 0% 或判阈值通过。资源类型比例另按精确声明分母计算。旧结果不改写，新版本须重产新根和评审后再开看板。本次续接未运行验证。

R7 新规则：发布状态只取 release-notes@2 JSON 的显式 product/build/defects[].bug/status/text，status 来自生成词表 release_status；complete 必须为 true，构建与冻结构建精确相等。HTML/Markdown 标题、文件角色及数字外形不再补 fixed/known，缺字段给来源维护人补原始 JSON 后重产。可选 version、released、module、system 只读声明，不从正文猜测。

查重规则 defect-to-case.case-structure@2：原用例作者在 KityMinder case 节点 data.case_structure 声明 {schema:"case-structure@2",commands:CommandIdentity[],expected:[{after,quote:ExpectedQuoteIdentity}]}，FAMX 原样保留并标作者声明。草稿给稳定 id，每步 identity，每个 expected 给 identity/after 和原文 quote。命令与期望的顺序及重复次数均保留，after 为从 1 起的命令位置；参数按显式位置排序及类型化 parsed 值比较，不补默认值，raw/role/标题/标签/正反向/优先级不作键。引用按原始摘要、parser、路径、byte span 完全相等。Hub 核验草稿引文 byte span 与完整原件字节；没有原件、类型来源、结构声明或完整索引范围时保持未知，并请求补声明/原件后以新根或新运行续做。非法负向命令没有合法完整身份时，不伪造身份：交包作者补非法输入身份合约或具名人工复核。

主张直接带 draft_id、requirement、rule_version、structure_key、duplicate_of 的 document/node/reference；计数只看这些字段，不读 statement。相同标题不表示结构重复。旧记录字节保留，新包重产后另留血缘；本次续接未运行验证。

## 结构声明与适用条件主张

作者声明只认 famx-applicability@1 的完整 JSON 代码块，scope.section 与原解析章节路径精确相等，descendants:true 明确授权机械继承；不按正文连词、否定词、单位话题或型号词触发条件。模型不进入生产器：在现有 knowledge-contribution 运行中以 code=applicability_claim 提交 data.applicability_claim={entry,field,value,section,evidence}，evidence 为共享 QuoteEvidence（原件摘要、parser/路径、原始 byte span 和逐字 text），source 与该引文一致。Hub 核对锁定根上的具体条目、冻结闭集、构建语法/已知名单、原始字节和章节位置，受理后保存独立判断记录，保留模型/运行/提交/原件身份，不改写原条目的作者条件。字段语义仍是判断，引文存在不证明语义正确。

FAMX_MODELS、FAMX_PLATFORMS 与已有 FAMX_COMPONENTS、FAMX_LICENSES、FAMX_DEPLOYMENT_FORMS 都是精确部署闭集；空闭集不放行任何成员，大小写、全半角、空白或同义词不映射。构建不增加变量，由原包构建名语法和根中冻结的已知构建记录共同核对；数组保持原声明次序，不从文字推连续区间。内存只接显式字节边界及 inclusive，raw 必须在原引文内，不读“至少/大约/例外”等关系词。

读取分开给 declaration_status 与 judgment_status。没有结构声明为 undeclared，没有已核主张为 unjudged，条件值 null 不代表无条件适用；旧条目声明出处未核时明确缺出处，不强填确定状态。分页或保留来源尚未核读完时判断状态保持未知，按 next/回注引用续读或由管理员恢复来源。相互冲突的作者字段和模型值都保留，不能挑有利值合并。主张只用于其受理时的相同组成与校验准则；上下文改变后按新组成重跑回注。

缺原包、闭集或保真范围时走具名管理员请求并带期限；结构声明报错保留 missing/next_action，不以空结果冒充完整生产。旧根和记录不改写；旧关键词规则受影响的适用字段需用新包重产新根、新模型运行并按原件和前驱保留血缘。本次续接未运行验证、测量或真实模型。

## 发布状态的局部缺口（1.6.2）

缺 release-notes@2 原始 status 不再作为整个构建的 producer incomplete。结构身份可核对的缺陷保留原文引用，status:null、declaration_status:undeclared，并带 missing/next_action；缺身份另记 identity_declaration_status:undeclared，不能从正文数字、标题、标记或文件名猜编号和 fixed/known。HTML 仅从解析后的明确 tracker URL 结构取身份，不从锚文本猜状态。

命令树、手册等独立来源仍照常成根；未声明条目不被追溯状态过滤静默删掉，依赖“已修复”的判断保持未知并请求来源维护者补结构状态后重产。缺陷转用例单列 fixed_status 要求项，其他检查继续独立核对。历史根不改写，本版验证只使用合成 JSON/HTML、临时 PostgreSQL 和脚本化模型，不重跑真实同步。

同步修复：设备显示别名在本轮构建保留集合确定后生成；被不完整结构元数据阻挡的基础构建不留下悬空别名。保留的未发布构建仍声明设备别名，以支持显式 includeUnreleased 同步。闭集命名语法保持原样，不从正文猜别名。


## Current adoc source structure

Owner task `adoc-structure`: implementation scope is `functions/adoc/**`, adoc declarations/variables in
`product.json`, this adoc documentation, related tests and the regenerated pack manifest. No vendor bytes or
`manual.ts` are changed. All validation sources are synthetic; no real manual group or deployment is read here.

`product.json` publishes `params.signature_structure` as `famx-adoc-signature-structure@1` for each family producer.
A definition candidate is an engine block of kind `paragraph` whose inline tree contains exactly one `strong`, or
one `strong`, an engine text whitespace node, and one `emphasis`, with no other content or nested markup. The adapter reads the
engine's inline serialization as a tree and corroborates its strong/emphasis/code nodes using the engine converter's
own typed inline callbacks and private per-parse identities. Observation identities are removed from every output;
quoted-node text is attribute-expanded by the engine, while its final typography remains separately recorded as
`rendered`. Document type follows the engine default or source declaration; no extra book-mode build flag is
invented. Identity checks do not fold rendered punctuation back into guessed command words. Passthrough HTML cannot
impersonate a strong node. It never recognizes a definition from
mapped Markdown, prose words, a chapter title, code formatting, a listing role or a table header.

The strong field is parsed using the command tree's lexer, with unquoted words and complete exact path comparison.
The declared `locked-tree-path-and-ascii-drift-slot@1` distinguishes proof from missing-path diagnosis: any complete
path explicitly declared in the locked tree is accepted, including non-Latin command words. An absent path is a drift
candidate only when every word belongs to the source signature's ASCII slot grammar: printable ASCII characters except
quote and group delimiters (`" ' { } [ ] < > |`); SP/HT separates words. Whole-word `{a|b}` variants
and optional `[no]` are expanded by a bounded grammar (64 variants). Every resulting word sequence must equal a complete
locked tree path, never a prefix. Existing paths receive definition entries with the original chapter-line citations.
A lexically valid missing path receives a `signature_drift` record with the missing complete alternatives and a repair
exit; known alternatives are retained independently. An unmatched field outside the declared drift-slot grammar, such as a Chinese bold heading, remains ordinary chapter
content and creates no drift; script alone is never command evidence, and a known non-Latin path is not excluded. Missing tree authority stays unknown and requests
rebinding, never an absence fact.

The one optional emphasis field follows the bracket/name parameter grammar: `<required>` and `[optional]`, bounded
nesting. Names are exact structured identifiers, including non-Latin names; no name-to-type heuristic or ASCII-name
restriction is applied. Name, position and required/optional flag are compared exactly to the locked tree's structured parameter
signatures; types and constraints must be declared there. `parameters_verified` records the mechanical result as a
boolean. A mismatch or missing type is retained with `missing`/`next_action` and a file/line warning, not inferred from
parameter names or descriptions. Native parameter declarations remain in `parameter_authorities`.

Body strong and code spans retain the engine quoted-node text as literals in `command_mentions`, including unknown strings.
Only exact complete path-word matches against the supplied locked tree enter `command_literals`; the existing read-time
relation evaluator repeats the exact `/commands` match in that immutable root. Unmatched mentions never enter a drift
field. Examples stay reference-only in `data.reference`. Table rows remain chapter content with their own verified line
citations and inline mentions; they do not define commands merely because their text is bold.

The pinned engine's incomplete-row recovery is observed at its table parser's `closeTable`, using its actual pending
cell objects and the identity of the ERROR that call emitted. No log-message keyword or regular expression classifies
an error. The engine keeps its own surviving rows; `report.dropped_table_cells` lists original file, line and count of
existing cells actually dropped (not the number of missing columns). Every other ERROR/FATAL
still fails the whole group. Per-book production warnings include the canonical full report: dropped cells, original
NUL counts, engine messages, branches and unverified origins; these facts remain visible in production records.

Each family compiles CLI and APP from the same complete pinned revision and the same family attribute declaration,
under `/manual/cli-<family>/...` and `/manual/app-<family>/...` on the same version line. `data.manual_name` also
preserves the book identity on command definitions and shared chapter content. Both main files are required
for configured adoc; absence of either refuses the group. The existing `<family>_ADOC_MAIN` is CLI;
`<family>_ADOC_APP_MAIN` is the second main-file variable. Configure each family map with the single brand attribute the source generation script actually passes; the adapter
does not infer a brand from attribute names or borrow another family map. An explicitly empty map stays empty and is
not proof that deployment matches the source script. `overseas` is optional, and the generation policy always uses `webfonts!` (JSON `webfonts: false`). No other family's
brand is added. Actual attribute names and file names are deployment facts supplied by the integrator, not guessed.

Directory substitution is explicit: `{line}` always preserves the supplied version line literally. `{line_dir}` accepts
one to three decimal components (at most nine digits each, including the pack naming grammar's canonical one-component line), applies the pack naming grammar `lineKey` to
leading zeroes and trailing zero components, then pads to three components and joins them with underscores: `10.8` and `0010.008.000` become `10_8_0`, and `10.8.2` becomes `10_8_2`. No prefix search, version guessing or implicit rewrite is
performed. Invalid or nonnumeric lines have a concrete correction exit.

Validation and expectation migration: the initial adoc suite had 95 tests, 24 failing. Old listing/monospace/table
signature assertions are retained as chapter/citation and non-definition checks under the current structure rule;
old prose applicability examples remain undeclared rather than being classified by words. Added synthetic cases cover
standalone signature spans, variants, raw mentions, Chinese bold headings, table recovery, separate CLI/APP books,
family flags, directory spelling and byte-identical repeated production. Historical capacity numbers above are not
performance evidence for this revision. Final synthetic validation: the 95 original adoc cases remain; 13 cases were added, for 108/108 passed and zero
failed/cancelled/skipped under concurrency 2. `npm run typecheck` passes. The forward pack version is 1.7.8, after
merging current hub-redesign before signing; its manifest and registry publish validation pass. This product declares
zero publication samples, so that check is not a sample correctness claim.

Supplementary unchanged product tests ran 43 cases: 42 passed and one existing formatting guard in
`packs/product/famx/variables.test.ts` failed. That guard demands one-line unrelated closed-set declarations; the untouched
base `db16a6a8` already stores those declarations across multiple lines. Their content and layout are unchanged in this
adoc-only task. No test is deleted, skipped or relaxed for that failure. Real manuals, real deployment values and real
systems have not been read or validated; the integrator supplies the actual brand flags and both main-file paths.

### famx-red-b 测试修复记录

三块生产接线测试按 R2/R4/R6 的精确结构规则更新；无锁定树、容错 XML 和正文许可都不能恢复旧推断。用例来源字节变化须重绑摘要与位置，完整条目比较逐条进行，避免失败时格式化巨型数组。命令树 optional 非法字段保留全部结构诊断，重复警告按字段汇总；见 [任务记录](../../../docs/hub-r4-tasks/famx-red-b.md)。

## famx-trunk-red 收尾

决定 60 的正文提及、结构命令和声明块条件已统一到生产、链接与合成集成测试。表格按原有单元格结构切分后逐项核对锁定树；Markdown 围栏不再当作命令；示例的提及归入 `reference`，不参与链接。原 adoc 记录中的闭集变量格式失败已修复。FAMX `1.7.23`：全包 632/632、类型检查通过，另链接及产品契约 45/45、生成物 131 文件一致。原因和旧期望的更正依据见[任务页](../../../docs/hub-r4-tasks/famx-trunk-red.md)。

## adoc 文件组的解析声明

`adoc_famx_files`、`adoc_famy_files` 的成员在产品输入声明中固定 `parser: text@1`。SVN 返回 `application/octet-stream` 时，Hub 按此声明解析并保留 text@1 的 NUL 计数；原件与读取清单仍记服务器原始媒体类型，生产报告注明差异。不按 `.adoc` 扩展名猜测，也不将通用 SVN 文件路由强制为文本。未声明来源继续按媒体类型选择解析器；声明无效时拒绝，不自动回退。FAMX 版本 1.7.25（发布版本补正），变更说明见[任务页](../../../docs/hub-r4-tasks/adoc-declared-text.md)。

文件组原有的子目录清单是辅助成员，也按 text@1 读取。只有父清单的结构字段明确指定该目录身份时，包才对其完整 UTF-8 JSON 原件做结构读取与摘要核对；正文不参与格式判断。子目录缺失、错误 JSON 或摘要不符仍拒绝整组，旧根不动。

## 冻结命令规则（command-policy@1）

产品声明 `/commands/show` 为只读观察范围。其余命令的逆操作按声明的树路径映射：`/commands/P` 对应 `/commands/no/P`，反向映射由更具体的 `/commands/no` 规则决定。两条命令都须在锁定树完整解析；不会通过去掉 no 认定一条原本不存在的命令。前导身份参数须由逆签名唯一确定，有歧义时产品作者须补显式 leading_parameters。规则随知识组成和运行冻结；没有可核验逆操作的计划不能放行。

### Unterminated delimited blocks

The pinned reader recovers a missing closing delimiter by consuming the rest of its current reader (a bounded container
or the expanded file stream). The adapter observes `readLinesUntil` with the actual terminator, engine context and
consumed cursor; it never classifies warning prose or inserts a closing delimiter. `report.unterminated_blocks` lists
each recovery as `{file, line, kind, delimiter, end_file, end_line}`: the opening source position and the inclusive end
actually consumed, mapped through include expansion to original files. A recovery can cross included files. Nested
readers are observed separately, and a closed inner block is not reported merely because another block was unclosed.

Blocks and their content retain the engine's kinds and normal processing: signature-looking text swallowed by a literal
block stays literal; example contents stay reference-only. No author intent or missing boundary is guessed. Engine
messages and NUL/table-cell diagnostics remain visible alongside these recovery records. A missing verifiable recovery
range or an unrelated ERROR/FATAL still refuses the group. Synthetic tests cover bounded and file-end recoveries, nested
blocks, cross-file source positions, unchanged failure severity, restored observation hooks and byte-identical reruns.

### Declared inverse enum alternatives

`command_policy.inverse_alternatives` declares exact pairs such as on/off and enable/disable. A pair applies only
to an enum at its parameter position in the command's matched signature, with both values in that enum's closed set.
The paired command must fully parse back to the same signature. Other parameter values, device identity and reverse
cleanup order stay fixed; valid quoting is read through the existing command grammar. Conflicting pair declarations,
multiple invertible parameters or a non-unique paired target remain unknown with an author repair action. They cannot
fall through to a guessed prefix inverse. Ordinary declared prefix rules remain available when no enum rule applies.
