# Verdict oracle

A reference implementation of the boundary-validation rules, written from the model elements V01, V03, V04, V05, V06, W02, W07, W08 and T03 and from the shapes in `contracts/src`. It does not follow `hub/runs/engine` or `hub/rules`. `oracle.ts` is the reference. `oracle.test.ts` pins it to the model text. `differential.test.ts` runs the same scenarios through the engine.

`expected(run, submission, outcomes)` returns the acceptance, the repair rounds, every item's partition and per-requirement layer terminals (with status, unsatisfied reason and attribution), the static and dynamic cell of each item, the partition counts, the unknown-item count and the errors summary.

## Reference scope and explicit choices

1. **One terminal from several outcomes.** A layer holds one terminal (the validation contract). A refutation is named ahead of an unknown, and an unknown ahead of a support, which is the worst-first order V03 R[3] gives the cell (不通过, then 未核对, then 通过). The cell still counts every non-pass terminal of the item, so an unknown on another requirement is not hidden behind a pass or a violation.

2. **Which refutation is named.** The first one that misses the expectation, in check order and then outcome order. T03 R[4] routes that code through its error-table row. An exact code wins over `*`.

3. **Which unknown reason is named.** The first unknown outcome, in the same order.

4. **Rounds already used.** New descriptions can provide a separate charged count per requirement. Each distinct received submission charges a requirement once for unresolved work, a skip or an eligible repair, regardless of how many item errors it has. A repeated body does not charge another round. The older scalar input is retained for the artifact-repair-only hand calculations. Budgets remain those declared on the code's row; unconsumed rounds are not invented.

5. **Several unsatisfied reasons.** V03 F[2] lists them in one order and the result holds one. The earliest listed is named: no producer, then abandoned, then an outcome that misses the expectation, then independence unknown.

6. **No producer.** No installed check makes the static layer unchecked (V01 R[1], V03 R[1]). That is unknown, so a fact or a judgment stays pending (V03 R[4], F[2]). An independent judgment with no check has no producer (W02 R[4]): nothing returned a judgment whose independence could be accepted. A judgment terminal is only what a check actually returned.

7. **Dynamic layer.** Installed checks land on the static terminals: V01 R[6] maps a refutation to 不通过. A dynamic pass or fail is a fact only after the integrity rule (V03 R[5]), and these scenarios carry no integrity proof, so a declared dynamic layer is not run (未装检查). Not run is unknown (V03 R[4]), so the requirement stays pending unless another layer already missed its expectation. A requirement that declares no static layer does not record the check's verdict and does not repair or reject from it.

8. **Who is named, and the actions other than repair.** The terminal of an unexpected refutation stays a violation (V01 R[6]), except a request. T03 R[4] reserves producer error for a statement that disagrees with a source it cites, and these scenarios do not carry that, so a repair row does not itself name the producer. Repair applies only to checks judging the artifact under verification; refutations of the subject stay at violation with author_input and consume no repair rounds (T03 R[4], W02 F[7]). A refutation of the subject is the author's input (V04 F[1]). A refutation of the artifact under verification is the producer's (V04 F[2]). Reject moves the item to rejected only when the tier is blocking and the check judges the artifact (W02 F[7], V05 R[2]); the code stays in `errors` even when an earlier incomplete requirement keeps the item out of that partition (V05 R[3] orders the partition, and the validation contract still lists the item-level refutation). A request waits: every declared layer is incomplete with reason awaiting a step, attribution transient (V04 F[3], V05 R[3] step 4), and the code is an error. The unknown action does not repair or reject, and its attribution stays unattributed (V04 F[5]). "记未知" is that handling, not a second mapping of the verdict. A check error is the producer failing to return a verdict (V04 F[2]). Timeout and awaiting a step are transient (V04 F[3]). Missing input is a data gap (V04 F[0]). Used-up repair rounds are the producer's. A declared skip, an uncovered item and a layer with no check name no one (V04 F[5]). Independence is a property of a judgment the check actually returned: an unknown or a refutation does not become independence unknown.

9. **A check's declared tier** replaces the tier of each of its refutations (the check entry's `tier`).

10. **Skipped or missing items.** Judgment requirements and facts needing the submitted artifact are incomplete; target facts retain the result of checking the frozen original. Only a required incomplete requirement chooses the incomplete partition. At zero remaining rounds, missing work is repair exhausted.

11. **Every unresolved fact is visible.** Receipt errors name each requirement and remaining budget. A run-level coverage error separately summarizes omitted items; its remaining budget is the minimum of the affected declared judgment slots, or zero when there are none.

12. **Error order.** The differential comparison sorts before comparing. Unknown outcomes, missing-work errors and layer recovery errors remain separate from known refutations; recording unknown handling retains the known refutation and names its request. It does not turn that violation into an unknown verdict.

13. **Installed check silence.** V03 now explicitly calls this a check error. This generator always supplies an outcome; the dedicated engine tests cover silence.

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
- A second outcome from the same check and the full declared-model-family parser. This generator uses distinct synthetic names; the engine tests pin its conservative word rule.

## Legacy declaration playback

The driving pack intentionally retains old declarations with no static check or dynamic observation, so it cannot be newly admitted. A separate negative test verifies that fresh admission refuses it and creates a named package repair request. Legacy playback seeds a synthetic frozen run from an admitted bootstrap's parsed sources and projection, pinned to the legacy pack's actual bytes. This fixture setup uses record storage only; the independent expected answer never imports engine or interpreter functions. No runtime admission rule is bypassed.

Target-check scripts are part of the synthetic source original and remain readable when a submission skips an item. Artifact checks read the submitted slots. Each random case uses a fresh frozen run, so its stated initial counters are true. Fixed repeated-body cases separately pin per-requirement charging and the existing independent-session rules. Missing facts and exits themselves have dedicated boundary and read-only historical tests.

## Cross-layer status

Integrator decision 2026-10-24: a known terminal that misses the declared expectation makes the requirement unsatisfied even when another layer remains transitional. With no known miss, an unsettled layer keeps it pending. The separate regression compares both answers, retains the raw dynamic unknown and its exit, and the engine property test verifies unchanged partition membership and unknown counts.
