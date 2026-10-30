# Start a run whose subject quotes more references than one evaluation may read

On the deployed Hub, regression-scope between two version lines (a command diff of 655 paths) failed at start_run with an internal error: the evaluator collected every reference-like string of the slot record and its table, reserved each against the 256-reference read budget, and the budget failure was thrown out of the collection and through start_run, which has no handler for it. maintenance-sweep on the same pair passed because its subject quotes fewer references. The pack's checks are pure functions of the table and never read those references.

Change: references past the budget are not warmed instead of failing the whole evaluation (a check that needs their text sees them as unavailable, an honest unknown; the budget still bounds what is read); and a read failure while evaluating a production run at start is a structured SOURCE_UNAVAILABLE refusal with its message and fix, as submit_result already answers it, never an internal error. The refusal handler is a safety net and is not exercised by a test of its own; the large-diff production test of regression-scope covers the budget case and fails without the change.

Allowed paths: `hub/runs/engine/evaluate.ts`, `hub/runs/engine/start.ts`, `packs/workflow/regression-scope/production.test.ts`, this page.

Verification: `npx tsc --noEmit`, the production tests of regression-scope, the engine tests of hub/runs, `affected-tests.py --run`.
