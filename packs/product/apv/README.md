# packs/product/apv

The product pack of APV/NSAE: one product line with two names, product line `apv`, names `APV` and `NSAE` (`PRODUCT_LINE`
in `functions/naming.ts`). Model elements: K01 R[10], K02, K04, C03, C07, D01 R[8], W03 R[0] R[5], T01 F[8]. Product facts
live only here. Other packages use `api.ts` (types, named functions, and `FUNCTIONS`, the sandbox entry points).

## The pack

| File | Content |
| --- | --- |
| `product.json` | `product@1` (pack version 1.1.2): names `[APV, NSAE]`; `sync` (start `buildsite:listing:index`, plan `functions/sync.ts`, options `case_index: true`, `min_line: 10.4.2`, 6 rounds, 300 reads); `select_build` `functions/select.ts`; catalog `commands@1` (entry kind `definition`, producer `command-tree`, complete, case-insensitive; no catalog over case entries); producers `command-tree` (slot `tree` <- source role `tree`), `manual` (slots `cli` <- `manual:cli:{line}` and `app` <- `manual:app:{line}`, both optional; `placement: judgment_allowed`), `release-notes` (slot `notes` <- source role `fixed_bugs`, optional), `cases` (list slot `documents` <- role `case_documents`, many, batch 40, optional; `tree` <- role `tree`; `folders` <- role `case_tree`, optional) |
| `functions/sync.ts` | the plan (SyncPlanInput -> SyncPlanOutput): every round recomputed from the pages read so far, index -> hub pages -> listing pages (depth 2, dead links tolerated, both name families, platform and customer pages only when `include` opts them in), then the builds; with `case_index`, `agile:tree:roots` and every own-tree build's case documents (`cases-sync.ts`) |
| `functions/cases.ts` and `cases-*.ts` | the case index: the producer `cases` (`cases.ts`), case nodes (`cases-nodes.ts`), the command catalog, phrase extraction and resolution (`cases-commands.ts`), the sync plan's part (`cases-sync.ts`), shared pack data (`cases-rules.ts`) |
| `functions/select.ts` | the build choice (SelectBuildInput -> SelectBuildOutput) over `select-build.ts`: the latest released build of the line across both families on the main platform, the other candidates as alternatives |
| `functions/producers.ts` | the producers (ProducerInput -> ProducerOutput) over `command-tree.ts`, `manual.ts`, `release-notes.ts` and `fixed-bugs.ts` (the build site's fixed-bug page, html@1) |
| `functions/sources.ts` | the build-site external ids (`buildsite:listing:<page>`, `buildsite:file:<link>`, the same rule as the build-site system pack; a test keeps them equal) and the source roles `tree`, `fixed_bugs` |
| `functions/documents.ts` | the version lines of documents: manual folders `rel_apv_<line>` / `rel_nsae_<line>`, version tokens in spec, product and qa names (an NSAE-named document has the same line as the APV-named one) |
| `functions/locate.ts`, `ids.ts`, `commands.ts` | the agile location rule (ancestor labels -> line, train, module), the story and bug ids of titles, the command extractor (phrases whose first word is a catalog head) |
| other `functions/*.ts` | the building blocks below (listing parser, naming, builds, sync-plan, select-build, command-tree, manual, release-notes, util, types) |

Not published: `api.ts` (`node packs/product/apv/api.ts check|sign|stage <directory>`), this README, the tests and
`testing/` (`test-support.ts`, the synthetic fixtures in `testing/fixtures/` and `testing/site.ts`, the small build site of the
end-to-end test).

The plan lists every released build of a mainline page on the main platform, every released build of an opted-in page, the
newest build of every version line and name family even when it is not released (released_at null: a line under test may
have no release yet, and a review may target one), and the base of every listed alias. Every other mainline build of the
read pages is listed too, as a name-only build: name, family, line and dates, base itself, sources empty — the knowledge
base then knows every build of the line by name (the case-location candidates read them), while the sync registers such a
build without producing a root and without counting it a failure (a separate `只登记名字` count in the sync report). A build with its own
command tree (an APV name, or an NSAE name of the newest lines) is its own base and carries the sources `tree` (and
`fixed_bugs` when linked); an NSAE name without a tree is an alias of the build its "based on" chain ends in and carries no
sources. Every planned build carries family, line, base, platform and both dates. The knowledge sync produces roots of
released builds only (unreleased own-tree builds need `includeUnreleased`), moves the line's current root and records the
aliases: a run started with an NSAE name locks the root of its APV base (end-to-end test).

Entry kinds follow K02 R[3]: the command tree gives `definition` entries, the manual `definition` for signature paragraphs
and `behaviour` for the text under a command, the fixed-bug list and release notes `defect`; the finer form stays in
`data.form` and `data.status`.

## Functions

| Module | Function | Input → output |
| --- | --- | --- |
| `listing.ts` | `parseListing` | html@1 model of a build-site listing page (or `{ model, context: { platform } }`) → `{ builds, hub, warnings }` |
| `select-build.ts` | `selectBuild` | `{ candidates, line, declared?, includePlatforms? }` → `{ build, base, basis, alternatives, notes }` |
| `sync-plan.ts` | `planSync`, `syncBuilds` | index page model(s) and hub pages read → listing pages, hub pages to read; builds → base builds to produce, aliases |
| `command-tree.ts` | `produceCommandEntries` | xml@1 model of `command_tree-<build>.xml` (or `{ model, params }`) → definition entries at `/commands/<words>` |
| `manual.ts` | `produceManualEntries` | markdown@1 model of the CLI manual, or the `ist.manual-command-catalog` JSON → definition entries, unplaced spans |
| `release-notes.ts` | `produceReleaseEntries` | markdown@1 model of a release note → defect entries (fixed or known) with build and date |
| `commands.ts` | `extractCommands` | `{ text, heads }` → command phrases with offsets |
| `locate.ts` | `locateFromAncestors` | agile tree labels, root first → `{ line, train, module, notes }` |
| `ids.ts` | `idsFromTitle` | document title → `{ stories, bugs, plm, unclassified }` |
| `cases.ts` | `cases` (product.json) | ProducerInput (documents batch, tree, folders) → ProducerOutput: one `case` entry per (case, resolved command) |
| `cases-nodes.ts` | `caseNodes` | kityminder@1 model → the case nodes with title, labels above, tags, priority, expected count, steps, vague, autoid |
| `cases-commands.ts` | `commandCatalog`, `textCommands`, `resolvePhrase` | xml@1 command tree → catalog; texts → the catalog paths their phrases resolve to |
| `cases-sync.ts` | `caseTree`, `caseDocumentsFor`, `caseIndexOptions` | the read agile tree → the located documents; a build line → its `case_documents` |

## Walking the build site (brief section 8)

Index → hub pages → listing pages, depth 2, tolerant of dead links:

1. `planSync({ index })` → `pages` (listing pages the index links), `hubs` (hub pages to read).
2. Read every hub page; one that cannot be read is given with `model: null`. `planSync({ index, hubs: [{ page, model }] })`
   → `pages` now also holds the listing pages the hubs link (`from` names the hub; resolve `href` against that page's URL),
   and `hubs` is empty. A page `parseListing` flags `hub: true` (no build entry, page links) may be given in `hubs` too.
3. Read every page in `pages`: `parseListing({ model, context: { platform } })`.
4. `syncBuilds({ builds, existingRoots })` → `produce`, `aliases`, `skipped`, `unreleased`.

## Decisions

Builds and lines
- Build name: `[prefix-]Rel|Beta <sep> family[-PLATFORM-TOKENS] <sep> n <sep> n ...[suffix]`, `<sep>` `_` or `.`. The first
  three numbers are the line, the rest the build number (`Rel_APV_10_6_1_57`: line `10.6.1`, number `57`;
  `Rel_APV-HG-K_10_6_1_3_1_9`: platform `hg-k`, number `3.1.9`). Prefix and suffix are kept as `variant`
  (`BrandOS-*.click`). Family tokens other than APV and NSAE are `other`.
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
  date, build time, APV before NSAE, build number, name; the first one whose root can be determined is chosen, better-ranked
  ones without a root are named in a note and stay in `alternatives`. When none has a root the best one is returned with
  `base` null. The result does not depend on the order of the candidates, duplicate names included.
- `base`: an APV name is its own base; an NSAE name with its own command tree is its own base (the newest lines 10.4.5,
  10.4.6: their trees equal the APV twin's, so the content-addressed roots coincide); an NSAE name without a tree follows
  its `based on` chain to the first APV build or NSAE build with a tree. Cycles, missing bases, a base of another family
  and an NSAE build with neither tree nor base give `base` null with a note. The base is never guessed from equal numbers.
- `basis` is the provenance type: `declared` or `projected`.

Sync plan
- Hub pages by name: a product name without `rel_` followed only by a version (`apv_10_5`, `apv_10_4_6`) or by no version
  (`apv_trunk`, `apv_10_x_patch`). Their content decides: a hub page read that lists builds is a listing page (warning).
  Hub pages linked from hub pages are beyond depth 2 and skipped with a reason.
- Listing pages by name: `[rel_]<family>[_<platform>]_<n>_<n>[...]_<tokens>`. Mainline: only the version or a mainline
  token (`tls13`). Platform: version and a platform token (`hg_uos`, `hg_k`, `ft_kylinv10`, `zx_neokylin`, `zhaoxin`, ...
  in `PAGE_PLATFORMS`). Patch: any `patch` token. Customer: anything else (customer, POC, feature, special branches, extra
  build numbers). No customer names are in the code.
- Default: mainline listing pages of APV and NSAE. `include` / `exclude` are case-insensitive globs (`*`, `?`) over page
  names; exclude wins and also applies to hub pages. The result does not depend on the order of the hub pages given.
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
- Producer placement: only `manual` declares `placement: "judgment_allowed"` so unplaced manual fragments may go to the typed-judgment model; `command-tree`, `release-notes`, and `cases` keep default `code_only` to prevent internal defects and test case titles from leaving the Hub.
- Command tree: one entry per full command; every `arguments` list is one overload (`id` `k`, fragment `fragments[k-1]`).
  `data` is catalog-entry@1 without `reference`. Types: STRING and XSTRING → string, U16 → int 0..65535, U32 → int
  0..4294967295, DOTTEDIP → ipv4, IPADDR → ipv4 or ipv6, IPMASK → mask or int 0..128; other types → string with a
  warning. A DOTTEDIP argument whose help text names another form (`or ...`, a host name, a URL: `OTHER_FORMS`, with its
  origin) is a string, with a warning count. Declared argument types (`params.argumentTypes`: `{ command, position, type,
  origin }`, `type` a key of `ARGUMENT_TYPES`) win over both; rows without an origin, of unknown type or never used are
  warnings. A union argument expands into overloads (`k.1`, `k.2`, ...), at most 32 per list, beyond that string. `limit`
  `[a - b]` is a value range (int, narrowed to the type range) or a length range (string); `{a|b}` an enumeration; `length`
  a maximum or a range of the length. Defaults are entity-decoded once more (the tree escapes them twice) and unquoted.
  Unnamed arguments are `arg1`, `arg2`, ... The statement has one line per overload plus its help texts.
- Manual (markdown): a command anchor is a paragraph that is only the bold head plus emphasized parameters
  (`**demo pool add** *\<name\> \[weight\]*`, also several spans), or a heading written that way. Head groups hold
  alternatives of one or more words (`{tcp|probe hello}`). The key is the words before the first `{}`/`[]` group (a
  leading optional group is skipped): the nearest common node of the variants (K01 R[3]). The blocks after an anchor up to
  the next anchor or heading are text entries at its node. A single-line paragraph without CJK that opens in bold and
  carries signature syntax but does not parse (a source defect, or an unknown head when `heads` is given) ends the
  command: it and the blocks after it are unplaced, with a warning. Every other block is returned `unplaced` (for the
  typed-judgment model, K04 R[3]).
- Manual (catalog JSON): each signature is a signature entry (fragment `p/signatures/<k>/signature_verbatim`). A
  "signature" whose head holds a quoted value or a number after a known head is a worked example: a text entry
  (`example: true`) at the longest known head, else unplaced; never a synthetic path. A number with no known head before
  it stays a command word. Value domains and worked examples become text entries at the matching head, else `unplaced`.
- Release notes: sections whose heading names fixed issues (已修复问题, 修复的问题, 问题修复, 已解决问题, Fixed Issues,
  Bug Fixes, Resolved Issues) or known issues (遗留问题, 已知问题, Known Issues, Open Issues); a negated heading (未修复,
  尚未修复, 没有修复, 未能修复, 未解决, not fixed, unfixed, unresolved) is known issues, tested first; English names only as
  whole words. The module is the child heading or a module column; items are list items, table rows (pipe, grid, HTML) or
  paragraphs; the bug id comes from an id column, a bug marker or a leading number and is stored as `data.bug` (the same
  id a case lists in `data.defects`). `data.status` is `fixed` or `known`. The names `bug`, `status` and `defects` are
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
  version, not a test activity).
- `idsFromTitle`: bug, story (`需求`, `Story#`) and PLM markers, misspellings seen in real titles included; lists after a
  marker; ids the title does not classify (a leading number, after 回归 or Test-) go to `unclassified`. Versions, dates,
  years, numbers glued to short words and alarm-like numbers in running text are never ids.

## The case index (brief section 6a, capabilities 4 and 6)

Sync (`cases-sync.ts`, called by `sync.ts` when the sync option `case_index` is true; product.json sets it)
- Round 1 fetches `agile:tree:roots` (the agile system pack's read of every configured root) besides the hub and listing
  pages; it is read once per sync and parsed as json@1. Documents are taken from the roots titled with a product name
  (`APV`, `NSAE`, NFKC, case-insensitive, alone or before a non-word mark): both name families, so the first name's root
  (no versions) is read too; its documents have no line and are counted. Other roots of the resource are counted, not read.
- Each document is located with `locate.ts` (its ancestors from the root title down, as the mind-map meta has them). A
  build whose own command tree is listed (`tree`) gets `case_documents`: the `agile:mindmap:<id>` of the documents with a
  line not later than the build's and not earlier than `min_line` (default 10.4.2, a dotted line; another value is noted
  and replaced), at most 20,000 (product@1 `MAX_LIST_SOURCES`; more are noted, not listed), ordered by id (numbers by
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
- **Commands** (`cases-commands.ts`): the catalog is the build's command tree read with `produceCommandEntries` (the
  command-tree producer's own function, so case paths are definition paths). The phrases of the case title and of every
  label above the case (the mind map's root text included) are found with `commands.ts` `extractCommands`, all distinct
  texts of a call in one scan (joined by a line no phrase crosses; equal to scanning each alone, tested). A phrase resolves
  to the longest run of its leading words that is a catalog command, case-insensitive; a word may be a unique prefix of the
  command word at its place (two letters at least, and at least three when the word is written in capitals, so `AD` and
  `SH` are acronyms); a command reached through an abbreviation needs two words (an abbreviation alone is no command);
  the words after a resolved command are arguments unless another command of two words or more starts there. The heads
  handed to extractCommands include the unique prefixes of first words (not English short words) so that an abbreviated
  first word is found at all; a `no` phrase the catalog lacks resolves to the command it undoes when that exists. Before
  extraction each text is folded one unit for one: full-width letters and digits to ASCII, Unicode spaces and zero-width
  characters to a space, vertical breaks to a line end. Full NFKC is not applied: it would turn full-width punctuation
  (，：) into ASCII marks that no longer end a phrase. A list number glued to a command (`1.widget`, `2）show`) is blanked
  out first. A two-letter lower-case prefix still abbreviates an inner word (`de` before `detail`); that is the same rule
  as `sh` and `end`, and the table locks it. The table is `tests/fixtures/case-index/table.ts`.
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
  `apv_trunk` and the `apv_10_x_*` pages hold is unknown: their content decides when they are read.
- "Latest released" is by release date: a sub-build released after a newer build of the same line wins; the alternatives
  show the others.
- Markdown anchors with other source defects (a stray escaped underscore, text after the parameters) are not anchors.
- Release notes were not sampled: the structure is the one described in the task, so the heading and column patterns may
  need additions once real notes are read.
- Platform tokens of build names (`HG-K`) and of page names (`hg_k`, `ft_kylinv10`) are kept as written; they are not
  mapped onto each other.
- The functions were also run, outside the repository, on the read-only samples of 2026-10-21 (the index and a listing
  page, a command tree, the CLI manual and its catalog, agile titles and labels); nothing from them is in Git. The case
  index functions were not run on real documents yet (the integrator's `scripts/real/`).
- Case index: only the title and the labels above a case are scanned for commands (as asked), not its steps or expected
  results. A case with no resolvable command is still an entry, with an empty path. Abbreviations are unique prefixes of
  command words (two letters, three when written in capitals); a CLI that accepts other short forms is not covered. A
  phrase whose first word is no catalog word (`health interval ...` without its context word) is not found.
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
  tree (`YYYY/M` in the train label), not the numeric order of the dotted line. Brief section 8: 10.4.5 and 10.4.6 are
  newer lines than 10.5. A line with no dated train is listed only on a build of that same line. `min_line` is the same
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
  those bytes, so this task signs the pack as 1.2.0 and does not change the read.

## How to test

```
node --test "packs/product/apv/**/*.test.ts"
node --test packs/workflow/case-review-verify/end-to-end.test.ts   # the sync through the real connectors and knowledge
npx tsc --noEmit
```

Case index tests (fixtures in `tests/fixtures/case-index`: the hand-written command table, two invented command trees whose
difference is known, a synthetic agile platform with the product's two roots and another product's root, 300 mind maps and
the truth of every document and case, built while the corpus is built): `cases-commands.test.ts` (every table row against
both trees, abbreviation, `no` and list-number rules, one scan equal to scans of each text, linear on long hostile text),
`cases-nodes.test.ts` (every case of the corpus with its contents; parity with the case-review projection under the marked
rule on the review, template, untagged, outline and tiny maps, the 3,000-node map and every corpus document; cycles,
shared children, invalid indices, depth), `cases-rules.test.ts` (negative tags equal to case-review's on 2,000 spellings,
the agile ids, the list limit, vague phrases), `cases-sync.test.ts` (options, product roots, the located documents and the
reasons, each build's list equal to the truth for the dated lines and another `min_line`, an added document keeps the
ids before it, pending, failed and incomplete trees, the plan reading the tree once in round 1 without an extra round,
own-tree builds listing their documents and aliases nothing, no build while the tree is unreadable or incomplete, lines
ordered by release-train date, a line no build covers, hostile input), `cases.test.ts` (every entry of a 10.6.1 and a
10.4.6 build equal to the truth in the Hub's own batches (`listBatches`), the later tree, counts by reason and at most 20
examples; another document id changes only the key, a renamed tree label changes nothing, reversed cases change nothing,
a document twice or listed twice doubles nothing, a document alone gives its entries of the batch; a short batch keeps
every document that carries `external` and does not guess the rest; a case with no command and a case with no command
tree still produce an empty-path entry; a case id copied onto an expected-result leaf; hostile input; one batch at scale;
the sandbox) and
`cases-integration.test.ts` (the real registry, connectors and knowledge service: the sync produces both builds, the facet
view by line and module, the index view by document with the entries' data and the impact view of the two builds (changed
commands and exactly the cases filed on them) equal to the truth, the NSAE alias reads the APV base's root, a second sync
skips every build, an agile outage lists no build and moves no current root).

`functions/adapters.test.ts` tests the product.json entry points against the product@1 shapes (good, malformed and hostile
input); `functions/sandbox.test.ts` and the adapters' sandbox suite run them in the Hub sandbox (skipped where sandbox-exec is
unavailable). Fixtures in `testing/fixtures/` are synthetic (invented names, numbers and texts; addresses in 192.0.2.0/24).
The end-to-end test publishes this pack in the real registry, syncs it from `testing/site.ts` through the build-site system
pack and reviews a mind map against the root it produced.

## Needs from other packages

- **contracts**: a parameter type for "IPv4 or IPv6 address" and one for "dotted mask or prefix length" (or a union of types
  in `CatalogParam`) would replace the overload expansion.
- **knowledge**: place `path: null` entries and `unplaced` spans with the typed-judgment model (module as the literal hint);
  without a Jev client they stay unplaced (the fixed-bug entries of a build, for example).
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
  the bed's agile resource has no product root (its roots are the shared fixtures' ORBIT/COMET), so its apv builds get an
  empty case list and the review is unchanged.

Done since the earlier round: the adapters to the product@1 shapes, the build-site external ids and source roles, the
catalog producer selector (`CatalogDeclaration.producer`), the entry-kind axis (K02 R[3]).
