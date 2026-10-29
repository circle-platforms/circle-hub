# hub/runs/engine

Starting runs, boundary validation, terminal states and partitions: model elements W01 W02 W03 W05 W06 W07 W08, V01 V03 V04
V05 V06 V07, T03 T04, A01-A04, B01 B05 and C08 R[4]. The server and the console import only `api.ts`.

```ts
import { createRunsService } from '../runs/engine/api.ts';
const runs = createRunsService({ records: kit, workflows, packs, knowledge, external, adminLog: (e) => note(e) });
await runs.startRun(user, input, { traceId, sessionId });   // RunsService of hub/ports.ts, exactly
```

`createRunsService(deps)` returns a `RunsEngine`: the `RunsService` of `hub/ports.ts` (startRun, submitResult,
resolveReference, getRun, listRuns; answers are the tool outputs without `trace`) plus `startRunDetailed` (the answer, the
whole production result of a fact-only pack, the run record digest and the evidence gaps), `startHubRun` (a run the Hub
executes for a standing obligation), `getResult` (a result by its submission digest, accepted or not) and `runsFor`.
Deps: `records` (store, objects, artifacts and the read-only `variables.snapshot` port of the records kit, and optionally its `config`, whose `limits.maxRecordBytes` lets
start_run size a run before storing anything; pass the whole kit), the ports `WorkflowStore`, `PacksPort`, `KnowledgePort`,
`ExternalReaderPort` (the assembly gives it the knowledge views beside the connectors); optional `parsers` (default the core
parsers), `sandbox` and `sandboxLimits` for every pack function call, `now`, `clientKeyWindowMs` (default 24 h) and
`adminLog`, which receives the real reason behind every neutral answer and every pack function failure (details are
well-formed text). The same reasons go to the admin note of the call they belong to (`CallContext.adminNote`, decision 25).

| File | What it does |
| --- | --- |
| `start.ts` | start_run: argument checks, client key window, pack and its schemas, predecessor and lineage, parameters, target, inputs, projection, expected sources, carry-over offers, sizes, the run record, production results |
| `target.ts` | product line by any name, version line, build (declared, the pack's select_build, or the newest released build with a root), the locked root, one basis claim each |
| `inputs.ts` | binding inputs to slots: uploads, Hub records (B03 R[4]), external objects read as the caller; parsing with the core parser |
| `projection.ts` | the projection function in the sandbox, item locations and fingerprints; expected sources read best effort |
| `submit.ts` | submit_result: store as received, idempotency for the same session and declared model, supersession, arguments the records cannot hold, structure, exact values, evaluation, a receipt for every call |
| `slots.ts` | the slot schema of RunSummary.slots, the structural check of slot records and cross-item entries, pack JSON Schemas (fail closed) |
| `exact.ts` | the run scope and exact-value resolution: references, verbatim quotations, commands (T04), locations in the judged source, canonical slot records |
| `evaluate.ts` | re-running every check, terminals per (item, requirement, layer), status, attribution, claims, errors, partitions |
| `lineage.ts` | the author of the work a run judges (A04): the predecessor chain, the runs of handed-over records, their producers |
| `terminals.ts`, `partitions.ts`, `independence.ts`, `claims.ts` | the pure rules, tested on their own |
| `reuse.ts` | carry-over offers and carried items (C08 R[4]) |
| `preview.ts`, `queries.ts` | resolve_reference; getRun, listRuns, getResult, runsFor |
| `store.ts`, `readers.ts` | records and index keys (`runs.*`, `action.kind`, `action.run`); visibility and the readers hub/refs resolves with |
| `testing/` | fakes of the ports, the synthetic toy packs (written to temp directories with real function files), mind maps, the harness |

## Ordinary-variable snapshots and parameter admission

Each accepted `start_run` call reads all current ordinary-variable decisions in one verified snapshot. Input binding and expected-source reads receive the same process-local map through `ExternalReadContext`; nested connector reads inherit it. The map is never serialized into the run. The returned input bytes and their source references remain frozen, so a later variable change affects a new run only. A newly referenced name absent from this snapshot requires setting the name and reopening the operation; it is never silently resolved against current state.

Before schema diagnostics or any external read, the entry point scans the complete JSON tool arguments for recognizable credentials. A hit refuses the whole call with `SUBMISSION_SCHEMA_VIOLATION` and the fixed instruction “参数里不能有凭据”; no run is stored and neither values nor sensitive syntax are quoted. Reference-looking parameter strings are ordinary text: the Hub never substitutes them, and accepted parameters remain byte-equivalent JSON values in the run.

## Decisions

1. **Records.** A run is `run@1` (`RunRecord`), checked with zod before it is written; a submission is stored before anything
   else is checked (once the run it names is found visible to the caller: a call naming no such run stores nothing and is
   answered SOURCE_UNAVAILABLE; a repeat stores nothing either), as `submission@1` when it parses and `submission-received@1`
   (the arguments object) otherwise. Arguments the records cannot hold as checked JSON (a lone surrogate, nesting past the
   canonical limit of 1000 levels, a body over the record limit) are kept as their JSON text in the object store and the
   `submission-received@1` record is the engine's wrapper `{ received: { object, sha256, size, non_canonical_path, run } }`
   (records decision 3; `object` is absent when the object store refuses the text too, then only digest and size are kept, as
   for an upload refused for a credential, B05 R[3]). Raw arguments always name their run at the top level, the wrapper never
   does: the run a submission record belongs to (visibility, R02) is its top-level `run`, and `received.run` only for the wrapper
   (`readers.ts runOfRecord`), so no argument key can move a record into another user's run. Results are `validation@1`,
   actions `action@1` (`parse` at start_run, `validate` per submission and per production result, acceptance and codes, the
   session and model observed, as well-formed text, and the requirements that used a repair round). Counts are never stored.
2. **Absent equals forbidden.** An unknown, unassigned or withdrawn pack, an invisible predecessor, run or input, and an
   external object no resource reads all give `SOURCE_UNAVAILABLE` (`对你不可用`) with the tool's empty shape; the reason goes
   to the call's admin note and `adminLog` only. Users see their own runs, admins every run, Hub-side runs admins only
   (W06 R[3]).
3. **Target.** A product name resolves through `productByName` (any name, case-insensitive) and must be a line the caller may
   read that provides the workflow's catalogs; with a fixed `product.id` that line is used, and a caller naming another line is
   refused rather than silently overridden. Without a product and with several eligible lines the call is refused with their
   names as options (K01 R[10]: the runner chooses). A build the caller names wins (declared); otherwise the product pack's
   `select_build` (sandboxed, candidates = the builds with a root, each with its single sources only: a role that lists
   external objects, thousands of case documents a build covers, is left out so that the sandbox input stays small;
   `selectCandidate` in `target.ts`) or the documented default `runs.newest_released@1` (newest
   released build of the requested line with a root) chooses (projected), with its basis text and alternatives. Unknown builds,
   builds of another line and lines without a root are `REFERENCE_UNRESOLVED` with the existing builds as options. The run
   records the root; the composition digest is in the build basis claim. Within one start, the unfiltered build list is reused
   for selection, exact-name resolution and the optional frozen build context; seedling lookups are memoized by exact line.
   Neither cache crosses calls, and the selected build's root is still resolved before it is locked.
4. **Hub record inputs** (handover, B03 R[3]-R[4]): the bound bytes are the canonical JSON of the record envelope (so their
   SHA-256 is the record digest), or of the value its pointer names, stored as a generated artifact readable by the caller;
   `BoundInput.meta` names the record. The receiver gets the record as a source; no carry-over is offered across a handover.
5. **Items.** The location is `srcFragment(sha, parser, selector, range)` of the bound source of the fragment's slot (the
   subject slot by default) and must resolve — when the fragment names its source (`FragmentRef.source`, the digest of the
   bound bytes), only that source is tried (naming one that is not bound in the slot refuses the start); without it every
   source of the slot is tried and exactly one must resolve. The digest is SHA-256 of the canonical `{id, label, fields}`
   (summary excluded).
   Duplicate ids refuse the call; a pack refusal keeps its code when it is under the pack name. A projection that succeeds
   with zero items is a legal answer, not a refusal (W01 R[3]): the run starts with an empty item list — a production run
   stores its result (every partition empty, coverage `complete: true, examined: 0, total: 0`, run-level requirements
   evaluated) — and the answer carries a `runs.empty_items` note and the projection's warnings in its evidence gaps (kept
   identical on a repeated client key, read back from the parse action).
6. **Expected sources** are read as the caller, best effort: an unreadable one is listed in the `parse` action as
   `{external, role, reason: 对你不可用}`; the real reason only in the admin log. The function failing never fails the run.
7. **Structure** (T03 R[3]): every declared item slot key is required in a handled item's record (`[]` says nothing to
   report); codes and ranks are required when the slot declares them; `min` defaults to 0. A cross-item entry without a code
   is a free claim (no requirement, no rank); with a code it belongs to the run-level requirement whose codes contain it.
8. **Pack JSON Schemas fail closed** (slot `data`, parameters). A schema is enforced only when it contains no regular
   expression keyword (`pattern`, `patternProperties`: they would run as backtracking expressions on model input inside the Hub
   process; property names are only names) and zod can compile it (`unevaluatedProperties`, `if`/`then`/`else`, remote `$ref`
   and the like cannot be); start_run refuses a pack with any other schema before reading anything
   (`SUBMISSION_SCHEMA_VIOLATION` at `/pack`, the schema's place in the pack named), and a statement or parameter value a schema
   cannot check is a structure violation, never an unchecked value.
9. **Scope of exact values** (T04 R[4]): `src:` into a source bound to the run (inputs, expected sources, the bytes of bound
   records), `tree:` under the locked root, `rec:` of bound records and of the predecessor's results; `entry:` never.
   Out of scope is `REFERENCE_UNRESOLVED` (message neutral). Quotations must match the resolved fragment text with hub/refs
   `quoteMatches`; their grounds are the reference pinned to the quotation's byte range. Commands (T04 R[5]): verbatim in the
   item's fragment or the statement's quotations, then the longest catalog head of the locked catalogs, then verbatim in any
   bound source; a catalog menu of several heads found in no source is `REFERENCE_AMBIGUOUS` with the heads as options;
   anything else `REFERENCE_UNRESOLVED`. A command stated absent (`present: false`) is not resolved: the catalog check judges it.
10. **Locations** (SlotClaim.location: where in the judged source the statement applies; scenario 16): a fragment of a source
    bound through the workflow's subject slot or holding an item of the run, or a record bound there. A location in an expected
    source, a hint, the tree or
    any other record is `REFERENCE_UNRESOLVED` at `<statement>/location` with a fix saying where evidence goes (grounds,
    quotes). Carried statements keep the location they were checked with in their own run.
11. **Canonical references for checks.** A check gets the slot record with every resolved reference (location, grounds,
    quotation references) in its canonical form, the cross-item entries likewise in the default run subject, and the evidence
    and fragment texts keyed by the canonical form (the as-written quotation reference too), so a check that pairs references
    by string meets one spelling per fragment whatever selector alias the model used (kityminder `i/<n>` and `n/<id>`, markdown
    `h/<x>[1]` and `h/<x>`, XML index and name paths). Claims rest on canonical grounds; each value's resolution keeps the
    model's text beside its referent (T04 R[1]).
12. **Checks.** Each check runs once per subject through `runCheck` with its table, the catalog it names (`KnowledgePort.catalog`
    of the locked root), `context.pack`, the closed sets of the slots file as `sets` (`<key>.codes`, `<key>.ranks`), the fragment
    texts of the item's evidence, the sandbox options. An item check of judgment requirements only runs for handled items. A
    run check's outcomes go to items by `item`; items it gave nothing get its item-less unknowns (a failed check never passes
    silently); item-less outcomes are run-level facts in `cross_item`, as are all outcomes of run-level requirements. An
    outcome whose `data` nests deeper than 32 levels is replaced by an unknown (check error) of that check.
    The run context (`RunContext`) carries the fixed facts plus, only when the workflow opts in with `context` in
    workflow.json, `builds`: every build the knowledge base knows for the bound product (both name families, an alias
    carrying its base, `{name, family, line, base, platform, built_at, released_at, has_root}` without sources or root
    digests, sorted by line, built_at, name), frozen in the run record like groups so an evaluation after a restart sees the
    same list. A workflow that did not ask gets nothing and stores nothing; a run bound to no product gets none. The start
    summary and answer never show it.
13. **Terminals and status** follow V01 R[6], V03 and P11 R[3]: violation > incomplete > unchecked > pass. An unknown outcome
    is classified by its reason only (`terminals.ts UNKNOWN_TERMINAL`, typed against the vocabulary): a check error, a timeout,
    missing input or an unproven closed world is unchecked (unknown, counted in `unknown`), whether the check is an interpreter
    or a pack function and whether it failed in the sandbox or returned an unknown itself; a used-up budget (an interpreter's
    work limit or the sandbox queue) is incomplete. `data.sandbox` is a display hint (`isSandboxFailure`) and steers nothing.
    A declared skip is incomplete (`declared_skip`) and an item the submission does not mention is incomplete
    (`not_covered`) at every requirement, fact or judgment (W07 R[2]-R[3]). Judgments that are handled stay `judgment`
    unless a check refutes, is unknown or ran
    out of budget; no slot: unchecked `no_check`, unsatisfied `no_producer`. A requirement that is incomplete for a skipped or
    uncovered item, used-up repair rounds or budget is incomplete at every layer it declares (W07 R[2]-R[3], W02 R[5], P11
    R[3]); otherwise a declared dynamic layer is not run (no check installed, V03 R[1]). A violation is satisfied only when
    every refutation has a code the matching override expects. Status: pending while any declared layer is unsettled,
    outcome_mismatch on a settled miss, then independence. Attribution by rule tables typed against the vocabulary: violations
    by the role the refuting check judges (subject author_input, artifact under verification producer_error, expected and
    hint data_gap, others unattributed), unknown and incomplete by reason.
14. **Error table** (W02 F[7], R[5], T03 R[4]): unexpected refutations are routed (exact code, else `*`) where the row applies
    to the role the refuting check judges: repair only to the artifact under verification (only a statement that disagrees
    with what it cites goes back to its producer; the target cannot be repaired through a submission), reject only to a blocking
    check on it; request and unknown to any. A row that does not apply leaves the violation as delivered content and uses no
    round. The primary refutation leads when its row applies, else the first routed one: repair keeps the violation and reports
    `rounds_left`; when the requirement's rounds (the largest `max_rounds` of its repair rows) are used up the terminal is
    incomplete `repair_exhausted`, the leading code and statement kept. Request is incomplete `awaiting_step` (no request record
    in milestone 1); unknown keeps the violation unattributed with the code; reject keeps the violation and puts the item in
    `rejected`. `errors` lists the repair, reject and request refutations (path into the submission for default subjects) and
    the items not covered (`core.coverage.shortfall`, the contracts' interim code); unrouted violations are only in the partitions.
15. **Rounds.** A round of a requirement is a distinct earlier submission of the run in which it had a repair-routed
    refutation, a whole-rejection error inside its statements, or (accepted submissions) an item not covered; `rounds_left` =
    rounds − used. Whole-rejection errors inside a requirement's statements carry its `rounds_left` (scenario 2).
16. **Not accepted** (W08 R[1]): the checks still run on the items whose own values resolved; their routed refutations come
    back as fix notes after the rejection codes; nothing is partitioned. Arguments that do not parse as `submission@1` are
    not an exception: their zod issues are the first codes, and every `items[]` and `cross_item[]` entry that parses on its own
    (each item once, none an issue points into) is checked like a submission at its original position, so the receipt names
    every cause at once. Arguments the records cannot hold as checked JSON or nested deeper than 64 levels are not read at all:
    the receipt is `SUBMISSION_SCHEMA_VIOLATION` at the refused path (cut to whole tokens within 1024 characters), without the
    offending text.
    Excluded items never enter item checks, run-check subjects or conclusion assembly. When every item is excluded,
    no check runs. Their missing slots therefore cannot fabricate refutations, fix notes or check repair rounds.
    Boundary errors and the remaining items' routed checks still supply the receipt; boundary error accounting is unchanged.
    Accepted submissions have no exclusions: skipped/uncovered handling keeps its existing rules.
17. **Receipts and size.** Every call that reaches a run gets a stored receipt. A validation result a record cannot hold (over
    `maxRecordBytes`, or nesting canonical JSON refuses) is answered not accepted, `SUBMISSION_SCHEMA_VIOLATION` at `''` with its
    size, the limit and the fix to split the target into at least ⌈size / limit⌉ blocks (the method splits large targets); the
    validate action is written. start_run refuses, before storing anything, a run record over the limit and a production
    result over it (computed before the run is stored: its `submission` is the run record digest, computed in advance).
18. **Independence** (A04, lineage.ts). A run independent of its predecessor judges the work of the lineage, not its own
    earlier revisions: the predecessor chain is read past the runs of the run's own pack (a verification revised by its
    verifier) to the first run of another pack (the draft), taken with its own revisions (the runs of its pack right behind
    it); every run a Hub record bound as artifact under verification belongs to is taken with its revisions too. The author
    origin is the start session of each of those runs, the session and declared model of every submission they validated, and
    the model warrants inside the bound records (carried judgments keep their producer there). A shared session or a model of
    the same family is `not_independent`; everything known and told apart is `model_family_declared`; anything else is
    `unknown`: an unobserved session, an accepted submission whose session or model is unknown, an artifact under verification
    of unknown origin (an upload, an external object), no author run, and a run without predecessor (A04 R[5]). start_run
    refuses (`SUBMISSION_SCHEMA_VIOLATION` at `/predecessor`, before anything is read) a run with such a requirement whose
    handed-over record belongs to a run outside the predecessor's lineage. Satisfied only when independent and the template
    accepts declared independence; otherwise unsatisfied `independence_unknown`; the claims are kept and carry
    `independence_declared` when the template accepts it.
19. **Model family.** The contracts give no declared family, so `sameModelFamily` compares declared names conservatively: the
    name is the text before the first white space (NFKC, lower case); two names are one family when they share a word (a run of
    two or more letters: a dated alias, another version, a hosting prefix of one model), two families when both have words and
    share none, and cannot be told apart (independence unknown) when a name has no word. A shared generic word makes
    independence `not_independent`, never `independent`.
20. **Claims.** Model statements: nature judgment, provenance declared, basis rank judgment, marks `semantics_unasserted` (V02
    R[1]), `no_reuse` when the item's slot record came without a context digest (W07 F[1]: written in one go; decision row 18
    (b)), source role the strongest role they cite (expected > subject > artifact under verification > ... > hint), grounds
    (canonical) plus pinned quotations, warrant model with the declared string, resolutions of location, grounds, quotations
    and commands, validity bound to the pack digest, the root, every cited digest, the context digest when it is a SHA-256, and
    the submission digest. Submitted cross-item entries are judgments; a declared fact keeps `unverified_submission` and
    `data.declared_nature`. Hub facts: every outcome, support included, warrant `function` with `interpreter` or
    `<pack>.<check>@<version>` and `judge_not_author` (a boundary re-run is an independent ground, A04 R[2]), provenance
    projected, basis `rule_over_observation` or, for checks of the artifact under verification, `rule_over_claims` with
    `conditional_on_judgment` and the judgments it rests on in `validity.premises` (V03 R[6], A02 R[3]: the statement the
    outcome points at, else the item's slot lists, the carried record of a carried item, the cross-item entries for a check
    over the run, the bound artifacts for a production result); an unknown outcome has nature `unknown`, no basis rank and no
    premise (A02: not on the lattice); `discrimination_not_established` where the requirement asks for discriminating power
    (V06 R[3]). Cross-item claims are bound to every item digest (V05 F[4]).
21. **Carry-over** (C08 R[4]): offered only for a pack with item-level judgment slots, from a predecessor of the same pack
    content and root whose latest accepted result came from a submission, not across a handover, for items delivered in that
    result with an unchanged digest, whose slot record (followed through earlier carry-overs) was written with a context digest
    (the published `context` description: "so unchanged items can be reused"; a record written in one go is `no_reuse`), and
    whose judgments cite only unchanged content: a source still bound, or a fragment with the same text at the same place of the
    new judged source (also several revisions back), a tree reference into the same root, a bound record. At submit only the
    offered reference is accepted (otherwise `SUBMISSION_SCHEMA_VIOLATION` at `/items/<n>/reuse`, the contracts' interim); the
    judgments come from the original record with its judge and model, the original slot record is checked again, and the item
    carries `carried_over`.
22. **Supersession** (W06 R[0], R[1]): a run is superseded by a newer run of the same runner (the configurer for a Hub-side run)
    and the same pack id that names it as predecessor; another runner's run of the pack naming it is a branch of theirs, and a
    run of another pack naming it (a verification) continues it. Submissions to a superseded run are stored and answered
    `RUN_SUPERSEDED`.
23. **Idempotency** (D05 R[4], R[5]): submissions per (run, SHA-256 of the canonical arguments, or of their JSON text when they
    are not canonical); start_run per (owner, client key) within the window, the request digest being that of the canonical
    parsed arguments. A repeat inside the window is answered from the run the key is bound to before the pack is authorized, so
    it returns the same run after the pack was unassigned or withdrawn (the run stays its runner's); other content is
    `IDEMPOTENCY_MISMATCH`. Start arguments the records cannot hold (a lone surrogate anywhere, a client key with NUL) are
    refused at their path before anything is read. Both are serialized per key in this process (a single Hub process); there is
    no cross-process lock.
24. **Production runs**: a pack whose requirements are all facts is evaluated at start_run with no submission; the result's
    `submission` is the run record digest and its acceptance `accepted` (the contract has no "not applicable", see Needs);
    the answer carries `result: {reference, counts}` (StartRunOutput.result) and `startRunDetailed` the whole result, the
    run record digest and the evidence gaps (unbound expected sources, the expected-sources function's warnings or
    failure, read back from the parse action on a repeated client key); later submissions only add model commentary. The
    same path serves `startHubRun` (host hub, trigger standing_obligation, the admin as configurer, fact-only packs only).
25. **Admin notes per call.** Every call that carries a CallContext gets an engine context of its own whose log also writes
    `<what>: <detail>` (well-formed, at most 1000 code points) to `CallContext.adminNote`, besides `adminLog`: a reason
    reaches the call it belongs to even when two calls share a trace id, without the caller bridging `adminLog` to calls.
    A note that throws changes nothing. Messages the connectors or the pack registry raise inside their own callbacks do not
    pass through the engine (the assembly's call notes take those).

## Deviations and disagreements

- **Partition step 4** counts only *required* requirements, as V05 R[3] ④ says ("某个必需要求项"); the task says "any declared
  layer". With every requirement required (the case-review packs) both agree.
- **Facts of skipped or uncovered items.** Judgment requirements and facts that need a missing submitted artifact become incomplete for a skipped or
  uncovered item; target-only facts keep the Hub's computed terminal. The current W07 R[2]-R[3] distinguishes target facts from missing artifacts; only a required incomplete requirement forces the incomplete partition.
- **Unknown outcomes** become claims with nature `unknown`, not `fact` (B01: an unknown verdict has no grounds to be a fact).
- **Default run subject**: `{ items: [{ id, label, location, fields, slots }], cross_item }` — `slots` (the item's slot record
  or null, references canonical) and `cross_item` (the submitted entries, grounds canonical) are added to the documented
  `{ items: [...] }` so that a run-level check can judge the submission (the verdict consistency of scenario 15). The default
  item subject is exactly as documented.
- **Draft versus independent verification.** The draft pack has answered this distinction: findings are judgments.
  A template that explicitly requires independence still needs the predecessor's author lineage (A04 R[5]); a revision
  does not turn its own author into an independent verifier.
- **Finding locations**: section 6 of the brief says "finding locations are references into the target ... and into sources
  (tree:, src:)". The engine reads the second half as the evidence (grounds, quotations): SlotClaim.location is "where in the
  judged source the statement applies" and scenario 16 refuses a location that is not in the target.
- **No item bound at start_run.** A bound on the number of items derived from `maxRecordBytes` alone would either refuse runs
  that fit or admit runs that do not, because a result's size depends on what the model writes; instead every submission gets a
  receipt (decision 17) and start_run refuses what certainly does not fit (the run record, a production result).

## Missing item artifacts in accepted submissions

V05 partitions delivery separately from verdicts. W07 R[2] makes a declared skip incomplete (`declared_skip`), and
W07 R[3] makes an omitted item incomplete (`not_covered`). W02 F[7] permits repair only of an existing artifact:
without a submitted item artifact there is nothing to judge or repair. The owner clarified this task's “no repair
rounds” means no **artifact-check** rounds; W07 R[3] coverage errors and their existing bookkeeping remain.

Before this change, eight synthetic cases (item/run checks, skipped/omitted items, with/without an item judgment
requirement) established these different outcomes:

| Accepted item handling | Artifact check received null slots | Stored artifact refutation | Receipt and repair | Partition |
| --- | --- | --- | --- | --- |
| Declared skip | yes | yes | no check repair | incomplete / declared_skip |
| Omitted, with item judgments | yes | yes | coverage.shortfall and judgment coverage bookkeeping; no artifact repair | incomplete / not_covered |
| Omitted, only item facts | yes | yes | false artifact refutation and artifact repair round | delivered |

Now item-artifact checks (including subject builders, tables and declared reads) do not run for skipped or omitted
items. Their artifact requirements have incomplete terminals at every declared layer, no check claims, and no check
repair round. This also covers fact requirements when the pack has no item judgment requirement. Target-only checks
still execute and keep their facts; their routing and terminals follow the existing target/handling rules. A handled
item with bad artifact data still runs checks and consumes real repair rounds. Carried artifacts still count as handled;
production evaluation without a submission keeps its previous behavior.

A run check that judges item artifacts receives only handled items and is not called for an empty set. A check of a
run-level artifact (such as a submitted final conclusion) still receives all target metadata to check coverage, but
skipped/omitted rows have **no slots property**, rather than null slots. Its per-item artifact outcomes cannot become
claims on an absent item artifact. This preserves the distinction between judging a final that claims coverage and
judging an item artifact that was never submitted.

Pack audit (read only; no pack changes in this task):

- `defect-to-case`: `checkDraftShape`, `checkCommandsRefutation` and `checkGroundedReading` explicitly turn null slots
  into “已声明跳过”的 support; `checkDuplicate` supports zero drafts. The engine no longer calls these paths for a skipped
  or omitted item. The direct-call compatibility branches remain in the pack.
- `case-review`: `findings_sources` returns missing_input for absent slots; that extra check claim is no longer made.
- `case-review-verify`: `dispositionsCheck` returns missing_input for absent slots. Its **run-level** `verdictCheck`
  depends on all targets' draft findings to reject PASS with undisposed findings on skipped items. Metadata is retained
  for this real final check; the engine must not discard those targets from its coverage calculation.
- `case-compile`: its item artifact checks can refute missing plan data or fail plan generation on null slots. Those
  checks no longer run for absent artifacts. Catalog/quote checks in these packs likewise no longer produce empty-list
  support facts for such items.

`empty-slots.test.ts` checks actual invocation counts, target facts, empty artifact claim lists, both incomplete layers,
partitions, coverage bookkeeping and the next submission's remaining real repair budget. It covers item/run checks,
one or every item absent, mixed valid/invalid artifacts, and run-level finals' retained metadata.

## Repetition policy (V07)

The pure aggregation lives in `repetition.ts` (rounds in, one summary out; no records, no dispatch, no clock). This is
what is wired to it:

- **Declaration** (`contracts/src/pack.ts`): a requirement may write `repetition {count 1..10, aggregation, k?, fresh_context?,
  baseline_first?, window_seconds?}`, and only a requirement that declares a dynamic layer may write it (a static check
  runs once). A workflow declares `work_class` (verification, reproduction, web); a requirement that writes nothing takes
  the class default (verification and reproduction: 3 rounds over `all`; web: 2 rounds, `first_pass`), and a workflow with
  no class runs one round and still reports `1/1`. An effect row declares `repetition`: the rounds it dispatches.
  `budget.count` stays a pure upper bound on writes and never doubles as a round count (integrator decision 1).
- **Publication** (`hub/runs/packs/validate.ts`): a frozen count above one that no effect row authorizes refuses
  publication with `effects.repetition_budget`, naming the row and both ways out (raise the row's `repetition`, or lower
  the count) — integrator decision 5. An impossible policy (a count over 10, `k` outside k-of-n or over the count, a
  repetition on a static requirement) is refused by the shape itself.
- **Freezing** (`repetitionSummary`, one projection with two callers): `packSummary` in the packs package and
  `requirementSummary` at start_run carry the same effective policy — count, aggregation, k, `basis`
  (`explicit` / `work_class` / `single_round`), which parts the pack wrote, and the round-shaping declarations — so a
  listing and a frozen run cannot disagree. A dispatch row's written count wins over the requirement and the class
  (V07 R[5]); `dispatchCountOf` takes the smallest count among the rows that release the requirement.
- **Aggregation** (`dispatch-results.ts`): every job of an item is one round, in journal order, and the policy frozen with
  the run aggregates them. A round whose terminal is settled (pass, or fail with a code) is judged against the
  requirement's expectation by the same `meets` the status uses; an unsettled round has no judgment. The dynamic layer
  then carries `rounds`, `distribution {count, by_terminal}`, `intermittent` and one `observation` sentence, and the
  aggregate's terminal, code and missing fact. Rounds that never ran stay in the denominator and are named as missing,
  with the rerun-these-rounds exit (V07 R[0]–R[3]); a determined mix of meeting and missing rounds is `intermittent`, an
  observation and never an attribution (V04 R[0]). A run stored before the field existed aggregates its one round as 1/1.
- **Display** (`hub/server/claims.ts`): `terminalLabel` puts the observed distribution beside the dynamic terminal
  (display rule 16), e.g. `通过（3/3 次未见失败）`.

Per-round dispatch lives in `hub/dispatch`. One `job dispatch` is one job and, in that command, runs every frozen round
in order. Each round is its own effect: the intent key's order component is the round, and the same (subject, round)
succeeds at most once. A round above the frozen count or the effect row's `repetition` is refused at the pre-effect
boundary. `first_pass` stops when a round meets the expectation; the rounds that did not run are not effects, stay in
the denominator, and the observation says which round passed and how many remain. `fresh_context` takes a new gateway
lease and session for each round. `baseline_first` repeats the environment check and the per-device read-only probe in
that round's lease; a miss is `not_run` with `integrity_unproven`, not a failure. The window starts when the first
round's intent is written; a round that would start outside it is not dispatched and stays in the denominator as
`not_run` / `budget_exhausted`. A gateway result with `complete=false` is `no_verdict` once the status has ended, and
`incomplete` (still pending, exit is wait or reconcile) when the status never ends. `job resume` only reconciles rounds
already started. `job status` lists each round. A single-round dispatch keeps the one-submit key `dispatch.bytes:<S>:<attempt>`.

The projection's `rounds` array is what aggregation reads, so one job's rounds are not collapsed into a single round.
The target's own per-round report is one observation claim (`目标报告：…`) and does not satisfy a fact-only requirement.
An aggregate that misses the expectation is `unattributed`; the three causes (被测对象缺陷, 环境, 执行上下文) are a
`hypothesis-set@1` record and are not the attribution. An aggregate that meets, including an early stop, carries neither.

## Limits

- Exact values can cite sources of the locked root only through `tree:` references (the port does not list the root's source
  digests); a `src:` reference into a manual behind a tree entry is out of scope unless that manual is also bound to the run.
- An item location must resolve in exactly one source of its slot; a slot with several sources and positional selectors is
  refused (FragmentRef names no source).
- Commands are split at white space to find heads; quoted arguments are judged by the catalog check, not at resolution.
- `knowledge.json` requirements are enforced before input binding; missing/incomplete required catalogs refuse the start and name selectable complete builds.
- Locks are per process. Pack function calls in one evaluation run at most 8 at a time. A lineage is followed for at most 100
  runs; a bound record is walked for model warrants up to 2,000,000 nodes.
- A submission nests at most 64 levels; check outcome data at most 32. A result must fit one record (`maxRecordBytes`,
  default 16 MiB, about 2,000 items of the toy packs with one finding each): larger targets are split into blocks.
- The not-accepted path runs the checks again (cost of an accepted submission).

## Tests

```
node --test "hub/runs/engine/**/*.test.ts"
npx tsc --noEmit
```

Pure tests (terminals, partitions with a 400-run property test and hand-written V05 R[3] cases, slots and pack schemas,
independence and model families, the keyed lock) run anywhere.
`start-result.test.ts` (moved here from the server's text tests): the production result in the answer and in the detail,
the run record digest, a repeated client key after a commentary submission, Hub-side runs, the evidence gaps of a judgment
run and of a failing expected-sources function, the example shapes the server's texts offer taken. `admin-note.test.ts`:
the reasons of neutral start, submit and resolve answers in the call's note and in `adminLog`, two calls of one trace, a
note that throws, an unreadable expected source named in its start's note. `select-build.test.ts`: list roles stripped
from the candidates the function sees. The others use a temporary PostgreSQL (`hub/testing/postgres.ts`,
one cluster per file) and the real sandbox (macOS `sandbox-exec`); where it is missing (Linux CI) they are skipped, which is not
a pass. They cover: target choice (alias names, declared builds of the second family, select_build, the default rule, every
refusal with options), inputs (required, unknown, accepted types, unreadable, fragments, many, unparseable, external objects
read as the caller with meta), parameters, a projection with no item (the pack's own refusal) and a projection with zero
items (a legal answer: empty production run stored, notes in the answer, repeated client key), absent equals forbidden, client keys (repeat, mismatch,
another user, expiry, repeat after unassignment, NUL and lone surrogates refused before any read, concurrent starts), Hub-side
runs; acceptance with exact terminals, satisfaction of a negative case, attribution, claims with their qualifiers, warrants,
resolutions, premises and validity; verbatim storage (parsed, unparsed, lone surrogate, too deep); arguments the records
cannot hold answered at their path every time; every whole-rejection code with its path and rounds left; W08 R[1] fix notes,
also for arguments that do not parse; locations outside the judged source; canonical references against selector aliases; the
repair path to exhaustion and back; repair rows on a check of the target not applied; not covered and skipped items at every
declared layer; rejection; a finding grounded only in a hint source; a cross-item fact and a judgment resting on it; idempotent
and concurrent submits; supersession by the runner only; the run of a stored submission whatever its keys; independence by
session, by model family and unknown, declared independence not accepted, verdict consistency, a verification revised by its
verifier and by the drafter, an older handed-over result, carried judgments, a handover from outside the predecessor lineage;
handover by `rec:`; carry-over (offers with context digests, `no_reuse` without, refusal, carried judgments, chains, none for
fact-only packs, none across pack versions); production runs and commentary; checks that throw or never return (unchecked,
check_error / timeout), a declared dynamic layer, a missing catalog; pack schemas with regular expressions or that zod cannot
read; results, run records and production results over the record limit; queries and previews.

## Needs from other packages

- **contracts**: (1) done: `StartRunOutput.result` carries the production result. (2) `ValidationResult` of a production run:
  `submission` and `acceptance` have no "not applicable"; the engine writes the run record digest and `accepted`. (3) Results of
  run-level requirements (target `run`: layers, status) have no field; they are visible only as cross-item claims; proposal:
  `run_requirements: RequirementResult[]` beside `cross_item`. (4) Document the default run subject with `items[].slots` and
  `cross_item`, and give `RunSubjectInput` the same, so subject builders of run checks see the submission. (5) A place for
  expected sources that could not be bound (`SourceBinding.reference` is required): `RunSummary.unavailable: [{ external,
  role }]`, so the model sees the evidence gap (case-review method step 2). (6) `FragmentRef` cannot name one of several
  sources bound to a slot (`many: true`). (7) Model questions 8 and 9 of the contracts README (a code for an uncovered item, a
  mark for carried judgments) are used with their interims. (8) A declared model family (A04 F[1]: the family is client
  declared): `Submission.model_family` (or a structured `model: { name, family, configuration }`), so independence need not be
  read from model names (decision 19). (9) `StartRunInput.client_key`: forbid U+0000 (the records index refuses it; the engine
  refuses it with `SUBMISSION_SCHEMA_VIOLATION` at `/client_key` meanwhile). (10) Say in `HandledItem.context` that a slot
  record without it is not reusable (W07 F[1], decision row 18 (b)), and that a SHA-256 is bound to the claims.
- **server**: pass `CallContext.sessionId` from `Circle-Session-Id` on every call (independence depends on it); hand
  `submit_result` the raw arguments; pass `CallContext.adminNote` (the engine notes each call itself, decision 25: no
  bridge of `adminLog` to calls is needed); pass the whole records kit as `records` (its `config.limits` sizes runs before
  they are stored); call `startHubRun` for scheduled fact-only sweeps (not wired yet: there is no scheduler).
- **runs/packs**: refuse at publish (so that no run is refused at start for the pack's own fault): (1) slot `data` and parameter
  schemas with `pattern` or `patternProperties`, or that `z.fromJSONSchema` cannot compile (decision 8); (2) `reject` rows on
  codes of checks that do not judge the artifact under verification or are not blocking (W02 F[7]), and `repair` rows on codes
  of checks that do not judge the artifact under verification (T03 R[4]); the engine does not apply such rows. `forUser` is
  also used with the configuring admin for Hub-side runs.
- **packs**: a `catalog@1` table over statements (`claims`) needs `present` on every command it selects, or the outcome is
  unknown (missing input) and the requirement unchecked; give the slot a data rule or always fill `present`. A finding's
  `location` must be in the judged mind map (decision 10).
- **acceptance**: scenario 10 needs `context` on each handled item of the first submission (decision 21); the synthetic models
  of scenario 14 must be of distinct families under decision 19 (names that share no word, unlike `model-a` and `model-b`).
- **records**: a transaction-scoped advisory lock would make the client-key and submission idempotency hold across processes.

## Open questions

1. Resolved by the draft pack: findings are judgments. Independent verification requires an observed session at both start and submission.
2. Current reuse rule: changed cited content is a structure violation. Frozen content-addressed references do not change
   within a run; this task retains that deterministic rule.
3. Resolved by W07 R[2]-R[3]: target facts retain Hub terminals; missing item-artifact facts and judgments are incomplete.
4. The family rule of decision 19 remains unchanged, as directed by the integrator: any shared word means one family
   (`aster-chat` and `birch-4-chat` share `chat`), conservatively yielding `not_independent`.

### 生产投影的确定说明

只有显式标记 nature=fact、verdict=support 的组会升格，且每条 grounds 都按本次运行的读取范围核验。说明对象只接收 nature、verdict、message、grounds 和可选 data；considered、details、view 等附加元数据必须显式放在 data 内，不静默丢弃额外键。message 和 grounds 分别进入主张文字和根据，data 原样进入 statement.data。pointer 保留 /groups/<序号> 以回读冻结输出；投影输出不合格的拒绝不伪造调用参数 path，而在消息和包维护人的修正动作中说明位置与规则。

投影说明统一是 cross_item 的提示用途事实，没有 requirement，不参与要求项满足或分区计数。Claim 不承载检查 tier，构造时也不传这个无效字段；回答按上述结构化位置和函数凭据标出“投影说明（提示，不参与要求项）”，不把它和条目检查事实混为同一用途，也不改变根据等级。

### Standing obligations and current read tiers

A standing obligation reads source bytes as its configuring administrator through
`artifacts.source(..., { consumer: 'function' })`, just as an ordinary run uses the effective-tier source reader.
It never uses `trustedBytes` or the first original's historical tier for pack checks. A withdrawn acceptance or a new
credential finding therefore withholds the bytes on re-evaluation and makes the dependent check unknown.
`standing-sources.test.ts` exercises an original from an earlier scanner, its accepted current scan and withdrawal with
real temporary records, including the bytes actually delivered to the sandboxed check.

## Concurrent submission subject construction

Checks that use the same pure subject builder previously started another isolated process for each check, even when
its function and JSON input were identical. The bounded sandbox pool then spent slots rebuilding the same item or run
subject. The run-keyed submission lock remains unchanged: different runs enter independently, and identical submissions
of one run return an existing settled receipt without another validation action. Transitional receipts are rechecked.

Each evaluation of one submission and locked pack version now creates a separate subject-builder scope for the whole run
and a short-lived scope for each item. A scope keys by function identity and SHA-256 of the exact JSON input bytes. It
shares successful construction and in-flight construction, gives each check an independent JSON.parse of the cached JSON text, and drops failures so a later check can retry. It never shares across items, submissions, versions or changed
inputs, and never shares check outcomes. Item scopes are discarded when that item's checks finish. Sandbox isolation,
limits, concurrency, MCP timeouts and existing acceptance assertions are unchanged.

Synthetic measurements on two concurrent 67-item submissions, excluding setup and start_run: before, 410 isolated pack
function starts and 11344 ms; after, 272 starts and 6794 ms. These are observed samples, not wall-clock test thresholds.
The repeated item builder drops from 268 to 134 starts, the repeated whole-run builder from 6 to 2; the 134 item check-function calls
and 2 run check-function calls still execute, as do the core interpreter checks. Auxiliary memory-poller processes are excluded from function counts. Tests use two runs,
one item and two checks, separately for item and whole-run subjects: the original starts four builders instead of two.
They also verify both checks execute, every submission receives its receipt, concurrent identical repeats return identical
receipt bytes, and only one submission, result and validate action is stored per run. Unit tests cover input/function/scope
separation, byte-preserving result copies, mutation isolation, an input snapshot and retries after construction failure.

## Retry evidence before the unknown-exit contract

Transient check-function and subject-builder attempts run through the sandbox's bounded retry policy. Validation actions
store their retry_attempts, including the first transient failure and the recovery or final failure, with a generated action_kind operation and component@version,
module and item where applicable, generated reasons, durations and 50/100 ms backoff. Successful first calls do not enlarge this
retry log. Production start actions and submitted-result actions both retain it. The per-evaluation subject cache
shares successful construction and exhausted transient failures, and replay of a completed identical submission creates no new attempt or action.
Exhausted sandbox errors now use the named exits and durable requests described below.

Bound check sources are re-read at most three times after unavailable/failed reads, with 50/100 ms backoff; the validation
action retains read retry attempts. Source/permission absence stays neutral SOURCE_UNAVAILABLE; internal failures
use registered check_error or integrity_unproven, an unresolved selector REFERENCE_UNRESOLVED. Text that cannot be provided
uses missing_input; a pinned text exceeding reads.max_bytes uses budget_exhausted. Deterministic no-text/size limits do not
repeat identical reads. Free-text diagnostics go only to the admin log. Every affected check outcome carries the actual
unread list into its fact claim's statement.data.unread_sources even if the pack omits it. This is not a new top-level
validation field. Read recovery reuses the same bound reference and retains integrity/permission checks. Named exit ownership, durable requests and deadlines are connected below; unread_sources remains structured claim data.

Exact-value resolution retries only SOURCE_UNAVAILABLE carrying an internal check_error or integrity_unproven reason
(and thrown read failures), using the same three-attempt 50/100 ms policy. Genuine absent/forbidden references and invalid
selectors keep their existing model-side treatment; source bounds and integrity checks are never bypassed. On exhausted
Hub failure, validation records a validate action with hub_error, the fixed source reason, retry_attempts, repair: [] and
no validation result. The protocol code stays SOURCE_UNAVAILABLE pending the model-owned code; the message identifies the Hub read failure, with an administrator-restore fix and no
requirement/rounds_left. The raw submission is still stored once. Hub-failure actions do not mark the digest as a consumed
repair attempt, so the identical body can be checked after restoration; genuine errors then consume their normal round.
A completed result still replays idempotently. The model-facing resolver keeps its neutral return rather than throwing.

The exit flow below supplies named administrators/pack authors, finite requests and automatic re-evaluation. Refused
submissions still retain their original bytes and validation action; unread_sources remains structured evidence.


Subject-copy review: a successful build is serialized once as JSON text, and every check parses an independent value.
The serializer is the same JSON.stringify used by the isolated function's result boundary; JSON.parse preserves deep
JSON without structuredClone's lower recursion ceiling. Only non-exhausted build failures evict a cache entry. A host serialization
or parse failure retains the successful build/text and is identified as subject_copy / Hub copy failure, never as
FUNCTION_THREW. Tests exercise 4000 levels through real isolated builders and both item/run checks, plus an injected copy
failure, independent mutation, retained launch count and byte-identical completed receipt replay. JSON-wire numeric zero
is used in fixtures because a child's JSON serialization has already normalized negative zero before the parent sees it.


## Scenario 19 submission latency under load

The earlier two-call 67-item sample measured reduced launches, not a structural fix for ten concurrent MCP deadlines.
The committed hub/server/submit-load.test.ts now exercises the exact scenario-19 shape through the real MCP client:
ten distinct runs, 67 items each, default 60000 ms request timeout, all accepted receipts and one stored result per run.
Eight bounded synthetic CPU workers run throughout the submission phase. Setup/start_run time is excluded. It asserts
40 physical sandbox launches: per evaluation, one run subject, one run check, one item-subject batch and one item-check
batch. Every item/check still has its own validation, JSON copy, outcome and failure; completed replay remains unchanged.

Observed submission-phase samples on this branch, with the same eight synthetic workers (other terminal load varied):
- Before evaluation batching: 1360 launches, ten receipts at 47452..48968 ms; loadavg before 66.77/40.00/31.14.
- After batching: 40 launches, ten receipts at 3504..4154 ms; loadavg before 33.90/44.64/38.99.
- Final-code repeat: 40 launches, ten receipts at 2957..3577 ms; loadavg before 23.27/26.10/28.31.
These are observations, not a claim that arbitrary background loads or arbitrary pack functions have a universal SLA.
The test itself enforces the existing 60-second MCP deadline, rather than raising it; diagnostics report each completion,
launch count, worker count and loadavg. It drains observed server work even after a failing baseline so abandoned work
cannot poison the next case. Owned load workers have a watchdog and are always terminated during cleanup.

Batches never span evaluations, users, pack versions, modules or check declarations. A pure module is loaded once in its
isolated process and each eligible input is invoked and serialized independently, with per-item diagnostics and errors.
All namespace, tier, output and source checks still run through runCheck. OS/permission/import policy, memory, time,
input/output and global child-slot caps stay unchanged. Boundary violations invalidate the physical batch; aggregate
limits, timeout or violation trigger bounded individual fallback under the old caps, so one bad item cannot hide others.
Stopping/cancellation is never revived by fallback. Ordinary per-item throws remain per-item outcomes. Skipped checks and
failed subject construction explicitly complete their collector slot to avoid deadlock. The parent may stage item calls
concurrently, but only the existing bounded sandbox pool executes children, and fallback uses CHECK_PARALLELISM.

Retain-only bound sources preserve their read tier through both runner and Hub readers. They are read once, never
retried as transient faults, and are passed/stored as credential_unreadable with the missing administrator acceptance
and an administrator acceptance/re-evaluation request. Other withheld bytes remain an internal read failure, not a credential fact.

Exhausted exact reads write validate actions as error with the registered internal reason and null acceptance.
The action retains the Hub-side message and administrator recovery/resubmit instruction; getRun shows it as not validated.
The existing protocol code remains until the model owner supplies a dedicated Hub error code; it no longer implies reader permission failure.

Exact-read retry also covers command quotation candidates, bound record reads, predecessor result scope and locked
catalog construction. Exhausted function-side failures use the same HubReadFailure receipt and do not charge a repair round.

Exhausted sandbox failures are marked by parent-only object identity and retained in the subject scope for the rest of
one evaluation. Checks sharing that exact input/module reuse the same bounded failure cycle; a new input or evaluation
gets a fresh cycle. Ordinary build failures and Hub-copy failures keep their separate existing policies.

Resolver diagnostics from both runner and Hub evaluation contexts, exact references and exhausted scope reads retain
the actual cause only in the administrator log. Caller answers, stored unread_sources and retry evidence contain no raw error text.

Retry evidence uses action_kind read/validate and the actual versioned pack or engine component; module/item/reference
identify the operation without a new classification axis. Sandbox control codes and queue_full/spawn_failed/stopping
remain parent-only diagnostics; persisted reasons map to timeout, budget_exhausted or check_error.

Data-only quoted fragments use the same bounded internal-fault reread policy as exact values, once per reference per
evaluation. A recovered read proceeds to quote checking; exhaustion produces a Hub error action and administrator
recovery/resubmit instruction, without a model repair charge or an accepted result frozen on a temporary read unknown.
Retain-only and neutral absent/forbidden reads are not transient retry targets in this path.

Retain-only data quotes preserve structured credential_unreadable evidence in data.unread_sources with the bound reference,
missing administrator acceptance and the administrator acceptance/re-evaluation next action. quote@1 uses awaiting_step
from the generated Reason axis; credential_unreadable belongs to ValidityStatus and is not a legal CheckOutcome.reason.
No contract axis is widened. Legacy retain_only views receive the same evidence, and source reads remain single-attempt
for this deterministic state. Named administrator requests and automatic re-evaluation are connected below.

Startup-failure diagnostics retain the actual host errno/message for check and subject onError logging after retry
exhaustion. Neither the submitted-result receipt nor persisted retry evidence carries those private causes; fixed
check_error evidence and receipt idempotence are unchanged.

部分结构拒绝保留原参数索引上的要求项与修复轮信息；只在回注槽位被明确重新归属时重算其轮数，不能用压紧后的 cross_item 索引给别的要求项记轮。

整份提交因其他条目被拒绝时，回注 not_stored 优先保留该条目自身的准入拒绝及 skipped/补件动作，不用一般重交文案覆盖它。

## Integration with hub-redesign dd65afbc

The generated FragmentRead grades and decision-37 quote normalization are retained. Permanent syntax, scope,
groundability, selector and size defects refute with the mainline remedies; transient internal reads retain bounded
retry and a Hub error receipt on exhaustion. Retained quotes also keep structured administrator-acceptance evidence.
Exact resolution caches targets and grounds separately: recovery may therefore read the same reference once more for
its other use, while each permanent absence is read only once per purpose. Standing obligations use the configurer's
effective read permissions, not a trusted byte bypass. Unexpected function-read null-byte metadata still reaches refs for diagnostics; intentional model withholding stays neutral.
K2 admission exclusions are applied before subject priming and before forming item function batches. Its transactional
contribution writes and identity locks stay atomic with the result, and both successful saves and fallback refusals retain
retry evidence. This merge changes no timeout, caller scope, generated contract or real-system configuration.

## Unknown exits

New transitional layer results bind every missing fact to a named, finite exit before partition validation.
`EXIT_BY_REASON` exhausts the generated cause vocabulary; a pack cannot choose another account through its exit.
Check outcomes require top-level `missing`; `data.missing` remains refutation evidence, never its alias.
The workflow port reads the recorded pack owner; the records account port selects an enabled administrator.
Missing identity wiring refuses evaluation rather than inventing a recipient. Requests use a 24-hour response window.
Stored results are never passed through this new-write binding; missing historical exits remain “出口未写”.
The following commits connect these exits to durable requests and automatic maintenance.

W07 R[2]–R[3]: skipped/omitted handling changes only judgment requirements and facts that judge the missing
item artifact. Target-only facts retain the Hub-computed pass/violation, including fact-only workflows.
A required incomplete requirement still takes the item into the incomplete partition (V05 R[3]).

Independent starts validate their own observed session before binding any input, including starts without a predecessor.
The judged lineage lists historical starts and accepted submissions missing a session; new independent starts refuse
until the author supplies a new revision with sessions. Missing-session submissions are kept and checked for all
other problems but refused as a whole. Their action records `refusal: session_missing` without repair keys and
never enter the distinct-submission repair ledger; the same bytes with a session are evaluated again.

Every unknown outcome is named in errors with its item, requirement, missing fact, submission path and remaining
repair rounds; the requirement is charged once per distinct submission. Cause selectors route alongside exact
codes without treating reason strings as interpreter codes. Repair routing is restricted to the artifact provider.

Skipped items retain their verbatim submitted `skip_reason`, including on delivered target-fact items. Every affected
requirement is named in errors with that reason and remaining rounds; one distinct submission charges one round per
requirement. At zero remaining rounds, missing artifact work becomes `repair_exhausted`, not another coverage prompt.

B07 requests are append-only records keyed by the exact run, item, requirement, source and missing fact. Repeating the
same problem never extends its original due date. Result errors name the request and the existing tool to answer it;
full replacement submissions remain allowed after exhaustion. Answers reference actual stored records and never
rewrite requests or old results. `getRun`/`listRequests` apply run visibility before listing requests. Unknown-routing
rows retain an empty hypothesis set with the mandatory open residual and a named judgment request, without inventing
hypotheses or predictions. The console lists unanswered requests with their named audience and deadline.

Maintenance also checks accepted historical results whose layer already contains a complete named request exit. If the
corresponding item/requirement request is absent, it uses the ordinary routing rules on a detached result copy to append
the request with the recorded missing fact, audience, source and deadline. Existing or answered requests are retained,
independent gaps are kept, and the old result is never rewritten. Non-request exits are not turned into human requests.
For older results without those fields, the already-created repair requests are looked up by their existing exact
identity in batches; repeated maintenance does not refresh their deadlines or issue one lookup per historical layer.

Installed checks returning no outcome for an item are `check_error`, not `no_check`. Output failures retain
`output_failed` on the dynamic not-run layer. Work-limit exhaustion is unchecked; it is distinct from an effect budget.
Every distinct unknown is retained in layer gaps even beside a settled violation. `pending_unknown` is an optional
additional item count, never a partition; the primary-terminal partitions remain disjoint and covering. Replies state
“其中 N 个还有未决未知”. Explicit `Claim.validity.premises` submission paths can wait on another requirement's repair;
these layers inherit its named exit and identify the requirement and repair path. No dependency is inferred from prose.

New runs freeze a finite submission deadline (explicit future `submission_due`, otherwise 24 hours after start).
The serving lifecycle runs maintenance at startup and every minute, with one pass in flight, and drains it before
closing records; command-only assemblies do not start maintenance. An expired run with no accepted submission gets
one append-only Hub delivery containing every frozen item as not-covered/incomplete and a named disposition request.
A late full submission remains possible. Old runs without deadlines are not assigned invented historical deadlines: a
named disposition request asks their runner to open a dated successor. The console shows deadline and delivery state.

Unexpected evaluation failures now append a validation action with null acceptance, a stable check-error code and a
retry instruction; internal exception details go only to administrator notes. getRun distinguishes “未校验（中断）”
from refusal, including submissions left with no action. Startup/minute maintenance revalidates orphan submissions
using the session actually recorded by the interrupted call, never the run's start session. Three failed attempts
lead to a finite named administrator repair request; missing historical session facts likewise go to a named request.

Publication rejects a static fact requirement without checks through the generated publishable shape (`requirements.shape`, at its `checks` field) and a dynamic fact requirement
without an observation contract. Start rejects invalid layer/schema/contribution declarations and records a repair
request addressed to the recorded pack owner. These pre-run requests bind the published pack digest, without making up
an unstarted run. Owner-facing requests can be listed without granting access to unrelated run contents.
`knowledge.requires` is checked before inputs are read; refusals name the missing catalogs and list currently eligible
builds. A workflow may require an explicit predecessor. Model-driven runs whose selected named build root changes receive a named
successor request; their frozen roots and prior results remain unchanged. Publication answers a package repair request only when --answer-request explicitly binds it; the actual pack-version
record is the answer source, and affected runners are prompted to open successors.

Hub-observed retain-only source reads produce administrator disposition requests with structured source references.
Maintenance polls their effective read permission/tier; after acceptance it revalidates with the originally observed
session and appends a new result/answer. Same-observer lookup returns the newest receipt, and by-submission result lookup
also returns the newest result. No old result is backfilled. Actual credential echo originals remain excluded from
acceptance; the next step is a redacted source/new revision. Non-source requests keep their explicit human next action.

Console product/diff arrays use snapshot-bound cursors (500 builds or 1000 paths per page), with explicit per-page and
whole-list counts. Changed snapshots refuse stale cursors rather than silently skipping. Run call logs pass the existing
stored cursor through `call_cursor`. Historical transitional layers show “出口未写” without backfilling an actor or due date;
new exits and every retained gap remain visible as escaped read-only text.

The shared core outcome constructor copies the existing concrete detail verbatim into top-level `missing`, without
changing any interpreter verdict. trunk-fixes-4 may carry the same constructor fix; keep one equivalent version when
merging. Pack functions still must declare their own missing fact and do not receive this trusted-core normalization.

Run-level unknown facts also enter errors with their cross-item path and remaining rounds, and produce B07 requests;
there is no `data.missing` alias. Shared request storage is exposed by `hub/requests/api.ts` for the dependent tasks.
Only settled results are cached: a repeated transitional submission is checked again and can resolve against new facts.
Legacy missing exits are reported as “出口未写”, with separate named repair requests; re-evaluation appends a new result.

Administrative abandonment is permanent for that run: new submissions are kept verbatim and refused with
`RUN_ABANDONED`; continuing requires a successor revision. The current run view selects the management projection by
its real input-action reference rather than confusing later evidence records with a resumption. It preserves old layer
terminals and unknown counts, marks requirements unsatisfied/abandoned, and cites the old result. If old technical fields
were unwritten, the new projection explicitly says so and binds only this real management request; the old bytes still
show “出口未写”. This is an administrative view, not a new target check. Remote execution and safety freezes remain
independent; pending effect reconciliation continues as its own recorded work.

System deliveries store their exact canonical input in an append-only action and name it through `system_input`. The
`submission` field is its recomputable digest, shown as “系统交付输入摘要”; these results have only run/system-input
indexes and cannot satisfy a user-submission cache lookup. Expiration and management deliveries never impersonate a user.

Dispatch integration reads existing journal bindings through the read-only API and calls the existing reconciliation
entry once per observed state. It never plans, dispatches or resends. Integrity-checked dispatch projections bind the
exact job, output digest and complete item set; target-reported conclusions remain judgments. Unsettled effects quarantine
only bound items. A named mark-failed disposition uses `EFFECT_UNKNOWN_DISPOSED`; abandonment is a management choice.
Neither choice rewrites the original dynamic observation or the physical safety freeze. Private journal references stay
in administrator-only evidence because they may reach lease material. User requests cite the safe observation record.

If a committed management choice is left without its delivery projection, maintenance retries projection at most three
times. Continued failure creates a finite request to an enabled named administrator, identifying the exact choice record
and the existing `run abandon` retry command. An identical retry completes that choice without repeating it; the actual
recovered delivery record answers its repair request. Internal write causes remain in administrator notes.

The oracle differential driver now separates fresh-admission rejection from synthetic legacy-run playback. Target facts
come from its frozen original, while artifact checks read submitted slots. Random cases start with true zero counters;
fixed repeat cases supply their independently counted per-requirement charges. The oracle computes unknown/skip errors
and W07 target-fact handling independently. Its cross-layer regression now follows the integrator's 2026-10-24 precedence: a known expectation miss is unsatisfied before considering unsettled layers.

### 外部读取覆盖限定

外部输入及包声明的预期来源把 coverage 冻结进 SourceBinding。主张构造按其对象位置、根据/精确值的根摘要和检查声明的 reads 选取对应覆盖；运行级检查还涵盖它判定的条目位置。依据未完整来源的事实或判断加生成词表的 partial，并保留 qualifier.coverage；生产投影说明使用同一规则。完整的无关来源不被别的部分来源牵连，旧运行也不因一次后续完整读而升级。合计仅使用已声明覆盖的观察；所依外部来源缺覆盖时不伪造 total，原始旧绑定仍可解析。start_run 文字直接披露部分来源的读取覆盖。

外部缺席与读取恢复：ReadOutcome/ExternalRead 的 absent 是系统对整份对象的确定观察。连接器保留原始应答，并提供带系统、对象、读取时刻的规范 JSON 观察；期望来源按原角色绑定它，声明 reads 的检查照常读取，其本身不替检查决定通过或驳回。必填输入缺席以 SOURCE_ABSENT 拒绝；输入重试耗尽以 SOURCE_RETRYABLE 给下次时间，期望来源重试耗尽也保留明确的缺失事实和重读后重开运行的动作。引用的新故障码按内部 reason 进入已有未完成路径，保留原修复轮记账规则。登录停止的具名管理员请求记录等 hub-unknown-exits 的接口，尚未声称已发请求。

## Transitional recovery metadata

The mainline pure-intent interface and the named runtime interface share the single reason table in recovery.ts.
terminals.ts keeps its existing exports. New writes keep producer-authored missing facts, bind audiences from actual
Hub identities and create the durable requests described above; missing ownership wiring fails explicitly.
Package-authored exits cannot nominate another account. Only an explicitly trusted parent observation can propose a
Hub reread or reevaluation intent through the compatibility interface; the helper itself performs neither action.
The older intent interface retains its 72-hour default for compatibility. Runtime requests retain their actual fixed
due dates (24 hours by default), without extending them on repeats. Historical records remain unchanged and readers
continue to report “出口未写” rather than synthesizing an old actor, fact or deadline.

A lease declaration without `max_ttl_seconds` grants no-expiry reservations (`until: null`). Acquire needs no TTL;
extend is refused for the whole request before effects, and release still requires the same user and predecessor
lineage. Capped workflows keep their existing validation. The trusted dispatch boundary treats a null expiry as
unbounded; fences, holder identity and lineage remain mandatory.

Lease views freeze `since`, `run`, `until`, `mine`, unfinished `jobs` and authorized `holder` identities, plus registration
rows (prefix/mine, owner identity only for admins). `lease_context` and `lease_registrations` are retained on the run;
evaluation reconstructs these frozen facts instead of consulting current ownership. Missing user identity or the trusted
read-only `leaseJobs` port refuses start with an administrator repair action. Assembly connects that port to
`DispatchService.activeLeaseJobs`; read-only jobs are excluded and unresolved frozen effects remain blockers.

Owner `force_release` checks every key, owner/admin authority, active row, nonempty reason and unfinished dispatch job
before any operation executes. Unfinished jobs refuse with job status/disposition instructions; local release cannot
stop remote work. The service rechecks owner authorization under the registration lock, increments fences, and records
the acting user, reason and original holders. Run records preserve released keys and their prior runs; originals remain
append-only. Registration operations use the same projection request boundary. Administrator CLI release uses the same
read-only job guard. As with the existing release/extend operations, successful ownership changes are irreversible if a
later acquire or run-record write fails; their action records remain the source of truth.

The final force-release guard runs under the same database lock used by dispatch reservation insertion. It re-reads
unfinished jobs while the lock is held; a competing reservation rechecks fences in that transaction before it commits.
The lock is released before connecting to an executor. This closes the gap between a read-only job snapshot and release.
Historical run@1 lease snapshots remain readable in their original key/until/mine shape and are passed unchanged to
older pinned packs. Current start_run contexts still require since/run/jobs; no historical identity or time is invented.

## Unknown exits

New transitional layer results bind every missing fact to a named, finite exit before partition validation.
`EXIT_BY_REASON` exhausts the generated cause vocabulary; a pack cannot choose another account through its exit.
Check outcomes require top-level `missing`; `data.missing` remains refutation evidence, never its alias.
The workflow port reads the recorded pack owner; the records account port selects an enabled administrator.
Missing identity wiring refuses evaluation rather than inventing a recipient. Requests use a 24-hour response window.
Stored results are never passed through this new-write binding; missing historical exits remain “出口未写”.
The following commits connect these exits to durable requests and automatic maintenance.

Supplementary recovery gaps keep their own cause codes and receipt rows even beside a settled violation. Request
projection fills remaining rounds and uses the received submission's actual item order for paths; it never treats a
projection index or an invented slot as a submitted location. The primary terminal and partition do not change.

Receipt reuse is gated by the current same-owner successor state and the frozen workflow's session requirement. A
settled contribution receipt does not stand in for a missing caller session; refused calls keep their own receipt and
charge no session-repair round. Cached success cannot revive a superseded run. Ordinary settled contribution retries
still reuse their original receipt and do not append effects.

Error-handling selector priority is exact code, then generated reason, then `*`, regardless of row order. The wildcard
also covers outcomes with a reason but no code. Layer routing and request projection use the same selector. Cause-based
repair rows contribute the declared requirement budget and actually route artifact work through its exhaustion path.
Reject handling applies only to a blocking artifact refutation with a code; an unknown never becomes a rejection through
an exact-code or wildcard row.

A known layer that misses the expectation makes its requirement unsatisfied; otherwise any transitional layer keeps it
pending. This integrator decision changes no raw layer, recovery exit, partition membership or unknown count.

Submission-handling errors apply only to actual submit_result bodies. Fact production checks its bound artifacts directly and does not require a model handling declaration.

Accepted unknowns following exhausted transient parent unavailability are rechecked by maintenance at most once per
pass and at most three times. Only structured onAttempt evidence can set that signal; pack-authored sandbox fields
cannot. Rechecks preserve the originally observed session, frozen input and distinct-submission repair charge. Continued
failure appends a recomputable system-delivery input and a real administrator repair request, retaining old bytes and
technical terminals. A fresh parent execution observation supplies the actual answer record after recovery.

## Task coverage

| Task | Runtime path | Synthetic regression |
| --- | --- | --- |
| 1 | Shared recovery rules and strict write boundary | recovery, exits, unknown-missing |
| 2 | Cause routing and located per-requirement errors | unknown-routing, request-gaps, cross-exits |
| 3 | Preserved skipped reasons and distinct-body charges | skipped-reasons, submit |
| 4 | Durable requests, hypothesis records and answer sources | requests, request-readers, registry |
| 5 | Frozen submission due date and system delivery | deadlines, system-input, abandon |
| 6 | Interrupted actions, startup/minute recovery and bounded parent retries | interrupted, parent-recovery |
| 7 | Empty checks, output failure, retained gaps and explicit premises | fragile, terminal-gaps, terminals |
| 8 | Declaration admission, required catalogs and observed source acceptance | start-requirements, standing-sources, registry |
| 9 | Snapshot-bound product/diff pages and call-log cursors | server console-pagination |
| 10 | Read-only journal binding, reconciliation and dynamic projection | dispatch read-runs, engine dispatch-results |
| 11 | Observed sessions and cache policy before receipt reuse | session-boundary, contributions, cache-policy |
| 12 | Bound target facts survive skipped/omitted artifact handling | target-facts, production-handling, independent oracle |

The workbook client permits only its declared pre-generation workbook-input gap; it still requires every other plan
prerequisite and the exact bound byte identities. The successor verification, not generation, supplies dispatch evidence.

A same-owner, same-pack successor stops replaying old submissions but never discards a trusted host-recovery gap. Maintenance appends a named administrator request and a system-input projection immediately, preserving the old result bytes and the actual retry count. A later trusted parent-success validation in that run or a same-pack successor answers the host-repair request; creating a successor alone never does. Unanswered requests keep their run open even after supersession.

Maintenance compares every unanswered request deadline with its clock. Expiry appends a separate named administrator clarification that cites the original request, with a new finite deadline; repeated passes reuse that escalation. An expired escalation advances in the same way. Originals are immutable, and actual original answers propagate through escalation references. Run listings expose overdue_requests separately, including superseded runs with unanswered requests; the console shows their original deadlines in a separate table.

## Shared read access

`canSeeRun` remains the synchronous owner/administrator capability used by submissions and predecessor checks.
`canViewRun` adds only the current sharing decisions and assignment checks. Production policies evaluate the frozen
requirements, include Hub-side runs, and never include judgment workflows. Shared readers receive the original run,
including runner, session and client key; accepted validation results and run-scoped submission/action records remain
citable by their exact record digests. Rejected validation bodies, administrator notes and call logs are not shared.

Run lists filter visible records before paging, ordered by start time with run identity as the stable tie breaker.
Cursors bind the reader, package filter and last ordering key; hidden records cannot create visible empty pages.
Sharing confers no submission, lease lineage, repair round or client-key ownership. The model's conditional read-only
predecessor exception requires a workflow declaration that the present format does not yet expose; this task keeps the
existing predecessor guard, as specified by its task page, and introduces no such declaration.

Shared previews use the same run-bound generated-source accessor for fragment resolution and quotation candidates.
A shared run never grants knowledge-tree permission: live catalogs are omitted from a preview when its reader cannot
read the product, and tree references still pass the ordinary tree reader. Connector originals retain their own ACLs.

Shared run-detail receipts use only the action codes and their registered descriptions for rejected validations. Instance
messages, fixes, paths and requirement pointers from those validation bodies do not enter the shared aggregate view.
Owners and administrators retain the full diagnostics. The underlying submissions, actions, results and run record are
never rewritten or redacted under their original digests.

The sharing/unknown-exit merge keeps visibility filtering before stable pagination, alongside unanswered and overdue requests. System-input deliveries remain independent of user-submission receipt lookup. Sharing grants accepted validation bodies and the run/submission/action records declared by B04; run-bound request and hypothesis-set records remain owner/administrator-only in both record readers, matching the request listing policy. Management delivery stays current without changing historical technical results.

### Runtime table admission (W04)

A submission's inline table is declared data. For a ledger-approved interpreter the Hub rebuilds each sample's default
item subject from the frozen projection, resolved slots and evidence, and reruns the same interpreter. Admission requires
matching positive and negative expectations and an observed external-read origin or an upload by another account.
Unknown source provenance names the missing source record and asks the runner to reread or re-upload and bind it.
Failed contrasts, missing polarities and author-only examples keep the submission accepted, with conditional conclusions.
The evidence is `detail.admission` on the submission's existing validate action, including table digest, expectations,
observed source provenance and actual outcomes. No additional validate action is written: author/session lineage and the
per-submission repair-round accounting keep their existing identity.

Admitted runtime checks are added to the locked template checks, never substituted for them. Their warrant is
`运行内检查@<canonical table sha256>`; validity additionally binds the current run body, submission and table digests.
Their grounds point to the stored submission's sample list. The admission of that submission is found on its existing
validate action (linked by submission record and argument digest); this avoids a circular result/action digest reference.
An admitted outside-author contrast establishes discriminating power. Otherwise the runtime conclusion is conditional and
its discriminating power is not established; a requirement asking for discrimination remains unsatisfied.

Shapes outside the locked requirement ledger are not executed. A cross-item judgment records only the requirement and
interpreter, marked `decision_shape_unruled`; the package owner can rule on it in the next published version. No ruling
request is created. Template violations, incompleteness and unchecked facts keep priority over that judgment. A judgment
cannot satisfy a fact-only requirement, even when its expected outcome is support; it is unsatisfied with outcome_mismatch.

`circle-hub pack shapes <pack>` is an administrator-only inventory of unruled cross-item shapes across the versions locked
by validation results. It lists requirement, interpreter, occurrence count and the most recently encountered run. Revalidation
of the same submission/shape is counted once. It neither prints nor returns inline tables. An empty result says
“没有未裁定的形状”; the owner publishes a new ledger version to adopt a shape.

The integrator confirmed that the existing run-level result boundary stays in place: `target:run` requirements produce
cross-item claims, without new layer/status fields in validation@1. Unruled run-level shapes therefore appear there as
qualified judgments beside the template facts. For `target:item`, RequirementResult also carries the judgment terminal and
the fact-only outcome_mismatch status.

For catalog@1, the integrator confirmed that runtime checks inherit only the unique catalog binding of the same
requirement's template checks. Samples and actual evaluation share callCheck and therefore the same locked catalog and
source context. Missing or ambiguous bindings remain unknown: the runner asks the package owner to publish an unambiguous
binding and then starts a new run. A catalog declared only by another requirement is never guessed as the binding.

Historical run@1 requirements may omit both ruling arrays; a half-written pair is refused. Public RunSummary fields stay
required. Reading, listing and idempotent start reuse derive missing arrays from the run's locked package, retaining the
original labels and all stored bytes. A missing locked package or requirement raises MissingRulingSummaryError with the
fixed SOURCE_UNAVAILABLE code and an instruction to restore the locked package from backup before rereading or reusing the
run. Current summaries do not acquire a dependency on reloading the package; list hydration shares a load per digest.

## Criterion changes (W10)

`criterion_changes` declares a proposed replacement without changing bound source bytes. The Hub resolves the criterion and
all grounds and checks their quotes before accepting the submission; source-role errors refuse only that declaration.
For a W10 tree criterion or quote, every provenance fragment must be a src reference whose exact digest is bound as expected
in this run. Missing provenance, an unbound original or any mixed non-expected original locally refuses the declaration.
The general tree citation role stays unchanged. This uses parsed reference syntax and explicit source bindings, without text
heuristics.
The ordinary checks and error-table budget still apply to the original run. Each accepted declaration creates a judgment
request at its submission record and JSON pointer, with the original run's submission deadline. Resubmission of the same
item and canonical criterion appends a superseding answer; it never edits the earlier request or result.

A view-predecessor workflow cannot declare `default_from_predecessor`; publication requires an explicit binding rather
than a defaulted predecessor result.

The criterion-review workflow explicitly binds that submission, and its optional expected-role evidence slot binds the
original fragments under the reviewer's own current rights. The account owner confirms acceptance or rejection; the Hub
verifies identity, exact quotes, source family and the satisfied independent requirement. Author accounts are runner, or
configurer when runner is absent, throughout the lineage. Session/model differences and client assertions cannot establish
account independence. A shared predecessor opens only a view gate: it supplies no inherited leases, repair budget, client
key or carry-over offer. Other workflows retain their owner/admin predecessor gate.

A same-workflow revision freezes only answers already accepted at its start cutoff. Unanswered, expired-unanswered and
rejected proposals remain visible with their request, named audience, deadline and next action. A late acceptance can enter
a later revision, never an already-started one. Each separately submitted declaration needs its own review. Run records
store only declaration/review references and reviewer accounts; checks receive the hydrated declarations in RunContext.
Effective criteria continue across revisions until replaced again. Checks decide how to use them; the core changes no
source content. Carry-over is withheld for affected items so old conclusions cannot bypass the changed context.

Each result partition may show `replaced_criteria`: position, effective old value, new value, declaration, private review
reference and reviewer. On repeated replacement, the old display value rolls from the preceding frozen new value, while the
submitted old quote and all predecessor records retain their original bytes. Requests expose only the safe acceptance,
reason and reviewer summary. Knowing the private review reference grants no access to its body. Start answers use their
snapshot statuses; the original run page also shows the current safe answers to its own requests.

This is the generic first stage. The case-compile consumer update waits for the integrator's hub-pack-findings merge and
separate second-stage notification. Synthetic checks prove these boundaries, not a real human confirmation or device run.

### Needs for the second stage

The first stage hands the frozen new text and its declaration/review references to checks. It does not promote submission
records to grounds: B01 still permits claim, validation result, action and effect records. The integrator must decide the
reference boundary for a consumer that quotes the accepted new text itself. The proposed allowance is limited to the exact
accepted declaration's `/new` fragment in the run that froze it, with current reader permissions and the review digest
bound; it has not been implemented or presumed authorized. This does not block checks from comparing the already-frozen
text through RunContext. The case-compile second stage remains deferred.

## Declared predecessor input defaults

An input slot opts in with `default_from_predecessor: {pack: <workflow id>}`. The declaration is valid only for an artifact-under-verification slot accepting JSON; media type alone never opts a slot in. Missing opted-in slots use one selection of the predecessor's latest accepted submitted validation record. Lookup follows every result page and verifies the original submission exists. Production, system-input and abandonment deliveries are excluded. The existing predecessor owner/admin guard and independent-session/lineage checks still apply; a read-only share adds no predecessor authority.

Explicit bindings, including explicit arrays, are not replaced. Unopted slots retain their existing required/optional behavior. `input_defaults` freezes each defaulted slot, predecessor and full `rec:` reference in the run and start reply; the text names the same binding. Client-key replay returns that frozen selection. No accepted submitted result refuses before input binding with the existing missing-input schema code and a concrete resubmit-then-review step. The Hub never interprets a package name or guesses a package-specific error code.

Predecessor defaults recognize only own input properties as explicit values and create selected bindings as ordinary data properties. Valid slot names do not inherit JavaScript object methods or setters.

The complete predecessor-result scan, including submission-existence reads, holds the predecessor’s existing `submit:<run>` key. Pagination therefore serializes with submissions in the same engine; a queued submission becomes eligible for the next selection after the current scan releases the key. The existing submission guard scopes this serialization to one engine process.

显式模型身份补线：submit_result 的可选 model_identity 使用既有 model-identity@1，显示用的 model 文字保持独立。当前提交、原槽位沿用和效果重验都读取结构声明；作者血缘从保存的原提交回读族，不从日志里的名字补造。模型 warrant 的 id 对显式声明取 model_id。任一旧作者提交没有声明族时仍未知；账号独立性不受声明族替代。

### Read-time withdrawal qualifier

getRun / getResult check the exact frozen pack version through the existing workflow metadata port after run visibility is established. A known withdrawn version adds rule_withdrawn: true to the read wrapper, outside the immutable run and validation_result bodies. Run and production-result pages disclose the generated validity label with “版本已下架”. Historical result digests, claims, partitions and requirement terminals remain byte-for-byte unchanged; unassignment is not withdrawal, and no approval workflow is introduced. Raw record references remain original evidence, not a rewritten current-state result.
