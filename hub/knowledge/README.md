# hub/knowledge: the content-addressed knowledge tree

Model elements **K01** (knowledge tree), **K02** (entries), **K03** (three writer layers), **K04** (placement by the typed
judgment model), **K05** (pinned reads), with **B03** tree references, **B05** actions, **D01 R[8]** (one product, several
names) and **W09** (the sync is a standing obligation the Hub executes). Other packages import only `hub/knowledge/api.ts`.
The shapes of the records are registered in `contracts/src/knowledge.ts`.

`createKnowledge(options)` returns an object that implements `KnowledgePort` of `hub/ports.ts` exactly (`builds`,
`resolveBuild`, `currentRoot`, `rootOfBuild`, `rootInfo`, `catalog`, `treeReader`, `getNodes`, `diffRoots`), plus
`produceTree`, `syncProduct`, `lockRoot`, `moveRoot`, `reconcileLine`, `provenanceOf`, `calibration`, `placement`,
`layers` and `store`. Its `treeReader` also takes an optional lock (`{ composition }`, see decision 13).

```ts
const knowledge = createKnowledge({
  records: kit,                       // store, artifacts, pointers, principals of hub/records
  parsers: createDefaultRegistry(),   // hub/refs core parsers: the Hub parses, never the pack
  packs,                              // PacksPort (runs)
  external,                           // ExternalReaderPort (connectors)
  jev,                                // hub/jev client (HttpJev with the vault key and the pinned model), or null
  sandbox: { requireOsIsolation: true },
  admin,                              // the admin context of standing syncs when a call names none
});
const report = await knowledgeSync(knowledge, packs, admin, parseKnowledgeSyncArgs(['--product', 'x', '--line', '1.2']));
registerCommand(knowledgeCliCommand(async () => ({ knowledge, packs })));   // `circle-hub knowledge sync ...`
```

| File | Content |
| --- | --- |
| `api.ts` | the public surface |
| `service.ts` | `createKnowledge`: wiring, `buildCalibrationSet`, one sync per product at a time |
| `produce.ts` | `produceTree`: sources, producers in the sandbox, verification, placement, nodes, composition, generate action |
| `sync.ts` | `syncProduct`: plan rounds, builds, productions, current roots, the report |
| `builds.ts` | build records, aliases, roots of builds, current-root pointers (`moveRoot`, `reconcileLine`) |
| `read.ts` | permission, `getNodes`, the `TreeReader`, `catalog`, `diffRoots`, `provenanceOf` |
| `placement.ts` | hierarchical placement with the typed-judgment client, judgment records and reuse, calibration samples |
| `calibration.ts` | Wilson lower bound, threshold rule, calibration sets, literal masking |
| `layers.ts` | observation and candidate layers |
| `sources.ts`, `verify.ts`, `tree.ts`, `digest.ts`, `store.ts` | reads and refusals, fragment and path checks, the in-memory tree, normalisation, digests and text cutting, record I/O with schema checks |
| `cli.ts` | `parseKnowledgeSyncArgs`, `knowledgeSync`, `formatSyncReport`, `knowledgeCliCommand` |
| `test-support.ts` | synthetic product pack with real pack functions, fake `PacksPort` and `ExternalReaderPort`, synthetic build site |

## Records

| What | Kind | Schema | Index keys |
| --- | --- | --- | --- |
| node | `tree_node` | `tree_node@1` | `knowledge.node` = node digest |
| entry | `tree_node` | `knowledge-entry@1` | `knowledge.entry`, `knowledge.entry.product` |
| composition of a produced root | `tree_root` | `tree_root@1` | `knowledge.root`, `knowledge.root.build`, `knowledge.root.product` |
| current-root move | `root_pointer` | `root_pointer@1` | `knowledge.pointer` = product/line, `knowledge.pointer.move` |
| build (what the sync listed) | `claim` | `knowledge-build@1` | `knowledge.build` = product/folded name, `knowledge.build.product`, `knowledge.build.base` |
| calibration set | `claim` | `knowledge-calibration@1` | `knowledge.calibration` = chain/model |
| observation, candidate | `claim` | `knowledge-observation@1`, `knowledge-candidate@1` | `knowledge.observation.product`, `knowledge.candidate.owner` |
| production or its failure | `action` (`generate`) | `action@1` | `knowledge.produce` = product/base, `knowledge.produce.product`, `knowledge.produce.root`, `knowledge.sync` |
| plan round | `action` (`parse`) | `action@1` | `knowledge.sync` |
| one typed judgment | `action` (`classify`) | `action@1` | `knowledge.jev.reuse` = reuse key, `knowledge.jev.input` |

Every body of this package's own schemas is parsed with its registered zod shape before it is written (`store.ts`), so
what is written always reads back. The records package writes the `move_root` action of every pointer move (in the same
transaction as the `root_pointer` record). The generate action is the light index of productions (product, build, root,
composition digest, sources, placement state, the producing component); the large `tree_root` record is read only for
catalogs, grounds and provenance.

## Decisions

1. **Digests** (K01 R[1], R[7]; K02 R[4]). Node digest = SHA-256 of the RFC 8785 JSON of `{name, children: [{name,
   digest}], entries}` (children sorted by name, entry digests sorted, the root's name empty). Entry digest = SHA-256 of
   `{kind, statement, data, applicability}` after normalisation: statement in NFC, NUL removed, LF line breaks, trailing
   white space and empty edge lines removed; applicability lists sorted without repeats; null stays 未声明. No source
   digest enters either, so unchanged commands of two builds give equal entries and shared subtrees; a source with other
   bytes but equal content gives the same root (proved for an own-tree build of the other name family).
2. **Levels** (K01 R[2], axis `node_level`): height 0 is a leaf, 1 a branch, higher a trunk; stored with the height, not
   part of the digest.
3. **Entries before the tree** (K02 R[0], R[3]): the kind must be one of the `entry_kind` axis (定义、行为、用例、缺陷、观察);
   every text must be storable (canonical JSON refuses a lone surrogate or a number that is not finite; the digest is
   computed inside that check); every fragment must locate in the stored source of its slot (selector syntax, registered
   parser, `locate`, UTF-8 range inside the fragment) and the path must be canonical tree path text (segments kept in
   NFC). The bytes were hashed once when loaded, so fragments are located in the parsed document directly instead of
   through `resolveReference`, which re-hashes the whole source per call. A refused entry or span is one refusal (first
   200 kept, all counted; its declared kind, path and reason cut to storable text); a build with nothing left fails.
   Producer warnings are cut to 1000 characters with lone surrogates replaced.
4. **Sources** (B02 R[3], R[4]). Read through the ExternalReaderPort in the admin's context, the `content` artifact when
   the system pack derived one, else the original, bytes only through `Artifacts.source(..., {consumer: 'model', record})`
   pinned to the very record the connector read returned, so every check (visibility, tier, scan) and `RootSource.artifact`
   are that record's, never another record of the same bytes. Refused, with a Chinese reason that names the digest: a
   credential hit (`retain_only`; the reason says an administrator can accept the findings of that exact document, then
   rerun the sync: proved end to end with `acceptFindings`), function-only bytes, bytes the scanner could not inspect, a
   read with a personal credential (`visibility.admins` false), sources of one build above the per-build cap together,
   no core parser that accepts the media type. A required source that is refused or unreadable fails the build; an
   optional one that cannot be read at all is skipped with a warning (and recorded as missing), but an optional one that
   is read and refused fails the build too.
5. **Basis and decider** (K01 R[5], R[7]): a source named by the build's own roles is `release_record` when the build is
   released, else `declared`; a templated source the pack maps to the version is `declared`. The decider is the product
   pack `id@version`. A row's basis is taken over every slot its fragments are in (one basis, else `declared`).
   `device_echo` is reserved for the observation layer.
6. **Composition rows** (K01 R[7]): one row per (path, entry) with the sorted ids of every producer that gave the entry
   there and every fragment in order; spans left unplaced are one row per content, again with every fragment and
   producer (equal spans at two places of a manual keep both fragments).
7. **Placement** (K04). Code places by source structure (entries with a path); entries without a path and the producers'
   `unplaced` spans go to the typed-judgment client, from the root down, one choice question per level among the
   children of the node (option names are the child names where the service takes them, the first line of each child's
   first entry is the description, cut to 160 units on a character boundary; `none` is always the last option). More
   than 254 children are narrowed to those whose name occurs in the span; nothing left or still too many stops there. A
   span descends only when the chain is calibrated for the client's exact model, the top option is a child, it is not
   tied and `p >= threshold`; otherwise it stops: at the root it is not hung (stored, citable, listed with its candidate
   in `unplaced`, K01 R[4]), deeper it is hung on the node where it stopped. Uncalibrated chains ask once at the root and
   keep the answer as a candidate flagged `calibrated: false`. The note is `归类判断：Jev@<exact version>，p=…，只影响位置`
   plus where and why it stopped; a probability below the threshold is shown with as many decimals as it takes to show
   the order, cut (never rounded up). A question the service would refuse fails only itself (each question is planned
   alone when a batch cannot be planned) and counts as a failed judgment, so a later sync asks again; its detail and a
   judge failure's detail go to the production's warnings, the note stays neutral.
8. **Judgments** (K04 R[2]): every question is a `classify` action carrying hub/jev's `judgmentRecord` (exact model,
   question, candidates, input and state digests, probabilities). Questions of one level are batched with
   `planBatches`/`askAll`, items in a stable order; a planned request is skipped when every one of its questions has a
   recorded judgment under the reuse key of that very state.
9. **Calibration** (K04 R[1]): samples `{input, expected, chosen, probability}` per chain (`placement.choice`) and exact
   model. The threshold gates descents, so only samples whose chosen option is a child count: the threshold is the
   lowest probability whose descents at or above it have a Wilson lower bound (z = 1.959964, the two-sided 95 %
   interval) of at least 0.95 over at least 30 of them; a child chosen where none was right is a wrong descent;
   abstentions count for nothing either way; samples at one probability enter and leave together; later sets win per
   input. A sample's input is the piece at one node. `buildCalibrationSet` masks the path words and command words of
   code-placed entries (ASCII as whole words, others as substrings), asks the placement question at every level of their
   known path, and at the entry's own node when it has children (there `none` is right); the sampled entry never
   describes an option (its own first line would hand over the answer) and every description is masked like the
   passage. `addLabelled` takes an administrator's samples (`origin: declared`).
10. **Builds and aliases** (K01 R[10], D01 R[8]): the newest record of a name wins; a record is written only when the
    listed build differs from it. A build whose base differs from its name is an alias and has no tree; aliases are
    followed to their final base (at most 8 hops, cycle safe, whatever line the base is on) before a root is looked up;
    names match exactly, else without case when only one spelling exists. Roots are keyed by product and base build; a
    build produced without a build record is still known through its production. A build whose name or base does not
    fit the build index (well-formed, no NUL, at most 1000 UTF-8 bytes with the product), whose other text cannot be
    stored or whose line makes no pointer name is refused before anything of it is written.
11. **Current roots** (K01 R[6], B05 R[4]): one pointer per product line@version (`knowledge/<product>/<line>`, bytes
    outside `[a-z0-9._-]` written `:hh`); its target is the root of the newest build of the line that has one (release
    date, unreleased last, then build time, then name; aliases count with their final base's root). A move is made by an
    enabled admin (the service's admin when none is named), by compare-and-set through the records Pointers, with
    `rec:<generate action>` as cause: the action must be a completed production of this product whose root is the
    target, and the build the pointer names must be listed on the pointer's line and use that production's tree. A
    `root_pointer` record is written in the same transaction. Reconciliation reads the pointer before it decides the
    newest build, so its compare-and-set fails whenever anything moved the pointer in between (it never moves a line back
    over a newer root) and it reads again. The sync reconciles every line it touched at the end (level triggered, W09
    R[2]); old roots stay.
12. **Sync** (W09, brief section 7). Start pages from the declaration (`{product}`, and `{line}` when one line is given),
    each page read once, checked like a source and parsed with the core parser for its media type; the plan function
    gets `{round, options, read, known}` with every page read so far; `options.lines` is set from the caller over the
    declaration's options. It stops when the plan is done, at `max_rounds` (6) or `max_reads` (300); a limit is a report
    warning and the last answer's builds are still the plan. Per build: a build the store cannot record (decision 10), a
    family that is not a name of the product and a recording error each fail that build only; aliases and builds without
    tree sources are skipped; unreleased own-tree builds are skipped unless a released alias needs them (or
    `includeUnreleased`). An own-tree build is produced again unless its newest production has the same product pack
    digest, the same production component (`knowledge.produce@1`), the same build as listed now (release date, line,
    platform, sources), the same external sources (read or missing), when it has model-placed spans the same model and
    threshold without judge failures, and every optional source that was missing is still unreadable (re-read on every
    sync, once per external id); `recheck` also re-reads the sources read then and produces when a digest changed.
    Productions run with bounded concurrency (2) under a per-build byte cap (64 MiB); their write phases run one after
    the other in this process, so the nodes two parallel productions share are written once; a failure of one build
    never stops the others; an abort signal is checked between builds; two syncs of one product in one process run one
    after the other. Dry runs store nothing of their own. Text a pack function wrote (the plan note) is cut to storable
    text before it is recorded.
13. **Reading** (R02, D05 R[3]): a reader is an enabled admin or has a pack that binds the root's product
    (`PacksPort.readableProducts` of the account as stored now). Absent and forbidden are the same null; the reader is
    checked before anything else of a get_nodes request is read. `getNodes` lists each requested path (duplicates
    removed, at most 256 distinct paths, the rest named in the coverage note) and its subtree to `depth` (default 1) in
    pre-order, each node once (a subtree is walked again only with more levels to go, capped at the node's height, so
    overlapping paths cost nothing extra); a page ends at 100 nodes or about 2 MiB counted over statements, canonical data and child
    lists; a node whose entries do not fit is split over pages (the cursor carries the entry to start at, the note says
    so); a cursor is bound to its query and must point inside the walk (a forged offset is refused like an absent root);
    coverage is complete only on the last page, missing paths in the note. Entries show their applicability text (未声明
    when undeclared) followed by the placement note when the model placed them. The `TreeReader` gives the entry
    statement (or a node's statements) with grounds from the version composition and premises naming it: bound to a
    composition (`treeReader({ composition })`, the RootInfo.composition a run locked) from that one alone; unbound, from
    every composition of the root, each also listed with its build under `validity.compositions`. `hasRoot` lets
    hub/refs answer a wrong path in a readable root with REFERENCE_UNRESOLVED. `entry:` reads check the products the
    entry was written for. `provenanceOf` needs a reader who may read the root.
14. **Catalog** (C07): the entries of the declared `entry_kind`, of the declared `producer` when the catalog names one,
    with catalog data (`words`, `signatures`, `summary`), each with the reference `tree:<root><path>@<entry>`; an entry
    two producers gave at one path is a member when one of them is the catalog's. `complete` is withdrawn for a root only
    when such a member was refused, left unplaced or has no catalog data (other producers' losses do not count);
    `case_sensitive` as declared; the nearest common ancestor of the members is the view's reference; null without
    members. Views are cached per composition.
15. **Layers** (K03): observations are appended by the Hub's own verification runs (the echo must be a stored source;
    no run id) and read with the product, by cursor; candidates belong to their owner only (admins included), rest on
    the owner's own private upload whose quotation is verified with hub/refs, bind the path, the digest of the text at
    the path and the root, and show 被引片段已变（根 X → Y） against another root. Neither enters a root digest.

## Limits

- The plan input holds the parsed model of every page read so far (the contract); a very large site can exceed the
  sandbox input cap (128 MiB here), which fails the sync with the reason.
- Without `recheck`, a source that changes behind the same external id is not noticed (released builds' files do not
  change; manuals mapped by template may). Run `knowledge sync --recheck` after a manual update. A missing optional
  source is noticed when it appears.
- Reuse of judgments depends on the batch a question is planned into: one changed span can re-ask the other questions
  of its request.
- The port's tree reader takes no lock (hub/ports.ts), so references resolved through it are grounded in every
  composition of the root (decision 13); get_nodes placement notes come from the root's newest composition.
- get_nodes walks the nodes before the cursor again on every page (in memory, bounded by the subtrees asked for); a
  node's child list is never split over pages.
- The one-sync-per-product rule and the queue of write phases hold within one process; a sync from another process at
  the same time can still write a shared node record twice (harmless: content-addressed, read by digest).
- `builds()` and the pointer reconciliation scan every build record and production of the product (fine for thousands).
- A credential found later in a source already in a root does not hide the tree's text; produce again.
- An entry record is written per product the first time it appears; a subtree shared from another product's root does
  not add records for this product, so `entry:` reads of those entries are answered for the first product's readers only.
- `diffRoots` and `builds` take no reader (the port); callers check the reader first.

## Deviations from the brief

- Composition rows carry `fragments` (all source fragments of the entry, in order) instead of one fragment reference,
  plus the entry's `kind`, its `producers` (so a catalog needs no tree walk and can be limited to one producer) and the
  model placement when there is one.
- `tree_root@1` (rows and unplaced rows gained `producers`, kinds are `entry_kind` codes, a refusal keeps the declared
  kind as given) and `knowledge-entry@1` (kind is an `entry_kind` code) changed in place: no Hub has written them yet.
  The integrator should confirm this, or ask for `@2`.
- The sync is identified by a sync id (`sync_<ULID>`) on its actions, not by a `run` record: `run@1` is shaped for
  workflow-pack runs (requirements, items, procedure). W09 R[3] calls each reconciliation a Hub-side run (Needs).
- A current-root move names the generate action as its cause; a run id is refused because this package cannot check
  that a run produced the root (Needs, runs).
- Default idempotence compares external source ids, not digests (see Limits); `recheck` compares digests.
- Builds whose line the caller did not ask for are not filtered by the driver: the plan function receives the line and
  is the authority.
- Spans that stop at the root are not hung on the root (K01 R[4], K04 R[3]); deeper stops hang on that node.

## Tests

```
node --test "hub/knowledge/**/*.test.ts"
npx tsc --noEmit
node tools/gen-contracts.ts --check
```

Every database test uses a temporary PostgreSQL from `hub/testing` (one cluster per file, a fresh database per test) and
runs the synthetic pack's functions in the real sandbox (`sandbox-exec` where available). Covered: normalisation and
digest vectors, text cutting on characters, levels, tree building and sharing, path checks, pointer names, build order,
the build index rule, sources and basis; the Wilson bound against independently computed values, the threshold rule at
its edges (29/30 samples, 72/73 right answers, groups at one probability, a mixed set, abstentions that would make or
block a threshold, children chosen where none was right), masking; production (nodes, composition, basis, decider,
generate action), digest stability and node sharing, refused entries (missing fragment, malformed path, unknown slot,
unregistered parser, bad range, missing slot with two inputs, oversize statements, kinds outside `entry_kind`, lone
surrogates in statements, paths, data, applicability, selectors and sections) with every record reading back, warnings
made storable, a composition the store refuses (failed generate action), equal spans, the per-build byte cap, the
connector's record deciding a read, the catalog limited to one producer and marked incomplete only for its own losses,
credential hits refused and unblocked by `acceptFindings`, function-only, personal-credential, uninspected and
unparseable sources, a producer that reaches for a listening loopback server (no connection), outputs outside the
contract, aliases; the sync end to end over a two-family synthetic site (index, hub page, listings, a dead link, an
alias by "based on", an own-tree build of the other family whose root coincides), idempotent reruns, resuming after
failures and after an abort, read and round limits, a plan that never says done, a broken plan function, one line only,
dry runs, the CLI entry and command, rechecks with the diff, a family that is not a product name, a new pack version,
another production component, a listing that changed, an optional source that appears, unindexable build names, a plan
note with a lone surrogate, alias chains and cycles, two concurrent syncs; current roots (the compare-and-set race, a
reconciliation interleaved with a newer production, moves refused for a user, without or with a wrong cause, for a build
of another line or tree, an alias of an alias, an alias on another line than its base); the permission matrix (admin,
reader, outsider, disabled, demoted, unknown account and root), paging and coverage, the reader checked before the
paths, the path cap, overlapping paths walked once, pages counted over data, nodes split over pages, forged cursors, the get_nodes output schema,
references through hub/refs (wrong paths REFERENCE_UNRESOLVED for readers), grounds of a root two builds share (all
compositions, or the bound one), provenance with a reader only, diffs that skip shared subtrees; placement (descend,
abstain, low probability with ordered digits, nothing named, ties, narrowing beyond 254 children, uncalibrated
candidates, reuse, re-placement after a judge failure and after calibration, a question that cannot be asked, a
description cut inside a surrogate pair, masked calibration samples without the sampled entry and with none questions);
the layers; the published JSON Schemas of the registered shapes and their kind, level and producer rules.

## Needs from other packages

- **contracts**: (1) vocabulary axes for the composition basis (K01 R[5], R[7]: 产品发布记录、设备回显、声明) and for the
  per-build outcome of a sync (W09, the brief's produced / skipped / failed); until they exist `COMPOSITION_BASES` is
  listed once in `contracts/src/knowledge.ts` and `BuildOutcome` with its labels once in `sync.ts`/`cli.ts`. (2)
  `ProducedEntry.kind` and `Unplaced.kind` in `contracts/src/product.ts` as `EntryKindSchema` (today a string, and an
  unplaced kind may even be empty; this package refuses anything outside `entry_kind` entry by entry). (3) A `.max(256)`
  on `GetNodesInput.paths` (`contracts/src/tools.ts`), so that the server refuses a larger request before it reaches the
  knowledge package. (4) A field for the placement note on `get_nodes` entries (K04 R[5]); it is appended to
  `applicability` today. (5) If the sync should be a Hub-side `run` (W09 R[3]), a run shape without requirements and
  items, or a decision that the sync id is enough. (6) The `SyncPlanInput` carries every page model each round; an
  incremental form (pages of the last round plus the plan's own state) would remove the input-size limit.
- **ports (integrator, `hub/ports.ts`)**: `KnowledgePort.treeReader(lock?: { composition: string })` (or the locked
  composition on `ReaderIdentity`/`NodesQuery`), so that a run's tree reads are grounded in the composition it locked
  (K02 R[2] condition 2, B01 R[5]); this package already implements the argument.
- **records**: (1) `MoveInput` could take the producing action's digest as its cause (it takes a run id; the action goes
  into the note as `生产动作 rec:<digest>` and into the `root_pointer` record). (2) A batched get by index value would
  make the first catalog or page of a large root faster. (3) A named lock (advisory lock) on the API, so that syncs and
  productions in different processes are serialised as they are within one.
- **runs**: lock with `lockRoot(product, {build})` or `{line}` (`rootOfBuild` / `currentRoot`), keep `RootInfo.composition`
  with the run and resolve the run's tree references with a reader bound to it once the port allows; every
  `KnowledgePort` method takes the product line id, not a product name. If production runs of workflow packs should
  move current roots later, a way to check that a run id is a completed production run of the product.
- **server**: register `knowledgeCliCommand` in the assembly; pass the knowledge service as `KnowledgePort`; supply the
  Jev client (`HttpJev` with the vault key and the pinned model of the configuration) and the admin principal; keep
  `knowledge-candidate@1` claims private to their owner in the record reader (admins included, K03 R[4]) and treat
  `tree_node` records as non-groundable (they already are not in refs' groundable kinds); `provenanceOf` now needs the
  caller's principal.
- **connectors**: store sync reads with the visibility of a shared credential (`admins: true`); a personal-credential
  read is refused by the knowledge package.
- **packs**: the real product pack's sync and producer functions must take and return `SyncPlanInput`/`SyncPlanOutput`
  and `ProducerInput`/`ProducerOutput` (`contracts/src/product.ts`); today they have their own shapes. Kinds must be
  `entry_kind` codes (the pack already uses `definition`); since the command tree and the manual both give
  `definition` entries, declare the command catalog with `producer` set to the command-tree producer. Paths must be
  canonical tree path text and fragments must name their slot when a producer has more than one input.
