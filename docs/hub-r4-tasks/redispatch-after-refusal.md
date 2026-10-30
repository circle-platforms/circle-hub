# Try again on a repeat after a refusal at the effect boundary

Found by the first real whole-mindmap run (production 0c1b6c2d54e9): after a dispatch refused at the effect boundary (the
run's lineage did not hold the whole target), the model planned to fix the cause and "resubmit the same submission to
trigger the dispatch". `acceptedDispatch` answered any repeat of a run that had a job by reading that job, so the refused
job, with the reason stored before the cause was fixed, was all a repeat could ever return; only a new verification run
dispatched. CES treats a workbook its gateway refused as not submitted: fix and resubmit (exit code 2 of `run_device.py`).
A refusal at the boundary ends before any reservation or remote call and writes no dispatch intent, and `dispatch` already
accepts a new attempt after it.

Change: `RunJob.boundary_refused` (`hub/dispatch/read-runs.ts`, from the journal's refusal record); `acceptedDispatch`
tries again when every job of the run ended refused at the boundary and the result is ready. A job that reached the target,
its precheck included, is still only read, so a repeat never contacts the gateway again by itself.

Tests: `hub/dispatch/accepted.test.ts` (refused, a read without retry, the lease moved to the run's lineage, a repeat
dispatches once, a further repeat reads); scenario 28 (a repeat after a partial booking is refused again, naming the keys;
the environment-precheck repeat still only reads); `hub/runs/engine/dispatch-results.test.ts` fixtures carry the field.

Allowed paths: `hub/dispatch/accepted.ts`, `hub/dispatch/accepted.test.ts`, `hub/dispatch/read-runs.ts`,
`hub/dispatch/README.md`, `hub/runs/engine/dispatch-results.test.ts`, `tests/acceptance/28-device-run.test.ts`, this page.

Verification: `npx tsc --noEmit`; the hub/dispatch and hub/runs tests; scenario 28; the full check before deploying.
