# template-gap: the template gap check (capability 2)

A workflow pack whose requirements are all facts (a production run, brief section 6a): for each test mind map it reports
which of the 24 categories of the team's case template v3 are missing and, for every category a case shows, which cases show
it. `start_run` computes and stores the validation result at once; nobody fills a slot. Model elements: T01 T02 (pack, samples,
publish check), W01 (one item per document), W02 W03 (one fact requirement, no product binding), C04 C05 (an admitted
coverage@1 table with samples), A03 (the documents are the subject).

## What is here

| Path | Pack file | Content |
| --- | --- | --- |
| `pack.json` | manifest | `template-gap@1.0.0`, workflow; lists every pack file below with SHA-256 and size |
| `workflow.json` | yes | input `documents` (subject; `agile:mindmap` or `application/json`; many, about 30 per run; required), parameter `skipped`, product binding without catalogs, projection; no expected sources |
| `requirements.json` | yes | `coverage`: item, fact, static layer, bookkeeping, required, checks `[coverage]`, no error handling rows (deviation 2) |
| `checks.json` | yes | `coverage`: `coverage@1` over `tables/template-v3-coverage.json`, per item, subject built by `functions/subject.ts`, judges the subject |
| `slots.schema.json` | yes | `item: {}`, `run: {}` |
| `SKILL.md` | yes | the procedure: start the run, relay the summaries unchanged, read evidence by the run record reference when the answer shows one (else the console), skips only on the user's word, commentary marked `模型转述，未经校验` |
| `functions/project.ts` | yes | the projection (default export): ProjectionInput → one item per document |
| `functions/subject.ts` | yes | the subject builder of the coverage check (default export, no totality guard) |
| `functions/cases.ts`, `template.ts`, `tags.ts`, `text.ts`, `common.ts`, `types.ts` | yes | the case rule, case identities and the node table; template admission and matching; tag spellings; text helpers; warnings and refusals; types (ported from case-review) |
| `tables/template-v3.json` | yes | the 24 categories of template v3 (`template-gap.template@1`), copied from case-review except that every category is required |
| `tables/template-v3-coverage.json` | yes | the coverage@1 table, advisory; the members are a closed set written from the template |
| `tables/codes.json` | yes | every refusal and warning code with Chinese `when` and `fix` |
| `samples/positive/*.json`, `samples/negative/*.json` | yes | 2 positive and 4 negative samples of the coverage check, source `author` |
| `examples/synthetic-gap.km.json`, `examples/synthetic-gap.result.json` | yes | an invented document without Stress cases (an upload) and the item and check outcome the pack gives it |
| `api.ts` | no | the package surface: `PACK_DIR`, `packFiles`, `manifestProblems`, `signManifest`, `stagePack`, the pure functions and types; a CLI (below) |
| `testing/` | no | synthetic mind maps with declared gold, the test bed on the real registry and engine, helpers, the example writer |
| `*.test.ts` | no | the tests |

`api.ts` is the only module other packages import. The pack is exactly the files `pack.json` lists: every file under the
places packs keep files except tests (`isPackFile`); `README.md`, `api.ts` and `testing/` are not pack paths. So the
directory itself is not published: publish a staged copy.

```
node packs/workflow/template-gap/api.ts check          # pack.json lists every pack file as it is on disk
node packs/workflow/template-gap/api.ts sign           # after changing a pack file: rewrite the file list
node packs/workflow/template-gap/api.ts stage <dir>    # a publishable copy: pack.json and the listed files
node packs/workflow/template-gap/testing/examples.ts   # rewrite the examples and sign
```

API changes in this round (no other package imports this one): `CaseRecord.path` became `CaseRecord.visit` (its node in the
document's node table; `casePath(nodes, record)` gives the ancestor texts), `categoryFacts(template, document)` takes the cases
with their node table, `CoverageSubject` has no `required`, `LIMITS` lost `maxWarnings` and gained `maxSkipProblems`
(`maxSummary` is 480); `casePath`, `DocumentCases` and `NodeTable` are exported.

## The projection (one item per document)

- **Inputs.** Every input of the slot `documents` must be parsed by `kityminder@1` (an `application/json` upload that is not
  a mind map arrives as `json@1` and is refused). The **document id** is the id of the external object (`agile:mindmap:<id>`,
  revision dropped) or `upload-<first 12 hex digits of the SHA-256>` for an upload; it may not contain a colon, white space or
  control characters (the colon separates document and node in a case id). The **title** is the meta title the agile system
  pack gives, else the root text; the **path** is `meta.folders` (top down, the connectors' agile meta), else
  `meta.ancestors`, else empty. The label is the title with white space collapsed (`（无标题）` when blank).
- **Cases** follow case-review's default rule `marked` (deviation 4): a case is either a node with a non-empty `resource`, or
  an untagged candidate node outside cases carrying the case priority (default 2), having children and holding no case or
  candidate (marked case, counted with `tags: []`). Parameter `case_rule: "tagged"` restricts to tagged cases. A tagged node
  with priority 1 that holds tagged or priority-2 nodes is a group (once nothing like that is below it, it is a case again:
  deviation 5); inside a case a leaf is an expected result unless it has priority 3 (a precondition), a child with children is
  a step; a tagged node below a case is a case of its own. Untagged candidate cases are counted in `caseCount` under `marked`
  and tracked in `fields.marked_only` and `fields.data`; under `tagged` they are not counted but disclosed in `fields.untagged`,
  the summary and the warning `template-gap.untagged_cases`. Case ids are exactly case-review's item ids (`<document>:<data.id>`,
  `#1`, `#2` for copies of a shared id, `@<node index>` without a usable id).
- **Categories.** A category is shown by a canonical test-type tag or by a literal keyword in the case texts it names
  (contains, prefix, equals; NFKC, lower case, white space collapsed, arrows written `->`; a space at a keyword end is a word
  boundary). The template is admitted at every call (closed shape, origin, literal keywords) or the run is refused with
  `template-gap.template_invalid`. Fields per category: `{id, label, group, required, present, count, evidence}`; the
  evidence is the sorted case ids, at most 20. Every node text is put in its matching form once and the ancestor-path keywords
  of a category are matched once per node, top down, so the cost stays linear in the document (a long title above many cases,
  a deep chain, a long run of dashes or of U+FEFF).
- **Fields** `{document, title, path, caseCount, untagged, categories, missing, skipped}`: `missing` is every template
  category (all 24 are required, deviation 1) no case shows and no skip names, in template order; `skipped` the declared skips.
- **Skips** (parameter `skipped`): `[{category, reason, document?}]`, the category one of the template's 24 ids (the
  parameter schema refuses others at start_run), the reason the user's words and not blank, `document` limiting the skip to
  one document, written as its document id, its external id (with or without `@revision`), the id with `@revision`, or the
  upload reference `src:<sha256>`. A skip without `document` applies to every document. A skip that cannot be applied refuses
  the whole start_run with `template-gap.skip_invalid` and a fix that lists the run's document ids: a blank reason (also
  U+3000, which passes the schema's `minLength`), a document not in the run, or the same document and category named twice
  (deviation 12). A skip is listed apart and never makes a category present.
- **Summary** (the model reads only id, label and summary; at most 480 characters):
  `用例 N 个（用例规则：…）；缺 M 个模板类别：压力测试（stress）、…；参数 skipped 声明跳过 K 个：…；模板类别出现 P/24 个；另有 U 个没有标签…`.
  When names and ids do not fit, every category is written by its id only (`缺 M 个模板类别（只列编号）：stress、…`), so
  every missing category is always named (tested on the worst case: all 24 missing, five-digit counts).
- **Location**: the root node. With one document `n/<root id>`, or `i` when the root id is not unique; with several,
  `n/<root id>`, which must resolve in that document only (the engine resolves a location against every source of the slot).
- **Refusals of the whole start_run** (with the pack's fix): `invalid_input` (not a parsed mind map, unusable or repeated
  document id, no document), `skip_invalid` (above), `no_case` (a document without cases, naming it and its untagged nodes),
  `root_ambiguous` (documents whose roots cannot be told apart), `too_large` (output above 8 MiB), `template_invalid`,
  `internal_error` (the projection's guard; never a throw).
- **Warnings** are per-document notes for the admin log (the engine shows them to nobody else): untagged nodes, tagged group
  nodes, shared, missing or unusable node ids, malformed structure, depth, tags that are not text.

## The check and the production run

`functions/subject.ts` builds `{item, location, document, covered, skipped}` from the item fields; coverage@1 (`required` the
closed set of the 24 category ids written in the table from the template, `covered: $.covered[*]`, skips with a non-blank
reason) supports or refutes with `core.coverage.shortfall` and `data.missing`, which equals `fields.missing` (tested on many
variants). The members come from the table, not from the item, so a projection that dropped a category could not make it
unrequired. A missing category list leaves `covered` absent, so the check is unknown (missing input), never a judgment of
`[]`. The table is advisory (keyword and tag matching can be wrong; C05 R[1]). The subject builder has no totality guard: the
engine treats only a throw as a failed builder (unknown, `check_error`, the cause in the admin log), while a refusal object
returned by a guard was judged as a subject without input (`missing_input`).

On the real engine: a document with a gap is delivered with the static terminal `violation` (`core.coverage.shortfall`,
advisory, attribution `author_input`) and the requirement unsatisfied (`outcome_mismatch`); a complete one `pass`,
satisfied; nothing is unknown. The result is stored at start_run with no submission (`getRun().latest`, `submissions: []`)
and named by `StartRunOutput.result`. `submit_result` is optional: a cross-item judgment is kept as the model's commentary and
the facts are recomputed; item slots are refused (nothing to fill).

## How to test

```
node --test "packs/workflow/template-gap/**/*.test.ts"
npx tsc --noEmit
```

- `functions/project.test.ts`: the synthetic ~180-node map (`testing/mindmap.ts`: 184 nodes, 74 cases; every category shown
  by cases of two test types at least and never only together with another category) against its declared gold for all 24
  categories; the metamorphic relations of brief 6b for **every** category (remove every case of it → exactly it missing;
  add one case → present with that case as evidence); five shuffles (every children list) → the identical item; the
  declared order limits (deviations 6, 7: numbered copies and uploads); skips for one or every document in every accepted
  spelling and every refused skip; several documents; summaries, including the worst case; every refusal; hostile models;
  determinism.
- `functions/cases.test.ts`, `template.test.ts`, `subject.test.ts`: the case rule (the tagged group in both directions),
  identities, template admission and matching, the arrow form against the earlier pattern, time bounds for the two inputs
  that were superlinear, the subject, the real coverage@1 interpreter and the missing guard.
- `functions/parity.test.ts`: on the shared fixtures (`tests/fixtures/mindmaps`) the cases, identities, counts and evidence
  equal case-review's `projectItems` + `templateCoverage`; the categories equal case-review's except that all are required.
- `pack.test.ts`: pack.json current, every declaration file in its contract shape and as the brief specifies, `validatePack`
  and the publish check without a database, the parameter schema, codes declared and reachable, SKILL.md (skips on the
  user's word, the conditional evidence step, the batch size), imports, the functions in the real sandbox equal to in
  process, two hostile maps inside the sandbox limits, the examples.
- `engine.test.ts`: the real registry (publish check passes; a failing sample refuses the publication), the real engine on
  the registry's ports with a temporary PostgreSQL: a production run over 27 documents (an upload and agile reads) with
  every one of the 24 categories removed in turn, a witness added back and a per-document skip written as the external id;
  the same document reordered gives the identical item and digest; commentary; every refusal at start_run, the skip refusals
  included; a failing subject builder (unknown, `check_error`); the `* → unknown` variant (verified in `engine.test.ts`). Two tests are marked
  `todo` because they wait for other packages (Needs): the `author_samples_only` mark on claims, and no product binding while
  a product pack is active. They run and report their current failure without failing the suite.

Tests that run pack functions skip where macOS `sandbox-exec` is missing (that is not a pass).

## Decisions and deviations

1. **Every category of template v3 is required** (brief 6a: the gap check runs against the whole template; 6b: removing
   every case of a category must make that category missing). case-review requires only the six test types, because with all
   24 required every document of its real sample missed 8 to 23 categories (median 19) and four categories matched in none:
   whether a per-command or per-feature category applies needs the commands of the feature. So expect most real documents to
   be unsatisfied; the check stays advisory, the summary names every gap, and a category that does not apply is declared
   skipped by the user. Confirmed by decision 35 item 19; open question 1 is settled.
2. **No error handling row vs `* → unknown`.** coverage@1 gives exactly one refutation code, `core.coverage.shortfall`.
   Earlier engine behavior turned a `* → unknown` row into `unchecked` (`integrity_unproven`, attribution `data_gap`, status
   pending, counted in `unknown`). On 2026-10-22, the owner unified the engine behavior with the reference (Decision 6):
   action `unknown` keeps the terminal as `violation`, records code and tier, leaves attribution empty (`unattributed`,
   待归因), and requirement status `unsatisfied`, with unknown count 0 (记未知保留反驳，归责待定). With `error_handling: []`,
   the violation is attributed to `author_input`. Both leave the gap a violation and the requirement unsatisfied (no longer
   a behavioral deviation); `engine.test.ts` verifies both.
3. **Additions to the brief's fields and parameter:** `fields.untagged` (untagged nodes written like cases: not counted, so a
   missing test type may be a missing tag) and the optional `document` of a skip (several documents in one run).
4. **The case rule is case-review's, not quite the brief's.** The brief defines a case as a node with a non-empty `resource`
   and a priority whose children are its expected results. Inherited from case-review (its deviations 1 to 3, measured on its
   real sample): a tagged node without a priority is a case (6 in the sample; dropping them would hide cases); steps and
   priority-3 preconditions are read (43% of tagged cases use case → step → expected). On 2026-10-22, the owner unified the
   default case rule across packs to `marked` (docs/hub-r4-tasks/union-case-rule.md): untagged candidate cases carrying the
   case priority are counted as cases (with `tags: []`, evaluating template gaps normally); `case_rule: tagged` remains
   available as a restrictive switch. Kept for evidence parity with case-review.
5. **A tagged group node changes role with what is below it** (case-review's rule, kept for parity): a tagged priority-1 node
   that holds cases is a group; with no case below it, it is a case. So 6b's relations fail at such a node in both directions:
   removing every Functional case below a Function-tagged group turns the group into a Functional case (functional stays
   present, the group as evidence); adding a case below a tagged priority-1 node that was the only Stress case turns it into
   a group (stress goes missing). A rule that does not look below needs the owner and case-review: "always a group" matches
   case-review's sample (all 8 such nodes hold cases) but drops a node written as a case with priority 1 (case-review's fixture
   has one and counts it); "always a case" (the brief) turns the 8 real groups into cases. `cases.test.ts` pins both
   directions; open question 2.
6. **Numbered copies and id-less cases follow document order** (W01 R[2]: such identities are the pack's own and not carried
   across revisions). Copies of a shared id are `#1`, `#2` and cases without an id `@<node index>` in document order, so
   reordering moves these evidence ids (and the item fingerprint); presence, counts, missing and the summary do not change.
   case-review numbers the same way and the evidence must name its item ids, so both would change together (open question 3).
7. **An upload is named by its bytes** (`upload-<SHA-256 prefix>`): the same map with its cases reordered is another upload,
   so the item id and the document part of every evidence id differ, while the facts are equal. A name that ignores order
   (the root id, which a copied template may share; a digest of an order-free form) is open question 4. Agile documents are
   named by their platform id and are not affected.
8. **Evidence: sorted, at most 20** (case-review: document order, 50): the report must not depend on the order of the cases,
   and the item stays small (about 6 KB of JSON per document of the synthetic map).
9. **The template is imported as JSON by the projection** (`with { type: 'json' }`, admitted by the import scan and the
   sandbox): the projection's input is fixed by the engine, so the table cannot be passed in like case-review does.
10. **Two documents with one root id are refused** (`root_ambiguous`) rather than located at another node: a location names
    no source (engine Needs 6), and a root is what a document item is.
11. **Samples are all `author`**: there are no returned counterexamples or retained deliveries for a new pack, so the check is
    honestly marked `author_samples_only` (warning `publish.author_samples_only`). The engine does not put the mark on the
    claims yet (Needs, runs-engine; a `todo` test).
12. **A skip that cannot be applied refuses the run** (W01 R[3] reserves the refusal for sources that cannot be projected;
    this is the caller's own parameter, like a document given twice, which the schema cannot check). A warning would reach
    only the admin log and the parse action (the engine shows warnings to nobody else), so the user's declaration would be
    dropped without notice.
13. **A skip rests on the user's declaration.** SKILL.md allows a skip only when the user says the category does not apply,
    with the user's words as the reason; the model's own view goes into its marked commentary. The resulting support is still
    a fact claim (nature fact, provenance projected, no mark), which this pack cannot change (Needs, runs-engine).

## Limits

- The categories other than the six test types are found by keywords (as in case-review): a group named after a category
  counts for every case in it, and whether a per-command category applies needs the commands of the feature.
- About half of the real cases are untagged (case-review README): under the default marked rule they are counted and projected as cases; under the restrictive tagged rule they are disclosed and not counted.
- A run takes about 30 documents: the bound inputs of a run are one sandbox input (32 MiB; a 3,000-node document is about
  0.8 MB of parsed model), above which the function never runs and the engine answers with its generic refusal; and every
  document adds a source line and an item line to the start_run text (30,000 characters, then paged).
- The evidence lists are in the run record (`items[n].fields`). SKILL.md reads them with the run record reference when the
  start_run answer shows one; today's answer does not (Needs, contracts and server), so they are in the console only.

## Needs from other packages

- **server / assembly**: publish this pack from a staged copy (`api.ts stage <dir>`, then `registry.publish`), since the
  package directory also holds README, api and tests. Show the run record reference (`rec:<digest>`, `StartRunDetail.runRecord`)
  in the start_run text, and pass the text context: `hub/server/tools.ts` calls `toolText(name, value)` without one, so
  `context.record` is null and even the paging hints fall back to the console.
- **contracts**: (1) a run record reference in `StartRunOutput` (today only `result.reference`, the validation result, which
  has no `/items`), so that reading item fields does not depend on how the server writes text; (2) an optional `path` in
  `PackError`: a projection refusal is always reported at `/inputs/<subject>`, also `skip_invalid`, whose cause is in
  `/parameters/skipped`; (3) a way for a workflow to say that it binds no product line (done: a workflow with no product id and no catalog binds none).
- **runs-packs** (done by the integrator): a workflow that names no product and requires no catalog is bound to no product line. `boundProducts` returns none for it, so `list_task_packs` shows no products, `readableProducts` grants nothing and `start_run` refuses a `product` argument at `/product`; `engine.test.ts` guards it with a synthetic product pack active.
- **runs-engine**: (1) T02 R[1]: apply `publishCheckMarks(workflow)` to the claims of each check (`author_samples_only` here);
  `engine.test.ts` asserts it as a `todo`. (2) Mark a support that rests on declared skips (`data.skipped` not empty) with
  `conditional_on_judgment` (以判断为前提), so that a gap the user declared away does not read as a plain fact. (3) Refuse an
  oversized projection input with the split fix: `serializeInput` (hub/rules) throws a RangeError above 32 MiB and the
  projection call answers `任务包的投影函数没有给出条目…请联系任务包作者`. (4) Observation: on 2026-10-22, action `unknown` was aligned with the reference to keep terminal `violation`, record code and tier, leave attribution empty (`unattributed`), and leave requirement status `unsatisfied` (记未知保留反驳，归责待定); a location that resolves in several sources of a `many`
  slot refuses the run (FragmentRef names no source; engine Needs 6).
- **rules**: coverage@1's support statement `N 个必须覆盖的成员都已覆盖（其中 K 个写明了跳过理由）` calls the skipped members
  covered while `data.covered` leaves them out; a wording such as `N 个必须覆盖的成员：M 个已覆盖，K 个写明了跳过理由` would
  match. Optionally a typed sandbox error for an oversized input, so the engine can tell it from a function error.
- **case-review**: `functions/template-coverage.ts:15` has the same arrow pattern, which is quadratic on a run of dashes or of
  U+FEFF; the linear form here (`/ ?(?:→|⟶|⇒|=>|—>|–>|(?<!-)-+>) ?/gu`) gives the same forms on folded texts
  (`template.test.ts`). The connectors' agile meta is `{title, folders, found}` (hub/connectors README) while case-review reads
  `ancestors`; this pack reads `folders`, then `ancestors`; one name should be settled. Decisions 5 and 6 are shared rules:
  change them in both packs together.
- **packs integrator**: case-review and this pack hold one copy each of the template v3 categories and of the case rule;
  `parity.test.ts` fails when they part (the required flag is the one declared difference). Change both together.

## Open questions

1. **已定（决定 35 第 19 项）**：模板 v3 的 24 个类别全部必选；另按命令报告 9 个 command 类别的覆盖。
   文档级 24 类覆盖不因命令、功能或索引内容而缩减。
2. A tagged priority-1 node: a group while it holds cases (now, case-review), always a group, or always a case (the brief)?
3. Number copies of a shared id and id-less cases by their content instead of document order, in both packs?
4. Name an upload by something its order does not change (its root id, or a digest of an order-free form)?
5. `* → unknown` (the brief) or no row (this pack)? Decided on 2026-10-22 (Decision 6): the engine unifies `unknown` routing to keep refutations as `violation` with attribution `unattributed` (记未知保留反驳，归责待定). With or without the row, a gap is a violation and status is unsatisfied.
6. **Count untagged cases by default**: decided by the owner on 2026-10-22 (docs/hub-r4-tasks/union-case-rule.md). The default
   case_rule is unified to marked across all packs (template-gap, case-review, case-review-verify), counting untagged candidate
   nodes as cases with `tags: []`; `tagged` remains available as a restrictive parameter.
7. Is 20 evidence ids per category enough for the console?
