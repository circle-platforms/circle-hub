# template-gap 1.1.1: document categories and command coverage

This workflow is a production run: both requirements are facts, computed and stored at start_run. It fills no item
slot, generates no cases and calls no model. The documents are the judged subject. Both checks are static,
bookkeeping and advisory: a missing category is a factual gap, not an instruction to change the source in the Hub.
Model elements: W01/W02, C04/C05, K02, T01/T02; decision 35 item 19.

## Inputs and the locked scope

- `documents`: required, many, subject; agile:mindmap or a JSON upload. A document is one item. Around 30 ordinary
  documents fit a batch; large maps or command fan-out require smaller batches.
- Product binding requires `commands@1`. The caller supplies product and build; the pack names no product.
- `case_index`: optional, one, expected, accepts knowledge:index. Read
  `knowledge:index:<product>:<same build>?kind=case&key=document&only=<agile document ids>&fields=document,node,commands,title,path_labels`.
  only must equal the agile documents of this run, no more or fewer; uploads are excluded. An all-upload run need not
  bind an index. Missing case_index is a recoverable evidence gap for agile documents, never an empty index.
- Admission checks index-view@1, case/document, root and product identity, required fields, entry identities/tree
  references, exact only, and completeness facts. Contradictions refuse the whole start_run with
  `template-gap.index_invalid`; its fix names the locked build and exact only. No partial result is accepted then.

The index is frozen in context.groups with its source receipt. Command paths are opaque values already parsed by the
product producer. This workflow does not scan titles, steps or expected results to infer commands. The current upstream
producer extracts commands from titles and ancestors; hub-view-scope may extend that to steps/expected results without
changing this consumer.

## The unchanged 24-category requirement

`coverage` uses the admitted template-v3-coverage.json table and coverage@1. All 24 categories remain required, including
the nine command categories; they do not disappear because an index or command is missing. categoryFacts still recognizes
categories by the existing canonical test-type tags and literal keywords. The case-review template table is untouched;
parity.test.ts retains its declared required-flag difference.

The default case_rule is marked (tags or the team's case marker); tagged remains available for document-level coverage.
An untagged marked candidate is counted as a case, with no invented test-type tag. marked_only discloses such cases;
untagged retains the existing restrictive-tagged-rule disclosure. The separate hub-pack-findings follow-up owns the
broader untagged-count and always-present covered changes; this task does not implement them.

## Command identity and revision matching

`command_coverage` requires marked, the product producer's default case-key rule. tagged produces the definite
`template-gap.case_rule_mismatch` conclusion, with a next action to rerun using the default (omit case_rule or use marked).
Knowledge sync cannot fix a rule mismatch. Uploads always get not_indexed instead of being mistaken for indexed agile data.

Cases connect by (document, case key), plus exact title and ordered path_labels. The case key is the existing
case-review-compatible identity; no new key/command parser was added. Headers use exact code-unit equality, without NFKC, whitespace folding or trimming. Labels keep their ancestor order. If a stable key has a different title or ancestor label,
it is not a matching current case revision: withhold its old command membership, report it among unmatched cases, and
require knowledge sync and a new read/run. Multiple index entries for one matching key count the case once per command.
Conflicting revisions under one key are also unmatched, not arbitrarily selected.

A shared parent-pointer graph freezes case headers/ancestors once; expected-result leaf text is omitted from that graph.
Every node text is normalized once for matching. A long shared title is not copied into every case's path. The existing
long-label/deep-tree tests still run within their original time bounds and the projection's 8 MiB output cap.
Truncated producer titles/label lists are not accepted by prefix matching: after one sync/re-read still cannot establish
identity, report the field-fidelity/capability gap. Do not silently guess a command or loop forever on sync.

## Command facts, evidence and skips

For each document and each command present in its admitted index, fields.command_coverage contains:

- unique matching case count;
- all nine categories from template-v3.json whose group is command, whether present or absent;
- per-category case count, sorted evidence case ids (at most 20), and their sorted tree: references;
- missing categories and declared skips, plus completeness and unmatched-case facts.

Full category membership comes from categoryFacts before display evidence is capped. It is reused for document and
command reports; command/category universes are not taken from the item's display rows. The command subject builder
reconstructs from frozen index/case facts, so dropping a display command/category cannot make it optional. Facts cite the
locked tree and cases; the original index-view receipt remains in frozen groups. JSON entry enumeration order does not
change the items or pure check conclusions. Real source-byte changes still change their src: provenance; positional or
numbered duplicate case keys retain the existing document-order limitation.

skipped entries are `{category, reason, document?, command?}`. Only the user's explicit declaration is allowed, with a
nonblank reason. No command means the existing document skip and all its commands. A command means only that exact indexed
path and a command-group category; it does not skip document-level coverage or another command. Unknown targets and
conflicting/overlapping declarations refuse start_run as skip_invalid, rather than being dropped. Skips are listed apart
and never manufacture observed cases.

## Conclusions and recovery

- Every command with all nine categories observed or explicitly skipped: support.
- Complete evidence but missing categories: refute `template-gap.command_shortfall`, data.missing names the categories.
- A complete index omits an agile document: refute `template-gap.not_indexed`, naming root/build. Uploads get the same
  code with the action to rerun using the agile document id.
- All cases match but none has a parsed command: refute `template-gap.no_commands`, with the case count and the action
  to put commands into titles/ancestors, sync and rerun.
- No bound index: transitional unknown, data.missing includes case_index, with the binding/rerun action.
- skipped sources, truncation/cut keys, unmatched case revisions: known command supports survive; potential
  shortfalls become missing-input unknowns. Only matched current cases contribute command paths. An additional document conclusion discloses orphaned keys, unmatched count/ids, skipped
  sources, truncation and the view's verbatim unplaced notes, because more commands may be unread. It never says full coverage.

Unplaced entries remain in the index. Notes are preserved verbatim for disclosure and never determine completeness.
IndexView has no typed unplaced-entry count: unplacedRoot stays null instead of parsing prose. A typed whole-root count
is a need from the contracts/knowledge owner; until then the raw notes carry that disclosure.

Every package-generated unknown carries missing facts, next_action and recovery: action, document/build (or failed check)
object, event deadline and one-attempt bound. Deadline: before this round's final report; rerun immediately once facts
are supplied. Sync/re-read once, then report a definite source, field-fidelity or index-read capability gap if still
incomplete. The six MCP tools have no sync tool: the client must request the authorized integrator's sync and follow its
receipt before rerunning, or state that capability gap. The Hub does not invoke a model or perform an undeclared action.
SKILL.md specifies the continuation; an unknown is not a successful final verification.

Summaries stay within 480 characters. Calculated complete reports say “按命令：N 个命令，K 个缺类别”. Partial reports label
only read commands/potential gaps; unbound/unsupported modes say not calculated or rule mismatch, without presenting
unknown coverage as zero. The all-missing, five-digit-case-count worst cases remain tested.

## Unversioned documents: handoff to kb-unversioned

A document moved to the product's unversioned scope will never appear in a version-build index. not_indexed therefore
has a conditional action: obtain the unversioned root from its run receipt/knowledge entry point, then use get_nodes on
`tree:<unversioned root>/` to inspect that scope. Until kb-unversioned lands, report that missing capability instead of
repeatedly trying other builds. This package currently accepts only the locked version root as case_index; it does not
pretend an unversioned root is a build root. After kb-unversioned merges, its owner/integrator must update the concrete
root-discovery interface, this next-action text, and the cross-scope binding/index contract if command coverage is to
include those entries. No fictional `knowledge:index:...:unversioned` address is promised here.

## Published samples and transitional examples

There are 13 author samples: coverage has two positives/four negatives, command_coverage two positives/five negatives.
They pass the real publication check and retain author_samples_only. No external evidence or real-bed proof is claimed.

**合约缺口：当前样例合约不收“期望未知”。** samples/positive only permits support; samples/negative requires a refutation.
Pure unknown and support-plus-document-unknown therefore cannot be published as those sample polarities. By integrator
authorization, four paired scenes live in examples/command_*.json, with synthetic mindmap/index inputs, exact check
subjects and independently declared before/after expectations. Both synthetic conformance tests and production runs on
the real registry/engine check them; every unknown must carry missing facts plus action, object and deadline, and the
restored side must resolve to support or refutation.

The integrator's model revision must add **期望过渡未知** samples, including the recovery obligation/expiry and resolved
counterpart; after generation/admission support exists, move these pairs into samples/ and rerun publication. The current
pack does not invent an undeclared polarity or turn an unknown into a false refutation to satisfy admission.

## Verification and ownership

Run `npx tsc --noEmit`, `node --test --test-concurrency=1 "packs/workflow/template-gap/**/*.test.ts"`, and
`node packs/workflow/template-gap/api.ts check`. `node .../testing/examples.ts` rewrites the upload example and paired
scenes then signs; `api.ts sign` refreshes pack.json. Tooling/tests/testing/README are excluded from published files.

Tests cover root/only/schema admission, multi-command/multi-entry deduplication, scoped skips, evidence limits, 9-class
removal/restoration, case/index permutations, monotone known support under new unmatched cases, stable-key title/label
drift, default-rule mismatch, bounded unknown recovery, publication, sandbox limits, and production runs over agile
documents plus an upload with temporary PostgreSQL and synthetic knowledge/read ports. Tests skip explicitly where OS
isolation is unavailable; a skip is not a pass. No real environment, system, deployment or model is used.

## Remaining package decisions

The case rule and identities remain shared with case-review: a tagged group that loses all child cases can itself become
a case; duplicate/id-less keys depend on document order; uploads are named by source SHA and change identity on byte
permutation. Those limits were not redefined here. Advisory keyword matches and user-declared skips do not replace a
judgment of applicability; the existing engine need to mark declared-skip-dependent support remains.

## Disclosure continuity

The numbered disclosures below retain their citation identities. Historical observations are not new real-system
verification. Current command coverage, binding and recovery rules above take precedence over the original scope.
Unresolved core requests remain handoffs; this package does not claim to have implemented them.

## Decisions and deviations

1. **Every category of template v3 is required** (brief 6a: the gap check runs against the whole template; 6b: removing
   every case of a category must make that category missing). case-review requires only the six test types, because with all
   24 required every document of its real sample missed 8 to 23 categories (median 19) and four categories matched in none:
   whether a per-command or per-feature category applies needs the commands of the feature. Decision 35 item 19 confirms all 24 required and adds nine-category per-command coverage; the check stays advisory, the summary names every gap, and a category that does not apply is declared
   skipped by the user. Open question 1 is decided.
2. **No error handling row vs `* → unknown`.** coverage@1 gives exactly one refutation code, `core.coverage.shortfall`.
   Earlier engine behavior turned a `* → unknown` row into `unchecked` (`integrity_unproven`, attribution `data_gap`, status
   pending, counted in `unknown`). On 2026-10-22, the owner unified the engine behavior with the reference (Decision 6):
   action `unknown` keeps the terminal as `violation`, records code and tier, leaves attribution empty (`unattributed`,
   待归因), and requirement status `unsatisfied`, with unknown count 0 (记未知保留反驳，归责待定). With `error_handling: []`,
   the violation is attributed to `author_input`. Both leave the gap a violation and the requirement unsatisfied (no longer
   a behavioral deviation); `engine.test.ts` verifies both.
3. **Additions to the brief's fields and parameter:** `fields.untagged` (untagged nodes written like cases: not counted, so a
   missing test type may be a missing tag) and optional `document` and `command` scopes of a skip (several documents in one run).
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
  `/parameters/skipped`; (3) a way for a workflow to say that it binds no product line (generic capability is done; this pack now requires commands@1 and therefore binds a product/build).
- **runs-packs** (historical generic capability, no longer this pack’s binding): a workflow that names no product and requires no catalog is bound to no product line. `boundProducts` returns none for it, so `list_task_packs` shows no products, `readableProducts` grants nothing and `start_run` refuses a `product` argument at `/product`; This pack now requires commands@1 and binds a product/build; engine.test.ts guards that current binding.
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

1. **已定（决定 35 第 19 项）**：24 个类别全部必选，另按命令核验 9 个类别。
2. A tagged priority-1 node: a group while it holds cases (now, case-review), always a group, or always a case (the brief)?
3. Number copies of a shared id and id-less cases by their content instead of document order, in both packs?
4. Name an upload by something its order does not change (its root id, or a digest of an order-free form)?
5. `* → unknown` (the brief) or no row (this pack)? Decided on 2026-10-22 (Decision 6): the engine unifies `unknown` routing to keep refutations as `violation` with attribution `unattributed` (记未知保留反驳，归责待定). With or without the row, a gap is a violation and status is unsatisfied.
6. **Count untagged cases by default**: decided by the owner on 2026-10-22 (docs/hub-r4-tasks/union-case-rule.md). The default
   case_rule is unified to marked across all packs (template-gap, case-review, case-review-verify), counting untagged candidate
   nodes as cases with `tags: []`; `tagged` remains available as a restrictive parameter.
7. Is 20 evidence ids per category enough for the console?

Deletion-only stale rows are disclosed as orphaned keys, excluded from current command membership and never treated as missing facts.
Command skips on orphan-only commands refuse; skips on unmatched current revisions remain visible as pending_skips until sync and rerun.
