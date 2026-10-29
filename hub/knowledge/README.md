# hub/knowledge: the content-addressed knowledge tree

Model elements **K01** (knowledge tree), **K02** (entries), **K03** (three writer layers), **K04** (placement by the typed
judgment model), **K05** (pinned reads), with **B03** tree references, **B05** actions, **D01 R[8]** (one product, several
names) and **W09** (the sync is a standing obligation the Hub executes). Milestone 2 (brief section 6a, capabilities 4 and
6) adds list sources read in memoized batches, large roots in bounded records, the entry-level version difference
(K01 R[1]: the version difference is the regression scope) and the Hub's own views of the tree as external objects
(`contracts/src/views.ts`). Other packages import only `hub/knowledge/api.ts`. The shapes of the records are registered
in `contracts/src/knowledge.ts`.

`createKnowledge(options)` returns an object that implements `KnowledgePort` of `hub/ports.ts` exactly (`builds`,
`resolveBuild`, `currentRoot`, `rootOfBuild`, `rootForRead`, `rootInfo`, `catalog`, `treeReader`, `getNodes`,
`diffRoots`, `diffEntries`), plus `produceTree`, `syncProduct`, `lockRoot`, `moveRoot`, `reconcileLine`,
`provenanceOf`, `calibration`, `placement`, `layers`, `views` and `store`. `rootForRead(product, {build?, line?})`
is the root a run locks and a view reads: the line's seedling pointer when it names one, otherwise `rootOfBuild` or
`currentRoot`. When those two digests differ, the view's `notes` name both. Its `treeReader` also takes an optional
lock (`{ composition }`, see decision 13). `createKnowledgeReader(knowledge)` serves the views as an `ExternalReaderPort`.

```ts
const knowledge = createKnowledge({
  records: kit,                       // store, artifacts, pointers, principals and objects of hub/records
  parsers: installedParsers,          // hub/refs skill registry: installed capabilities execute in the sandbox
  packs,                              // PacksPort (runs)
  external,                           // ExternalReaderPort (connectors only: the views are not a source of the tree)
  // no jev: the Hub calls no model; only tests inject a scripted judge
  sandbox: { requireOsIsolation: true },
  admin,                              // the admin context of standing syncs when a call names none
});
const report = await knowledgeSync(knowledge, packs, admin, parseKnowledgeSyncArgs(['--product', 'x', '--line', '1.2']));
registerCommand(knowledgeCliCommand(async () => ({ knowledge, packs })));   // `circle-hub knowledge sync ...` and `knowledge seed ...`
// The run engine reads `knowledge:impact|facets|index:...` ids through the views, every other id through the connectors.
const engineExternal = routeKnowledgeViews(createKnowledgeReader(knowledge), external);
```

| File | Content |
| --- | --- |
| `api.ts` | the public surface, `createKnowledgeReader` |
| `service.ts` | `createKnowledge`: wiring, `buildCalibrationSet`, one sync per product at a time |
| `produce.ts` | `produceTree`: sources, producers in the sandbox (list producers per batch), verification, placement, nodes, composition (parts), chunked writes, generate action |
| `lists.ts` | list slots: batches, the list loader (read, then fetch and parse; reuse within `max_age_seconds`), memo keys, stored outcomes, the split that isolates a failing document |
| `call.ts` | one producer call in the sandbox with its output checked |
| `composition.ts` | content-defined parts of a large composition, `CompositionView` over one record or parts |
| `views.ts` | the impact, facet and index views, their ids, `routeKnowledgeViews` |
| `concurrency.ts` | bounded concurrency helpers |
| `sync.ts` | `syncProduct`: plan rounds, builds, productions, current roots, the report |
| `builds.ts` | build records, aliases, roots of builds, current-root pointers (`moveRoot`, `reconcileLine`) |
| `read.ts` | permission, `getNodes`, the `TreeReader`, `catalog`, `diffRoots`, `diffEntries`, `provenanceOf` |
| `placement.ts` | hierarchical placement with the typed-judgment client, judgment records and reuse, calibration samples |
| `calibration.ts` | Wilson lower bound, threshold rule, calibration sets, literal masking |
| `layers.ts`, `contributions.ts` | observation and verified contribution layers |
| `sources.ts`, `verify.ts`, `tree.ts`, `digest.ts`, `store.ts` | reads and refusals, fragment and path checks, the in-memory tree, normalisation, digests and text cutting, record I/O with schema checks |
| `cli.ts` | `parseKnowledgeSyncArgs`, `knowledgeSync`, `formatSyncReport`, `knowledgeCliCommand` (`sync` and `seed`) |
| `seed.ts` | `knowledge seed`: the three sources the product pack declares, `produceSeedling`, the Chinese report |
| `test-support.ts` | synthetic product pack with real pack functions (a list producer over synthetic mind maps among them), fake `PacksPort` and `ExternalReaderPort`, synthetic build site, a deterministic scale corpus |

## Records

| What | Kind | Schema | Index keys |
| --- | --- | --- | --- |
| node | `tree_node` | `tree_node@1` | `knowledge.node` = node digest |
| entry | `tree_node` | `knowledge-entry@1` | `knowledge.entry`, `knowledge.entry.product` |
| composition of a produced root | `tree_root` | `tree_root@1` | `knowledge.root`, `knowledge.root.build`, `knowledge.root.product` |
| part of a large composition (rows with entry content, unplaced rows, list sources) | `tree_root` | `tree_root-rows@1`, `tree_root-unplaced@1`, `tree_root-sources@1` | `knowledge.part` = content key |
| read of a list source | `action` (`read`) | `action@1` | `knowledge.read` = external id |
| one producer call of a list batch (memo: its output, or how it failed) | `action` (`generate`, component `knowledge.producer@1`, result completed or error) | `action@1` | `knowledge.memo` = memo key |
| the ids of a list role (as listed) | object (canonical JSON array) | | its SHA-256, cited by the build's `{list, count}` |
| one computed view | `action` (`generate`, component `knowledge.views@1`) | `action@1` | (the read's manifest) |
| current-root move | `root_pointer` | `root_pointer@1` | `knowledge.pointer` = product/line, `knowledge.pointer.move` |
| build (what the sync listed) | `claim` | `knowledge-build@1` | `knowledge.build` = product/folded name, `knowledge.build.product`, `knowledge.build.base` |
| calibration set | `claim` | `knowledge-calibration@1` | `knowledge.calibration` = chain/model |
| observation, contribution | `claim` | `knowledge-observation@1`, `knowledge-contribution@1` | `knowledge.observation.product`, `knowledge.contribution.product` |
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
7. **Placement** (K04). Code places by source structure (entries with a path). The Hub calls no model (owner decision
   2026-10-22): the production assembly injects no placer, so entries without a path and the producers' `unplaced`
   spans stay unplaced at the root, marked 未挂到树上位置的条目, and the production records `placement.spans` 0. The judgment flow
   below is the shape the bot's placement proposals will be verified against, exercised in this package's tests with a
   scripted judge: from the root down, one choice question per level among the
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
    listed build differs from it. A build record keeps the single roles in `sources` and names the roles that hold a list
    in `lists`, without their ids: a list that changes writes no new build record (the ids a production read are kept with
    the production, by reference, decision 16), so records grow with the builds, not with their lists. A build whose base
    differs from its name is an alias and has no tree; aliases are followed to their final base (at most 8 hops, cycle
    safe, whatever line the base is on) before a root is looked up; names match exactly, else without case when only one
    spelling exists. Roots are keyed by product and base build. Build-list reads first discover nonempty index keys in
    batches of at most 16, with at most two batches in flight; each present key still uses the existing newest-completed
    per-base reader. A failed batch falls back to those original reads, and no discovery result survives the call. This
    avoids an individual empty lookup per unproduced base without reading every production. A build produced without a build
    record (not by a sync) gets one in the production's last transaction (`plan` and `sync` null), so every known build has
    a record. `builds()`, `resolveBuild()` and `RootInfo.build` carry no list roles. A build whose name or base does not fit
    the build index (well-formed, no NUL, at most 1000 UTF-8 bytes with the product), whose other text cannot be stored or
    whose line makes no pointer name is refused before anything of it is written.
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
    declaration's options. Its answer may take the sandbox's largest output (64 MiB, memory 1 GiB). The answer is checked
    as an envelope first (`fetch`, `done`, `note`, `builds` an array; anything else fails the sync with the reason), then
    build by build: a build that is not build-info@1 (one bad list id, a list over MAX_LIST_SOURCES) is a failed build of
    the report and the others go on. It stops when the plan is done, at `max_rounds` (6) or `max_reads` (300); a limit is
    a report warning and the last answer's builds are still the plan. Per build: a build the store cannot record (decision
    10), a family that is not a name of the product and a recording error each fail that build only; aliases and builds
    without tree sources are skipped; unreleased own-tree builds are skipped unless a released alias needs them (or
    `includeUnreleased`). An own-tree build is produced again unless its newest production has the same product pack
    digest, the same production component (`knowledge.produce@1`), the same build as listed now (release date, line,
    platform, single sources, the roles that hold lists; then every list by its digest), the same external sources (read
    or missing), when it has model-placed spans the same model and threshold without judge failures, and every optional
    source that was missing is still unreadable (re-read on every sync, once per external id); `recheck` also re-reads the
    sources read then and produces when a digest changed. For a list (decision 16) the listed ids must be the same (their
    digest), the skipped ids kept with `retry` (first 50 per list) are loaded again on every sync and the build is produced
    again once one loads; `recheck` reads every listed id again through the port (records and digests only: no bytes are
    fetched and nothing is parsed, so no document is held) and produces when the [id, digest] pairs of what reads now
    differ from those of every object read then (`ListDetail.read`), whatever was then skipped. Each retried or rechecked
    load is reduced to its outcome or digest as soon as it is done, at most `listReadConcurrency` at a time.
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
    when such a member was refused, left unplaced or has no catalog data (other producers' losses do not count), or when a
    listed source its producer could have given members from was skipped (decision 16; C07 R[1]: absence is a fact only
    for a complete catalog): the catalog's producer, or, when it names none, every producer that gave entries of the kind
    in the root or gave none whose kind is known; `case_sensitive` as declared; the nearest common ancestor of the members is the view's reference; null without
    members. Catalog views are cached per composition; the members of a composition in parts are read from the parts of
    the catalog's kind only (decision 20).
15. **Layers** (K03): observations are appended by the Hub's own verification runs (the echo must be a stored source;
    no run id) and read with the product, by cursor. Contributions come only through dedicated contribution runs,
    with every item requirement satisfied. The boundary verifies verbatim quotation, the run scope, locked-root source
    membership, target path and actual Hub lineage; it accepts no submitted provenance, grade or applicability. Product
    readers see them beside nodes, with source, submitter, session, time and conservative judgment attribution. Every
    reader, including administrators, passes the product-reader port. A changed path fragment shows 被引片段已变（根 X → Y）.
    Candidates remain in Circle; neither layer enters the root digest.
16. **List slots** (product@1 `ProducerSource` `many`, `ProducerInput.lists`/`batch`, `FragmentRef.source`). An input
    `{source, many: true, batch}` reads every external object the build lists in that role (one id is a list of one;
    repeats are read once, with a warning); a list role read by an input without `many` fails the production, and a
    producer has at most one list input. The ids are cut into consecutive batches of `batch` (default 50) in list order;
    an empty list, or a missing role of an optional input, is one empty batch (the producer runs once); a missing role of
    a required input fails the production. Every element is loaded like a single source (decision 4: the admin's context,
    the record the connector read returned, shared-credential visibility, model-readable tier, an inspected scan, the core
    parser for the media type), in two steps: the elements of a batch are read first (their records and sizes, no bytes),
    the batch is cut into consecutive calls whose documents hold at most `maxBuildBytes` together by those sizes, and a
    call's documents are fetched, checked and parsed only when its turn comes, so at most `maxBuildBytes` of documents
    (and their parsed models) are held per batch; a document over `maxBuildBytes` alone is skipped (`retry: false`). At
    most `listReadConcurrency` (4, option `readConcurrency`) reads or loads run at a time per production,
    `batchConcurrency` (2) batches at a time. The function gets `lists[slot]` (the call's elements in list order) and
    `batch: {index, of}` (the batch the call belongs to); its single slots are the same in every call. Outputs are
    concatenated in batch order and element order (refusal indices count over the concatenation). A fragment in a list
    slot names its element by `source`, the element's digest; a digest outside its own call's elements is refused (an
    entry must not depend on another call), and a single slot's fragment that names `source` must name that slot's digest.
    Each call is verified while its documents are parsed and keeps only verified entries and source rows. A document that
    cannot be read (`retry: true`), checked or parsed (`retry: true`), that is over the cap alone or that the producer
    fails on alone (decision 19; both `retry: false`) is skipped: listed with external id and reason in the composition
    (`skipped`, first 200, `skipped_count`), in the production result and the sync report; its producer's catalogs are
    no longer complete (decision 14) and every view of the root says so (decision 22). When more than `maxSkippedShare`
    (0.5) of a required list's ids are skipped, the production fails with the counts by cause. An optional list uses a
    share of 1: skipped documents stay in `skipped` and do not drop the root (a case index must not take the command
    tree with it). Each list element carries `external`, the object it was read from, and the memo of a list call includes
    that id so two documents with equal bytes stay two calls.

    The build is recorded with each list role by reference, `{list, count}` (`RecordedBuild`
    in the composition and the generate action), the listed ids kept once as an object named by `list`. The generate
    action summarises each list (count, digest of the listed ids, digest of the [id, digest] pairs used, digest of the
    pairs of every object read, the first 50 skipped ids with `retry`); its `sources` and `inputs` keep the single sources
    only. A list element's basis is that of a build role.
17. **Stored reads used again** (`max_age_seconds`). Every read of a list element through the port that gives a record
    writes a `read` action (`knowledge.sources@1`, index `knowledge.read` = external id) naming the source_artifact record
    and the digest. A later read of the same id within `listMaxAgeSeconds` (86400; option `maxAgeSeconds` per production
    or sync, CLI `--max-age`; 0 reads every one again) uses that record, and its bytes are fetched through
    `Artifacts.source` pinned to it, so every check is applied again with the admin of this sync; when one fails now (the
    record became unreadable, a finding was accepted since and a new read would pass), the object is read again. The age
    is counted from the read action. A dry run writes no read action. An id too long for the index is always read.
18. **Memoized producer calls.** A call of a list producer is keyed by SHA-256 of the canonical JSON of everything the
    function receives: the component (`knowledge.producer@1`), the pack digest, the producer id, its function reference
    and params, the build as handed to it (by the digest of its canonical JSON, list roles included), the list slot's name
    with the batch position `{index, of}` and the call's elements in order, and the other slots, each element and slot as
    `{sha256, media_type, parser}` (null for a missing optional slot). A stored output therefore stands for exactly that
    call: a list producer may read `input.build` (applicability, the line) and still gets its own build's output, and a
    root never depends on what was produced before (K01 R[1]). Every producer, with or without a list, receives
    `build.root: null`: the root is what the production makes, and the previous root a sync knows would make the output
    (and so the root) depend on production history. The validated output, as canonical JSON, is an object
    (`Objects.put`), referenced from a `generate` action (component `knowledge.producer@1`, index `knowledge.memo` = key,
    inputs the `src:` references of the elements and slots). A call that failed in a way a smaller call can avoid
    (decision 19) is stored the same way with result error and the producer's sandbox limits; under equal limits the
    failure is used again without running the call. When the key recurs the newest stored outcome is used; an output that
    does not read back or validate is a miss. A reused output is verified like a fresh one, so reuse never changes a
    digest. Reported as `calls: {made, reused}` (stored failures among the reused) in the production result, its generate
    action and the sync report. Invalidation is by key only. An output the object store cannot keep (over its size limit)
    is computed again next time, with a warning. Producers without a list slot run once per production and are not
    memoized. Consequence: batches are shared within a build (a changed document re-runs only its call), not across builds
    or a changed list (Needs, contracts).
19. **A document the producer fails on.** A call that fails in a way a smaller call can avoid (the function threw, its
    output was too large or outside producer-output@1, its input over the sandbox limit, the memory limit, the time limit)
    is split in halves, down to the single document it fails on, which is skipped (`retry: false`). Before any split, the
    producer must work on an empty batch (one call per production; else the production fails with 是生产器本身的问题).
    The production fails instead of blaming documents when: no call of the producer with at least one document succeeded
    in this production (made or stored) while some document failed alone; every document of a batch of two or more
    failed alone; the calls made to isolate documents (each part of a failed call) reach `isolationCallsPerBatch` (16) ×
    (the list's batches + 4); or more than `maxTimedOutCalls` (16) calls of the production ran past the time limit. A failed call and its parts are memoized (decision 18), so the next production of the same input replays the
    split from stored outcomes without a sandbox call. Every other sandbox failure fails the production.
20. **Large roots in bounded records.** A node holds at most `maxNodeEntries` (20000) entries: further entries for a full
    node are refused with the reason (in output order, so deterministically), never moved to a made-up path (K01 R[3]).
    When the composition rows, the unplaced rows or the list sources exceed `inlineRows` (1000), they go to part records
    beside the `tree_root@1` record: composition rows grouped by kind (code-unit order) with the content of their entry
    (`tree_root-rows@1`; a scan by kind reads its own parts and views read a root in bulk), unplaced rows by entry
    (`tree_root-unplaced@1`; the part does not repeat the entry content, so a facet or index scan reads the entry records
    in batches), list sources by digest then external id (`tree_root-sources@1`). Each group is split at
    content-defined boundaries (after a row whose entry or source digest's leading 32 bits are 0 modulo 512, once a part
    has 64 rows; at most 2048 rows or about 2 MiB), so that a change moves only the boundaries around it. A part is
    content-addressed (index `knowledge.part` = SHA-256 of its canonical schema and body), written in its own
    transaction and found instead of written again by a later root (unchanged cases of a new build share every part).
    The `tree_root@1` record then holds the part references (kind, rows, first and last sort key), the single sources,
    counts, `kinds` (rows per entry kind), refusals, skipped sources and warnings, and empty `composition` and
    `unplaced`. Writes are chunked: nodes not yet stored are found level by level from the root (a stored node's subtree
    is complete and shared), the entries of the new nodes and of the unplaced rows not yet stored for the product are
    checked eight at a time and written `writeChunk` (500) per transaction, `writeConcurrency` (4) transactions at a
    time, then the nodes by height from the leaves up (a node only after its whole subtree), then the parts, then the
    composition record with the generate action in one transaction: no root exists before that last transaction.
    `CompositionView` reads both forms: the rows at a path by binary search over each kind's parts (a cache of at most
    48 parts and 64 MiB of their JSON text), every row of some kinds part by part without filling the cache. Tree reads (get_nodes, the TreeReader) use
    a part row's content only when it hashes to the entry digest, else the entry record.
21. **The entry-level version difference** (`KnowledgePort.diffEntries`, K01 R[1]). Both trees are walked in parallel by
    digest (equal subtrees are never read) to the nodes whose own entry lists differ, a node on one side only included;
    the kinds of their entries come from the composition rows at the path (newest composition of each root), else from
    the entry records. A path is a change when its entries of the given kinds differ: `added` (none before), `removed`
    (none after), `modified`, with both digest lists sorted; changes are sorted by path text in code units, at most
    `limit` (default 20000) with `total` and `truncated`. `diffRoots` is unchanged.
22. **The knowledge views** (`createKnowledgeReader`, `contracts/src/views.ts`). Ids `knowledge:impact:<product>:<from>..<to>`
    (`changed`, `attached`; default definition, behaviour and case), `knowledge:facets:<product>:<build>?kind=&by=` (one
    to six distinct field names), `knowledge:index:<product>:<build>?kind=&key=[&only=][&fields=]` (at most 1000 values), and `knowledge:impact:<product>:<from>..<to>[&changed=&attached=][&attached_fields=][&catalog=]`; query
    values comma-separated and percent-decoded; the two builds of an impact id are split at the first literal `..`
    before decoding (an escaped `.` stays in a name); the revision is the trailing `@<root>[..<root>]`, so a query value
    may hold a literal `@` (a catalog name like `commands@1`, `%40` reads the same); an unknown or repeated parameter, a
    kind outside `entry_kind`, a catalog name outside `name@major`, a
    field name outside `DataFieldName`, an empty value or a pinned `@revision` other than the current one is malformed.
    The product resolves by id or any name, a build of any family and case through its aliases to the root it uses
    (`rootOfBuild`), shown in its stored spelling; the reader must be an enabled admin or read the product
    (`PacksPort.readableProducts`). Refusals are `ok: false` with the Chinese reason for the admin log (the engine shows
    SOURCE_UNAVAILABLE). Every list is cut by its exact canonical bytes against `maxViewBytes` (15 MiB, the core JSON
    parser of a run reads 16 MiB) less 64 KiB for the fixed fields and notes, and the whole answer is checked once more
    (trailing items dropped until it fits), so a cut answer is always served; the totals count everything. A root whose
    composition skipped listed sources (decision 16) gets a note naming the build, the count and the producers: what those
    sources would give is unknown, not absent. *Impact*: the changes of decision 21 for the changed kinds; placements are
    the attached entries filed exactly at a changed path in each root (only paths that have some). Unplaced entries are on
    no path and stay out of this view. Every named entry is cited once,
    in the later root where it is on the later side of a kept path, else at its first path in the later root when
    it is there (found by reading the rows of its kind), else in the earlier root; paths kept in path order at
    MAX_IMPACT_PATHS, MAX_IMPACT_ENTRIES or the byte budget, the content of an entry read only for kept paths; notes for a
    cut, equal roots and roots without the attached or changed kinds. With `catalog=<id>` only the members of that catalog
    count as changes, read per root like the catalog reader (the kind and the producer from the product's declaration for
    that root) and compared by syntax — catalog-entry@1 without the descriptive fields (parameter descriptions, the entry
    summary), the per-root references and the signature ids, overloads as a set; members differing only in those are not a
    change and are counted in a note. `changed` may then be omitted (the catalog's kind) or must equal it, anything else is
    a refusal, and so is a root that does not declare the catalog (the reason names the build, never an empty answer). The
    answer names the catalog in `catalog`. With `attached_fields=<name,…>` the attached entries
    carry only those data fields and an empty statement, the byte accounting uses the slimmed size, and the changed entries
    are never slimmed (a diff needs their full data); the answer records the fields it carries (`attached_fields`) and says
    so in a note. *Facets*: distinct entries of the kind, the rows hung
    on the tree and the unplaced rows of the root (K01 R[4]: they stay under the root, marked unplaced). An entry counts
    once; one that is also hung keeps that path. An unplaced entry is cited at `/`, the existing tree reference
    `tree:<root>/@<digest>`. `total` includes them, and when there are any a note says how many (`未挂到树上位置的条目 N 个，标在根下，计入合计`); the note counts entries (each once, even when a document produced several), never documents or rows.
    A list field counts once per distinct element, a missing field, null and an empty list count as null, a value that is
    not a scalar as its canonical JSON text (noted); an entry whose field combinations exceed 4096 is counted in `total`
    only (flagged); at most `facetCombinations` (100000) distinct combinations are collected, later new ones are left out
    (flagged, the listed rows then being those met first); rows sorted by the canonical JSON text of their values, field by
    field, in code-unit order (facet-view@1), at most MAX_FACET_ROWS or the byte budget. *Index*: the same entries. The
    text of each value (strings as they are, other values as canonical JSON, null and missing never), only the `only`
    values when given (those without entries are noted), keys in code-unit order, built from pairs (a key is always an own
    member), at most MAX_INDEX_PER_KEY digests per key and MAX_INDEX_ENTRIES entries or the byte budget, cut before a key.
    The optional `only` response field echoes the requested values, deduplicated and sorted in UTF-16 code-unit order;
    it is absent without the parameter. Generated views always include `cut_keys`: the listed keys cut by the per-key
    cap, sorted in the same order, or `[]` when none were cut. Whole keys omitted by the byte or entry budget are not
    per-key cuts. Existing notes about missing requested values and per-key cuts remain. Consumer follow-up:
    `packs/workflow/defect-to-case` should read these fields instead of parsing the URI or inferring cuts from list length;
    that consumer change is outside this task.
    With `fields=<name,…>` (only this view) the entries carry only those data fields and an empty statement, the byte
    accounting uses the slimmed size, and the answer records the fields it carries (`fields`) and says so in a note, so a
    big index fits the byte budget. MAX_INDEX_ENTRIES is 200,000 since `fields` exists: the byte budget is the effective
    bound and the entry cap only guards an injected bigger one.
    An unplaced entry is cited at the root, and only its own reference reads it back (`tree:<root>/@<digest>`): get_nodes
    lists the entries hung on nodes, so no walk of the tree enumerates them while `total_keys` and `total_entries` count
    them — a consumer that needs every key of a truncated index follows the view's own `next` continuation and
    cross-checks the counts against the facets view of the same scan.
    When any entries of the kind are unplaced, a note says how many
    (`未挂到树上位置的条目 N 个，标在根下`), including entries that carry no value of the key; `total_entries` stays the entries that carry a
    value. The value `__proto__` is not listed as a key (a JSON reader that builds plain objects would take it for the
    prototype; noted, counted in `total_keys`); the content of an entry is held during the scan only while the held
    entries fit the budget, and a listed entry not held is read in a second scan of the same entries. The answer is built, checked against its schema (the built object
    is stored, never a parsed copy) and stored as the original (`application/json`, generated by `knowledge.views@1` from
    `tree:<root>/`, projected, readable by the caller and admins, not shareable) with a `meta` artifact (a Chinese title).
    Credential acceptance follows only the actual composition(s): the generated origin pins their record digests beside
    the tree roots, and offers their original/derived source byte digests to records (`derivedSources`). Records verifies
    current acceptance and complete, exact finding coverage in memory; knowledge never receives matched text. One
    `prepareDerived` operation batches the actual graph/scan/authorization reads and collects accepted source matches
    once; all parts and final ingestion share its opaque matcher. An entry
    (impact/index) or row (facets) with complete coverage stays, with a note counting covered entries (facets count rows).
    Covered parts are considered in digest order (facet rows in canonical key order), reserving the unchanged 100-hit
    whole-file budget for fixed content, parts and each retained index key once. A part that would overflow stops later
    hit-bearing parts being retained; non-hit parts remain. Notes distinguish covered retained parts from parts omitted
    for the whole-file limit. Uncovered entries/rows are left out with their references and the answer is computed again;
    a changed entry with an uncovered hit takes its path out, an attached one only itself. The complete answer is then
    ingested and checked again; a remaining uncovered hit refuses the read. If serialization context adds unexpected
    hits that truncate the full scan, one conservative recomputation omits all hit-bearing parts (the previous safe
    behavior), never rescanning every prefix. The unfiltered answer alone is cached:
    every read rechecks coverage, so a withdrawal filters a warm cache too and never serves the earlier accepted answer. Revision: the root digests
    joined by `..`; manifest: a `generate` action of `knowledge.views@1`. Equal content gives equal bytes; a computed
    answer is kept in memory (4) by request and roots. `routeKnowledgeViews(views, connectors)` gives the run engine one
    reader; the knowledge service itself reads through the connectors only.

## Limits

- The plan input holds the parsed model of every page read so far (the contract); a very large site can exceed the
  sandbox input cap (128 MiB here), which fails the sync with the reason.
- The plan's answer repeats every list in every build that lists it (the contract) and is at most 64 MiB, the sandbox's
  largest output: about one million listed ids of 60 bytes in one sync (measured: 300 builds of 300 ids of 225 bytes,
  20 MB, read in about half a second). More fails the sync with the reason (Needs, contracts: declare a list once).
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
- `builds()` and the pointer reconciliation read every build record of the product (one per change of a build's
  identity, never per list change) and one production per base build (an indexed newest-first lookup).
- A credential found later in a source already in a root does not hide the tree's text; produce again.
- An entry record is written per product the first time it appears; a subtree shared from another product's root does
  not add records for this product, so `entry:` reads of those entries are answered for the first product's readers only.
- `diffRoots`, `diffEntries` and `builds` take no reader (the port); callers check the reader first.
- Stored producer outputs are shared within a build only: another build, or a changed list of the same build, runs every
  batch again, because the build (its list included) is part of what a list producer receives (decision 18; measured:
  the second build of the scale corpus makes all 61 calls in 10,100 ms instead of 1 in 8.8 s). Batches stay consecutive
  slices of the listed ids; content-defined batch boundaries would help only once list calls receive no build (Needs,
  contracts), since until then any change of the list changes every key.
- A list producer's entries must depend only on their own document: the Hub calls it on parts of a batch to isolate a
  document it fails on and to keep a call within the byte cap (decisions 16, 19). A producer that combines documents of
  one call can give other entries for a split call (the contract says only "not on another batch"; Needs, contracts).
- A call that timed out is split like any isolatable failure, and how a batch is split then depends on the machine's
  load: for a producer that follows the rule above the root is the same either way.
- A plain sync tries again only the first 50 skipped ids of a list; with more, `recheck` reads all of them again.
- A production with more than half of a list skipped fails (decision 16): a build whose documents are mostly unreadable
  for a while keeps its last root (or none) until enough of them read again.
- A node over `maxNodeEntries` refuses the excess entries; nothing splits a node.
- Chunked writes are not one transaction: a production that fails after some chunks leaves nodes, entries and parts
  behind (content-addressed and complete bottom-up, shared by the next production), but no root and no completed
  production.
- The views trust the entry content in composition parts (the record digest is verified when a part is read and the
  content was verified when the root was produced); get_nodes and the TreeReader verify each entry digest again.
- A view answer is cut at `maxViewBytes` so that a run's core JSON parser (16 MiB) can read it; the measured impact
  view of 400 changed paths with 18,000 attached cases is 13 MB, close to that budget, and the index of 180,000 cases by
  document is cut at 409 of 3,000 keys (15.6 MB).
- The views' notes are the only place a reader learns that skipped sources make an answer incomplete: a pack function
  cannot read them reliably (Needs, contracts: a machine-readable field).
- A view retains credential hits only with complete coverage from its pinned composition sources under current
  acceptance. Novel text from a producer and unrelated accepted sources provide no coverage. An entry cannot inherit
  through an upload or human-authored intermediate. Facet coverage notes count rows, not distinct source entries.
- Besides the entries it answers with (bounded by the budget), a view holds the digest, path and size of every carrier
  of its scan (index), every distinct combination up to `facetCombinations` (facets) or the digests of every changed
  path (impact): that part grows with the root, not with the answer.
- The caches of computed views (4 answers), part content keys and parts live in one process; another process finds
  stored parts through the records and computes views again.
- `builds()`, `resolveBuild()` and `RootInfo.build` carry no list roles (decision 10): a caller that needs the ids a
  build lists reads them from its production (`{list, count}`, the object of `list`).

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
- Placement opt-in: path-less entries only enter placement (`toPlace`) when their producer declares `placement: "judgment_allowed"`. By default (`code_only`), path-less entries stay unplaced at the root; skipped entries are counted per producer in the production record (`placement.skipped`) and sync report. The Hub calls no model (owner decision 2026-10-22): even declared entries are never placed by the Hub — they stay unplaced, marked 未挂到树上位置的条目 — and the Hub will only offer them to the bot for placement proposals and verify each proposal with deterministic rules (not implemented yet).
- The memo key identifies every element and slot by `{sha256, media_type, parser}` and adds the production component
  (`knowledge.producer@1`), not by the digest alone: the function receives all three, and a Hub with another parser
  version gives other models. It also covers the build and the batch position, which the function receives too.
- Every build producer receives `build.root: null` (ProducerInput.build is a KnownBuild); product-wide producers omit build: the root is what the production
  makes, and handing the previous root would make a root depend on production history (decision 18).
- A batch the producer fails on is split to find the document instead of failing the production, and a batch over the
  byte cap is handed in several calls (decisions 16, 19): the contract speaks of one call per batch.
- A production fails when more than half of a list is skipped, when the producer is not shown to work on documents, or
  over the isolation budget (decision 19); the brief says only that a failure of one build never stops the others.
- The plan's answer is checked build by build (a bad build fails alone), not as one sync-plan-output@1 (decision 12).
- `tree_root@1` gained optional `parts`, `skipped`, `skipped_count` and `kinds`, its `build` keeps list roles by reference
  (`RecordedBuild`), `knowledge-build@1` keeps single roles only and gained `lists`, and the three part schemas are new,
  all in place (still no Hub has written them); the integrator should confirm this or ask for `@2`. Composition parts
  repeat the content of their entries (the entry records stay) so that views and catalogs read a large root in bulk.
- Facets count a missing field, null and an empty list as null, a value that is not a scalar as its canonical JSON text,
  and leave out (flagged) an entry whose field combinations exceed 4096; their rows are in code-unit order of the
  canonical JSON text of the values (facet-view@1 says "the values in code-unit order"; read so, `"1"` sorts before
  `1`, `10` before `9`, strings before `false`, `null` and `true`). Index keys are the text of the values, so 1 and "1"
  share a key, and `__proto__` is never a key. A view read also returns a `meta` artifact (its title), and a pinned
  `@revision` must be current.
- A view leaves out entries or rows with uncovered credential findings, with a note, instead of refusing the read
  (decision 22).
- `max_age_seconds` applies to list sources; single sources are read whenever a build is produced, as before.

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

Milestone 2 (`lists.test.ts`, `memo.test.ts`, `views.test.ts`, `lists-sync.test.ts`, `scale.test.ts`): list slots in
batches (boundaries and order, element digests in fragments, the summary in the generate action), documents that cannot
be read or whose connector fails, hostile documents (a credential hit, a JSON document that is no mind map and makes the
producer throw, a document that crashes it, bytes no core parser takes; each skipped in list order, the producer's
failures isolated by splitting), a fragment naming a digest outside its batch, a producer that fails on an empty batch
too, the byte cap of a batch, optional and missing lists, a role of one id, a list read without `many`, two list inputs,
repeated ids; stored loads used again within `max_age_seconds`, read again with 0, after a day, and after a credential
finding was accepted; the node entry cap; memoized calls (stored outputs and their records, another build running every
batch, the same root with and without stored outputs, one changed document re-running only its batch, other tree bytes
re-running every batch, a previous root not changing a key, the memo key recipe with the build and the batch);
compositions in parts (the same answers as one record for get_nodes, references,
provenance and catalogs; parts by kind; parts found instead of written again); the views against hand-computed answers
(every change kind, attached entries on both sides, case-only changes, the reverse direction, equal roots, kinds no root
holds, truncation by the byte budget with full totals, diffEntries with limits and unknown roots, facets over scalar,
list and missing fields, the combination cap, placed and unplaced entries counted once with the unplaced ones cited at
the root, a root of 60,000 unplaced entries, index with `only`, the index byte budget, aliases and product names,
determinism, the stored answer's readers, the revision pin, the manifest, the permission refusal, a disabled reader,
unknown products and builds, 17 malformed ids, the router); the sync of a build whose plan lists 500 documents (first
sync, an idempotent rerun that reads only the failed document again, its appearance re-running one batch, recheck with
a changed document and without one); and a reduced scale run (300 documents of 20 cases: parts, reuse of every load on a
second build, shared case parts, the impact view equal to a command-level diff computed from the corpus and placements
exactly the cases on the changed commands, facets and index equal to the corpus counts).

The review of milestone 2 (`review.test.ts`, one scenario per finding, each failing on the reviewed code and passing now):
a list producer that fails on every non-empty batch or answers outside the contract (the production fails, the sync
reports it, no current root moves), a failing document's split replayed from stored failures (one sandbox call on the
second production), more than half of a list skipped, the isolation budget, a document that times out alone (isolated
and skipped), a skipped document withdrawing catalog completeness (the catalog's producer, and a catalog naming none)
and noted by the impact, facet and index views, a list producer that reads `input.build` (its own build's line and
applicability; the same root as in a fresh database; no change over a previous root), a recheck with 52 documents over
the cap (skipped, not produced again), `__proto__` beside `constructor` and `toString` as data values (index, `only`,
facets), a view over an entry whose source's credential findings were accepted (retained with current coverage, removed
again after withdrawal even from a warm cache, with its reference in a note; novel text and unrelated accepted sources
never cover it), lists kept by reference (no ids in the build record, the generate action or the composition; the list
object; no new build record for a changed list; no list roles in `builds()`, `resolveBuild()`, `rootOfBuild()`), a plan
answer of 20 MB and a plan build with a bad list id, a batch over the byte cap handed in two calls with no document
fetched before its call (instrumented `Artifacts.source` and object store), an attached entry that moved to an
unchanged path cited in the later root, `diffEntries` with NaN, infinite, negative and fractional limits, an escaped
`..` in a build name, the facet row order over mixed types, an index of 1,200 quote-heavy entries and a facet of 120
long titles cut by exact bytes and served, distinct facet combinations over the limit, and an index whose listed entry
is read again in a second scan. To show the failures, the reviewed code was rebuilt in a scratch copy of the worktree
from the files as read before this change (the original suite gives the same 146 passes there) and the file was run
against it: 21 of 21 fail, each on the finding's behaviour.

## Derived acceptance complexity guard

`derived-scale.test.ts` uses real temporary PostgreSQL and synthetic content only. Its root has 3,000 sources,
20 currently accepted credential-bearing sources and 200 credential-bearing case entries. Historical held records
are used as source pins; eligibility follows effective acceptance, not their admission-time tier. In digest order,
100 entries are retained and 100 omitted for the whole-file scan cap; the delivered bytes have exactly 100 findings,
no truncated scan, and remain model-readable. The view's own truncation flag and notes disclose the omissions.

| Operation | Database queries | Credential-scanner calls | Credential-scanner bytes |
| --- | ---: | ---: | ---: |
| Generate view | 42 | 224 | 219430 |
| Read stored view | 7 | 0 | 0 |

The 224 scans are 20 accepted sources (45910 bytes, collected once), 200 entries, one index key, the fixed skeleton,
the final complete answer and its meta artifact. Assertions cap generation at 128 queries and read at 16, enforce this
source/entry-linear call count and a linear byte bound, and refuse any credential scan during a read. SQL and byte
budgets fail fast; fixture setup is excluded. These are complexity counters, not real-environment latency claims.
A separate multi-megabyte read test checks that source/text fetch only their requested bytes and readability checks
fetch no bytes for credential verification. Preview mutation and stale/foreign matcher handles cannot forge admission.

## Scale (measured on this machine)

Measured on 2026-10-22 on the development Mac (macOS, Node 24.17, 15 cores, 48 GB), temporary PostgreSQL from
`hub/testing`, pack functions in the real sandbox under `sandbox-exec`, by a generator and a measuring script kept outside
the repository. Corpus: a catalog of 4,000 commands (40 groups of 100, one integer parameter) for build A and the same
catalog with the range of 400 commands changed for build B; 3,000 KityMinder documents of 60 cases each (180,000 cases,
36 MB), each case on one command (45 per command), a defect id on every tenth case. Producers: the synthetic command
producer and list producer of `test-support.ts` (batches of 50). The external reader reads the generated files from disk
on demand and stores every read as a connector does. Both builds list all 3,000 documents.

| Step | Wall time | What happened |
| --- | --- | --- |
| first build | 49.1 s | 3,000 reads, 61 producer calls, 184,000 entries, 4,042 nodes, 332 part records (324 of rows) |
| second build | 8.8 s | 3,000 loads used again (one read: the new catalog), 60 of 61 calls from stored outputs, 442 new nodes, 316 of 324 row parts shared |
| impact view A..B | 3.1 s | 400 changed paths, 18,000 attached cases, 18,800 entries, 13.1 MB, not cut |
| facets (case by module, has_expected) | 1.2 s | 20 rows over 180,000 cases |
| index (case by defects) | 1.5 s | 50 keys, 18,000 entries, 11.7 MB |
| the same index again | 0.2 s | answered from the computed-view cache |

Measured again on 2026-10-22 after the review's fixes (same machine and corpus, a measuring script outside the
repository; the batches of the second build are no longer shared with the first, decision 18):

| Step | Wall time | What happened |
| --- | --- | --- |
| first build | 41.6 s | 3,000 reads, 61 producer calls, 184,000 entries, 4,042 nodes, 336 part records |
| second build | 10,100 ms | 3,000 loads used again, 61 of 61 calls made (another build), 442 new nodes |
| the second build again | 5.6 s | 60 of 61 calls from stored outputs, the same root |
| impact view A..B | 2.3 s | 400 changed paths, 18,000 attached cases, 13.05 MB, not cut |
| facets (case by module, has_expected) | 1.3 s | 20 rows over 180,000 cases |
| index (case by defects) | 1.7 s (0.1 s again, from the cache) | 50 keys, 18,000 entries, 11.7 MB |
| index (case by document) | 3.7 s | cut at 409 of 3,000 keys, 24,540 of 180,000 entries, 15,640,062 bytes (at most 15,728,640): served |

The resident set of that process (sampled every 100 ms, the corpus and the fake connector's store included) peaked at
1,901 MiB during the index by document.

Every answer was checked against the corpus: the impact view's changed paths equal the command-level diff the generator
wrote from the two catalogs, its attached cases are exactly the corpus's cases on those commands, the facets count all
180,000 cases and the index has the corpus's 50 defect ids. The composition record stays at 126 KB. Memory of the Hub
process: 1,686 MiB maximum resident set (kernel figure from `/usr/bin/time -l`; 1,669 MiB sampled every 100 ms), most of
it garbage the collector had not yet reclaimed: with a full collection forced every 500 ms the live heap (heapUsed plus
external) peaked at 343 MiB and the resident set at 1,001 MiB; with `--max-old-space-size=1024` the run took 51.3 s,
9.7 s, 2.9 s, 1.5 s and 1.6 s at a 1,184 MiB peak. Two earlier runs before the last memory changes: 57.9 s / 11.7 s /
5.9 s / 2.2 s / 3.4 s at 1,628 MiB, and 48.9 s / 9.4 s / 3.1 s / 1.4 s / 1.6 s at 1,609 MiB. Not measured: the sandbox
children (each limited to 1 GiB plus headroom by the producer limits) and PostgreSQL's own memory, real connectors and
networks, a typed-judgment model placing spans (every synthetic case has a command), and real mind maps (their statements
and data are larger than the synthetic ones, so the impact view of a real version difference may be cut at the byte
budget). The suite runs a reduced version (`scale.test.ts`: 300 documents of 20 cases, about 4 s on this machine).

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
- **runs**: lock with `rootForRead` / `lockRoot(product, {build})` or `{line}` (the line's seedling root when that
  pointer names one, otherwise `rootOfBuild` / `currentRoot`). A view that reads the seedling while the same build
  still has a different sync root names both digests in `notes`. Keep `RootInfo.composition` with the run and resolve
  the run's tree references with a reader bound to it once the port allows; every `KnowledgePort` method takes the
  product line id, not a product name. If production runs of workflow packs should move current roots later, a way to
  check that a run id is a completed production run of the product.
- **server**: register `knowledgeCliCommand` in the assembly; pass the knowledge service as `KnowledgePort`; supply the
  admin principal; route knowledge-contribution@1 record reads through layers.contributions.read before any admin
  bypass, and treat
  `tree_node` records as non-groundable (they already are not in refs' groundable kinds); `provenanceOf` now needs the
  caller's principal.
- **connectors**: store sync reads with the visibility of a shared credential (`admins: true`); a personal-credential
  read is refused by the knowledge package.
- **packs**: the real product pack's sync and producer functions must take and return `SyncPlanInput`/`SyncPlanOutput`
  and `ProducerInput`/`ProducerOutput` (`contracts/src/product.ts`); today they have their own shapes. Kinds must be
  `entry_kind` codes (the pack already uses `definition`); since the command tree and the manual both give
  `definition` entries, declare the command catalog with `producer` set to the command-tree producer. Paths must be
  canonical tree path text and fragments must name their slot when a producer has more than one input.

Milestone 2:

- **ports, runs and server (integrator)**: `KnowledgePort.diffEntries` is new in `hub/ports.ts` (with `EntryDiff`); the
  fakes that implement the port do not compile until they add it: `FakeKnowledge` in
  `hub/runs/engine/testing/knowledge.ts` and in `hub/server/fakes.ts` (for example
  `async diffEntries() { return null; }`, or a fake over their toy trees).
- **server (assembly)**: give the run engine `routeKnowledgeViews(createKnowledgeReader(knowledge), external)` as its
  `ExternalReaderPort`, and keep the connectors' reader alone as the knowledge service's `external` (the views are not a
  source of the tree). `KnowledgeRecords` now takes `objects` (the records kit already has it). Register the
  `knowledge` external type where the console lists resources, if it should appear there.
- **runs**: none for lists: `builds()`, `resolveBuild()` and `RootInfo.build` carry no list roles any more (decision 10),
  so the stripping in `hub/runs/engine/target.ts` (`selectCandidate`) is now redundant but harmless.
- **contracts** (milestone 2, after the review): (1) Product-wide producers now omit build; cross-build list calls without build-specific input still need a separate declaration: `ProducerInput.build`
  absent (or a fixed, build-free context) for a producer with a list slot, or a `Producer` flag that declares its output
  independent of the build; the reuse key could then leave the build out again (another build listing the same
  documents shares every batch) and content-defined batch boundaries would let an inserted document re-run only its
  neighbourhood. Until then the key covers the build (decision 18). (2) Say on `ProducerSource.many` that an entry must
  depend only on its own element, not on the other documents of its call: the Hub calls a producer on parts of a batch
  (decisions 16, 19). (3) A machine-readable completeness field on impact-view@1, facet-view@1 and index-view@1 (for
  example `unknown: {skipped_sources, producers}`): today the notes alone say that a root's skipped sources make an
  answer incomplete, and a pack function cannot rely on Chinese text. (4) State the row order of `FacetView.rows`
  precisely (this package reads "the values in code-unit order" as the canonical JSON text of each value) or change it.
  (5) Let a plan declare a list once and builds refer to it by role, so that one sync is not bounded by repeating every
  list in every build (64 MiB of plan answer). (6) Say whether `ProducerInput.lists` may hold more than one slot (this
  package allows one list input per producer). (7) Say on the views that an answer is cut to fit a run's JSON parser
  (16 MiB), with the truncated flags already there.
- **view delivery follow-up**: separately admitted parts/chunks are not implemented. The current whole-file scanner
  cap is unchanged; budgets omit later hit-bearing entries instead of producing an unreadable answer. A part-wise
  coverage or delivery format requires a separate decision.
- **records**: (1) **Done** (records decision 19): `derivedSources`, exact in-memory coverage and source/decision-only
  receipts carry an administrator's acceptance through verified Hub-owned ancestry. Views pin the actual root
  compositions and their source records, prepare one shared matcher with `prepareDerived`, and assess each entry/row
  through that matcher in memory. Ingest checks the complete artifact; reads validate immutable scan facts and
  live decisions without re-scanning source bytes. No matched-text fingerprint is used or stored. (2) **Bulk APIs now available:** coverage uses `findMany`/`getMany`; adoption in the other per-entry existence checks
  of a first production (184,000 queries on the measured corpus) and stored-read lookups remains a separate follow-up.
- **platform**: consider starting the persistent Hub with `--max-old-space-size=1024` (or 1536): on the measured corpus
  the resident set stayed at 1.2 GB instead of 1.7 GB at the same speed (see Scale).
- **packs (agile-case-index)**: list case documents in a stable order, new ones last; give every fragment of a list slot
  its `source`; make each entry depend on its own document only (the Hub may call the producer on part of a batch); the
  producer may read `input.build` (the key covers it), at the price of batches not shared across builds; keep the
  documents it cannot handle rare (more than half of a list skipped fails the production); give cases data fields the
  views can count (`module`, `line`, `has_expected`, `defects`, ...) as scalars or lists of scalars, and avoid the value
  `__proto__`.


## Composition-pinned literal relations (kb-links, first step)

Relation preparation reads tree nodes in batches of at most 128 instead of issuing one indexed read per node. Each node
uses the same oldest indexed record and digest/shape validation as the single-node reader; missing or invalid records still
produce the existing repair outcome. After prefetch, relation sources are processed in the original depth-first order,
including a shared digest reached at more than one path. The computation still examines the full declared relation scope;
batching reduces storage round trips and does not establish a wall-time bound for an arbitrarily large composition.

The product's optional `links` array declares `id`, a top-level literal `field`, a target `namespace`, generated `link_match`,
and an `entry_kind` (required for longest-prefix matching). Only declared boolean normalizers are supported: `lowercase`,
`nfc`, `nfkc` and `strip_nul`; NFC and NFKC are mutually exclusive. Omission means unchanged spelling. Tokenization is by
white space, one word per path segment; canonical tree-path encoding preserves reserved characters. Unknown declaration keys,
unknown modes/kinds, conflicting normalizers and duplicate ids refuse production before any source is read. Some cross-field
conditions are runtime refinements in addition to the generated JSON Schemas.

`exact` requires the complete literal path (and the kind when declared). `longest_prefix` picks the longest leading path
whose node has the declared kind. Remaining words are returned as written, without interpreting their values. A mere middle
node does not qualify. Drift groups retain the literal, its attempted path, last reachable path and source-entry references;
unplaced occurrences use citable root tree references, resolved only against readable selected-composition rows;
no diagnosis of correction versus defect is made. Production and reading invoke the same generic evaluator. No relation writes
nodes, changes entry content, or adds a drift record.

The snapshot is in the append-only `tree_root` composition, never the node digest. A new declaration may therefore produce
the same tree under a new composition. A same-target pointer refresh is explicit, records another move and compares the
observed pointer action as well as its target; a stale concurrent refresh writes nothing. Existing pointer callers still
refuse an accidental same-target move. Legacy compositions are not rewritten: their view reports that the composition has
no link declaration, with null totals and the next action of reproducing the line.

External read: `knowledge:links:<product>:<line>?prefix=<source-path>&target=<target-path>&rule=<id>&limit=<1..200>`;
all filters are optional. With no read lock it selects that line's current pointer composition. `composition=<digest>` and
the cursor pin continuation; a cursor is bound to composition, filters and offset and is refused on a different query.
A run uses its locked composition, never the latest production of the root. Each page carries complete `totals` (distinct
source references, literal occurrences, links, drift groups and drift occurrences), `next`, and detail-only `truncated`.
The same composition and request produce identical canonical bytes. Cache entries are keyed by composition and recheck
permissions on every external read; output artifacts retain the existing derived-credential gate.

### Minimal composition plumbing and K2 merge handoff

`RootInfo.composition` already exists and is stored in the build target-basis claim's `statement.data.composition`.
`start.ts` now passes it to `inputs.ts` and `projection.ts`, which forward optional `ExternalReadContext.composition`.
This is needed BEFORE the run record exists. An explicit null means a run has no target root and lets the source view lock
its own line pointer; an omitted value on an existing run is resolved from the stored target-basis claim.
`server/tools.ts` forwards the stored composition through optional `NodesQuery.composition` for node reads of that run's
root; explicit null on a legacy run prevents substituting a current declaration. No judgment, producer selection or workflow
behavior is changed by this plumbing. K2's composition-lock repair touches these same files: align the optional field rather
than letting either side reconstruct a newer composition. Node cursors also retain the selected composition across pointer
refreshes. Node replies show only reverse references and one-line summaries, with the full total when rows are cut.

### Local synthetic measurement

`links-performance.test.ts`: 20,001 stored entries, including 20,000 literal-bearing notes, one definition, 100 note nodes,
10,000 links and 10,000 drift occurrences in one drift group. On the local macOS temporary PostgreSQL run, a cold read took
313.9 ms, a warm read 14.7 ms; a 10-detail page was 3,676 bytes. These are synthetic local timings, not deployment or real-source
acceptance. Tests also cover exact and longest-prefix positives/negatives, grouped drift, source-prefix and target filters,
unchanged bytes for an old composition after a same-root refresh, stale-pointer refusal, legacy snapshots and declaration
rejection. Views can be bound as ordinary external inputs; review and version-difference pack consumption is the second step.

Declared relation normalizers apply to both literal words and node segments. Equivalent target paths select the code-point-smallest eligible canonical path, independent of enumeration order. Drift is grouped by normalized words and retains every written spelling in spellings.
Relation rules may restrict target_producers and source_producers to product-declared producer ids. Target kind and producer must match the same composition entry provenance; a definition emitted by the mentioning producer does not acquire another producer's authority. A malformed in-scope literal field is a positioned diagnostic, with no_check and an explicit producer-repair/reproduction action. It does not discard the production. Views retain diagnosed_entries in full totals and page diagnostic details with links and drift; counts cover only parseable literals.

Named relation views use knowledge:links:<product>:<build>; the earlier version-line form remains a fallback for callers that omit the new context field. A run lock applies only to its named target; another build, even with equal node content, resolves its own composition. Explicit historical compositions are checked against the named build's recorded base relationships. Context build is the canonical target name forwarded beside composition before run persistence; a stored run remains authoritative over conflicting supplied context. The wiring touches start.ts, inputs.ts and projection.ts only to forward this existing selection. Other branches touch these same files; retain both optional fields when integrating. start_run coverage includes a workflow slot reading a real links view while a new same-root production appears between selection and binding.

get_nodes prepares relations once per request and retains a compact per-composition target index (distinct count and first 20 sorted source references). The request-local promise remains reusable even when a shared cache rejects an oversized value. RelationReadError classifies missing records at the throw site with a generated reason and a concrete repair action; no message pattern determines refusal causes. Relation failures become one page-level note and do not discard independently readable nodes. On a synthetic 20,020-entry, 2,025-node deep root, this run measured first get_nodes 933.7 ms and warm 2.9 ms for 23 queried nodes. Timing is local synthetic evidence without a tight load-sensitive timing assertion.

Backlinks exclude source entries hung at the target itself. Node text reserves room for its own entries and children first,
then relation summaries. Every computed backlink block supplies `view_id`, an exact build-and-composition-pinned external
id for reading the complete reverse view; a detail limit never changes the count.

Production drift warnings preserve the exact group count. Their detail list fits 800 characters by retaining whole literals
and appending ` 等` when more remain; a literal longer than the detail budget is deferred intact to the relation view.


Alternative groups (integrator authorization, kb-links review finding 1) use `alternatives_field` instead of `field` in a
link declaration, with `match: exact`. The data value is a list of `{primary: string, alternatives: nonempty string[]}`.
The same target-kind and producer filters apply to both. An exact primary hit contributes one link and no alternative
checks; otherwise each distinct expanded alternative contributes a link or drift. Neither a missing primary nor unused
alternatives are counted separately. Malformed groups produce entry diagnostics. The producer and read-time view share
`relationFacts`; declarations are frozen in the composition as before. These are source spellings, never build-dependent
entry edits. Ordinary-field declarations and their counts keep their existing behavior.

缺少目标目录或目录内没有符合声明种类、生产器的目标时，relationFacts 不判漂移：rule_diagnostics 每条声明一条，写出缺失目录和补齐有效来源后重新生产的动作。totals.unchecked_literals 单列未核对候选，仍计入 literals，绝不计入 drift；备选组在目录不可用时计入主干及展开项的去重候选。生产警告和读时结果共用这一判定，后续有效来源的生产会重新核对。

关联记录完整性缺失按决定 36 处理：提示管理员从可信备份恢复与摘要匹配的缺失记录或原件，再重新核验组成；重建或重读不能证明缺失字节的完整性。计算错误交管理员或维护者修复后重新计算，运行时提示不点开发代理的名字。

没有唯一当前组成的根（旧根或多条线的当前根）给出带命名构建、目标路径及 composition 的确定视图标识；在以另一个构建为目标的运行中，该标识独立绑定所指组成，不借用目标运行的版本线锁。

反向视图与节点块使用同一目标局部排除条件：不列挂在目标自身的来源条目，正向视图仍保留这些链接。来源字段诊断和目标不可用说明归入节点页覆盖说明，一页只出现一次，不复制到每个目标块。

根级条目若已挂在根节点，不读取未归位分块。未归位成员及其原文归位行按组成摘要缓存为有界索引（8 份、合计 64 MiB），并合并同份组成的并发首次加载；权限筛选仍在索引使用之前执行，摘要对应的行和根据不会因缓存改变。

链接请求的未知声明、外来游标、非法范围和单条输出超限在抛出处标为 LinkRefusal；外部读取保留确定原因，返回去掉修订的请求 id。记录完整性仍用 RelationReadError，真正未预期的计算故障才报知识视图出错，不按消息文字猜分类。

## 有效条件状态（B01 R[2]）：解析时计算，矛盾只打标

读知识树条目和解析记录引用时，有效条件状态按可机器检查的规则计算（`TreeReading.read`、`hub/refs/resolve.ts`），不由写入方声明。**几种条件同时成立时全部列出**（`validity.conditions`，各带来源），`status` 按固定次序取第一条：**规则已撤回 > 被引片段已变 > 出现矛盾主张**；后算的不覆盖先算的。

| 状态 | 数据来源 | 现状 |
| --- | --- | --- |
| `rule_withdrawn` 规则已撤回 | 组成行的 `decided_by`（决定该条目的包 id@version）；读时查包端口，下架即标。一次读里同版本的查询有缓存 | 有数据，已算 |
| `cited_fragment_changed` 被引片段已变 | **所引根 X 与读者根 Y 比**（K03 R[5]）：X ≠ Y，且 Y 里同一路径的条目摘要与 X 里的不同、或 Y 里没有这个路径，才标，并写出 X 和 Y 两个根（`cited_root`、`reader_root`）。读者根：运行里 = 读者的锁（锁定组成）所属的根；**运行外（K01 R[6]）= 这条产品线的当前根指针**（指针已移到别的根时同样标，并注明主张在所引根上仍成立）；**同一个根永远不会变**（根按内容寻址）；当前指针也取不到（这条产品线@构建还没有根）时不标，照实不算 | 有数据，已算 |
| `expired` 已过期 | 记录主张 `validity.expires_at`，解析时按解析上下文注入的时钟（没有才用墙钟）重读（B01 R[3]）；树条目自身无过期字段，不算 | 记录主张有数据，已算；树条目无来源 |
| `contradicted` 出现矛盾主张 | `claim` 记录带 `relation: 'contradicts'`，见下；**只算读者本人可见的关系**（本人的候选关系 + Hub 确定性规则产出的关系），别人的私有候选关系不给另一个读者打标（K05 R[4]，管理员也不例外）；也包括组成记录 `applicability_sources` 标记的适用条件冲突，含义是「来源声明互相矛盾」：凡可读这个根的人都能看到这些组成出处，只有 claim 关系受上述读者可见范围限制；这一来源不补造 claim，也不写入 `validity.contradictions` 关系列表 | 合成关系记录与组成出处已算；候选层的提议通道由另一终端在建 |
| `grounds_withdrawn` 根据已撤回 | 管理员命令 `circle-hub knowledge retract` 追加的 `retraction@1` | 有数据来源；喂入和回注的读侧已按撤回记录标出 |
| `premise_failed` 前提失效 | 前提的认证状态没有机器可读记录 | 无数据来源，先不算 |

一次读里所有条目的矛盾关系**合成一次查询**（一次 `findMany` 取全部条目摘要的关系，内部翻完，无上限截断）；查询次数不随条目数增长。

### 撤回喂入条目

管理员执行 `circle-hub knowledge retract (--entry <记录摘要> | --run <运行> | --object <对象摘要>)… --reason <一行原因>`。`--entry` 可以是喂入条目的记录摘要，也可以是 `knowledge-contribution@1` 回注记录的摘要。三种目标可以混用，每种目标各追加一条 `retraction@1`。撤回不删除、不改写原记录；读侧随后把对应喂入条目标成 `invalid`，把回注标成 `grounds_withdrawn`（根据已撤回）。同一目标已经有撤回记录时不再追加。

### 矛盾关系怎样存、怎样查

一条矛盾关系是一条 `claim` 记录：`body.relation = 'contradicts'`、`body.at`（关系成立时间）、`body.other`（对方的树地址）、`body.claim`（本方的树地址），索引键 `knowledge.claim.contradiction` 上按**两个**条目摘要各写一行（双方都能按自己的摘要查到）。候选层的关系提议（另一终端的通道）最终也落成这个形状；确定性的规则可以直接写。谁能看由 `claim` 记录本身的权限规则决定（和观察层一致）。

读条目时按条目摘要查这个键：命中的关系进 `validity.contradictions`（每条带 `source`（关系记录的 rec: 引用）、`at`、`other`），状态标 `contradicted`。**不裁决**：矛盾双方都原样返回（`hub/knowledge/validity.test.ts` 钉住：另一方不被隐藏、任何一方的文字与依据等级不变、双方状态同为 contradicted 各带自己的来源和时间）。

回注公开文字的完整凭据扫描包括客户端 model 声明；准入时明确拒绝敏感模型声明，追加边界也复核，避免该声明随共享回注交给产品读者。测试只用合成凭据。

回注分页的字节预算是软上限：已有条目时才延后下一条；空页若放不下完整回注，立即给出引用标记并消费该记录，即使首个标记超过剩余预算也前进。客户端沿 next 必达末页；较大正文按标记中的 rec: 引用分段读取，不以不可用或不存在的管理员设置阻断续读。

回注去重在同一事务里按内容身份键排序取得 records 的业务锁，随后查询、追加与回执一起提交；跨运行、跨模型同时提交相同内容只保留首份归属。单条 append 也取同一锁；多条可信调用方先 lockIdentities，再逐条 append。不同内容键不共用全局锁。以后是否改用 hub-job-dispatch 的唯一业务键 37577e99 由集成者在合并后决定。

K2 closureA2：回注公开正文保留会话标识；准备阶段扫描提交上下文中的会话标识，追加阶段重新扫描实际写入的会话标识，和模型声明一样拒收凭据命中。拒收前不追加公开回注，普通会话标识照常保留。


合入模型第 10 版和最新 K1 时保留了链接读取与回注覆盖层两条通路：get_nodes 同时能展示两类数据；树引用继续计算撤回、片段变化及矛盾条件，并保留按组成的未归位索引、权限筛选和页级链接说明。既有 composition/build 透传不改变运行目标判定。link_match 在第 10 版词表之后追加为第 65 个轴，来源记录仍保留在 K05。

View-scope task 7: sync source-load failures retain the core parser identity, safe ParseError message, original-byte
offset and constructor-defined recovery instruction. Raw parser-library detail and source text are not copied into
the sync report. No supporting parser is distinguished from a registered parser rejecting invalid bytes.

View-scope task 8: case-only ambiguous build spellings are returned as explicit candidates to an authorized product
reader rather than guessed or called absent. Empty declared catalogs retain completeness. After root permission
checks, invalid/mismatched/out-of-range node cursors give REFERENCE_UNRESOLVED with a restart-from-first-page fix;
unreadable roots remain neutral. Listing parser failures carry a determined failure field and do not become plan builds.

计划可用 sync-plan-output@1 的可选 failed_builds 把来源、原始构建资料、注册原因码和修复动作交给核心。
同步把它记为失败 generate 动作和无根构建（已有成功构建及其根不被替换）；store.buildFailures 可按产品、
构建和根查询，未产根使用 root:null。失败计入同步计数，dryRun 不写记录。原因码在产品计划构造处确定。

读树条目的有效性同时列出 unevaluated：缺读者组成/当前根、原件核验事实或声明的目标适用事实时，
不能给 valid。原件按锁定的来源记录重新核验档位，确定的撤回或凭据不可读照实列出；未能评估的条件
带缺失事实、补取动作、具名管理员、请求引用和期限，核对请求去重存成动作。负面条件仍优先于
not_evaluated，只有适用检查全已评估且没有失效事实才给 valid。没有 expiry 字段的树条目不虚构到期条件。

归位提议沿用 placement_proposal 回注通道。准入从锁定组成的原条目/片段找到生产器，按组成记的包版本和
摘要读取已发布的 product.json，所有相关生产器都须声明 judgment_allowed；不得用新版本的允许去改旧
组成的权限。目标路径存在和引文逐字核验沿用 K2，未归位条目在根下的引用也可核验；Hub 不调用模型、
不把提议改成自己的事实或直接修改根。

视图分页：index、facets、impact 接受 after，next 给带根修订的完整续读 id。游标绑定查询、组成、根；
同一索引键也可跨页，不再永久只留 2000 条。页内的 totals 是整个范围的计数，不可逐页相加。
分面组合超过计算上限、单项超过页预算、JSON 原型保留键无法安全交付时整份拒绝，并给出减少 by、
fields 或 only 的具体办法。运行输入经 completeKnowledgeView 续读所有页，校验修订、查询范围和前进；
即使输入带 after 也从首页读全；超过 16 MiB 或仍有未交付内容时要求收窄，绝不绑定尾页或截断页。整份合并也有公开结构上限；同一键
超过绑定上限时须换用本次条目所需的具体索引字段和取值。源码与测试只用合成资源。

生产器恢复：超时失败不进入跨生产的失败记忆；旧的未带确定原因码的失败记忆也不复用。
被隔离的超时记 reason_code:timeout、retry:true。单份文档超过批次字节预算时独立调用；沙箱硬输入上限
仍生效，不为它放宽。每次同步重读所有上次跳过来源，成功输出仍可复用；同步不复用失败输出。
单文档生产器错误登记 producer_error 修复请求，交具名管理员联系该版本包作者核对和发布修正。

根和答复仍保留有界摘要；生产动作的 problem_chunks 保留全部 skipped、refused、warnings，分块是
按内容寻址的管理员原件，含源文件记录引用、字节摘要和行数。重试从完整分块取来源，兼容旧记录时
若旧摘要没有列全，就重读该列表而不猜漏掉的是哪些文档。分块缺失或摘要不符明确拒绝并要求恢复。

同步恢复：连接器失败只透传已有的 read-manifest 摘要，知识侧验证该清单再用固定码和 HTTP 状态，
不匹配错误文字。确定的 404 保存为带来源观察的失败生产动作和无根构建；同一包、输入、列表不变时
保留失败结论，列表变化后自动重查。403 给具名管理员请求，联系构建站负责人开放访问。可选来源缺失
在组成警告及生产动作 missing 的 conclusion/observation 留下确定事实。buildFailures 可查无根失败动作。

缺基础构建的别名把 required_builds 放回计划 options，再跑一轮计划；仍缺时登记具名核对请求，不声称
使用一个不存在的根。计划受轮数/读数限制时把已读原件引用、待取页和所需基础构建保存为检查点；
下次同包与同选项接着取，不从首页反复耗尽预算。检查点不把旧观察说成新读取。

Knowledge.scheduleSync 是显式启用的进程内周期接口：同产品同步仍串行，周期结束再排下一次，stop
取消以后不再启动；意外失败登记管理员修复请求。这里只实现和验证接口，没有配置真实部署或定时器。

凭据处理使用 KnowledgeOptions.credentialAcceptance：autoAcceptSources 逐项指定 systemPack 和生产器 slot，
默认空名单；deadlineHours 默认 72。系统包身份取自已验证的 read-manifest，不能按外部标识前缀猜。
仅共享、Hub 原件且原请求档位明确为 model_readable 的普通命中可按名单自动受理；明确 retain_only
（包括真实凭据回显）、个人来源、缺来源身份的观察均不自动接受。接受后重读连接器，让原投影自己完成，
不把被拦住的原始响应冒充派生内容。管理员撤回不会被自动策略覆盖。

records.artifacts.scanFindings 为管理员分页返回检测类与位置，绝不返回值。acceptFindings 的 detectors
选择是增量接受；只在完整扫描的全部检测类均有有效决定时解除扫描造成的保留。默认旧调用仍不接受
截断摘要；完整维护扫描另有 100000 命中的硬界限，超出时要求拆分/转换来源，不放行。派生覆盖也用
完整扫描，超过旧展示上限的合法覆盖不再被人为丢掉；明确要求保留的档位始终保留。

未受理来源登记给具名管理员的有期限请求；到期追加核对请求，不等同接受。同步开始及来源复核会推进
到期处理，已核验有效的接受会关闭对应请求。视图最后一步仍被保留时，答复给被排除引用、完整分块
清单及管理员请求和动作；完整清单没有只留前十条。实际部署名单及 variables 接线由集成者配置，本任务
没有读取或修改任何在用的配置、凭据或系统。

视图 scope 声明主组成、额外组成、各来源的用途（生产器/槽位）、每个组成未纳入的来源、在额外根
覆盖的来源、确定略去与待核对来源、缺失可选来源及未归位数；影响视图另有两侧未归位用例数。
来源观察完整存成每块至多 2000 行、通常不超过 512 KiB 的不可变原件，公开链接用字节摘要，不用读者专属记录摘要；资料多
不会只留前几条。scope.complete 只说范围元数据已枚举，不代表未列出的企业资料都已覆盖。

KnowledgeOptions.additionalScopeRoots(product) 返回 {root, composition} 数组，逐项核验属于该产品。
额外根只供这一步核对“是否确实略去”；把其中条目合到视图由 kb-unversioned 接线。本接口未配置且
有待归属来源时 omitted_documents 为 null，来源进 pending_documents，并登记具名管理员请求，不能
把缺配置解释成确定略去。没有候选的当前根仍可声明自身的确定范围，不声称全系统穷尽。

视图按命名构建锁定组成和缓存键；根摘要相同但未归位内容不同的两份组成不再串用。来源清单与页内
条目用同一组成，防止索引来自一个构建、范围声明却来自另一个构建。

已合入 kb-unversioned：默认 additionalScopeRoots 从产品不分版本指针取得组成；运行读取沿已锁定快照，不用当前指针替换旧根。显式额外根回调仍核对产品与组成。
第 10 条已接入合并后的 catalog-entry@1：地址角色只由显式资料提供，主机名类型由目录核验；未知参数约束保留在签名中，检查输出在顶层 missing 说明事实，exit 由 Hub 按原因补。未打标签用例仍明确“正负向和测试类型未声明”。

第 10 条续接：本次合入 hub-redesign 的 be27627f（含 d2236556）。目录未核对约束由通用签名字段保留，
不会在 catalogData 边界丢掉；未知结果的 missing 位于顶层，未预填 exit。参数定位与修复说明不作为目录
语法差异，生产警告保留完整 XML 参数路径，参数元数据用相对重载片段的路径，避免元素移位制造变更。

Placement permission uses the validated declaration of the exact producing product
version and digest. Historical versions without a matching current handle are read
through the public manifest-verifying pack reader. Non-product handles, absent or
corrupt files and invalid declarations produce positioned admission refusals; an
unverified edited extraction never grants permission.

Review closure: impact credential exclusions are counted across the entire scan on
every page; a final page cannot hide exclusions from an earlier offset. Complete
bindings reject duplicate placement paths, including duplicates within a page.
Automatic source acceptance uses the configured administrator (the public sync
administrator requirement is unchanged). A failed acceptance/verification attempt
writes `knowledge.credential.acceptance-failed` evidence and links it to the named
administrator request, without copying exception text or credential values. An
unrecognized historical reason stays explicitly unrecognized, with a registered
awaiting-step reason and automatic retry/reproduction as its next action.


### Product-wide production

`sync-plan-output@1.scope` lists source roles without a version or build. A producer
with `unversioned: true` runs only for that scope; other producers run only for builds.
Its `ProducerInput` omits `build`; its composition records `version: null`, `build: null`
and sources with `basis: declared`, decided by the product pack id and version.
The product-wide pointer is `knowledge/<product>`; version pointers always have one
more path segment, so even a line named `unversioned` cannot collide. Moves use the
same audited compare-and-set operation, including composition refresh at equal roots.
Sync reports put this result in `scope`, separately from `builds`. Without `scope`,
no product-wide production or pointer move occurs.

Integrated with hub-variables step two at e9c08866. Both production scopes use the
same declared-variable snapshot as the plan and external reads. Resolution precedes
producer selection, preserving published reference positions. Each composition and
change detector keeps sync-option uses plus only the active producers' parameter uses;
a variable used solely by the other scope cannot force this root to reproduce.

`KnowledgePort.unversionedRoot?(product)` returns the current product-wide root and
composition, including the required `source_count`. An older port without this method means no product-wide root. `RootInfo.build`
is nullable; build-specific `currentRoot` and `rootOfBuild` retain non-null build results.
Reading by digest uses the same product permission checks, the product-wide pointer
for currentness, and displays build provenance as “未声明”. The console labels it “构建未声明”.

Runs lock both roots and their compositions in `target_basis`. The product-wide
basis is projected by `runs.unversioned_root@1`; no root is a definite fact followed
by the instruction to sync the product. Boundaries, check fragments, reuse and
contribution admission recognize the locked set, never a newly moved pointer.
A changed product-wide lock prevents predecessor reuse. Older ports remain compatible.

The start answer lists the product-wide digest separately. The knowledge overview
always has an “不分版本” row per readable product, with the current digest and source
count (including source parts); a missing pointer displays “—”. No extra read right
is implied by either display.

Build differences remain differences of the two build roots alone. Product-wide
paths never become added/removed paths or regression changes merely because the
product-wide scope is readable alongside those roots.

### Product-wide views and snapshot handoff

Index and facet scans stream the selected build composition and the product-wide
composition, deduplicating entry digests. Product-wide entries keep their own tree
reference, `root` and `build: null`; a facet row records `unversioned_count` and
`unversioned_root`. Impact includes the product-wide attached entries for reading,
without adding paths to `changes` or `placements`. Links views expose the scope's
entries beside the selected composition's relations; they do not invent links
between roots.

Every view has an `unversioned` snapshot with complete entry/document totals,
independent of detail limits. Existing totals also include those counts when a
scope exists. Document counts count distinct nonempty `data.document` strings;
index counts apply its key/only selection. A missing scope has a definite note and
the sync action. All bytes, including the scope, pass the existing credential gate.
Scope composition identity participates in cache/revision identity and artifact
lineage. Build-only revisions retain their legacy format when no scope is present.

`KnowledgeOptions.additionalScopeRoots` has the same callback shape as hub-view-scope:
`(product) => Promise<readonly {root, composition}[]>`. Its default reads this package's
product-wide current pointer. It is the read adapter for omission classification
when those changes are merged; the ordinary view scan uses the same snapshot.
Callbacks must return at most one matching product-wide composition. Run reads use
the stored target basis instead. Before the run is persisted, `ExternalReadContext.unversioned`
transports that exact snapshot (including explicit null) through input and expected
source binding. It never follows a pointer after the lock was selected.

Needs: this is the core first step only. The manual-store/openkm readers and FAMX
scope declarations/producers remain the separately scheduled second step. The
hub-variables dependency is now merged and its snapshot integration has synthetic
coverage; no deployment or real-source verification is claimed.

Link pagination cursors carry both the selected composition and the product-wide
snapshot (including explicit absence). Later pages validate that snapshot against a
run lock and preserve it across pointer movement. Legacy cursors remain readable.
`unversioned.skipped_sources` discloses sources omitted during production; index,
facet and impact skipped counters include these sources, so complete produced-entry
counts never imply coverage of a source that production could not read.

A catalog tied to a named producer is advertised only in a root where that producer
runs. Link declaration producer ids are validated against the whole product pack,
so a valid declaration does not become invalid merely because one producer belongs
to the other scope; the root retains the declaration snapshot.

### 产品声明的部署变量

真实同步开始时一次读取全部普通变量的当前决定；计划、外部读取、生产器参数都用这一份快照。声明中任何名字没设置或不合所属包的模式，产品在读页之前确定失败，报告逐名给出 `circle-hub var set <名字> --file <JSON文件> --reason <理由>`，不写值。直接生产入口同样核对，不把占位符交给函数。

试运行不写知识结果，读取仍留审计：不写构建、知识根、生产或计划动作，真实读取照常保留原件、读清单与登录审计。只有试运行可以用缺失名字的合成默认值，报告逐名标明。发布检查只核对默认值合模式；Hub 无法证明值的业务来源。

引用先解析再合并调用选项，调用选项优先。计划动作记录同步选项的每处 `VariableUse`；组成记录记录同步选项和参数的每处引用及决定，不把来历交给函数。变量决定变更触发重核，报告原、新版本；内容相同仍有相同的根节点摘要。列表调用照旧复用，声明变量的产品的普通单次生产调用也按实际输入摘要保存、完整性回读并重新核对输出；只改计划变量时不重算输入相同的生产器。

Needs：依赖按实际交给函数的完整参数记录，不推断函数内部的名称族分支。要精确到只重产某个族，由产品包在对应接线任务中拆出只引用该族变量的独立产出范围。试运行保留读取审计，以及这个依赖边界，均经集成者确认（2026-10-24）。

`var list --root` 接受同步回执里的根节点摘要，也兼容组成记录摘要。同内容根可以对应不同的变量决定；按根查时列出全部组成记录，每行带组成摘要，不拿当前值代替历史版本。

合入 1d399f68 的 read-absence 通道时，保留视图的第二根/组成快照与完整续读绑定，同时保留读取端确定码、重试、私有诊断及失败 manifest。源加载把连接器成功返回的 SOURCE_ABSENT 当作缺席观察而非正文：核对清单的调用人、外部对象、完成状态和支持应答，只有相符的 HTTP 或声明缺席根据才进入来源结论；清单缺失、对象或主体不符、支持键缺失、403 等都不形成缺席事实。失败清单通道不变，404 的无根记录与列表变化后的重查继续生效。节点游标在权限核对后给 /cursor 与从首页重读的修正，无权者仍中性。

Applicability now also records explicit components (with/without), numeric memory bounds in bytes with endpoint flags
and raw source spelling, licenses and deployment forms. Lists sort and deduplicate before hashing. Existing entries
without these fields keep their digest. `inherited` stores generated applicability_field codes only; selectors and
section paths remain composition provenance. Display labels use labelOf, and these four new target prerequisites state
“目标前提，未核对：缺目标上的<字段>观察；下一步：在目标上观察”; source declarations do not certify a target observation.

Product-wide sync failures are isolated in the scope report; pointer failures are
separate `pointers` rows with `line: null`. Successful build reconciliation still
runs. Scope pointers use the observation captured before production and the exact
successful action matching the returned composition, so a concurrent newer root
cannot be overwritten or mistaken for this production's cause. An already aborted
scope is reported without consulting production storage.

Links scope payloads use half of the shared page budget after the same 4096-byte
reserve as the relationship page. The build-side page receives the remaining byte
budget and the final artifact is checked as a whole. Product-wide entry details are
sent only on the first page; cursors retain the original cut count and snapshot.
`unversioned.totals.cut_entries` remains available even without configured relations;
`totals.unversioned_entries_cut` mirrors it when link totals exist. Both count entries
omitted by that first-page detail budget, independently of total scope membership.
The note directs readers to get_nodes on the scope root for omitted details.

An absent scope in a run/read snapshot is described as absence from that locked
range, with a new-run or restart-from-first-page action. It does not claim that the
product currently has no pointer, and no mutable current-pointer lookup is added to
the immutable answer. Unbound current reads retain the product-level sync advice.

View skipped counters include both the build composition and its selected scope.
For impact, the shared scope count contributes to each side; the two counters are
not disjoint source totals. Scope notes name the root, skipped count and producers
actually retained in the bounded summary, disclose absent legacy producer detail,
and request source/producer repair followed by automatic resync and a new run.
They never infer that no entries exist from a source that did not produce.

适用条件出处的 `superseded: true` 表示已被内层作用域取代，仅保留来历；读时不参与字段显示和 `contradicted` 打标。原值、章节路径和原片段仍完整保存在组成记录中。

### 视图性能：hub-view-perf

集成者已接收本次性能改进：冷读 4.586 → 1.133 s，归位峰值 RSS 697,728 → 494,448 KiB。RSS 回归护栏为实测值加 15%（568,616 KiB），单次墙钟使用宽松上限，查询次数单独钉住；降至修前三分之一保留为后续优化目标。合成根的归位与未归位路径分开取证；后者原来逐条查条目并填充全局条目缓存。当前批量扫描不填充该缓存，普通单条读取的缓存同时按逻辑权重限额；权重不是 Node 进程 RSS 的保证。规范条目哈希仍使用同一 `entryCanonical` 配方，批量读取只复用本次调用的编码器。

分块行读取继续核对记录摘要，再按原行合约校验；单次操作的已校验事实由本存储签发的不可伪造句柄持有，不缓存权限或来源受理决定。视图的字节预算、每键上限、跳过与凭据遗漏规则不变；大答复交接缓冲区所有权后放弃内存缓存别名。具体测量、历史预算失败与后续事项见[任务页](../../docs/hub-r4-tasks/hub-view-perf.md)，不把合成验证当成持久部署或真实业务证明。

长驻观察补充：根、分块、目录、关联图、答复等读取负载缓存只在一次异步读取中复用，finally 主动释放；晚到回调不能重新填充，并发读取独立。节点、目录和树引用入口同样建立读取范围。小型写入内容键 memo 不存根负载。对象释放回归已通过，但不等同于物理 RSS 峰值或持久部署验证。

运行引擎的解析文档缓存同样按 start/submit/preview/maintenance 调用拥有并在 finally 终止释放；维护合成补测读取 3 份冻结的大视图原件，3 份解析文档读后未保留。峰值 RSS 和操作结束后的强引用是分别量测的两件事。

## 同步报告与视图的条目计数

同步报告的 `entry_counts` 和分面/索引视图 `totals.entry_counts` 使用同一个口径：
`total = placed + unplaced`，按内容身份去重。身份包含种类、陈述、数据和适用条件的规范 JSON；
不是仅按文字。同一内容的多来源、多片段不增加条目数。所选根范围内，只要有一个树上位置，
就归入 `placed`，不再计入 `unplaced`；一个内容挂在多个节点也只算一个。
没有位置的标签由生成词表 `knowledge_count.tree_unplaced_entries` 提供：未挂到树上位置的条目。

旧报告把已挂载的 `(路径, 内容)` 行数叫作条目总数，却另报没有位置的内容行数；
后者可以大于前者，且同一内容可能两边都有。现在报告同时写明内容总数、已有位置数和树上挂载处数，
没有位置的数采用上述互斥分类。例如三处挂载、四行没有位置的内容，去重并让已有位置优先后，
实际是五个内容条目：两个有位置、三个没有位置。

这次只修汇总与文字，不改组成记录、根节点、引用、分组或存储摘要。历史组成/根的
`counts.entries` 及生产结果 `entries` 仍是挂载行数，原来的 `counts.unplaced` 和
生产/同步结果 `unplaced` 仍是无位置内容行数；需要内容总数的消费者应读新的 `entry_counts`。
同步报告按每个根统计全部种类，构建根和不分版本根分别报告。
视图按请求种类统计锁定的根范围，合并不分版本根时跨根去重，保留原先构建根优先的载体选择；
同一内容在任一所选根有位置，汇总就计为有位置，这不改变引用载体。
因此不能直接相加两个根的报告。分面 `total` 等于内容总数；索引 `total_entries` 仍只数
携带所选索引键/筛选值的条目，新 `entry_counts` 则数该种类全部条目。汇总在明细截断或排除前计算。

看板“未归位（没有命令归属的用例）”另按 `by=commands` 的空组数算，不以树上位置判断，
标签来自 `knowledge_count.commandless_cases`。它和没有树上位置的数不必相等；上述五个条目
可以有四个没有命令归属。看板业务规则保持不变。

合入主线 48592b83 时，视图页保留 unversioned 的独立来源和总数，也保留 after/next、only、scope 完整清单与凭据档位约束。索引与分面在两份固定组成上合并枚举；影响视图在变化路径之后分页交付不分版本附着条目，运行完整绑定同时校验两根范围。范围清单沿同一锁定组成生成，不因续读期间的同步而换到新根。生产超时、完整问题分块、失败构建及恢复检查点与不分版本同步并存；适用条件冲突和未核对条件都保留。
普通构建的额外根仍只参与来源归属核对，不冒充不分版本范围。自动发现不分版本根与显式声明通用额外范围分开记录；无可用不分版本根且通用范围未声明时，待核对来源和具名请求保留，不把它改成确定略去。
独立命令 gold 同步保留 paths（标题/祖先）、steps（直接步骤）测量，并另存 placement_paths（标题、祖先与该用例正文的并集）；前置叶节点和嵌套用例正文不串入外层。命令索引和回归范围比较优先使用这份完整集合，仍兼容未带新字段的旧测量输入。索引只给首个规范归位引用，不证明列举了全部树挂载；比较器核对完整 data.commands、该引用的根与首路径，以及不分版本来源标记；独立脚本不导入 Hub 或包函数。

本次合并同时保留视图的 scope/next、锁定组成与按页偏移的截断判断，以及按内容身份去重的 entry_counts。计数在过滤明细和分页之前完成，任一所选根已有位置就计为 placed；续页和完整绑定保留同一计数。命令归属空组仍由 commandless_cases 单独计量，不与 tree_unplaced_entries 混用。

## Complete empty product-wide roots

An empty result remains a refusal for builds. For a product-wide root only, every active producer must return a complete zero-selection inventory proof. `ProducerOutput.inventory` labels each list and cites two fragments of the same bound JSON source: `listed` must locate an array and `complete` must locate JSON true. The Hub checks these source references, derives the total from the array length, checks the actual batch is empty and selected is zero, and also requires zero refused entries, zero skipped sources and no failed optional reads. Missing evidence, source failures, a producer exception, refused entries or an incomplete list still refuse production and leave the pointer unchanged. No placeholder knowledge entry is generated.

The optional `tree_root@1.empty_scope` stores complete=true and each producer label, checked list/completion references, total and selected=0. Thus a complete empty root differs from a product that has never synced. It is content-addressed and can replace a formerly populated second root by the existing compare-and-set path. Production and unchanged-sync reports render the frozen labels and zero counts as “不分版本的根为空（清单完整，…）”. Authorized node reads return an empty page and that definite coverage note, with no unknown; root-reference reads retain the same note. Compositions keep the proof even when an empty node digest is shared with a root carrying unplaced entries; callers can pin the composition.

同步别名的最终成根检查区分结构化发布状态：未发布别名及本次刻意排除的未发布基础构建不承担成根义务，保持跳过。已发布别名仍强制育出基础根，生产失败仍登记失败与修复出口。

缓存测试冻结 known_builds 清单后比较同一输入的复用；当前构建也是已登记清单的一员，不能为提高缓存命中率从生产器输入中删除。清单变化仍导致重算。分片布局测试只排除 entry.applicability_context.composition 的布局身份差异，并逐条核对该字段等于实际组成记录，其他输出必须完全一致。

## Catalog constraint integration fixtures

`catalog-constraints.test.ts` calls FAMX's public `commandTreeProducer` with the parsed original and its SHA-256. The internal `produceCommandEntries` result also carries pack-only `declarations`; that map is not a `producer-output@1` field and must never be copied directly into a Hub producer fixture. Strict output validation, unchecked source constraints, undeclared native types and incomplete grammar evidence remain asserted. See [fix-catalog-constraints](../../docs/hub-r4-tasks/fix-catalog-constraints.md).

## Explicit source parsers

`ProducerSource.parser` pins a registered core parser for a single source or every member of a list. The product pack owns that source interpretation; a system pack retains its observed Content-Type. SourceLoader executes the exact declaration without recognition fallback, while undeclared sources keep media recognition. Original artifacts, read manifests, composition rows and producer slots retain the observed media type; mismatch notes identify the declared parser in the production report. Parse caches include source digest, parser and media/charset options, and declaration-specific slot caches cannot grant recognition to an undeclared binary source. Read tiers, credential checks and size budgets still apply.

## Index read omission metadata

Each generated index-view read places two fields in its accompanying `meta` artifact: `index_excluded_entries` is the
number of distinct entries excluded by the scan for that delivered page, and `index_view_sha256` is the digest of that
page's original view bytes. Zero is an explicit observation. Other incomplete sources, pagination and per-key cuts retain
their existing fields; this count does not cover them. The index-view original and its existing byte identity do not change.
Readers must compare the digest before using the count. A legacy or collated view with absent or mismatched metadata does
not acquire a zero count by inference; the caller handles the missing fact using its other structural coverage fields.

## Frozen feeding cuts

For a frozen append position, the feeding reader pages the product, retraction, source-head, binding and usage indexes in bounded batches. Index values and insertion order are retained, so a record indexed under multiple objects is still associated with each matching object. Product-wide notes and all other records in the frozen cut remain included. Each record and original is still checked against the reader's current permissions and read tier; those decisions are not shared between records. This changes query layout only, not historical records or their frozen horizon.

When an unbound source discovers products from prior feeding records, one currently readable witness establishes each distinct product. Additional records of that same product do not need another visibility check to prove the same existence fact. An unreadable record establishes nothing, so later records of that product are still checked; two distinct readable products remain ambiguous. No other record is made readable by a witness.

Live feeding entry reads, including `get_nodes`, use the same batched retraction and source-head index reads as frozen
cuts when the store supports them; the previous per-record path remains the fallback. Each record still has its current
reader and source permission checked separately. A synthetic 40-record regression reproduces 80 per-record retraction
and source-head reads before the change and at most four after it, while comparing the returned entries with the old
path. This does not establish that index reads are the only cause of a slow real request.

For `get_nodes`, the batched read selects candidate records by the requested root and the same exact node path or
declared command path before reading their originals. Every selected record still receives its own current permission,
source, retraction and frozen-offset checks. A synthetic request for an unrelated node previously read the same source
40 times and now reads it zero times; the related node still checks all 40 candidates. A store without batch support
uses the earlier per-record path. This is not a measurement of total latency on a real document.

### Feeding cases in views

A feeding cut keeps valid function projections by exact locked root and exact source identity. A later source-only read
cannot replace a root-specific command projection; projections on different roots stay separate. Facets count the content
identity once. If multiple sources of that identity disagree on a requested facet field, that identity is omitted from
that facet, the view is marked truncated, and a note names the missing agreement and the next action.

An index lists each source projection by its immutable claim-record digest, with `rec:<digest>` as its reference and the
shared content digest in `data.object`; multiple sources can therefore point to one content object without inventing tree
membership. Tree entries keep their existing tree references. Exact source title, ancestors, parser selector and command-tree
source are used only when present and verified in that projection. Older records without these fields remain readable and
must be re-read under the desired locked root when a consumer needs them. A nonempty legacy expectation list without a
product-declared nonblank flag remains unknown in expectation-count facets; it is not counted as present. A case seen only without a locked root is not
attached to a version view by this change; it needs a root-bound read. No version inheritance is inferred here.
When a case has unparsed steps, its complete command set is unknown: the view omits `commands` and `command_identities`
for that source, and command-dependent facets and indexes are incomplete with a missing fact and next action. This does
not assert whether the unparsed steps contain commands.
An index may carry `key_space_complete`: it is true only when the page covers every raw key in the frozen unfiltered
view, no listed source was skipped, and no known unresolved feeding projection or missing indexed field can add a key.
A page may have complete keys while some entries under a listed key remain paginated. The flag says nothing about sources
not observed in that view, and does not make `only=` a normalized-id query; legacy views without the flag
cannot prove an absent key. When all pages of one frozen index are bound together, the final page must carry the new
structural flag, the combined keys must cover the reported key count, and the unfiltered source scope must be complete
before the combined view can assert key-space completeness. A legacy paginated view is not upgraded from its old
`truncated` flag.
The view artifact's derived-coverage ancestry still pins the tree and its composition, not the individual feeding source
artifacts. A credential finding in a feeding field may therefore require source-coverage handling before that view can be
read, even when the individual feeding record is readable. This limit does not grant access through another capture.
The shared `ViewEntry` contract also allows record references in impact and links views, but their current producers still
emit only tree references and regression-scope and maintenance-sweep accept only those. Before adding feeding records to
an impact view, narrow that shared contract or update the affected consumers together.
