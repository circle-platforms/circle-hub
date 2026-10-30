# case-compile 3.9.0: one run and one workbook for the whole document (decision 104)

The owner asked why the goal mindmap was compiled and run case by case: a user converts a whole mindmap for a version. Until
now case-compile selected exactly one autoid per run, generated a single-case workbook, and the Hub's dispatch proof required
exactly one item. Decision 104 makes one run take the whole document and produce one workbook.

Change:

- `packs/workflow/case-compile/workflow.json`: `autoid` optional (absent: the whole document); new input `plan_result`
  (`from_runs` case-compile: the plan run id, bound by the Hub as that run's latest accepted result).
- `functions/project.ts`: whole-document selection (textual autoid of the configured shape, not excluded, document order;
  duplicates refuse; recomposition stays per case); with a workbook of several cases, freeze `plan_set` (each case's accepted
  plan and catalog receipt, item order) from `plan_result`, or refuse.
- `functions/generate.ts`: `caseRecipe`, `recipeDigest`, `generateWorkbookSet`; one case keeps the single-case bytes.
- `functions/workbook.ts`: the reader walks every case block; each item check requires its plan to equal its frozen plan and
  regenerates the whole workbook from `plan_set`. `functions/subject.ts` passes `plan_set`.
- `functions/dispatch-policy.ts`, `policies/dispatch.json`: 1 to 64 distinct autoids.
- `tools/generate-workbook.ts`: `satisfiedRecipes` for every case; `satisfiedRecipe` stays for one case.
- `hub/dispatch/proof.ts`: a verification run may have several items; the proof must name one dispatched id per item; a
  workflow whose dispatch-observed dynamic layer would be projected onto one item stays single-item until an item map exists.
- Tests: `functions/whole-mindmap.test.ts` (workbook set, per-item regeneration, frozen-plan mismatch, order, duplicates,
  dispatch policy, startup selection, plan_result freezing); `hub/dispatch/release-diagnostics.test.ts`: the `run.items` case
  now uses an empty item list (several items are legal), new cases for `proof.fields.items` and `run.items.dynamic`, and a
  release of a two-item run. `hub/dispatch/hardening.test.ts` is unchanged and still refuses a second item without its id.
- Version 3.8.11 → 3.9.0 (generator identity and the typed samples recomputed with the pack's own generator).

Allowed paths: `packs/workflow/case-compile/**`, `hub/dispatch/proof.ts`, `hub/dispatch/release-diagnostics.test.ts`, this page.

Verification: `npx tsc --noEmit`; all case-compile and hub/dispatch tests; `affected-tests.py --run`; the full check before
deploying.
