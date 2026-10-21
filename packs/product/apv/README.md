# packs/product/apv

The pure functions of the APV/NSAE product pack. APV and NSAE are one product with two names: product line `apv`, names
`APV` and `NSAE` (`PRODUCT_LINE` in `functions/naming.ts`). Model elements: K01 R[10], K02, K04, C03, C07, D01 R[8], W03
R[0] R[5], T01 F[8]. Other packages use `functions/api.ts` (types, named functions, and `FUNCTIONS`, the sandbox entry
points).

Every entry point is a pure ECMAScript module, `export default function (input: unknown): unknown` (sync-plan also exports
`syncBuildsFunction`), deterministic and total: bad input gives a result with warnings, never an exception. Only modules
inside `functions/` are loaded at run time; the imports of Hub types are `import type` and erased. `sandbox.test.ts` runs
every entry point through `callPackFunction` (sandbox-exec on macOS) and compares with the direct call.

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
  and manual entries are `definition`, release-note items `defect`. The finer form is data: `data.form` `signature` or
  `text` on manual entries (examples also `data.example`), `data.status` `fixed` or `known` on defects. An unplaced span's
  `kind` is the kind its entry will have.
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
  paragraphs; the bug id comes from an id column, a bug marker or a leading number. `path` is null (the module is the hint
  for placement); `applicability` is `{ builds: [build] }`; a part of a block is cited with a byte range. Table scanning
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

## Deviations from the brief and the task

- `basis` is `declared` / `projected` (provenance_type axis, A01 R[1]) instead of `declared` / `rule`: the task asked for
  `rule`, but enumerations come only from the generated vocabulary.
- Entry kinds follow K02 R[3] (`definition`, `defect`), not the task's `command`, `manual_signature`, `manual_text`, `fix`,
  `known_issue`: the model wins over the task. The task's distinctions are kept in `data.form` and `data.status`.
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

## Limits

- Manual text under a command is always `definition`: code cannot tell a definitional sentence from a behavioural one; a
  later typed judgment could refine it.
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
  page, a command tree, the CLI manual and its catalog, agile titles and labels); nothing from them is in Git.

## How to test

```
node --test "packs/product/apv/functions/**/*.test.ts"
npx tsc --noEmit
```

`sandbox.test.ts` starts sandboxed child processes (about one second) and is skipped where sandbox-exec is unavailable.
Fixtures in `functions/fixtures/` are synthetic (invented names, numbers and texts; addresses in 192.0.2.0/24).

## Needs from other packages

- **contracts**: (1) `CatalogDeclaration` selects members by `entry_kind` only. With the model's kinds the build's command
  tree entries and the manual's signatures and text are all `definition`, so a catalog declared over `definition` would
  take manual entries (no signatures, "takes no arguments") as commands, and unplaced manual spans would withdraw its
  completeness. The catalog must come from its authoritative source (C07 R[0]; a manual is never a contract source):
  please add a member selector beside the kind, for example the producer id. Until then do not declare a catalog over
  `definition` alone. (2) A vocabulary axis for the K02 R[3] kinds, so producers use generated codes. (3) A parameter type
  for "IPv4 or IPv6 address" and one for "dotted mask or prefix length" (or a union of types in `CatalogParam`) would
  replace the overload expansion.
- **contracts / knowledge / runs**: the entry points do not yet take the shapes of `contracts/src/product.ts`
  (`sync-plan-input@1` / `sync-plan-output@1`, `select-build-input@1` / `-output@1`, `producer-input@1` /
  `producer-output@1`): the sync is two functions over html@1 models instead of one round-based plan over external ids,
  `selectBuild` takes listing builds instead of `KnownBuild`, the producers take the model (or `{ model, params }`)
  instead of `{ build, slots, params }`, and the release-note result adds `product`, `version`, `build`, `released`, which
  the strict `producer-output@1` rejects. An adapter needs the build-site system pack's external id scheme and the
  `BuildInfo.sources` roles, which are not defined yet; a decision on who writes it (this pack's entry points or the
  callers) is needed.
- **knowledge**: accept `ProducedEntry`; build `src:<sha256>/<parser>/<selector>[:<from>-<to>]` from `fragments` for the
  composition record; add `reference: tree:<root><path>` to command entries to get catalog-entry@1; record the aliases of
  `syncBuilds`, unreleased ones included; walk the site as above (call `planSync` again with the hub pages read); place
  `path: null` entries and `unplaced` spans with the typed-judgment model (module as the literal hint). The line → manual
  path map (`/cli/rel_apv_<line>/...`) and any `argumentTypes` belong to the pack's knowledge declaration, not to these
  functions.
- **runs**: call `selectBuild` with the bases and aliases the knowledge base knows; record `basis` and `notes` in
  `target_basis`; read `unclassified` ids by the workflow pack's rule; take line and train from `locateFromAncestors`.
- **packs (pack files)**: `pack.json`, `capabilities.json` and `knowledge.json` of this product pack are not written here;
  `FUNCTIONS` lists the entry points they should name.
