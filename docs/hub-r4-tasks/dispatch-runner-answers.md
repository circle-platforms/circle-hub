# The Hub's own dispatch retries only what sent nothing, keeps a running dispatch, and answers the runner as a runner

Found by the read-only check of 162482b85 after the whole-mindmap run (two reviewers, every finding re-read in the code):

- A repeat of a ready submission retried every job whose journal holds a `boundary_refused` phase. The final boundary
  writes that phase too, after the connector session, the target lease, the precheck and the per-device probes
  (`service.ts` :399, :476 and the later rounds). A deterministic refusal there (an executor updated after the
  verification run froze its snapshot, which happens at every case-compile release) made each progress read open a new
  job and probe every device again, answering "已派发作业".
- The answer lists one note per job without a cap; the output schema allows 16 notes of 800 characters, and a violation
  turns submit_result into an internal error for that run for good.
- Jobs refused by the preflight (clauses 1–4) were bound with `input: null` and were invisible to the run's notes.
- The runner was shown administrator text: every running job's progress said `下一步：circle-hub job resume <job>`, an
  occupied target named the occupying jobs (possibly another user's) with `job dispose`, and dispatch errors were shown
  raw and logged nowhere (`explainRelease` errors were swallowed into "放行条件尚未全部满足").
- An accepted plan run (items delivered, `workbook_verified` still open) tried to dispatch and answered
  "Hub 没有派发：放行条件尚未全部满足…按放行说明补齐后重交", a release explanation the runner cannot read. In the
  first whole-mindmap session the model guessed the cause and reopened its plan run.
- A different submission while a job of the run was still checking became the run's latest accepted result, so the
  job stopped before its submit ("只读核对期间核验数据已改变") and the run could never dispatch again.
- A session name the gateway reports that is not a valid source name would make the result read throw after the
  receipt and keep the job, and the bed, waiting.

What CES does (compile-excel `SKILL.md` §9): the run is submitted once and its task id printed; progress is read with
`cex_case_status` / `cex_case_results` for that id, "do not resubmit, which runs the whole workbook again"; only a
submission that was not sent (refused, or the submit call failed) or a lost run is submitted again; a failed check is
reported as it is. The Hub keeps decision 105 (repeating the same submission reads progress) and aligns the rest:

- `hub/dispatch/read-runs.ts`: `boundary_refused` holds only when the job's journal has no response of the target before
  the refusal, so only a refusal that sent nothing is tried again; with `unbound` the run's preflight refusals (bound
  before any input) are listed too, for the runner's notes only.
- `hub/dispatch/accepted.ts`: the runner's note says what the runner can do in each state (running: repeat the same
  submission; unknown: the named administrator reconciles; refused before sending: fix and repeat; refused after the
  target was reached: this run dispatches no more, start a new verification run; effective: read the result reference)
  and never forwards the administrator's `next_action`; at most 16 notes (the newest, after a line counting the older),
  each at most 800 characters; `runInFlight` reads the run's jobs that have not ended.
- `hub/dispatch/service.ts`: `dispatchAccepted` answers in runner terms, names the release checks that do not hold by
  their fixed labels (no values: the fields are digests), and writes the administrator log for unmet releases and
  errors; an occupied target throws `TargetOccupiedError` (the CLI text is unchanged, the runner is told the bed is
  occupied without job ids); the reverification message no longer asks for a redispatch; failure evidence takes a safe
  source name when the reported one is not valid and a piece that cannot be saved is logged instead of stalling the job.
- `hub/runs/engine/submit.ts`: ready means every item delivered and every release requirement of a hub_template row
  that the item lists satisfied, so a plan run does not try to dispatch; while a job of the run has not ended, the same
  submission reads progress from the stored result without a new validation, and a different one is stored as
  received but not validated, answered IDEMPOTENCY_MISMATCH with the jobs' notes (the dispatch goes on); dispatch errors
  are logged; the refusal does not count as a repair round.
- `hub/runs/engine/deps.ts`, `hub/server/assemble/hub.ts`, `hub/dispatch/api.ts`: the `inFlight` port.

Tests: `hub/dispatch/accepted.test.ts` (a refusal after the target was reached is read and never tried again; notes stay
within the schema limits; runner notes carry no administrator command in any state); `hub/dispatch/results.test.ts`
(an invalid session name still saves the evidence and the job completes); `hub/runs/engine/dispatch-in-flight.test.ts`
(a plan run with a release requirement open does not dispatch; during a running job the same submission reads progress
and a different one is stored, refused with IDEMPOTENCY_MISMATCH and leaves the latest accepted result unchanged);
scenario 28 where its texts change.

Allowed paths: `hub/dispatch/read-runs.ts`, `hub/dispatch/accepted.ts`, `hub/dispatch/accepted.test.ts`,
`hub/dispatch/service.ts`, `hub/dispatch/results.test.ts`, `hub/dispatch/api.ts`, `hub/dispatch/README.md`,
`hub/runs/engine/submit.ts`, `hub/runs/engine/deps.ts`, `hub/runs/engine/dispatch-in-flight.test.ts`,
`hub/server/assemble/hub.ts`, `tests/acceptance/28-device-run.test.ts`, this page.

Verification: `npx tsc --noEmit`; the dispatch and engine tests; scenario 28; the full check before deploying.
