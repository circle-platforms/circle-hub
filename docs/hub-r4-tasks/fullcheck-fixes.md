# Fixes from the full check of the decision 104/105 trunk

The full check of hub-redesign c86951112 failed in two places; both come from the decision 104 and 105 changes merged
before it.

- Vocabulary: `packs/workflow/case-compile/functions/command-obligations.ts` wrote the verdict pair `'unknown'|'refute'`
  by hand in the `Problem` type added for net-effect cleanup (case-compile 3.8.11). It now narrows the generated `Verdict`
  with `Extract`, as `plan-commands.ts` does. Only the type changes, not the behaviour, but the bytes do, and a tracked
  version keeps the manifest of the commit that set it (the docs check refused the unchanged 3.9.2), so case-compile moves
  to 3.9.3: version strings, regenerated samples (only their identity row changes) and the manifest written by the pack's
  own `pack-files.ts`. 3.9.2 was never published.
- Scenario 28 (`tests/acceptance/28-device-run.test.ts`) still dispatched as an administrator after the verification
  run was accepted. Since decision 105 the Hub dispatches at that acceptance itself, so the second dispatch met the
  Hub's job on the physical target (tests 1, 6, 7), and test 2 passed only because its legacy workflow was put in place
  after the Hub had already sent the workbook. The conditions of each dispatch (legacy workflow, environment mismatch,
  lost receipt) are now set before the verification submission, the tests read the job the Hub dispatched and wait for it
  to settle, and every existing assertion stays. Added, after the CES on-device run (section 9 of its compile-excel
  skill: the task id comes back as soon as the gateway accepts, a repeat reads that task and never resubmits, a failed
  bed check is reported to the user as it is): the job is initiated by the runner with the administrator acting; a
  repeat of the same submission returns the same job and result reference and sends nothing; a failed environment check
  shows in the runner's answer; the next case is not dispatched while the first effect is frozen, and the answer says so.
- `hub/dispatch/accepted.ts`: a job's progress note lists its failed checks (step, seat, check, missing fact) and the
  unmatched conditions (pointer and operator), the facts the journal keeps of a refused precheck.
- Whether a job has ended came from the name of its last phase: the progress note said a job still ran unless that phase
  was `complete`, but a refused precheck ends with its done record followed by the target lease release (`release`), so
  the runner was told to poll a finished job; the first version of the scenario helper made the same mistake.
  `RunJob.ended` (`hub/dispatch/read-runs.ts`) now comes from the journal: `done` with a terminal record, `unknown` once the
  effect is recorded as unresolved and waits for an administrator, null while the job runs. The note and both test
  helpers use it; the fixtures of `hub/runs/engine/dispatch-results.test.ts` carry it.

- Scenario 28 had no run at the user's unit of work (decision 104). A new test does what the user does in Circle: a plan run
  without autoid takes every case, one submission plans them all, the client's own `tools/fetch-run.ts` fetches the inputs
  from `/run-export` with the runner's token on standard input, `tools/generate-workbook.ts` writes one workbook, one
  verification run binds `plan_result`, the Hub dispatches once with every autoid and the result has one verdict row per
  case; a repeat reads the same job. Its first run found that `fetch-run.ts` reported any failure other than an HTTP
  status as a malformed export and waited for the platform's 300 s request timeout (the test had blocked the in-process Hub
  with a synchronous child): an unreachable Hub is now reported with its cause and an unanswered request after 120 s
  (case-compile 3.9.3, `tools/fetch-run.test.ts`), and the test runs the tool asynchronously.

- The contract and profile inputs of `workflow.json` name their default documents, as the inventory input does: in the first
  real per-case run the model guessed them nine times before the user told it.
- Its second run found that no verification run of several cases could start: `functions/project.ts` froze the plans from
  `plan_result` by a supporting verdict on `plan`, but the Hub records the accepted plan as the model's judgment claim
  without a verdict; the unit fixture had invented one. The plan is now that judgment claim (exactly one, with data), the
  fixture carries the recorded shapes, and two refusals are added (no data; a verdict in place of the judgment).

Allowed paths: `packs/workflow/case-compile/functions/command-obligations.ts`, `packs/workflow/case-compile/functions/project.ts`,
`packs/workflow/case-compile/functions/whole-mindmap.test.ts`, `packs/workflow/case-compile/workflow.json`,
`packs/workflow/case-compile/tools/fetch-run.ts`,
`packs/workflow/case-compile/tools/fetch-run.test.ts`, the version files of case-compile
(`pack-files.ts`, `pack.json`, `pack.test.ts`, `publish.test.ts`, `tables/workbook-format.json`, the four typed samples,
`README.md`), `tests/acceptance/28-device-run.test.ts`,
`hub/dispatch/accepted.ts`, `hub/dispatch/accepted.test.ts`, `hub/dispatch/read-runs.ts`, `hub/dispatch/README.md`,
`hub/runs/engine/dispatch-results.test.ts`, this page.

Verification: `npx tsc --noEmit`; the vocabulary suite of `packs/workflow/case-review/packs.test.ts`;
`hub/dispatch/accepted.test.ts`; scenario 28; the full check before deploying.
