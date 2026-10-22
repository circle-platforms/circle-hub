# packs/workflow/case-location

Capability 3 of the architecture brief (section 6a): a fact-only workflow pack of the product line `apv` (APV and NSAE, one
product with two names). For each document (or each case) bound to a run it answers where it belongs: product line,
version, version line, release train, module, the build names written in the tree, and the requirement and defect ids
linked to it. Every requirement is a fact, so `start_run` computes and stores the validation result at once (a production
run); `submit_result` only adds model commentary. Model elements: W01 (items), W02 (requirements), W03 (one line bound,
R[5]), C05 (a pack function check with samples), T01, T02 (publish check), V01/V03 (support, unknown with a reason, refute),
A01 (declared values stay declared), B01/B03 (grounds).

## Files

| Path | Content |
| --- | --- |
| `pack.json` | the manifest of exactly the pack files below (`pack-files.ts --write` keeps it current; a test fails when it is stale) |
| `workflow.json` | input `documents` (subject, `agile:mindmap`, many, required); parameters `product`, `line`, `granularity`, `id_ranges`; `product: { id: "apv", catalogs: [] }`; projection and expected sources |
| `requirements.json` | `location`: item, fact, static, required, checks `[locate]`; `build_candidates`: item, fact, static, required, checks `[candidates]` |
| `checks.json` | `locate`: pack function `functions/check.ts`, applies `run`, subject builder `functions/subject.ts`, judges `subject`, advisory; `candidates`: `functions/candidates.ts`, same shape |
| `slots.schema.json` | empty (`item: {}`, `run: {}`): nothing for a model to fill |
| `SKILL.md` | the procedure: start the run, read every summary (reading on when the answer is partial), relay every answer unchanged |
| `functions/locate.ts` | the attribution scheme (pure): `locateItem(input) → { answer, judgment }`, `summaryOf`, `locateInputOf` |
| `functions/convention.ts` | the line's conventions (pack data): prefix codes, line and train nodes, version labels, modules, the version scheme and its guards, written build names |
| `functions/ids.ts` | requirement and defect ids in titles, folders and map texts |
| `functions/params.ts` | the run parameters and the id-range rule |
| `functions/project.ts` | projection-input@1 → projection-output@1 |
| `functions/subject.ts` | run-subject-input@1 → the check's subject (items plus product, names, parameters) |
| `functions/check.ts` | PackCheckInput → check-outcome@1, one outcome per item |
| `functions/candidates.ts` | the build_candidates check: per item the candidates of the located line from the frozen context builds, then one outcome per written build name |
| `functions/expected.ts` | expected-sources-input@1 → `plm:story:<id>`, `plm:bug:<id>` with role expected |
| `tables/codes.json` | every pack code (refusals, warnings, the one violation) and the labels of `version_source` and `confidence` |
| `samples/positive/*`, `samples/negative/*` | two positive and three negative samples of `locate`, one positive and one negative of `candidates` (author samples); the negative `trees-that-are-no-facts` holds, beside its declaration conflict, trees that must stay unknown (contradicting levels, mentioned versions), so the publish check also guards the location rules |
| `pack-files.ts` | not a pack file: lists the pack files, writes/checks `pack.json`, stages a publishable copy |
| `testing/examples.json` | not a pack file: five synthetic examples with hand-written answers (no verified real run exists, T01 F[11]) |
| `functions/test-support.ts`, `test-hub.ts`, `*.test.ts`, `README.md` | not pack files: tests and their helpers |

## The answer

The `data` of each item's `location` outcome, and so of its claim (`claim.statement.data`):

| Field | Meaning |
| --- | --- |
| `case_id` | the item id: the document id (`24001`) or `document:node` (`24001:<data.id>`) |
| `product_line`, `product_name` | the line id and the name the tree root gives; `product_line` null when the root is not a name of the run's line |
| `version`, `version_source`, `confidence` | the version and where it was read: `folders` (high at a consistent version level; low when only mentioned in a folder name or when the level contradicts itself), `title` low, `parameter` low, `none` |
| `build`, `build_source`, `patch`, `patch_source` | the build date (eight digits) and the patch; at the version level they share its confidence, otherwise they are references (`folders` or `title`) |
| `line`, `train`, `module` | the folder convention `NNN：<line>` / `NNN：<line>-<train>` / module, where it holds |
| `ancestor_path` | root, folders, and for a case the document title and the map path, top down |
| `source` | the external identity (with revision) of the document the answer was read from |
| `build_names` | build names written in the folders, the title or the map, verbatim, of the line's name families; not checked, not resolved |
| `requirements`, `defects`, `unclassified` | linked ids: marked by a word as story or bug, or unmarked |
| `id_sources` | per linked id: its kind and every place it was read (`title`, `folders`, `map`) |
| `ranged` | the unclassified ids the caller's `id_ranges` assign a kind (a declaration, apart from the tree facts) |
| `declared`, `conflicts`, `notes` | fields filled from the caller's product or line, declarations the tree contradicts, explanations in Chinese |

How it is reported: **support** (a fact claim) when the tree gives the product line by its root and a consistent version
level; **unknown, reason missing_input** (terminal unchecked, attribution data_gap) when the scheme cannot answer (no
product line, a version only mentioned or only in the title, a declared version, no version, a version level that
contradicts itself), with what is known in `data` and the reason leading the statement and the summary; **refute**
`case-location.declaration_conflict` (advisory) only when a caller's declaration contradicts the tree. The second
requirement `build_candidates` is a real check (`candidates`, advisory): the candidates are the builds the run's frozen
context lists for the located version line (both name families, an alias shown with the base it is based on, by built
time descending — a build the knowledge base knows by name only, without a root yet, is a candidate the same
way); no located line, or a line without any known build, is an unknown (missing input), never a pass.
The support statement writes the candidates out, one by one — build name (family), the built time of the page's
“build on” (`制作于 YYYY-MM-DD HH:mm`; `制作时间未知` when the page carries none), an alias with the build it is based
on (`基于 <build>`), and the release state apart (`已发布 <date>` or `未发布`) — ordered by built time descending
(name as the tie-break, no built time last), at most the first 12, the rest counted as `另有 N 个`. Each written build name is
classified against the knowledge base's builds and its statement carries the name: known (a candidate, or the base an
alias is based on) is a support; known but of another line is an advisory violation (`build_other_line`, naming the line);
not known is an unknown (the knowledge base lists only the builds of the build site), never a violation.

## The scheme (decisions)

1. **Product.** The root's name (meta.root: a string, or `{name|title|label}`; `name` first) compared with every name of
   the run's line (NFKC, case and white space folded). Equal: `product_line` = the line id, `product_name` = that name.
   Anything else: `product_name` as the tree names it, no line. A first ancestor equal to the root is dropped (the agile
   system pack lists the root title first). The names reach the check through the subject builder.
2. **Version level and version.** Version labels are the convention's line nodes (prefix code + a pure version), the first
   release train (prefix code + version + separator + more) and labels that are only a version in the owner's expression
   over the whole label (`10.6.1`, `V10.7.0`, `NSAE_10.5.3`, after an optional prefix code). The version level runs from the
   root to the train, else to the first line node, else to the first version label, and includes every line node of the
   path. The version is the level's version nearest the root, confidence high, when every version of the level names one
   version line (first three numbers compared as lines: `10.6.1.57` and `10.6.1` agree, `10.6` and `10.6.1` do not).
   Otherwise the tree contradicts itself (several line nodes, a train of another line, a version label of another line):
   confidence low, unknown, both values kept (`version` nearest the root, `line` and `train` by the convention), the
   disagreement leads the summary. Without a version level a version mentioned in a folder name among other words is a
   reference version (`802.1Q VLAN`, `Chrome 120.0 兼容`, `NSAE_10.6.1.57_专项`: confidence low, unknown), then the title's
   (low), then none (the APV-named root: version unknown, not an error). Every other version is a quote (notes). The
   scheme's guards stay (protocol versions, quantities, addresses), also on line and train nodes.
3. **Build date and patch** (`build<8 digits>`, a valid date; `patch<n[.n]>`; both masked before versions are read) are read
   only from the labels of the version level (the version's label, the labels above it, the train). Deeper folders and the
   title only quote them (notes). Without a version level the nearest folder match, else the title's, is a reference and
   the summary says so (`构建日期 20260315（标题，参考）`).
4. **Line, train, module.** The first train from the root is the train, the nearest line node above it the line (none: the
   train's version, noted); without a train the first line node is the line. The module is the label right below the train
   when it is a plain name (no activity or document words, no version, no id, no four digits, at most 40 characters).
5. **Build names.** Only names written in the folders, the title or the map (`Rel|Beta_<family>[-PLATFORM]_n_n...`), verbatim,
   of a name family of the bound line; other products' names are left out (noted). Nothing is derived: no twin in the other
   family (older NSAE builds are based on APV builds with other numbers, brief section 8) and no name made from a version.
6. **Build candidates** (K01 R[10]: the builds of every name family under the version line, aliases resolved to their
   base): since 1.1.0 the workflow declares `context: ["builds"]` (workflow@1), the engine hands the knowledge base's builds
   of the bound product to the run context and freezes them in the run record, and the `candidates` check answers from the
   frozen list. The candidates are the builds of the located line, released first by date descending, then by name; a
   candidate whose name differs from its base is an alias (`alias: true`, shown with its base). Before 1.1.0 the requirement
   had no check (every item showed it unchecked, no_check): the pack could not see the builds.
7. **Ids.** Read from the document title; from the folders below the version level; and, for a case, from the map path and
   the case text. Only a word right before the number names its kind (`bug`, `缺陷` → defect; `story`, `需求` →
   requirement); the "bug to case" family and `PLM` name a document type and the system, so their numbers are unmarked. A
   bare leading number is an id only at the start of the title or of a document folder in the module place (a label there
   that is not a module), with five to seven digits and no Han text or unit glued to it (case-review measured 947 of 949
   unmarked ids at 10,000 or more; `8080 端口`, `4094 VLAN`, `10000并发`, `1000条` are quantities). Deeper folders and the
   map are read after a marker word only. A number marked anywhere takes that kind wherever it stands unmarked. Where each
   id was read is in `id_sources`; the summary marks ids not from the title (`需求 20931（目录）`).
8. **Id ranges** (`id_ranges`) are a declaration (A01 R[2]): the kinds they give are reported apart (`ranged`, summary
   `33001（声明的范围：需求）`), never as tree facts, and the answer's verdict does not rest on them. A declared range
   classifies the ids it contains unless the other declared range contains them too; an id in no declared range stays
   unclassified, so a range given alone classifies its own ids.
9. **Declarations** (`product`, `line`). A declared product fills the product only when there is no root (marked in
   `declared`, answer unknown). With a root the root's product is kept: a declared product is a conflict when the root is a
   name of the line and the declaration is not, or when the root is not a name of the line and the declaration differs from
   it; in an unbound run that cannot be decided and is only noted. A declared line is compared with every value the tree
   gives at the version level (the reported version, the line node, the train's version): any disagreement is a conflict.
   Without a version level it fills `line` (and the version when there is none, `version_source: parameter`), marked, the
   answer unknown. A value the parameter schema lets through but the rules cannot read refuses the start with
   `case-location.invalid_parameter` and the rule.
10. **Items.** `granularity: document` (default) gives one item per document, id the document id, label the title the tree
    lists (else the map root text). `granularity: case` gives one item per node with a non-empty `resource` array, id
    `<document>:<data.id>` when unique in the document, else `<document>:@<index>`; a document without case nodes becomes a
    document item (warning). The location names the node (`FragmentRef` with `source` = the bound document's digest); with
    several documents the selector is one no other bound document resolves, else the start is refused
    (`ambiguous_location`). The summary is `summaryOf` of the same answer.
11. **Expected sources.** Every requirement id as `plm:story:<id>`, every defect id as `plm:bug:<id>` (title, folders or
    map, said in the reason), every ranged id as its declared kind (the reason says it is a declaration), role expected, at
    most 200 per run (`sources_capped`). An unclassified id that no declared range decides is not read
    (`id_kind_unknown` lists them): story and bug numbers are separate sequences, so reading both kinds would show a false
    evidence gap for one of them and could bind an unrelated record of the other.
12. **Grounds.** The ground of each outcome is the item location (its mind-map node), which does not contain the folder
    facts: they are the system pack's `meta` of the read, copied into the item fields. Every statement says so
    (`目录是敏捷平台读取时列出的，取自系统包的元数据，没有引用片段`) and every outcome points at the item's fields in the
    subject (`pointer: /items/<k>/fields`, the k-th item of the run record too). The location is passed through when it has
    reference shape (`<scheme>:<sha256>...`); which schemes may ground a claim is the engine's decision.

## How a run goes

```
start_run { pack: "case-location", inputs: { documents: [{ external: "agile:mindmap:24001" }, ...] } }
```

The workflow binds the line `apv`, so a run without `product` binds it (any name of the line may be given; another line is
refused). The binding locks the newest released build with a root (the engine's target rule), which is unrelated to the
located versions; `SKILL.md` says so. The answer carries the items with their summaries and the production result
(`StartRunOutput.result`: its `rec:` reference and the counts).

## How to test

```
node --test "packs/workflow/case-location/**/*.test.ts"
npx tsc --noEmit
node packs/workflow/case-location/pack-files.ts --check
```

- `functions/locate.test.ts`: 71 invented ancestor paths with the answer written in the row, among them every scenario of
  the second review (an older-line NSAE build name, another product's build name, contradicting trees with and without a
  declared line, build dates and patches in the title or deeper folders, quantities at the start, folder and map ids, a
  range given alone, declared products beside another root, mentioned versions); metamorphic properties (another root
  name changes only the product; a deeper mention changes neither version nor confidence; a mention above the level is a
  quote, a version label above it that disagrees makes the answer unknown; the order of the line's names does not matter;
  no build name that is not written); totality on hostile and 400 random inputs (every fact has a consistent level);
  bounds.
- `functions/convention.test.ts`, `functions/ids.test.ts`: the label rules, version labels, the scheme and its guards,
  same-line comparison, written build names, ids and their leading-number rule.
- `functions/project.test.ts`: real kityminder@1 models; selectors that resolve in exactly one bound document; the agile
  system pack's meta shape; case granularity; every refusal; the item and byte budgets; hostile input.
- `functions/check.test.ts`, `functions/expected.test.ts`: outcomes per item, their pointers and grounds of any reference
  shape, conflicts, an unbound run, malformed subjects, the largest admitted run within the sandbox output limit; bound
  and unread ids, declared ranges, folder ids, the cap.
- `functions/candidates.test.ts`: the candidates of the located line of both name families (an alias shown with its base,
  released first by date descending), a written name of another line (advisory violation) and one the knowledge base does
  not know (unknown), no located line or a line without builds (unknown, never a pass), order independence, 2,000 builds.
- `functions/sandbox.test.ts`: every entry point in the Hub sandbox equals the direct call; the check through `runCheck`.
- `pack.test.ts`: `pack.json` current and without examples, contract shapes, the product binding and both requirements,
  parameter schemas zod can enforce, declared codes and labels, the hand-written examples, and the staged pack through
  `readPackDirectory`, `validatePack` and `runPublishCheck`.
- `publish.test.ts` (temporary PostgreSQL): the real registry publishes it (5 samples pass, 2 positive and 3 negative,
  `author_samples_only`), and refuses a wrong sample (also a fact expected for a contradicting tree) and a missing
  negative sample.
- `production.test.ts` (temporary PostgreSQL): production runs end to end with the real registry and engine: answers
  written first, claims with their pointers, terminals of both requirements, counts, expected sources (the unmarked id not
  read), a declaration conflict, a run that binds the pack's line without `product`, declared id ranges, case granularity,
  an unassigned user, model commentary, and a second active product line that neither widens the pack's products nor its
  knowledge nor accepts runs of that line.

The sandbox tests (and the database tests that run pack functions) are skipped where `sandbox-exec` is unavailable; a skip
is not a pass.

## Publishing

The source directory holds tests, fixtures and this README, which are not pack files, so a publication goes through a
staged copy: `node packs/workflow/case-location/pack-files.ts --stage <empty directory>`, then
`registry.publish(owner, <directory>)`. After any change to a pack file run `pack-files.ts --write`.

## Deviations from the brief and the task

1. `version_source` has a fourth value `parameter` (confidence low): a declared value must not pass for one read from the
   tree (A01). The task listed folders, title, none.
2. "Overrides" are declarations that fill what the tree does not give, are marked, and are refuted where they contradict
   the tree (W03 R[0]). This is also the check's only refutation, which the publish check needs for its negative samples.
3. Extra answer fields: `unclassified`, `id_sources`, `ranged`, `build_source`, `patch_source`, `declared`, `conflicts`,
   `notes`. In 1.0.0 `build_candidates` was an unchecked requirement and `build_names` carried the written names only,
   because a pack check could not see the builds; since 1.1.0 the `candidates` check computes them from the frozen context
   and cross-checks the written names (decisions 5, 6).
4. `source` is read as the identity of the source document (the task does not define it).
5. "Priority order" is read as the order inside one label (build date, then patch, then version, each masking its match).
   "Nearest the root" applies among the version labels; a version only mentioned among other words is a reference version
   (confidence low) although the owner's expression matches it, because the scheme's high confidence otherwise made facts
   of `802.1Q`, `Chrome 120.0` and `OpenSSL 1.1.1` (open question 3).
6. Guards beside the owner's expression (protocol versions, quantities, addresses), parts of one to three digits, valid
   build dates.
7. Line and train nodes need the prefix code (the convention is `NNN：...`), unlike the product pack's `locate.ts`.
8. Added parameters `granularity` (the task's "case or document") and `id_ranges`.
9. Ids are read from the title, the folders below the version level and the case's map (the task: "named in the title";
   the second review asked for folders, as case-review reads them). Unmarked leading numbers need five digits.
10. Every outcome becomes a claim; the engine records an unknown outcome as a claim of nature unknown, not a fact.
11. A tree that contradicts itself is unknown, not a fact with a note (the second review; open question 1 lets the owner
    choose otherwise).

## Limits

- The candidates are the knowledge base's builds at the start of the run (frozen with the run record); a name the
  knowledge base does not know is unknown, never a violation. An NSAE name of an older line is not resolved to the APV
  build it is based on beyond what the knowledge base's alias records say.
- Dates written with dots (`7.1`, `10.1 国庆版本`) are read as versions; outside the version level they are only references.
- A label that is only a version (`802.1`, `1.5`) is a version label; under a root without a version level it would be a
  fact. No such folder was seen in the sampled trees.
- A spaced quantity of five digits or more at the start of a title (`10000 并发握手`) reads as an id; glued ones do not.
- Case granularity uses the brief's case rule (a non-empty `resource`); untagged cases (case-review's `marked` rule) are not
  items. Positional ids (a duplicated or missing `data.id`) are pack identities, not stable across revisions.
- The id and convention rules are adapted copies of the case-review and product pack functions (packs cannot share modules
  at run time); a change there must be carried over here (see "Needs").
- At most 64 folder levels and 1000 characters per label are read; at most 50 ids per kind, 24 build names, 16 notes.
- One run holds at most 2,500 items and 5 MiB of projection output (`too_large` beyond): the check answers every item in
  one sandbox call under the default 8 MiB output limit.
- The server lays every tool answer out within `TEXT_BUDGET` = 30,000 characters (`hub/server/budget.ts`); sources and the
  list of problems and unknowns come before the item lines. Measured on 2026-10-22 with the renderer as it then was (it is
  being reworked, so the numbers move), full convention, document granularity, with the production result, the run record
  and the evidence gaps passed to the text: titles that each mark one defect whose PLM record exists: 40 documents fit
  whole (25,443 characters), 50 show 45 of 50 summaries, 60 show 51 of 60; titles with unmarked ids only (nothing bound):
  60 fit whole (25,643). Hence the guidance of about 40 documents in the input description and `SKILL.md`, which also
  tells the model to read the rest with the call the closing note names; scripts read the structured result.

## Needs from other packages

- **runs engine** (`hub/runs/engine/target.ts`): every run of this pack binds the line (`product.id`) and therefore chooses
  a build and locks its root, although the workflow requires no catalog; with no synced build of the line the start is
  refused, and the run summary shows a version line and build that are not the located ones. Request: for a workflow
  without catalogs, bind the line (its names in `RunContext`) without choosing a build or locking a root.
- ~~runs engine (`hub/runs/engine/projection.ts`): `FragmentRef.source` picks the bound source of an item location~~
  **resolved** (hub-builds): a fragment naming its source is resolved in that source only, so node ids repeating across
  the bound documents no longer force `ambiguous_location`; without `source` the old rule stands.
- ~~runs engine / contracts (build candidates, K01 R[10])~~ **resolved since 1.1.0** (hub-builds): workflow.json declares
  `context: ["builds"]`, the engine hands the knowledge base's builds of the bound product to the run context and freezes
  them in the run record; the `candidates` check answers from it (all lines, so the written-name cross-check can name the
  line a build belongs to).
- **runs engine / contracts** (grounds of the folder facts, B01, B03): the engine reads the `meta` artifact of an external
  read (`hub/runs/engine/inputs.ts`) but binds neither it nor the `agile:tree` reads it was derived from as a run source,
  and `BoundInput` carries the parsed meta without its digest, so no claim can cite what the folders rest on. Request: bind
  the meta artifact as a source of the run (role subject or a new role) and put its SHA-256 in `BoundInput` (for example
  `meta_sha256`), so that a check can cite `src:<meta sha256>` (with a JSON selector into `ancestors`) as a ground; and say
  whether the folder tree came from the connector's nested-read cache (`hub/connectors/read.ts`, up to one hour) with its
  read time, so that the engine can time-bound the claim (`collected_at`) instead of presenting an hour-old tree as
  current. Until then every statement says where the folders come from and the outcome points at the item's fields.
- **runs engine / contracts** (one implementation, T01 R[0]): a workflow pack cannot call the bound product pack's
  functions, so the location rules exist twice (`packs/product/apv/functions/locate.ts`, `ids.ts` and this pack's
  `convention.ts`, `ids.ts`), with differences (prefix codes required here, consistency rules, the leading-number rule).
  Request: a way for a workflow function to run a function of the bound product pack (for example a product function
  reference in `workflow.json` that the engine resolves to the bound pack and runs in the product pack's directory), so
  that the conventions live in the product pack once.
- **agile-platform system pack**: `meta.root` is `{ id, title }` with the platform's own title; please add the resource
  settings name as `meta.root.name` (this pack reads `name` first, then `title`).
- **case-review pack**: its id-range rule makes a kind without a range cover every id, so declaring only the story range
  classifies no id as a story and every other id as a bug; this pack lets a range given alone classify only its own ids.
  Please settle one rule for both packs (with the owner).
- **product pack**: a deployment default for the id ranges of the line's defect system (case-review asks for the same), so
  that unmarked ids are read without a caller's declaration.
- **packs integrator**: publish through `pack-files.ts --stage`; assign the pack to users; the knowledge base needs a root
  of some build of the line before runs can start (see the first item).

## Open questions for the owner

1. A version level that contradicts itself (`010：9.8` above `020：10.6`, a train of another line) is unknown with both
   values kept. Should it instead be a fact with the nearest root winning?
2. Should a build name written in a folder (`Rel_NSAE_10_6_1_57 回归`) count as the folder version? The scheme reads dotted
   versions only, so today it is listed in `build_names` and the version stays unknown.
3. Are the guards and the version labels acceptable beside the stated expression: a version mentioned among other words is
   only a reference (low), a label that is only a version is a version label (high)?
4. Ids after "bug to case": unmarked (here and in case-review) or defects (the product pack's `ids.ts`)? With the defect
   system's id ranges as a deployment default most of them would be classified and read.
5. Folder ids: are ids in folder labels below the version level links of every document under them (as read now), and is
   a bare leading number of five digits at the start of a document folder in the module place an id?
