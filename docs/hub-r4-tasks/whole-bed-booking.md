# Book the whole bed, and say so when a dispatch is refused at the boundary

Found by the first real whole-mindmap run after decisions 104/105 went live (production 3c7d0d03de02): the model, following
step 1 of the case-compile skill ("先取得 test-bed 预订"), booked one load balancer of a bed whose executor declares all
eleven devices as its target. The whole-bed requirement was only mentioned in step 8. Following the run through the code
showed what the user would then have seen: the dispatch is refused at the effect boundary before any reservation
(`LEASE_UNAVAILABLE`, clause 5), but `acceptedDispatch` reported it as "Hub 已派发作业" without a job, because
`dispatchAccepted` returns started for any status `dispatch` returns; and the progress note never printed the refusal's
public reason. CES reports a failed bed check as it is and submits nothing past it (section 9 of its skill).

Change:

- `packs/workflow/case-compile/SKILL.md` step 1: book the whole bed (`need.devices` with every device of the inventory, the
  dispatch must cover it); case-compile 3.9.4 (version files, regenerated samples, manifest by the pack's `pack-files.ts`).
- `hub/dispatch/accepted.ts`: a dispatch that ended before any reservation answers "Hub 没有派发：<reason>" with the
  refused job and its next action; the progress note prints the public reason (`原因：`).
- Tests: `hub/dispatch/accepted.test.ts` (a lease of another lineage: the first answer says nothing was sent and why, with
  the job; a repeat reads it as ended with its reason); scenario 28 (a booking of part of the bed: accepted verification,
  "Hub 没有派发：…租约", nothing sent; the legacy-workflow test now asserts that no answer claims a dispatch, since a
  refusal now names its job).

Allowed paths: `packs/workflow/case-compile/{SKILL.md,README.md,pack-files.ts,pack.json,pack.test.ts,publish.test.ts}`,
`packs/workflow/case-compile/tables/workbook-format.json`, the four typed samples of case-compile, `hub/dispatch/accepted.ts`,
`hub/dispatch/accepted.test.ts`, `hub/dispatch/README.md`, `tests/acceptance/28-device-run.test.ts`, this page.

Verification: `npx tsc --noEmit`; `hub/dispatch/accepted.test.ts`; the pack, publish and production tests of case-compile;
scenario 28; the affected tests; the full check before deploying.
