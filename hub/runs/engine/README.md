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
   records the root; the composition digest is in the build basis claim.
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
and W07 target-fact handling independently. Its pre-existing cross-layer status difference remains a separately named
regression, without changing the engine's status precedence.

## Transitional recovery metadata

New unknown outcomes name `missing` at their producer. Evaluation binds every transitional layer to its missing facts
and complete `exit`, preserving independent causes in `gaps`. Pack repairs address the published pack owner;
clarification and artifact repair address the runner (or standing-obligation configurer); administrator actions address
the first active administrator in account-id order. A legacy test port without publication ownership instead asks its
runner to clarify that missing authority; it never invents a pack owner.

Until `hub-unknown-exits` binds actual request records and deadline processing, every exit intent has an absolute due
at evaluation time plus 72 hours, matching the administrator acceptance request default. These fields do not claim
that a request was created or an action was performed. Existing finite retries and splitting remain unchanged. Missing
input from a temporarily unavailable quote schedules rereading; withheld ordinary sources require administrator
acceptance; digest mismatches require trusted-backup restoration, never blind rereading. Actual credential echoes
remain excluded at the input boundary and cannot gain an administrator-acceptance exit here.

Historical stored results remain byte-for-byte unchanged. A transitional layer without a recorded exit displays
`出口未写`; the reader never invents its missing facts, audience or deadline.

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
