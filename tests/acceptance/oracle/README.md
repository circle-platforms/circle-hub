# Verdict oracle

A reference implementation of the boundary-validation rules, written from the model elements V01, V03, V04, V05, V06, W02, W07, W08 and T03 and from the shapes in `contracts/src`. It does not follow `hub/runs/engine` or `hub/rules`. `oracle.ts` is the reference. `oracle.test.ts` pins it to the model text. `differential.test.ts` runs the same scenarios through the engine.

`expected(run, submission, outcomes)` returns the acceptance, the repair rounds, every item's partition and per-requirement layer terminals (with status, unsatisfied reason and attribution), the static and dynamic cell of each item, the partition counts, the unknown-item count and the errors summary.

## Choices the model text does not settle

1. **One terminal from several outcomes.** A layer holds one terminal (the validation contract). A refutation is named ahead of an unknown, and an unknown ahead of a support, which is the worst-first order V03 R[3] gives the cell (不通过, then 未核对, then 通过). The cell still counts every non-pass terminal of the item, so an unknown on another requirement is not hidden behind a pass or a violation.

2. **Which refutation is named.** The first one that misses the expectation, in check order and then outcome order. T03 R[4] routes that code through its error-table row. An exact code wins over `*`.

3. **Which unknown reason is named.** The first unknown outcome, in the same order.

4. **Rounds already used.** `roundsUsed` is how many submissions were validated on this run before this one, and every repair row sees that one count. Rounds left are that row's budget minus `roundsUsed`. The current refutation does not consume a round of its own: with nothing used and a budget of 2, two rounds remain. W02 F[7] puts the budget on the code's row, so a code with a budget of 1 is exhausted while a code on the same requirement with a budget of 3 is not. The run's maximum is the largest such budget. The differential generator passes 0, because the engine leaves the counter at 0 across submissions; that disagreement is pinned rather than copied.

5. **Several unsatisfied reasons.** V03 F[2] lists them in one order and the result holds one. The earliest listed is named: no producer, then abandoned, then an outcome that misses the expectation, then independence unknown.

6. **No producer.** No installed check makes the static layer unchecked (V01 R[1], V03 R[1]). That is unknown, so a fact or a judgment stays pending (V03 R[4], F[2]). An independent judgment with no check has no producer (W02 R[4]): nothing returned a judgment whose independence could be accepted. A judgment terminal is only what a check actually returned.

7. **Dynamic layer.** Installed checks land on the static terminals: V01 R[6] maps a refutation to 不通过. A dynamic pass or fail is a fact only after the integrity rule (V03 R[5]), and these scenarios carry no integrity proof, so a declared dynamic layer is not run (未装检查). Not run is unknown (V03 R[4]), so the requirement stays pending unless another layer already missed its expectation. A requirement that declares no static layer does not record the check's verdict and does not repair or reject from it.

8. **Who is named, and the actions other than repair.** The terminal of an unexpected refutation stays a violation (V01 R[6]), except a request. T03 R[4] reserves producer error for a statement that disagrees with a source it cites, and these scenarios do not carry that, so a repair row does not itself name the producer. A refutation of the subject is the author's input (V04 F[1]). A refutation of the artifact under verification is the producer's (V04 F[2]). Reject moves the item to rejected only when the tier is blocking and the check judges the artifact (W02 F[7], V05 R[2]); the code stays in `errors` even when an earlier incomplete requirement keeps the item out of that partition (V05 R[3] orders the partition, and the validation contract still lists the item-level refutation). A request waits: every declared layer is incomplete with reason awaiting a step, attribution transient (V04 F[3], V05 R[3] step 4), and the code is an error. The unknown action does not repair or reject, and its attribution stays unattributed (V04 F[5]). "记未知" is that handling, not a second mapping of the verdict. A check error is the producer failing to return a verdict (V04 F[2]). Timeout and awaiting a step are transient (V04 F[3]). Missing input is a data gap (V04 F[0]). Used-up repair rounds are the producer's. A declared skip, an uncovered item and a layer with no check name no one (V04 F[5]). Independence is a property of a judgment the check actually returned: an unknown or a refutation does not become independence unknown.

9. **A check's declared tier** replaces the tier of each of its refutations (the check entry's `tier`).

10. **An item the submission does not mention** is incomplete, including when every requirement is optional. The "required" flag selects which incomplete requirement moves a covered item; not being covered is about the item (W07 R[3], V05 R[3]).

11. **Not covered and the rounds left.** The error names the run's remaining rounds (the maximum minus the rounds used). The model says a missing item counts toward the repair rounds and does not say which requirement's budget.

12. **Error and item order.** Items follow the run's projection order. On an accepted submission the errors are, per item and in requirement order, a request, a repair whose rounds are used up, and every reject-routed refutation, then a not-covered error for an item the submission does not mention. A repair that still has rounds left stays on the terminal (W02 R[5]). A submission that is not accepted lists its protocol codes and then every item-level refutation, including an open repair with the rounds left (W08 R[1]). The model does not prescribe this order; the differential comparison sorts before it compares.

13. **What one check's silence about a handled item means.** Not specified. The reference refuses the scenario. The generator always supplies an outcome.

## Not covered

The generator does not build these, because the scenario has no field for them or the model forbids inventing the terminal:

- A judge abstaining (V01: a judge may abstain; the outcome list here is support, refute, unknown).
- Dynamic pass, fail or an observed no-verdict. Recording pass or fail would claim a fact without the integrity rule (V03 R[5]).
- Effect dispositions: quarantine, mark failed, abandon, and the other effect states in V05 R[3] steps 1 to 3. Milestone inputs have no effects, so those partitions are not produced. `abandoned` as an unsatisfied reason is in the same gap.
- Output failed, budget exhausted, and an integrity failure supplied as an input. Awaiting a step is produced when an error-table row sends a request; it is not supplied as an input.
- A terminal qualified by an unconfirmed judgment (V03 R[6]), effect endpoints (V03 R[8]), and non-upgrade in transit (V03 R[9]).
- The gating done-rule and the discrimination display (V06). Required requirements are enforced only through the partition order.
- The text of a cross-item claim. A run-level requirement key is accepted and, by V05 R[4], does not appear on an item. The claim itself is not built.
- Carry-over of a predecessor fragment, check silence, target-side attribution, and the request id or options of an error. Author-input attribution is produced for a refutation of the subject.
- A second outcome from the same check, and two declared models that share a word but are not the same string. The reference takes the declared string as the family, because A04 names a family and does not say how to split a name. The random loop also stays on handled items, a first repair round, and `support` for `loose`, `recorded`, `both` and `dyn`. Skip, missing, a second repair round, the unknown action, an omitted check tier, a same-pack predecessor and a later submission on an already independent run are pinned on their own, because the engine disagrees there. `both` is not refuted in the random loop: a static violation beside a dynamic layer that was not run is a combination the model does not rank, and the two sides disagree; that pair is pinned and not called a defect.
