# The Hub dispatches an accepted run by its hub_template effect row (decision 105)

Decision 105 (owner, 2026-10-30): once every requirement is satisfied while the user holds the bed, the user's own run
dispatches the verified workbook; the one-dispatch budget, the release checks and the bed checks stay. The generic model
already says so (elements/68 rule 4, W03/D06: a hub_template job starts when submit_result is accepted and the release
holds, deduplicated per run and submission; repeating the same submission reads asynchronous progress; submit_result's
annotations follow the widest row of the caller's packs). Until now only the administrator command `job dispatch` started
a job, and the runner could not see jobs at all.

Change:

- `hub/dispatch/service.ts`: `dispatchAccepted(run)`: the first enabled administrator is the operator responsible for an
  unknown outcome; among enabled executors of the run's pack exactly one must release (`explainRelease`), else nothing starts
  and the reason is returned; the job binding records `initiated_by` = runner and `acting_by` = that administrator.
  `dispatch` takes `initiatedBy`; one next-action text uses `acting_by ?? initiated_by` like the others.
- `hub/dispatch/accepted.ts` (exported by `api.ts`): `acceptedDispatch`: with jobs bound to the run, report their phase,
  outcome and result reference; with none and a ready result, dispatch and wait up to 60 s for the reservation (the job runs
  on after the answer; its journal and the scheduled reconciliation carry it to its end).
- Engine: `RunsEngineDeps.dispatch.accepted` (wired in `hub/server/assemble/hub.ts`); `hub/runs/engine/submit.ts`
  `withDispatch` on every accepted answer (new, cached or repeated) of a run whose pack declares a hub_template row; ready =
  every item delivered and no error.
- Contract: `contracts/src/tools.ts` SubmitResultOutput gains `dispatch` (job, executor, result reference, text); regenerated
  `contracts/generated/tools.json`. `hub/server/text.ts` prints one `派发：` line per note.
- Annotations: `hub/server/tools.ts` `submitDispatchesJobs`: submit_result takes the job effect class (open-world,
  destructive, still idempotent) for a caller with such a pack (`annotationsFor` already documents this, D06 R[4]).
  `notifications/tools/list_changed` on assignment changes is not implemented (README of hub/dispatch).
- Tests: `hub/dispatch/accepted.test.ts` (dispatch once as the runner with a named administrator; no administrator; release
  not holding; reserved note then progress); `hub/server/mcp.test.ts` (per-caller submit_result annotations, with the new
  `hubTemplate` option of `hub/server/fakes.ts`).

Allowed paths: `hub/dispatch/**`, `hub/runs/engine/deps.ts`, `hub/runs/engine/submit.ts`, `hub/server/assemble/hub.ts`,
`hub/server/tools.ts`, `hub/server/text.ts`, `hub/server/fakes.ts`, `hub/server/mcp.test.ts`, `contracts/src/tools.ts`,
`contracts/generated/tools.json`, this page.

Verification: `npx tsc --noEmit`; hub/dispatch, hub/server and hub/runs tests; `npm run verify:contracts`; the full check
before deploying (contracts and engine change).
